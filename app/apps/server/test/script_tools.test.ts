// The package's routes and the whole script import, against the mock
// (Docs, Drive, the relay's speech and transcription) with real FFmpeg.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import type { App } from "../src/app.ts";
import { baseRouter, respond } from "../src/http/server.ts";
import { dispatch } from "../src/mcp/index.ts";
import type { ScriptBlock, ScriptJob } from "../src/model.ts";
import { researchRoutes, routes, start, timing as scriptTiming, voiceRoutes } from "../src/script_tools.ts";
import * as tools from "../src/tools.ts";
import { timing as transcribeTiming } from "../src/transcribe.ts";
import { timing as voiceoverTiming } from "../src/voiceover.ts";
import { fixtureHome, type Fixture } from "./helpers/home.ts";
import { MockServer, scribeAnswer } from "./mocks/server.ts";

const ffmpeg = Bun.which("ffmpeg");
const ffprobe = Bun.which("ffprobe");
const FILE = "1FOOTAGEabcdefgh";

let mock: MockServer;
let restore: () => void;
let footage: Uint8Array = new Uint8Array();
let tone: Uint8Array = new Uint8Array();

function make(args: string[]): Uint8Array {
  const out = `${fs.mkdtempSync("/tmp/edit-wp4-")}/out`;
  const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-y", ...args, out], { stdin: "ignore" });
  if (made.exitCode !== 0) throw new Error(made.stderr.toString());
  return new Uint8Array(fs.readFileSync(out));
}

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: undefined });
  transcribeTiming.sleep = async () => {};
  voiceoverTiming.sleep = () => Bun.sleep(5);
  scriptTiming.sleep = () => Bun.sleep(5);
  tools.forget();
  if (ffmpeg === null || ffprobe === null) return;
  // Seven minutes of police footage (tiny), a keyframe a second.
  footage = make([
    "-f", "lavfi", "-i", "color=gray:s=32x32:r=5:d=420",
    "-f", "lavfi", "-i", "sine=f=300:d=420",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "5", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-f", "mp4",
  ]);
  tone = make(["-f", "lavfi", "-i", "sine=f=440:d=2", "-c:a", "libmp3lame", "-f", "mp3"]);
  mock.driveFile(FILE, footage, "Bodycam.mp4");
  mock.on("POST", "/v1/speech", () => new Response(tone, { headers: { "content-type": "audio/mpeg" } }));
  mock.on("POST", "/v1/transcribe", () => Response.json(scribeAnswer("On July 13 Kent police were called".split(" "))));
}, 60_000);

afterAll(() => {
  restore();
  mock.stop();
});

const link = (start: string) =>
  `https://www.google.com/url?q=https://drive.google.com/file/d/${FILE}/view?usp%3Dsharing&amp;sa=D">${start}`;
const DOC = `<html><head><title>Kent crash</title></head><body>
<p><span>Kent crash</span></p>
<p><span>(</span><a href="${link("00:05 - 00:10")}</a><span>)</span></p>
<p><span>On July 13, Kent police were called.</span></p>
<p><span>(</span><a href="${link("05:00 - 05:05")}</a><span>)</span></p>
</body></html>`;

function serve(app: App) {
  const router = baseRouter();
  routes(router);
  voiceRoutes(router);
  researchRoutes(router);
  return async (method: string, path: string, body?: unknown): Promise<[number, unknown]> => {
    const init: RequestInit = { method, headers: { host: "localhost:7700" } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { host: "localhost:7700", "content-type": "application/json" };
    }
    const response = (await respond(app, router, new Request(`http://localhost:7700${path}`, init), null))!;
    const text = await response.text();
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
    return [response.status, value];
  };
}

function withAgents(name: string): [Fixture, string[]] {
  const sent: string[] = [];
  const fixture = fixtureHome(name, {
    services: {
      agents: {
        status: async () => ({}),
        ask: async () => "",
        send: async (_project: string, text: string) => {
          sent.push(text);
        },
      } as never,
    },
  });
  return [fixture, sent];
}

