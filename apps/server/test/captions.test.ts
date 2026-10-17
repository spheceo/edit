// captions.rs's tests, same names, and the package's tools and routes end to
// end on the stub (Luna through a stand-in Agents).

import { afterEach, expect, test } from "bun:test";

import type { App } from "../src/app.ts";
import {
  adjusted,
  anchor,
  CAPTION_BOTTOM,
  captionSize,
  captionStyle,
  cap,
  carried,
  layOut,
  linesOf,
  lineText,
  named,
  relabels,
  sameSpeaker,
  starredText,
  subtitleName,
  subtitleStyle,
  throwaway,
  uncrammed,
  type Adjusted,
  type Glimpse,
  type Line,
} from "../src/captions.ts";
import { routes } from "../src/captions_tools.ts";
import { baseRouter, respond } from "../src/http/server.ts";
import { dispatch } from "../src/mcp/index.ts";
import type { Clip, Media, Project, Rgba, TextClip, TextStyle, Transform } from "../src/model.ts";
import { newProject } from "../src/project.ts";
import { f32 } from "../src/rust.ts";
import * as seams from "../src/seams.ts";
import type { Face, Found } from "../src/seams.ts";
import { serialize, type Transcript, type Word } from "../src/transcribe.ts";
import { fixtureHome, write } from "./helpers/home.ts";

function word(text: string, start: number, end: number, speaker: string): Word {
  return { text, start, end, speaker };
}

test("speakers_match_without_their_brackets", () => {
  expect(sameSpeaker("Pearl", "Pearl (Pearl)")).toBe(true);
  expect(sameSpeaker("Officer Rodriguez", "Rodriguez (Officer Rodriguez)")).toBe(true);
  expect(sameSpeaker("rodriguez", "Rodriguez (Officer Rodriguez)")).toBe(true);
  expect(sameSpeaker("speaker_2", "speaker_2")).toBe(true);
  expect(sameSpeaker("Latricia", "Pearl (Pearl)")).toBe(false);
  expect(sameSpeaker("other", "Pearl (Pearl)")).toBe(false);
  expect(sameSpeaker("", "Pearl (Pearl)")).toBe(false);
});

test("splits_lines_at_pauses_voices_and_sentences", () => {
  const words = [
    word("A", 1.0, 1.1, "s0"),
    word("little", 1.15, 1.4, "s0"),
    word("accident,", 1.45, 1.9, "s0"),
    word("perhaps?", 2.0, 2.5, "s0"),
    word("I", 3.2, 3.3, "s1"),
    word("have", 3.35, 3.5, "s1"),
    word("no", 3.55, 3.7, "s1"),
    word("idea.", 3.75, 4.1, "s1"),
    word("None.", 4.15, 4.5, "s1"),
  ];
  expect(linesOf("c1", words).map(lineText)).toEqual(["A little accident, perhaps?", "I have no idea.", "None."]);
});

test("drops_lines_that_are_only_fillers", () => {
  const line = (words: string[]): Line => ({
    clip: "c1",
    words: words.map((text) => word(text, 0.0, 0.1, "s0")),
    voice: null,
    name: null,
    color: null,
    role: "other",
  });
  expect(throwaway(line(["like"]))).toBe(true);
  expect(throwaway(line(["Um,", "like..."]))).toBe(true);
  expect(throwaway(line(["No."]))).toBe(false);
  expect(throwaway(line(["Like", "this."]))).toBe(false);
});

test("sits_above_or_below_the_face_and_on_screen", () => {
  const frame: [number, number] = [1920.0, 1080.0];
  // A face high in the frame: no room above, so below it.
  expect(anchor([-500.0, -100.0, -300.0, 100.0], "below", [400.0, 80.0], frame, 14.0)).toEqual([0.0, -300.0 + 14.0 + 40.0]);
  // Room above: sits over the head.
  expect(anchor([0.0, -100.0, 200.0, 100.0], "above", [400.0, 80.0], frame, 14.0)[1]).toBe(-14.0 - 40.0);
  // Never off the edge.
  const [x] = anchor([0.0, 900.0, 200.0, 960.0], "above", [400.0, 80.0], frame, 14.0);
  expect(x + 200.0).toBeLessThanOrEqual(960.0);
});

