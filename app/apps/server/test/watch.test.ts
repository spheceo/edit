// watch.ts's tests (the paid ones stay behind their env gates),
// and a whole watch against the gateway mock.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import type { App } from "../src/app.ts";
import { dispatch } from "../src/mcp/index.ts";
import type { AudioClip, Clip, Media, Project, Segment } from "../src/model.ts";
import { newProject } from "../src/project.ts";
import * as seams from "../src/seams.ts";
import { serialize, type Transcript } from "../src/transcribe.ts";
import * as tools from "../src/tools.ts";
import {
  completedKey,
  linesOf,
  normalize,
  prompt,
  reassigned,
  serdeF64,
  setsSegments,
  stretches,
  unfence,
  voicesFor,
  watchWindow,
  post,
  windows,
  LONGEST,
  type Answer,
  voicedSegments,
} from "../src/watch.ts";
import { fixtureHome, scratch, write } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

function audio(track: string): AudioClip {
  return { id: "audio", track, start: 0, duration: 300, color: "blue", fade_in: 0, fade_out: 0, type: "audio", media: "m", source_in: 0, speed: 1, volume_db: 0 };
}

test("completed_watch_key_ignores_cosmetic_edits_but_not_speech_or_timing", () => {
  const p = newProject("p", "case", { width: 1920, height: 1080, fps: 30 });
  p.media.push({ id: "m", name: "source", path: "/unused", kind: "video", duration: 10.0, width: 1920, height: 1080, fps: 30.0, has_audio: true, markers: [] });
  const track = p.tracks.find((track) => track.kind === "audio")!.id;
  p.clips.push(audio(track));
  const t: Transcript = { model: "test", language: null, words: [{ text: "hello", start: 1.0, end: 1.5, speaker: "speaker_0" }], speakers: {}, roles: {}, colors: {} };
  const transcripts = new Map([["m", t]]);
  const original = completedKey(p, transcripts, false);
  p.clips[0]!.name = "renamed";
  expect(completedKey(p, transcripts, false)).toBe(original);
  // A correction's output gets its own receipt, so regrouped lines do not
  // force another paid watch. Changing it later invalidates that receipt.
  transcripts.get("m")!.words[0]!.speaker = "corrected_voice";
  const corrected = completedKey(p, transcripts, false);
  expect(corrected).not.toBe(original);
  expect(completedKey(p, transcripts, false)).toBe(corrected);
  p.clips[0]!.duration -= 30;
  expect(completedKey(p, transcripts, false)).not.toBe(corrected);
});

test("floats are written as serde_json writes them, so receipts match earlier versions'", () => {
  expect([1.0, 0.25, 1.5, -2.0, 0.0, -0.0, 1e-7, 0.0001, 0.00001, 0.000001, 1e16, 1e15, 123456789012345680, 30.000000000000004].map(serdeF64)).toEqual([
    "1.0",
    "0.25",
    "1.5",
    "-2.0",
    "0.0",
    "-0.0",
    "1e-7",
    "0.0001",
    "0.00001",
    "1e-6",
    "1e16",
    "1000000000000000.0",
    "1.2345678901234568e17",
    "30.000000000000004",
  ]);
});

function seg(start: number, end: number, kind: Segment["kind"]): Segment {
  return { start, end, kind };
}

test("windows_tile_the_span_cutting_in_pauses", () => {
  // A line every 10 s for 15 minutes, with a long pause after 230 s.
  const lines: [number, number][] = Array.from({ length: 90 }, (_, i) => {
    const start = i * 10.0 + (i >= 24 ? 6.0 : 0.0);
    return [start, start + 3.0];
  });
  let out = windows(lines, 0.0, 905.0);
  expect(out.length >= 3 && out.length <= 5).toBe(true);
  expect(out[0]?.start).toBe(0.0);
  expect(out[out.length - 1]?.end).toBe(905.0);
  for (let i = 1; i < out.length; i++) {
    expect(out[i - 1]!.end).toBe(out[i]!.start);
    expect(out[i - 1]!.lines[1]).toBe(out[i]!.lines[0]);
    expect(out[i - 1]!.end - out[i - 1]!.start).toBeLessThanOrEqual(LONGEST);
  }
  expect(out[out.length - 1]?.lines[1]).toBe(90);
  // The first cut falls in the longer pause, between lines 23 and 24.
  expect(out[0]!.lines[1]).toBe(24);
  // No lines at all: even pieces.
  out = windows([], 0.0, 700.0);
  expect(out.length).toBe(3);
  expect(out.every((w) => w.lines[0] === w.lines[1])).toBe(true);
  // Short: one window.
  expect(windows([[1.0, 2.0]], 0.0, 100.0).length).toBe(1);
});