test.skipIf(ffmpeg === null || ffprobe === null)(
  "a script is read from its Doc, its footage downloaded and cut, laid out, voiced, and its research started",
  async () => {
    const [{ app, cleanup, home }, sent] = withAgents("script-import");
    mock.doc("DOCabcdefghijk", DOC);
    try {
      const http = serve(app);
      const docUrl = "https://docs.google.com/document/d/DOCabcdefghijk/edit";
      expect(await http("POST", "/api/scripts/preview", { url: docUrl })).toEqual([
        200,
        { files: 1, footage: 2, narration: 1, seconds: 13, title: "Kent crash" },
      ]);
      expect(await http("POST", "/api/scripts/preview", { url: "https://example.com/doc" })).toEqual([
        400,
        { error: "Paste a Google Docs link (docs.google.com/document/d/…)." },
      ]);
      expect((await http("POST", "/api/scripts/preview", {}))[0]).toBe(422);
      const id = app.store.create("Kent crash", { width: 1920, height: 1080, fps: 30 }).project.id;
      const events: ScriptJob[] = [];
      app.store.subscribe((event) => {
        if (event.type === "script") events.push(event.job as ScriptJob);
      });
      // Attaching starts the import (its job is in the answer); here it's awaited.
      const store = app.store;
      const [status, attached] = await http("POST", `/api/projects/${id}/script`, { url: docUrl });
      expect(status).toBe(200);
      expect((attached as { job: ScriptJob }).job.state).toBe("downloading");
      while (!["done", "failed"].includes(app.scripts.get(id)?.state ?? "")) await Bun.sleep(20);
      const job = app.scripts.get(id)!;
      expect(job).toMatchObject({ state: "done", files: [{ file: FILE, name: "Bodycam.mp4", state: "done", bytes: footage.length }] });
      expect(events.map((event) => event.state)).toContain("voicing");
      const project = store.get(id)!.project;
      // Two excerpts (the ranges are minutes apart), each from a keyframe.
      const cuts = project.media.filter((media) => media.kind === "video").map((media) => media.name);
      expect(cuts.length).toBe(2);
      expect(cuts[0]!.startsWith("Bodycam 0h00m00s-0h00m20s-")).toBe(true);
      expect(cuts[1]!.startsWith("Bodycam 0h04m50s-0h05m15s-")).toBe(true);
      const blocks = project.script!.blocks;
      const [first, , second] = blocks as [Extract<ScriptBlock, { kind: "footage" }>, ScriptBlock, Extract<ScriptBlock, { kind: "footage" }>];
      expect(first.media_start).toBeUndefined();
      expect(second.media_start).toBe(290);
      // Laid out butted: range, cut-in (its voice-over's length), range.
      const pictures = project.clips.filter((clip) => clip.type === "video" || clip.type === "solid").sort((a, b) => a.start - b.start);
      expect(pictures.map((clip) => [clip.type, clip.start])).toEqual([
        ["video", 0],
        ["solid", 150],
        ["video", pictures[2]!.start],
      ]);
      const narration = blocks[1] as Extract<ScriptBlock, { kind: "narration" }>;
      expect(project.clips.find((clip) => clip.id === narration.voiceover)?.name).toBe("Voice-over");
      // The case's research starts once it's laid out, through the agent panel.
      expect(sent.length).toBe(1);
      expect(sent[0]!.startsWith("The script is imported and laid out.")).toBe(true);
      const [, polled] = await http("GET", `/api/projects/${id}/script/job`);
      expect(polled).toMatchObject({ unfinished: false, job: { state: "done" } });
      // Again: nothing to fetch, nothing placed twice; the research is asked
      // for again only because none was saved yet .
      await start(app, id, false);
      expect(store.get(id)!.project.clips.length).toBe(project.clips.length);
      expect(sent.length).toBe(2);
      expect(fs.existsSync(`${home}/media/drive/${FILE}/.done`)).toBe(true);
      expect(await http("POST", `/api/projects/nope/script/job`)).toEqual([404, { error: "no such project" }]);
    } finally {
      cleanup();
    }
  },
  60_000,
);