function glimpse(frame: number, faces: Face[], speaker: Face | null): Glimpse {
  return { frame, faces, speaker };
}

test("a_caption_sits_under_a_clear_speaker_and_never_on_a_face", () => {
  const frame: [number, number] = [1920.0, 1080.0];
  const style = captionStyle(1920, 1080);
  // The speaker mid-frame, steady: under their chin, still, off their face.
  const face: Face = [-100.0, -300.0, 100.0, -60.0];
  const seen = Array.from({ length: 6 }, (_, i) => glimpse(i * 15.0, [face], face));
  let laid = layOut("told me that,", style, frame, seen, true);
  expect(laid.under_face).toBe(true);
  // A face that hardly moves: no jitter.
  expect(laid.keys).toBeNull();
  const [w, h] = captionSize("told me that,", style);
  const top = laid.y - h / 2.0;
  expect(top).toBeGreaterThan(seams.faces.grown(face)[3]);
  expect(Math.abs(laid.x) < 1.0 && w > 0.0).toBe(true);
  // Not clearly visible (or the wrong person): bottom middle.
  laid = layOut("told me that,", style, frame, seen, false);
  expect(laid.under_face).toBe(false);
  expect([laid.x, laid.y]).toEqual([0.0, f32(CAPTION_BOTTOM * 1080.0)]);
  // Under the speaker would sit on someone else's face: bottom middle, still off it.
  const other: Face = [-150.0, 0.0, 150.0, 200.0];
  const crowded = Array.from({ length: 6 }, (_, i) => glimpse(i * 15.0, [face, other], face));
  expect(layOut("told me that,", style, frame, crowded, true).under_face).toBe(false);
  // A face at the bottom middle moves the fallback aside.
  const low: Face = [-120.0, 250.0, 120.0, 520.0];
  const text = "in that moment, but if I lose my baby";
  laid = layOut(text, style, frame, [glimpse(0.0, [low], null)], false);
  const [lw, lh] = captionSize(text, style);
  const area: Face = [f32(laid.x - lw / 2.0), f32(laid.y - lh / 2.0), f32(laid.x + lw / 2.0), f32(laid.y + lh / 2.0)];
  expect(seams.faces.overlap(area, seams.faces.grown(low))).toBe(0.0);
});

test("a_moving_speaker_is_followed_smoothly", () => {
  const frame: [number, number] = [1920.0, 1080.0];
  const style = captionStyle(1920, 1080);
  const seen = Array.from({ length: 8 }, (_, i) => {
    const x = f32(-400.0 + 60.0 * i + (i % 2 === 0 ? 8.0 : -8.0));
    const face: Face = [x, -300.0, f32(x + 180.0), -80.0];
    return glimpse(i * 15.0, [face], face);
  });
  const laid = layOut("saying", style, frame, seen, true);
  expect(laid.keys).not.toBeNull();
  const [xs] = laid.keys!;
  // Smoothed: each step forward, no back-and-forth jitter.
  for (let i = 1; i < xs.length; i++) expect(xs[i]!.value).toBeGreaterThanOrEqual(xs[i - 1]!.value - 0.5);
});

test("stretched_words_end_when_they_could_be_said", () => {
  // "right." stretched over 9 s of silence: capped, the pause splits the line.
  const words = [word("All", 0.0, 0.2, "s0"), word("right.", 0.25, 9.4, "s0"), word("Anything", 9.5, 9.7, "s0"), word("else?", 9.75, 10.0, "s0")];
  expect(linesOf("c1", words).length).toBe(1);
  const capped = words.map(cap);
  expect(Math.abs(capped[1]!.end - 1.35)).toBeLessThan(1e-9);
  expect(linesOf("c1", capped).map(lineText)).toEqual(["All right.", "Anything else?"]);
  // Numbers keep their time.
  expect(cap(word("$8,320", 0.0, 3.0, "s0")).end).toBe(3.0);
});