function answer(people: [string, string][], lines: string[]): Answer {
  return {
    people: people.map(([id, role]) => ({ id, look: "", place: "", on_screen: true, name: "", role })),
    lines: lines.map((who, n) => ({ n, who, sure: "high", or: null })),
    segments: [],
    background: [],
  };
}

test("letters_take_their_majority_voice_or_split_off", () => {
  // A and B both mostly speaker_0 (two detectives who sound alike): A has
  // more lines and keeps it, B splits off; C is the suspect.
  const labels = ["speaker_0", "speaker_0", "speaker_0", "speaker_0", "speaker_1", "speaker_0"];
  const watched = answer(
    [
      ["A", "leader"],
      ["B", "officer"],
      ["C", "suspect"],
    ],
    ["A", "A", "A", "B", "C", "B"],
  );
  const splits = new Map<string, string>();
  const known = new Set(["speaker_0", "speaker_1", "speaker_2"]);
  const voices = voicesFor(watched, labels, splits, known);
  expect(voices.get("A")).toBe("speaker_0");
  expect(voices.get("C")).toBe("speaker_1");
  expect(voices.get("B")).toBe("speaker_3");
  // The next window's second officer is the same split voice.
  expect(voicesFor(watched, labels, splits, known).get("B")).toBe("speaker_3");
  expect(known.size).toBe(4);
});

test("background_talk_goes_to_a_hidden_voice", () => {
  const BACKGROUND = seams.speakers.BACKGROUND;
  // A (officer) talks with B (suspect); C, a medic, questions D behind them
  // in lines 2 and 4. Line 5 was background talk before.
  const labels = ["speaker_0", "speaker_1", "speaker_0", "speaker_0", "speaker_2", BACKGROUND];
  const watched = answer(
    [
      ["A", "officer"],
      ["B", "suspect"],
      ["C", "medic"],
      ["D", "witness"],
    ],
    ["A", "B", "C", "A", "D", "B"],
  );
  watched.background = [2, 4];
  const known = new Set(["speaker_0", "speaker_1", "speaker_2", BACKGROUND]);
  const voices = voicesFor(watched, labels, new Map(), known);
  // The background lines say nothing of who C and D are, and the background
  // voice is never a person's.
  expect(voices.get("A")).toBe("speaker_0");
  expect(voices.get("C")).toBeUndefined();
  expect(voices.get("D")).toBeUndefined();
  expect(voices.get("B")).not.toBe(BACKGROUND);
  const moved = reassigned(watched, voices, labels);
  const voiceOf = (n: number) => moved.find(([line]) => line === n)?.[1];
  expect(voiceOf(2)).toBe(BACKGROUND);
  expect(voiceOf(4)).toBe(BACKGROUND);
  // Line 5 is followed again: back to its speaker.
  expect(voiceOf(5)).toBe(voices.get("B"));
  expect(voiceOf(0)).toBeUndefined();
  expect(voiceOf(3)).toBeUndefined();
  // Hidden in repack_subtitles, without cutting the line before short.
  expect(seams.subtitles.hiddenRole(BACKGROUND)).toBe(true);
  expect(seams.subtitles.silentRole(BACKGROUND)).toBe(true);
});

test("segments_fill_gaps_join_and_drop_slivers", () => {
  const out = normalize(
    [seg(0, 100, "captioned"), seg(90, 200, "narration"), seg(200, 210, "footage"), seg(210, 400, "narration"), seg(500, 900, "other"), seg(900, 905, "narration")],
    1000,
    24,
  );
  expect(out.map((s) => [s.start, s.end, s.kind])).toEqual([
    [0, 100, "captioned"],
    [100, 400, "narration"],
    [400, 500, "footage"],
    [500, 905, "other"],
    [905, 1000, "footage"],
  ]);
  // All footage is no segments.
  expect(normalize([seg(0, 50, "footage")], 1000, 24)).toEqual([]);
  expect(normalize([], 1000, 24)).toEqual([]);
});