test("the voice-over routes answer", async () => {
  const [{ app, cleanup }] = withAgents("voice-routes");
  try {
    const http = serve(app);
    let [status, value] = await http("POST", "/api/voice", { name: "  " });
    expect(status).toBe(200);
    const project = (value as { project: { id: string; name: string; lines: { id: string }[]; voice: { speed: number } } }).project;
    expect([project.name, project.lines.length, project.voice.speed]).toEqual(["Untitled voice-over", 1, 1.15]);
    [status, value] = await http("GET", "/api/voice");
    expect((value as { projects: { id: string }[] }).projects.map((own) => own.id)).toEqual([project.id]);
    expect(await http("GET", "/api/voice/nope")).toEqual([404, { error: "no such voice-over" }]);
    expect(await http("GET", "/api/voice/..%2Fx")).toEqual([404, { error: "no such voice-over" }]);
    [status, value] = await http("PUT", `/api/voice/${project.id}`, {
      name: "Narration",
      voice: { voice_id: "abc", stability: 3 },
      lines: [{ id: project.lines[0]!.id, text: "Hello there." }, { text: "Second." }],
    });
    expect(status).toBe(200);
    expect((value as { project: { voice: { stability: number }; lines: unknown[] } }).project.voice.stability).toBe(1);
    expect((await http("PUT", `/api/voice/${project.id}`, { name: "x" }))[0]).toBe(422);
    const id = app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    expect(await http("POST", "/api/voice", { from_project: id })).toEqual([400, { error: "That project's script has no cut-ins to voice." }]);
    expect(await http("POST", `/api/voice/${project.id}/send`, { project: id })).toEqual([400, { error: "No lines have a chosen take yet." }]);
    expect(await http("POST", `/api/voice/${project.id}/send`, { project: "nope" })).toEqual([404, { error: "no such project" }]);
    expect(await http("GET", `/api/voice/${project.id}/full.mp3`)).toEqual([400, { error: "No lines have been spoken yet." }]);
    expect(await http("GET", `/api/voice/${project.id}/lines/l1/takes/t1`)).toEqual([404, { error: "no such take" }]);
    expect(await http("POST", `/api/voice/${project.id}/lines/nope/generate`)).toEqual([400, { error: "no such line" }]);
    expect(await http("DELETE", `/api/voice/${project.id}`)).toEqual([200, { ok: true }]);
    expect((await http("GET", "/api/voice"))[1]).toEqual({ projects: [] });
  } finally {
    cleanup();
  }
});

test("the research routes answer", async () => {
  const [{ app, cleanup }] = withAgents("research-routes");
  try {
    const http = serve(app);
    const id = app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    expect(await http("GET", `/api/projects/${id}/research`)).toEqual([200, { articles: [], collecting: false, items: [] }]);
    expect(await http("GET", "/api/projects/nope/research")).toEqual([404, { error: "no such project" }]);
    expect(await http("POST", `/api/projects/${id}/research`, { queries: ["  "] })).toEqual([400, { error: "say what to search for" }]);
    expect((await http("POST", `/api/projects/${id}/research`, {}))[0]).toBe(422);
    expect(await http("POST", `/api/projects/${id}/research/clear?status=kept`)).toEqual([
      400,
      { error: "kept images stay (they're in the media bin)" },
    ]);
    // Nothing found yet: there's no folder to write the index in.
    expect(await http("POST", `/api/projects/${id}/research/clear`)).toEqual([400, { error: "No such file or directory (os error 2)" }]);
    expect(await http("POST", `/api/projects/${id}/research/x`, { status: "maybe", origin: "ui" })).toEqual([
      400,
      { error: "status is new, kept or rejected" },
    ]);
    expect(await http("POST", `/api/projects/${id}/research/x`, { status: "kept", origin: "ui" })).toEqual([400, { error: "no such found image" }]);
    expect(await http("GET", `/api/projects/${id}/research/x/image`)).toEqual([404, { error: "no such found image" }]);
  } finally {
    cleanup();
  }
});