test("crammed_lines_get_time_to_be_read", () => {
  const spans: [number, number][] = [
    [234_750.0, 236_000.0],
    [244_380.0, 244_790.0],
  ];
  const out = uncrammed(spans, ["All right.", "Anything in your pocket?"]);
  expect(out[0]).toEqual(spans[0]!);
  // Read time taken from the gap before it; it still ends with its words.
  expect(out[1]![1]).toBe(244_790.0);
  expect(Math.abs(out[1]![0] - (244_790.0 - 21.0 * 60.0))).toBeLessThan(1e-6);
});

test("narrator_radio_and_background_talk_are_not_subtitled", () => {
  const BACKGROUND = seams.speakers.BACKGROUND;
  const transcript: Transcript = {
    model: "test",
    language: null,
    words: [],
    speakers: { s0: "Officer", s1: "Narrator", s2: "Dispatch" },
    roles: { s0: "officer", s2: "dispatch", [BACKGROUND]: BACKGROUND },
    colors: { s0: "#00e5c7" },
  };
  const words = [
    word("Hands", 0.0, 0.2, "s0"),
    word("up.", 0.25, 0.5, "s0"),
    word("In", 1.0, 1.1, "s1"),
    word("2019,", 1.15, 1.5, "s1"),
    word("Unit", 2.0, 2.2, "s2"),
    word("four.", 2.25, 2.5, "s2"),
    word("Ma'am,", 3.0, 3.2, BACKGROUND),
  ];
  const lines = linesOf("c1", words).map((line) => named(line, transcript));
  expect(lines.filter((line) => !seams.subtitles.hiddenRole(line.role)).map(lineText)).toEqual(["Hands up."]);
  // The narrator read from its name, with no role given.
  expect(lines[1]!.role).toBe("narrator");
  expect(lines[0]!.color).toBe("#00e5c7");
});

test("stars_house_words_in_the_line_they_are_said_in", () => {
  const line: Line = {
    clip: "a1",
    words: [word("What", 10.0, 10.2, "s0"), word("the", 10.25, 10.4, "s0"), word("fuck.", 10.45, 10.7, "s0")],
    voice: "s0",
    name: null,
    color: null,
    role: "officer",
  };
  const words = seams.subtitles.timedWords(line.words, 0.0, 100.0);
  const found: Found[] = seams.subtitles
    .suggestions(words, false, 0.0, 100_000.0)
    .map((suggestion) => ({ clip: "a1", timeline_ms: [suggestion.at_ms, suggestion.end_ms], suggestion }));
  expect(starredText(line, found)).toBe("What the f***.");
  // Found in another clip's sound: left alone.
  expect(starredText({ ...line, clip: "a2" }, found)).toBe("What the fuck.");
});

function subtitleClip(start: number, duration: number, transform: Transform, style: TextStyle): TextClip {
  return {
    id: `s${start}`,
    track: "v9",
    start,
    duration,
    color: "cyan",
    name: "Subtitle · Officer",
    fade_in: 0,
    fade_out: 0,
    keyframes: {},
    type: "text",
    text: "Hands up.",
    style,
    transform,
    animation: { preset: "none", duration: 12, stagger: 1.5 },
    opacity: 1.0,
    word_times: [],
  };
}

const ORIGIN: Transform = { x: 0, y: 0, scale: 1, rotation: 0 };

test("a_rerun_keeps_who_is_who_and_their_colour", () => {
  const labelled = (text: string, colour: Rgba): TextStyle => ({ ...subtitleStyle(1920, 1080), label: { text, color: colour, size: 26.0 } });
  const red: Rgba = [1.0, f32(0.3), f32(0.35), 1.0];
  const project = newProject("p", "t", { width: 1920, height: 1080, fps: 30 });
  // "Officer" was renamed Sinclair on two lines of three; one slipped.
  project.clips = [
    subtitleClip(0, 10, ORIGIN, labelled("Sinclair:", red)),
    subtitleClip(20, 10, ORIGIN, labelled("Sinclair:", red)),
    subtitleClip(40, 10, ORIGIN, labelled("Officer:", [1, 1, 1, 1])),
  ];
  const kept = relabels(project);
  expect(kept.get("Officer")).toEqual(["Sinclair:", red]);
  expect(kept.size).toBe(1);
});