/**
 * One real window, end to end: `EDIT_WATCH_SOURCE` (a video),
 * `EDIT_WATCH_TRANSCRIPT` (its transcript.json) and `EDIT_WATCH_WINDOW`
 * (which window, default 0). Costs a model call.
 */
test.skipIf(process.env.EDIT_WATCH_SOURCE === undefined)("watches_one_real_window", async () => {
  const source = process.env.EDIT_WATCH_SOURCE!;
  const transcript = JSON.parse(fs.readFileSync(process.env.EDIT_WATCH_TRANSCRIPT!, "utf8")) as Transcript;
  const which = Number(process.env.EDIT_WATCH_WINDOW ?? "0");
  const end = (transcript.words[transcript.words.length - 1]?.end ?? -1) + 1.0;
  const lines = linesOf(transcript.words, 0.0, end);
  const all = windows(lines.map((line) => [line.start, line.end]), 0.0, end);
  const window = all[which]!;
  const mine = lines.slice(window.lines[0], window.lines[1]);
  const { dir, cleanup } = scratch("watch-real");
  try {
    const [watched, cost, cached] = await watchWindow(source, `${dir}/watch`, "12-Year-Old Realizes Police Know He's The Killer", window, mine, transcript.speakers ?? {}, false);
    console.log(`cost $${cost}, cached ${cached}`, JSON.stringify({ people: watched.people, segments: watched.segments }, null, 2));
  } finally {
    cleanup();
  }
}, 600_000);

/** Watches one real window both ways (paid): EDIT_WATCH_BENCH="<source path>,<start s>,<end s>" with AI_GATEWAY_API_KEY. */
test.skipIf(process.env.EDIT_WATCH_BENCH === undefined)("old_and_new_settings_on_one_window", () => {
  // The bench compared 3 fps with default thinking against 1 fps with low
  // thinking; only the second is kept (cut, ask). Run the Rust bench.
});

test("an_edit_is_watched_once_per_stretch_of_each_file", () => {
  // Cut-ins from three moments of a file; two close together.
  expect(
    stretches(
      [
        [300.0, 310.0],
        [20.0, 30.0],
        [40.0, 45.0],
      ],
      400.0,
    ),
  ).toEqual([
    [10.0, 55.0],
    [290.0, 320.0],
  ]);
  // Clamped to the file.
  expect(stretches([[2.0, 398.0]], 400.0)).toEqual([[0.0, 400.0]]);
});

test("segments_are_only_set_for_subtitled_videos", () => {
  const project = newProject("p", "t", { width: 1920, height: 1080, fps: 30 });
  project.media = [
    { id: "m", name: "bodycam", path: "/tmp/b.mp4", kind: "video", duration: 60.0, width: 1920, height: 1080, fps: 30, has_audio: true },
    { id: "s", name: "hit", path: "/tmp/hit.wav", kind: "audio", duration: 1.0, width: 0, height: 0, fps: 0, has_audio: true },
  ];
  project.tracks = [
    { id: "v1", kind: "video", hidden: false, muted: false, locked: false },
    { id: "a1", kind: "audio", hidden: false, muted: false, locked: false },
  ];
  const clip = (id: string, track: string, start: number, duration: number, type: "video" | "audio", media: string): Clip =>
    type === "video"
      ? { id, track, start, duration, color: "blue", fade_in: 0, fade_out: 0, type, media, source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 }
      : { id, track, start, duration, color: "blue", fade_in: 0, fade_out: 0, type, media, source_in: 0, speed: 1, volume_db: 0 };
  project.clips = [clip("c1", "v1", 0, 300, "video", "m"), clip("c2", "a1", 0, 300, "audio", "m")];
  // Footage and nothing else yet: a subtitled video in the making.
  expect(setsSegments(project)).toBe(true);
  // A sound effect makes it an edit.
  project.clips.push(clip("c3", "a1", 300, 30, "audio", "s"));
  expect(setsSegments(project)).toBe(false);
});