test("place_voiceovers, tighten_voiceover and speed_voiceover say what's missing", async () => {
  const [{ app, cleanup }] = withAgents("voiceover-tools");
  try {
    const id = app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    const call = async (name: string, args: Record<string, unknown>) => {
      const reply = (await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: { project_id: id, ...args } } }, null)) as {
        result: { content: { text: string }[]; isError: boolean };
      };
      return reply.result.content[0]!.text;
    };
    expect(await call("place_voiceovers", {})).toBe("no voice-over recordings: import the audio first");
    expect(await call("place_voiceovers", { media_ids: ["m9"] })).toBe("no media m9");
    expect(await call("place_voiceovers", { media_ids: "m9" })).toBe('invalid type: string "m9", expected a sequence');
    expect(await call("tighten_voiceover", {})).toBe("no voice-over plays in that span");
    expect(await call("speed_voiceover", { start: 0 })).toBe("end is required (seconds)");
    expect(await call("speed_voiceover", { start: 0, end: 5 })).toBe("speed is required");
    expect(await call("speed_voiceover", { start: 0, end: 5, speed: 2 })).toBe("speed must be between 1.01 and 1.25 (1.04–1.08 is usual)");
    expect(await call("speed_voiceover", { start: 0, end: 5, speed: 1.1 })).toBe("no voice-over plays in that span");
    expect(await call("realign_script", {})).toBe("every range already starts and ends on its words");
  } finally {
    cleanup();
  }
});

test("place_voiceovers with some recordings keeps the cut-ins they don't read", async () => {
  const [{ app, cleanup, home }] = withAgents("voiceover-partial");
  try {
    const id = app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    const take = (name: string, words: string[]) => {
      const path = `${home}/${name}.mp3`;
      fs.writeFileSync(path, name);
      const transcript = app.media.paths(path).transcript;
      fs.mkdirSync(transcript.slice(0, transcript.lastIndexOf("/")), { recursive: true });
      const said = words.map((text, index) => ({ text, start: index * 0.5, end: index * 0.5 + 0.4, speaker: "speaker_0" }));
      fs.writeFileSync(transcript, JSON.stringify({ model: "scribe_v2", language: "eng", words: said }));
      return path;
    };
    const first = take("first", ["the", "detectives", "kept", "asking", "about", "him"]);
    const second = take("second", ["she", "never", "saw", "the", "file", "coming"]);
    await app.store.update(id, "test", (project) => {
      project.media.push(
        { id: "a1", name: "first", path: first, kind: "audio", duration: 20, width: 0, height: 0, fps: 0, has_audio: true },
        { id: "a2", name: "second", path: second, kind: "audio", duration: 20, width: 0, height: 0, fps: 0, has_audio: true },
      );
      const track = project.tracks[0]!.id;
      project.clips.push(
        { id: "k1", type: "solid", track, start: 0, duration: 60, name: "Cut-in 1", fill: [0, 0, 0, 1], color: "pink" } as never,
        { id: "k2", type: "solid", track, start: 60, duration: 60, name: "Cut-in 2", fill: [0, 0, 0, 1], color: "pink" } as never,
      );
      project.script = {
        blocks: [
          { kind: "narration", text: "The detectives kept asking about him.", clip: "k1" },
          { kind: "narration", text: "She never saw the file coming.", clip: "k2" },
        ],
      };
    });
    const call = async (args: Record<string, unknown>) => {
      const reply = (await dispatch(app, { id: 1, method: "tools/call", params: { name: "place_voiceovers", arguments: { project_id: id, ...args } } }, null)) as {
        result: { content: { text: string }[] };
      };
      return reply.result.content[0]!.text;
    };
    const voiced = () =>
      app.store.get(id)!.project.script!.blocks.map((block) => {
        const clip = block.kind === "narration" && block.voiceover ? app.store.get(id)!.project.clips.find((own) => own.id === block.voiceover) : undefined;
        return clip?.type === "audio" ? clip.media : null;
      });
    await call({});
    expect(voiced()).toEqual(["a1", "a2"]);
    // A new take of the first cut-in only: the second keeps its voice-over.
    const answer = await call({ media_ids: ["a1"] });
    expect(answer).toContain("its voice-over stays");
    expect(voiced()).toEqual(["a1", "a2"]);
    expect(app.store.get(id)!.project.clips.filter((clip) => clip.name === "Voice-over").length).toBe(2);
  } finally {
    cleanup();
  }
});