test("edit_subtitles_use_first_names_without_glow", () => {
  expect(subtitleStyle(1920, 1080).glow.enabled).toBe(false);
  expect(subtitleName("Jane Doe (Mother)")).toBe("Jane");
  expect(subtitleName("Hayven:")).toBe("Hayven");
  expect(subtitleName("Officer Diaz")).toBe("Diaz");
  expect(subtitleName("Deputy 2")).toBe("Deputy 2");
  expect(subtitleName("Child 2")).toBe("Child 2");
  expect(subtitleName("Sister 3")).toBe("Sister 3");
  expect(subtitleName("")).toBe("Speaker");
  const subtitled = seams.subtitles.houseStyle(1920, 1080, [1, 1, 1, 1]);
  expect(subtitled.glow.enabled).toBe(true);
  expect(subtitled.label).toBeUndefined();
});

test("a_rerun_keeps_subtitles_moved_by_hand", () => {
  const style = subtitleStyle(1920, 1080);
  const placed: Transform = { ...ORIGIN, y: 1080.0 * 0.4 };
  // As add_subtitles left it: nothing to keep.
  expect(adjusted(subtitleClip(0, 30, placed, style), style, placed, [1920, 1080])).toBeNull();
  // Its speaker's label differs per line: not an adjustment.
  const labelled: TextStyle = { ...style, label: { text: "Officer:", color: [1, 1, 1, 1], size: 26.0 } };
  expect(adjusted(subtitleClip(0, 30, placed, labelled), style, placed, [1920, 1080])).toBeNull();
  // Moved up off a blur, and another narrowed.
  const moved: Transform = { ...placed, y: -300.0 };
  const narrow: TextStyle = { ...style, max_width: 700.0, size: 40.0 };
  const old = [subtitleClip(100, 50, moved, style), subtitleClip(150, 50, placed, narrow), subtitleClip(300, 50, placed, style)]
    .map((clip) => adjusted(clip, style, placed, [1920, 1080]))
    .filter((one): one is Adjusted => one !== null);
  expect(old.length).toBe(2);
  // A new line over most of the first takes its place; mostly over the second, its width and size.
  expect(carried(old, 95, 140)?.transform).toEqual(moved);
  const second = carried(old, 140, 190);
  expect(second === null ? null : [second.max_width, second.size]).toEqual([700.0, 40.0]);
  // Over only unadjusted ones, or nothing: the house place.
  expect(carried(old, 300, 350)).toBeNull();
  expect(carried(old, 200, 260)).toBeNull();
});

// ---------------------------------------------------------------------------
// End to end on the stub

const realAgents = new Map<App, App["agents"]>();
afterEach(() => {
  for (const [app, agents] of realAgents) app.agents = agents;
  realAgents.clear();
});

function bodycam(dir: string): Media {
  return { id: "m", name: "bodycam", path: `${dir}/bodycam.mp4`, kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true };
}

const TRANSCRIPT: Transcript = {
  model: "scribe_v2",
  language: "eng",
  words: [
    { text: "Stop", start: 1.0, end: 1.3, speaker: "speaker_0" },
    { text: "moving", start: 1.35, end: 1.7, speaker: "speaker_0" },
    { text: "now.", start: 1.75, end: 2.0, speaker: "speaker_0" },
    { text: "Okay.", start: 3.0, end: 3.3, speaker: "speaker_1" },
  ],
  speakers: { speaker_0: "Officer", speaker_1: "Jane (Mother)" },
  roles: { speaker_0: "officer", speaker_1: "witness" },
  colors: { speaker_0: "#00e5c7", speaker_1: "#e57e00" },
};

async function footage(app: App, dir: string): Promise<string> {
  const media = bodycam(dir);
  // A file (empty: FFmpeg can't read it) for the media key to name.
  write(media.path, "");
  write(app.media.paths(media.path).transcript, serialize(TRANSCRIPT));
  const live = app.store.create("p", { width: 1920, height: 1080, fps: 30 });
  const project = structuredClone(live.project) as Project;
  project.media = [media];
  const clips: Clip[] = [
    {
      id: "f",
      track: "v1",
      start: 0,
      duration: 900,
      color: "blue",
      fade_in: 0,
      fade_out: 0,
      type: "video",
      media: "m",
      source_in: 0,
      speed: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      opacity: 1,
      link: "l1",
    },
    { id: "a", track: "a4", start: 0, duration: 900, color: "blue", fade_in: 0, fade_out: 0, type: "audio", media: "m", source_in: 0, speed: 1, volume_db: 0, link: "l1" },
  ];
  project.clips = clips;
  await app.store.replace(project.id, null, project, "test");
  return project.id;
}

