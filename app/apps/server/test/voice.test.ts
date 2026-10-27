// voice.ts's test, plus the voice-over of a script's cut-ins made
// end to end against the mock relay (speech, then transcription to place it).

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import { layOut } from "../src/script.ts";
import * as tools from "../src/tools.ts";
import { timing as transcribeTiming } from "../src/transcribe.ts";
import { Voices } from "../src/voice.ts";
import { generate, timing as voiceoverTiming } from "../src/voiceover.ts";
import { fixtureHome, scratch } from "./helpers/home.ts";
import { MockServer, scribeAnswer } from "./mocks/server.ts";

test("lines_keep_their_takes_and_drop_the_deleted", () => {
  const { dir, cleanup } = scratch("voice");
  try {
    const voices = new Voices(dir);
    const project = voices.create("Test", null, [
      ["One.", null],
      ["Two.", null],
    ]);
    const [first, second] = [project.lines[0]!.id, project.lines[1]!.id];
    // Pretend the second line was spoken.
    const stored = voices.get(project.id);
    stored.lines[1]!.takes.push({
      id: "t1",
      created_ms: 0,
      text: "Two.",
      settings: { voice_id: null, voice_name: null, model_id: "eleven_v4", stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1.1 },
      duration: 1,
      characters: 4,
    });
    voices.save(stored);
    fs.writeFileSync(voices.takePath(project.id, "t1"), "mp3");

    // Reordered, the second keeps its take; a made-up chosen take is refused.
    const voice = { voice_id: "gUABw7pXQjhjt0kNFBTF", model_id: "eleven_v4", speed: 5.0 };
    const updated = voices.update(project.id, {
      name: "Renamed",
      voice,
      lines: [
        { id: second, text: "Two!", chosen: "t1" },
        { id: first, text: "One.", chosen: "t9" },
        { text: "Three." },
      ],
    });
    expect(updated.name).toBe("Renamed");
    expect(updated.voice.speed).toBe(1.2);
    expect(updated.lines[0]!.id).toBe(second);
    expect(updated.lines[0]!.chosen).toBe("t1");
    expect(updated.lines[1]!.chosen).toBeNull();
    expect(updated.lines.length).toBe(3);

    // Deleting the line deletes its take's file.
    voices.update(project.id, { name: "Renamed", voice: {}, lines: [{ id: first, text: "One." }] });
    expect(fs.existsSync(voices.takePath(project.id, "t1"))).toBe(false);
    expect(voices.list().length).toBe(1);
    // The UI's changes are refused in serde's words.
    expect(() => voices.update(project.id, { voice: {}, lines: [] })).toThrow("missing field `name`");
  } finally {
    cleanup();
  }
});

const ffmpeg = Bun.which("ffmpeg");
let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: undefined });
  transcribeTiming.sleep = async () => {};
  // Short real waits: the transcription runs on the event loop meanwhile.
  voiceoverTiming.sleep = () => Bun.sleep(5);
  tools.forget();
});

afterAll(() => {
  restore();
  mock.stop();
});

test.skipIf(ffmpeg === null || Bun.which("ffprobe") === null)(
  "a script's cut-ins are spoken with the house voice, one after another, and laid on the cut-ins",
  async () => {
    const { app, dir, cleanup } = fixtureHome("voice-generate");
    // The stub measures no loudness, so the takes keep 0 dB.
    try {
      // A second of tone stands in for every take ElevenLabs speaks.
      const tone = `${dir}/tone.mp3`;
      expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:a", "libmp3lame", tone]).exitCode).toBe(0);
      const spoken: Record<string, unknown>[] = [];
      mock.on("POST", "/v1/speech", (request) => {
        spoken.push(request.json());
        return new Response(fs.readFileSync(tone), { headers: { "content-type": "audio/mpeg", "x-request-id": `req-${spoken.length}` } });
      });
      const lines = ["Police arrived at the house", "Then the call came in"];
      let heard = 0;
      mock.on("POST", "/v1/transcribe", () => Response.json(scribeAnswer(lines[heard++ % lines.length]!.split(" "))));
      const live = app.store.create("Case", { width: 1920, height: 1080, fps: 30 });
      await app.store.update(live.project.id, "test", (project) => {
        project.script = { blocks: lines.map((text) => ({ kind: "narration" as const, text })) };
        layOut(project);
      });
      const report = (await generate(app, live.project.id)) as { media: string[]; report: { placed: boolean; words_matched: string }[] };
      expect(report.media.length).toBe(2);
      expect(report.report.map((entry) => [entry.placed, entry.words_matched])).toEqual([
        [true, "5/5"],
        [true, "5/5"],
      ]);
      // The second line carries on from the first (stitched), with the line around it.
      expect(spoken[0]).toMatchObject({ voice_id: "gUABw7pXQjhjt0kNFBTF", text: lines[0], previous_text: null, next_text: lines[1] });
      expect(spoken[1]).toMatchObject({ text: lines[1], previous_text: lines[0], previous_request_ids: ["req-1"] });
      const project = app.store.get(live.project.id)!.project;
      const voiced = project.script!.blocks.map((block) => (block.kind === "narration" ? block.voiceover : null));
      expect(voiced.every((clip) => typeof clip === "string" && project.clips.some((own) => own.id === clip && own.name === "Voice-over"))).toBe(true);
      expect(project.media.map((own) => own.name)).toEqual(["Case (voice-over) - Cut-in 1.mp3", "Case (voice-over) - Cut-in 2.mp3"]);
      // A second run reuses the takes: nothing is spoken again.
      await generate(app, live.project.id);
      expect(spoken.length).toBe(2);
    } finally {
      cleanup();
    }
  },
);