test("a model's answer comes out of its Markdown fences, and a window's text names its lines", () => {
  expect(unfence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  expect(unfence('  ```\n{"a":1}```  ')).toBe('{"a":1}');
  expect(unfence('{"a":1}')).toBe('{"a":1}');
  const text = prompt(
    "Case",
    { lines: [0, 2], start: 245.0, end: 485.5 },
    [
      { start: 246.0, end: 247.25, text: "Hands up.", label: "speaker_0", words: [0, 1] },
      { start: 250.0, end: 251.0, text: "Okay.", label: null, words: [2] },
    ],
    { speaker_0: "Officer" },
  );
  expect(text).toBe(
    "Title: Case\n\nThe clip starts 4:05 into the video and is 240.5 seconds long; line times and segment times are seconds into the clip.\n\nLines (n [start–end] label: text):\n0 [1.0–2.2] speaker_0 (Officer): Hands up.\n1 [5.0–6.0] ?: Okay.",
  );
});

// ---------------------------------------------------------------------------
// A whole watch, against the gateway mock

let mock: MockServer;
let restore: () => void;
beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ AI_GATEWAY_API_KEY: "test-key" });
});
afterAll(() => {
  restore();
  mock.stop();
});

const TRANSCRIPT: Transcript = {
  model: "scribe_v2",
  language: "eng",
  words: [
    { text: "Where", start: 1.0, end: 1.2, speaker: "speaker_0" },
    { text: "were", start: 1.25, end: 1.4, speaker: "speaker_0" },
    { text: "you?", start: 1.45, end: 1.8, speaker: "speaker_0" },
    { text: "At", start: 3.0, end: 3.1, speaker: "speaker_0" },
    { text: "home.", start: 3.15, end: 3.5, speaker: "speaker_0" },
  ],
  speakers: { speaker_0: "Detective (Leader)" },
  roles: { speaker_0: "leader" },
  colors: { speaker_0: "#00e5c7" },
};

async function subtitled(app: App, dir: string): Promise<string> {
  const media: Media = { id: "m", name: "interview", path: `${dir}/interview.mp4`, kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true };
  write(media.path, "");
  write(app.media.paths(media.path).transcript, serialize(TRANSCRIPT));
  const live = app.store.create("Interview", { width: 1920, height: 1080, fps: 30 });
  const project = structuredClone(live.project) as Project;
  project.media = [media];
  project.clips = [
    { id: "f", track: "v1", start: 0, duration: 300, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1, link: "l" },
    { id: "a", track: "a4", start: 0, duration: 300, color: "blue", fade_in: 0, fade_out: 0, type: "audio", media: "m", source_in: 0, speed: 1, volume_db: 0, link: "l" },
  ];
  await app.store.replace(project.id, null, project, "test");
  return project.id;
}