async function call(app: App, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const reply = (await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, null)) as {
    result: { content: { text: string }[]; isError: boolean };
  };
  return { text: reply.result.content[0]!.text, isError: reply.result.isError };
}

test("caption_speakers asks Luna who speaks and lays the intro's captions out (no faces found: bottom middle)", async () => {
  const { app, dir, store, cleanup } = fixtureHome("captions");
  try {
    const id = await footage(app, dir);
    const asked: unknown[][] = [];
    realAgents.set(app, app.agents);
    app.agents = {
      status: async () => ({}),
      ask: async (model, effort, _instructions, input, schema, timeout) => {
        asked.push([model, effort, input, schema !== null, timeout]);
        return JSON.stringify({ lines: [{ n: 0, above: true, people: [{ who: "Officer", face: [100, 400, 300, 600] }], overlays: [] }, { n: 1, above: true, people: [], overlays: [] }] });
      },
    };
    // The stills are FFmpeg's; there's no footage here, so it says so.
    let reply = await call(app, "caption_speakers", { project_id: id });
    expect(reply).toEqual({ text: "couldn't take a still", isError: true });
    // With stills (an FFmpeg that "takes" them), the captions go in.
    const bin = `${dir}/bin`;
    write(`${bin}/ffmpeg`, "#!/bin/sh\nexit 0\n");
    (await import("node:fs")).chmodSync(`${bin}/ffmpeg`, 0o755);
    const before = process.env.EDIT_FFMPEG;
    process.env.EDIT_FFMPEG = `${bin}/ffmpeg`;
    (await import("../src/tools.ts")).forget();
    try {
      reply = await call(app, "caption_speakers", { project_id: id, start: 0, end: 10 });
    } finally {
      if (before === undefined) delete process.env.EDIT_FFMPEG;
      else process.env.EDIT_FFMPEG = before;
      (await import("../src/tools.ts")).forget();
    }
    expect(reply.isError).toBe(false);
    expect(reply.text.startsWith("captioned 0–10s: {")).toBe(true);
    const summary = JSON.parse(reply.text.slice(reply.text.indexOf("{"))) as Record<string, unknown>;
    expect(summary).toMatchObject({ lines: 2, placed: 2, under_the_speakers_face: 0, bottom_middle: 2, speakers: ["Officer", "Jane (Mother)"] });
    const [model, effort, input, schema, timeout] = asked[0]!;
    expect([model, effort, schema, timeout]).toEqual(["gpt-6-luna", "medium", true, 600_000]);
    const prompt = (input as { text?: string }[])[0]!.text!;
    expect(prompt).toContain("Who's who: speaker_0 (Officer); speaker_1 (Jane (Mother)).");
    expect(prompt).toContain("0 [1.0s, speaker_0 (Officer)] Stop moving now. (still 0 is at 1.5s)\n1 [3.0s, speaker_1 (Jane (Mother))] Okay. (still 1 is at 3.1s)");
    const captions = store.get(id)!.project.clips.filter((clip): clip is TextClip => clip.type === "text");
    expect(captions.map((clip) => [clip.name, clip.text, clip.start, clip.duration, clip.transform.y, clip.animation.preset])).toEqual([
      ["Caption · Officer", "Stop moving now.", 30, 41, f32(388.8), "words"],
      ["Caption · Jane (Mother)", "Okay.", 90, 20, f32(388.8), "words"],
    ]);
    expect(captions[0]!.style).toMatchObject({ font: "Montserrat", size: 44, max_width: 806 });
    expect(captions[0]!.word_times).toEqual([0, f32(10.5), f32(22.5)]);
    // place_captions lays them out again (no faces analysed under them here).
    const placed = await call(app, "place_captions", { project_id: id, under: { [captions[0]!.id]: "bottom" } });
    expect(placed.isError).toBe(false);
    expect(JSON.parse(placed.text)).toMatchObject({ captions: 2, under_the_speakers_face: 0, bottom_middle: 2 });
    expect((await call(app, "place_captions", { project_id: id, under: { x: [1] } })).text).toBe("under.x: a point is [x, y]");
    expect((await call(app, "place_captions", { project_id: id, under: { x: 3 } })).text).toBe('under.x: "bottom", "auto" or [x, y]');
  } finally {
    cleanup();
  }
});