test.skipIf(ffmpeg === null || Bun.which("ffprobe") === null)("partial narration recovery keeps placed takes, reuses saved takes and survives repeated concurrent requests", async () => {
  const { app, dir, cleanup } = fixtureHome("voice-recovery");
  try {
    const tone = `${dir}/tone.mp3`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:a", "libmp3lame", tone]).exitCode).toBe(0);
    const lines = ["Police arrived at the house", "Then the call came in", "The officers checked the recording"];
    const spoken: string[] = [];
    mock.on("POST", "/v1/speech", (request) => {
      spoken.push((request.json() as { text: string }).text);
      return new Response(fs.readFileSync(tone), { headers: { "content-type": "audio/mpeg" } });
    });
    let heard = 1;
    mock.on("POST", "/v1/transcribe", () => Response.json(scribeAnswer(lines[heard++]!.split(" "))));
    const id = app.store.create("Partial", { width: 1920, height: 1080, fps: 30 }).project.id;
    await app.store.update(id, "test", (project) => {
      project.script = { blocks: lines.map((text) => ({ kind: "narration", text })) };
      layOut(project);
      const first = project.script.blocks[0]!;
      if (first.kind !== "narration") throw new Error("narration");
      project.media.push({ id: "recorded", name: "User recording", path: tone, kind: "audio", duration: 2, width: 0, height: 0, fps: 0, has_audio: true });
      project.clips.push({ id: "recorded", type: "audio", track: project.tracks.find((track) => track.kind === "audio")!.id, media: "recorded", start: 0, duration: 45, source_in: 0.1, speed: 1.1, volume_db: -3, mutes: [{ from: 0.3, to: 0.4 }], color: "green", fade_in: 0, fade_out: 0 });
      first.voiceover = "recorded";
      project.markers = [{ frame: 270, name: "end" }];
    });
    const before = structuredClone(app.store.get(id)!.project);
    const voice = app.voices.forProject("Partial (voice-over)", id, lines.map((text, index) => [text, `Cut-in ${index + 1}`]));
    // An interrupted import already paid for line 2, but never placed it.
    await app.voices.generate(voice.id, voice.lines[1]!.id);
    expect(spoken).toEqual([lines[1]!]);
    await Promise.all([generate(app, id, true), generate(app, id, true)]);
    const after = app.store.get(id)!.project;
    expect(spoken).toEqual([lines[1]!, lines[2]!]);
    expect(after.clips.find((clip) => clip.id === "recorded")).toEqual(before.clips.find((clip) => clip.id === "recorded"));
    expect(after.script!.blocks.every((block) => block.kind === "narration" && block.voiceover && after.clips.some((clip) => clip.id === block.voiceover))).toBe(true);
    expect(after.media.filter((media) => media.name.includes("Cut-in 1"))).toHaveLength(0);
    const completed = structuredClone(after);
    await generate(app, id, true);
    expect(app.store.get(id)!.project).toEqual(completed);
    expect(spoken).toHaveLength(2);
  } finally { cleanup(); }
});

test.skipIf(ffmpeg === null || Bun.which("ffprobe") === null)("recovery preserves a cut-in edited while its missing take is being generated", async () => {
  const { app, dir, cleanup } = fixtureHome("voice-recovery-concurrent-edit");
  try {
    const tone = `${dir}/tone.mp3`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:a", "libmp3lame", tone]).exitCode).toBe(0);
    mock.on("POST", "/v1/speech", () => new Response(fs.readFileSync(tone), { headers: { "content-type": "audio/mpeg" } }));
    mock.on("POST", "/v1/transcribe", () => Response.json(scribeAnswer("Police arrived at the house".split(" "))));
    const id = app.store.create("In progress", { width: 1920, height: 1080, fps: 30 }).project.id;
    await app.store.update(id, "test", (project) => {
      project.script = { blocks: [{ kind: "narration", text: "Police arrived at the house" }] };
      layOut(project);
    });
    const speak = app.voices.generate.bind(app.voices);
    app.voices.generate = async (voice, line) => {
      const done = await speak(voice, line);
      await app.store.update(id, "user", (project) => {
        const block = project.script!.blocks[0]!;
        const card = project.clips.find((clip) => clip.id === block.clip)!;
        card.duration = 120;
      });
      return done;
    };
    await generate(app, id, true);
    const after = app.store.get(id)!.project;
    const block = after.script!.blocks[0]!;
    expect(block.kind === "narration" && block.voiceover).toBeUndefined();
    expect(after.clips.find((clip) => clip.id === block.clip)!.duration).toBe(120);
    expect(after.clips.filter((clip) => clip.name === "Voice-over")).toHaveLength(0);
    expect(app.voices.chosenTakes((app.voices.list()[0] as { id: string }).id)).toHaveLength(1);
  } finally { cleanup(); }
});