test("watch_footage asks the gateway once per window, corrects the transcript, sets the segments and reads its receipt next time", async () => {
  const { app, dir, store, cleanup } = fixtureHome("watch");
  // An FFmpeg that "cuts" a window (writes a byte to its output).
  const bin = `${dir}/bin`;
  write(`${bin}/ffmpeg`, '#!/bin/sh\nfor a; do out="$a"; done\nprintf x > "$out"\n');
  fs.chmodSync(`${bin}/ffmpeg`, 0o755);
  const before = process.env.EDIT_FFMPEG;
  process.env.EDIT_FFMPEG = `${bin}/ffmpeg`;
  tools.forget();
  try {
    const id = await subtitled(app, dir);
    mock.gatewayAnswer = JSON.stringify({
      people: [
        { id: "A", look: "grey suit", where: "left", on_screen: true, name: "", role: "leader" },
        { id: "B", look: "hoodie", where: "right", on_screen: true, name: "Tyler", role: "suspect" },
      ],
      lines: [
        { n: 0, who: "A", sure: "high", or: null },
        { n: 1, who: "B", sure: "medium", or: "A" },
      ],
      segments: [
        { start: 0, end: 0.5, kind: "captioned", note: "cold open" },
        { start: 0.5, end: 10, kind: "footage", note: "" },
      ],
      background: [],
    });
    // Who is who across the windows: A is the detective, B is Tyler.
    mock.castAnswer = JSON.stringify({
      people: [
        { name: null, title: "Detective", role: "leader", members: [0] },
        { name: "Tyler", title: "Suspect", role: "suspect", members: [1] },
      ],
    });
    const calls = mock.calls("/v1/chat/completions").length;
    const reply = (await dispatch(app, { id: 1, method: "tools/call", params: { name: "watch_footage", arguments: { project_id: id } } }, null)) as {
      result: { content: { text: string }[]; isError: boolean };
    };
    const text = reply.result.content[0]!.text;
    expect(reply.result.isError).toBe(false);
    expect(text.startsWith("watched: {")).toBe(true);
    const report = JSON.parse(text.slice("watched: ".length)) as Record<string, unknown>;
    expect(report).toMatchObject({ windows: 1, cached: 0, failed: [], lines_changed: 1, segments_set: true, examples: [{ time: 3, text: "At home.", from: "Detective (Leader)", to: "speaker_1" }] });
    // The window, then who is who across the windows.
    expect(mock.calls("/v1/chat/completions").length).toBe(calls + 2);
    expect(report.cast).toEqual([
      { name: null, title: "Detective", role: "leader", voices: ["speaker_0"] },
      { name: "Tyler", title: "Suspect", role: "suspect", voices: ["speaker_1"] },
    ]);
    const request = mock.calls("/v1/chat/completions").at(-2)!;
    expect(request.headers.get("authorization")).toBe("Bearer test-key");
    const body = request.json<{ model: string; reasoning: { effort: string }; messages: { content: unknown }[] }>();
    expect([body.model, body.reasoning.effort]).toEqual(["google/gemini-3.8-flash", "low"]);
    // Keys sorted, as serde_json wrote the request.
    expect(request.text().startsWith('{"messages":')).toBe(true);
    // The transcript's second line is someone else now: Tyler, the suspect.
    const corrected = JSON.parse(fs.readFileSync(app.media.paths(`${dir}/interview.mp4`).transcript, "utf8")) as Transcript;
    expect(corrected.words.map((word) => word.speaker)).toEqual(["speaker_0", "speaker_0", "speaker_0", "speaker_1", "speaker_1"]);
    expect(corrected.speakers?.speaker_1).toBe("Tyler (Suspect)");
    expect(corrected.roles?.speaker_1).toBe("suspect");
    // A sliver of captioned under a second (30 frames) goes to its neighbour: all footage, no segments.
    expect(store.get(id)!.project.segments ?? []).toEqual([]);
    // Again: the receipt answers, nothing is paid for.
    const again = (await dispatch(app, { id: 2, method: "tools/call", params: { name: "watch_footage", arguments: { project_id: id } } }, null)) as {
      result: { content: { text: string }[] };
    };
    const second = JSON.parse(again.result.content[0]!.text.slice("watched: ".length)) as Record<string, unknown>;
    expect(second).toMatchObject({ windows: 1, cached: 1, cost: 0, lines_changed: 0, examples: [] });
    expect(mock.calls("/v1/chat/completions").length).toBe(calls + 2);
    expect(fs.existsSync(`${app.store.cacheDir()}/watch-projects/${id}.json`)).toBe(true);
  } finally {
    mock.castAnswer = null;
    if (before === undefined) delete process.env.EDIT_FFMPEG;
    else process.env.EDIT_FFMPEG = before;
    tools.forget();
    cleanup();
  }
});