test("track_region, transcribe, find_in_footage and the routes answer as mcp.rs and server.rs did", async () => {
  const { app, dir, cleanup } = fixtureHome("captions-tools");
  try {
    const id = await footage(app, dir);
    expect((await call(app, "track_region", { project_id: id })).text).toBe("time is required");
    expect((await call(app, "track_region", { project_id: id, time: 1 })).text).toBe("follow is required");
    expect((await call(app, "track_region", { project_id: id, time: 1, follow: "x", box: [1, 2] })).text).toBe("box is [x0, y0, x1, y1]");
    expect((await call(app, "track_region", { project_id: id, time: 100, follow: "x", box: [1, 2, 3, 4] })).text).toBe("no footage at that time to track");
    expect((await call(app, "track_region", { project_id: id, time: 1, follow: "x", box: [1, 2, 3, 4] })).text).toBe("no clip x");
    expect((await call(app, "track_region", { project_id: id, time: 1, follow: "a", box: [1, 2, 3, 4], boxes: [{ time: 99, box: [1, 2, 3, 4] }] })).text).toBe(
      "the box at 99.00s isn't on the footage tracked (f plays 0.00–30.00s); give boxes on that clip",
    );
    expect((await call(app, "transcribe", { project_id: id, media_id: "m" })).text).toBe('transcript for bodycam: "ready"');
    expect((await call(app, "transcribe", { project_id: id, media_id: "x" })).text).toBe("no media x");
    const found = await call(app, "find_in_footage", { project_id: id, phrases: ["stop moving"] });
    expect(JSON.parse(found.text)).toEqual({
      results: [{ phrase: "stop moving", hits: [{ media: "m", name: "bodycam", at: 1, end: 1.7, speaker: "Officer", exact: true, said: "Stop moving now. Okay." }] }],
      untranscribed_media: [],
    });
    expect((await call(app, "find_in_footage", { project_id: id, phrases: [] })).text).toBe("give 1 to 60 phrases");
    expect((await call(app, "find_in_footage", { project_id: id })).text).toBe("phrases: invalid type: null, expected a sequence");

    const router = baseRouter();
    routes(router);
    const post = (path: string, body?: unknown) =>
      respond(
        app,
        router,
        new Request(`http://localhost:7700${path}`, {
          method: "POST",
          headers: body === undefined ? { host: "localhost:7700" } : { host: "localhost:7700", "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        null,
      ) as Promise<Response>;
    let response = await post(`/api/projects/${id}/media/m/transcribe`);
    expect([response.status, await response.text()]).toEqual([
      200,
      '{"status":{"light":"pending","peaks":"pending","proxy":"pending","proxy_progress":0,"thumb_count":0,"thumbs":"pending","transcript":"ready"}}',
    ]);
    response = await post(`/api/projects/${id}/media/x/transcribe`);
    expect([response.status, await response.json()]).toEqual([404, { error: "no such media" }]);
    response = await post(`/api/projects/nope/captions`);
    expect([response.status, await response.json()]).toEqual([404, { error: "no such project" }]);
    response = await post(`/api/projects/${id}/captions`, { start: "x" });
    expect(response.status).toBe(422);
    // No key for the gateway: the watcher says so, as a 400.
    const key = process.env.AI_GATEWAY_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    try {
      response = await post(`/api/projects/${id}/watch`, { force: true });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain("the watcher needs AI_GATEWAY_API_KEY");
    } finally {
      if (key !== undefined) process.env.AI_GATEWAY_API_KEY = key;
    }
  } finally {
    cleanup();
  }
});