test("a turn two windows give to two people is watched again, and that answer decides whose it is", async () => {
  // Killer Couple: one detective talks across the edge between two windows;
  // the cast has the earlier window's voice as one detective and the later
  // window's as the other. The second look says the turn is the later one's.
  const { app, dir, cleanup } = fixtureHome("watch-bridge");
  const bin = `${dir}/bin`;
  write(`${bin}/ffmpeg`, '#!/bin/sh\nfor a; do out="$a"; done\nprintf x > "$out"\n');
  fs.chmodSync(`${bin}/ffmpeg`, 0o755);
  const before = process.env.EDIT_FFMPEG;
  process.env.EDIT_FFMPEG = `${bin}/ffmpeg`;
  tools.forget();
  try {
    const media: Media = { id: "m", name: "room", path: `${dir}/room.mp4`, kind: "video", duration: 480, width: 1920, height: 1080, fps: 30, has_audio: true };
    write(media.path, "");
    const words = Array.from({ length: 159 }, (_, n) => ({ text: `w${n}.`, start: 1 + n * 3, end: 1.5 + n * 3, speaker: "speaker_0" }));
    write(app.media.paths(media.path).transcript, serialize({ model: "scribe_v2", language: "eng", words, speakers: { speaker_0: "Detective" }, roles: { speaker_0: "leader" } }));
    const live = app.store.create("Room", { width: 1920, height: 1080, fps: 30 });
    const project = structuredClone(live.project) as Project;
    project.media = [media];
    project.clips = [
      { id: "f", track: "v1", start: 0, duration: 14400, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1, link: "l" },
      { id: "a", track: "a4", start: 0, duration: 14400, color: "blue", fade_in: 0, fade_out: 0, type: "audio", media: "m", source_in: 0, speed: 1, volume_db: 0, link: "l" },
    ];
    await app.store.replace(project.id, null, project, "test");
    mock.gatewayAnswer = JSON.stringify({
      people: [{ id: "A", look: "detective", where: "at the table", on_screen: true, name: "", role: "leader" }],
      lines: Array.from({ length: 200 }, (_, n) => ({ n, who: "A", sure: "high", or: null })),
      segments: [{ start: 0, end: 480, kind: "footage", note: "" }],
      background: [],
    });
    mock.castAnswer = JSON.stringify({
      people: [
        { name: "Jeff", title: "Detective", role: "leader", members: [0] },
        { name: "Mike", title: "Detective", role: "leader", members: [1] },
      ],
    });
    // 1 is Jeff (the earlier window's), 2 is Mike (the later's): Mike says it all.
    mock.bridgeAnswer = JSON.stringify({ lines: Array.from({ length: 200 }, (_, n) => ({ n, who: 2 })) });
    const report = (await seams.watch.watchFootage(app, project.id, { force: true, segments: null })) as Record<string, unknown>;
    expect(report.windows).toBe(2);
    const looks = report.second_looks as { time: number; voice: string; windows_said: string[]; decided: Record<string, number> }[];
    expect(looks.length).toBe(1);
    expect(looks[0]!.windows_said).toEqual(["Jeff (Detective)", "Mike (Detective)"]);
    expect(Object.keys(looks[0]!.decided)).toEqual(["Mike (Detective)"]);
    const edge = looks[0]!.time;
    const corrected = JSON.parse(fs.readFileSync(app.media.paths(media.path).transcript, "utf8")) as Transcript;
    const named = (word: { speaker?: string }) => corrected.speakers?.[word.speaker ?? ""];
    // The turn across the edge is Mike's on both sides; Jeff keeps what's long before it.
    for (const word of corrected.words) {
      if (word.start > edge - 115 && word.start < edge + 115) expect(named(word)).toBe("Mike (Detective)");
      if (word.start < edge - 135) expect(named(word)).toBe("Jeff (Detective)");
    }
    expect(report.cast_failed).toBeUndefined();
  } finally {
    mock.castAnswer = null;
    mock.bridgeAnswer = null;
    if (before === undefined) delete process.env.EDIT_FFMPEG;
    else process.env.EDIT_FFMPEG = before;
    tools.forget();
    cleanup();
  }
});

test("a cast that can't be had is asked twice, said in the report, and leaves no receipt", async () => {
  const { app, dir, cleanup } = fixtureHome("watch-cast-failed");
  const bin = `${dir}/bin`;
  write(`${bin}/ffmpeg`, '#!/bin/sh\nfor a; do out="$a"; done\nprintf x > "$out"\n');
  fs.chmodSync(`${bin}/ffmpeg`, 0o755);
  const before = process.env.EDIT_FFMPEG;
  process.env.EDIT_FFMPEG = `${bin}/ffmpeg`;
  tools.forget();
  try {
    const id = await subtitled(app, dir);
    mock.gatewayAnswer = JSON.stringify({
      people: [
        { id: "A", look: "grey suit", where: "left", on_screen: true, name: "", role: "leader" },
        { id: "B", look: "hoodie", where: "right", on_screen: true, name: "Tyler", role: "suspect" },
      ],
      lines: [
        { n: 0, who: "A", sure: "high", or: null },
        { n: 1, who: "B", sure: "high", or: null },
      ],
      segments: [{ start: 0, end: 10, kind: "footage", note: "" }],
      background: [],
    });
    // The cast call gets the window's answer: not a cast.
    const calls = mock.calls("/v1/chat/completions").length;
    const report = (await seams.watch.watchFootage(app, id, { force: true, segments: null })) as Record<string, unknown>;
    expect(mock.calls("/v1/chat/completions").length).toBe(calls + 3);
    expect(String(report.cast_failed)).toContain("run watch_footage again");
    expect(fs.existsSync(`${app.store.cacheDir()}/watch-projects/${id}.json`)).toBe(false);
  } finally {
    if (before === undefined) delete process.env.EDIT_FFMPEG;
    else process.env.EDIT_FFMPEG = before;
    tools.forget();
    cleanup();
  }
});

test("a gateway that refuses says why, and the window's failure is the watch's error", async () => {
  const { app, dir, cleanup } = fixtureHome("watch-refused");
  const bin = `${dir}/bin`;
  write(`${bin}/ffmpeg`, '#!/bin/sh\nfor a; do out="$a"; done\nprintf x > "$out"\n');
  fs.chmodSync(`${bin}/ffmpeg`, 0o755);
  const before = process.env.EDIT_FFMPEG;
  process.env.EDIT_FFMPEG = `${bin}/ffmpeg`;
  tools.forget();
  mock.on("POST", "/v1/chat/completions", () => Response.json({ error: { message: "no credits" } }, { status: 402 }), 3);
  try {
    const id = await subtitled(app, dir);
    await expect(seams.watch.watchFootage(app, id, { force: true, segments: null })).rejects.toThrow(
      `${dir}/interview.mp4 0:00–0:10: the AI gateway answered 402: no credits`,
    );
  } finally {
    if (before === undefined) delete process.env.EDIT_FFMPEG;
    else process.env.EDIT_FFMPEG = before;
    tools.forget();
    cleanup();
  }
});

test("segments are held to who is heard: talk marked narration is footage, a narrator's monologue in footage is narration", () => {
  const fps = 30;
  const s = (seconds: number) => Math.round(seconds * fps);
  // 0–60 s: the room talks 0–20, the narrator 22–40 (marked footage), the room 42–60 (marked narration).
  const heard = [
    ...Array.from({ length: 30 }, (_, n) => ({ start: s(n * 0.6), end: s(n * 0.6 + 0.4), narrator: false, seen: false })),
    ...Array.from({ length: 40 }, (_, n) => ({ start: s(22 + n * 0.45), end: s(22 + n * 0.45 + 0.35), narrator: true, seen: true })),
    ...Array.from({ length: 25 }, (_, n) => ({ start: s(42 + n * 0.7), end: s(42 + n * 0.7 + 0.5), narrator: false, seen: false })),
  ];
  const given = [
    { start: 0, end: s(41), kind: "footage" as const, note: "" },
    { start: s(41), end: s(60), kind: "narration" as const, note: "narrator over B-roll" },
  ];
  const out = voicedSegments(given, heard, s(60), fps);
  const narration = out.filter((segment) => segment.kind === "narration");
  expect(narration.length).toBe(1);
  // Edge to edge with the room: from the room's last word before to its first after.
  expect(narration[0]!.start).toBeGreaterThanOrEqual(s(17.8));
  expect(narration[0]!.start).toBeLessThanOrEqual(s(22));
  expect(narration[0]!.end).toBeGreaterThanOrEqual(s(39.9));
  expect(narration[0]!.end).toBeLessThanOrEqual(s(42));
  // A short narrator line in the room's talk is left alone (narratorsInFootage decides it).
  const short = voicedSegments(given.slice(0, 1).concat([{ start: s(41), end: s(60), kind: "footage", note: "" }]), [
    ...heard.slice(0, 30),
    ...Array.from({ length: 6 }, (_, n) => ({ start: s(22 + n * 0.4), end: s(22 + n * 0.4 + 0.3), narrator: true, seen: true })),
  ], s(60), fps);
  expect(short.filter((segment) => segment.kind === "narration")).toEqual([]);
  // A narrator's voice the watch saw as someone in the room (diarisation lumped them in): left alone.
  const lumped = heard.map((word) => ({ ...word, seen: false }));
  expect(voicedSegments(given.slice(0, 1), lumped, s(41), fps).filter((segment) => segment.kind === "narration")).toEqual([]);
});

test("without a gateway key of its own, the watcher asks through the relay with the cloud token", async () => {
  const put = mock.useEnv({ AI_GATEWAY_API_KEY: undefined, EDIT_RELAY_TOKEN: "cloud-tok" });
  const { dir, cleanup } = scratch("watch-relay");
  try {
    mock.on("POST", "/v1/cloud/ai/chat", () => Response.json({ choices: [{ message: { content: "hi" } }] }));
    const body = `${dir}/body.json`;
    write(body, '{"model":"m"}');
    expect(await post(body)).toEqual({ choices: [{ message: { content: "hi" } }] });
    const sent = mock.calls("/v1/cloud/ai/chat", "POST");
    expect(sent.length).toBe(1);
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer cloud-tok");
    expect(sent[0]!.text()).toBe('{"model":"m"}');
  } finally {
    cleanup();
    put();
  }
});

test("caption turns go through the normal visual speaker/cast verification and reuse its completed receipt", async () => {
  const { app, dir, cleanup } = fixtureHome("watch-captions");
  write(`${dir}/ffmpeg`, '#!/bin/sh\nfor a; do out="$a"; done\nprintf x > "$out"\n');
  fs.chmodSync(`${dir}/ffmpeg`, 0o755);
  const previous = process.env.EDIT_FFMPEG;
  process.env.EDIT_FFMPEG = `${dir}/ffmpeg`;
  tools.forget();
  try {
    const id = await subtitled(app, dir);
    const transcript: Transcript = { model: "youtube-captions", language: "en", words: TRANSCRIPT.words.map((word, index) => ({ ...word, speaker: index < 3 ? "caption_turn_1" : "caption_turn_2" })) };
    const path = app.media.paths(`${dir}/interview.mp4`).transcript;
    write(path, serialize(transcript));
    mock.gatewayAnswer = JSON.stringify({
      people: [{ id: "A", look: "grey suit", where: "left", on_screen: true, name: "", role: "leader" }, { id: "B", look: "hoodie", where: "right", on_screen: true, name: "Tyler", role: "suspect" }],
      lines: [{ n: 0, who: "A", sure: "high", or: null }, { n: 1, who: "B", sure: "high", or: null }], segments: [], background: [],
    });
    mock.castAnswer = JSON.stringify({ people: [{ name: null, title: "Detective", role: "leader", members: [0] }, { name: "Tyler", title: "Suspect", role: "suspect", members: [1] }] });
    const call = async () => await dispatch(app, { id: 1, method: "tools/call", params: { name: "watch_footage", arguments: { project_id: id } } }, null) as { result: { isError: boolean; content: { text: string }[] } };
    const first = await call();
    expect(first.result.isError).toBe(false);
    const verified = JSON.parse(fs.readFileSync(path, "utf8")) as Transcript;
    expect(verified.model).toBe("youtube-captions");
    expect(verified.words.map(({ text, start, end }) => ({ text, start, end }))).toEqual(transcript.words.map(({ text, start, end }) => ({ text, start, end })));
    const voice = verified.words[3]!.speaker!;
    expect(verified.speakers?.[voice]).toBe("Tyler (Suspect)");
    expect(verified.roles?.[voice]).toBe("suspect");
    const count = mock.calls("/v1/chat/completions").length;
    const second = await call();
    expect(JSON.parse(second.result.content[0]!.text.slice("watched: ".length))).toMatchObject({ cached: 1, cost: 0, failed: [] });
    expect(mock.calls("/v1/chat/completions")).toHaveLength(count);
    expect(mock.calls("/v1/transcribe")).toHaveLength(0);
  } finally {
    mock.castAnswer = null;
    if (previous === undefined) delete process.env.EDIT_FFMPEG; else process.env.EDIT_FFMPEG = previous;
    tools.forget(); cleanup();
  }
});
