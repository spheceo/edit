// One system for both modes (kept_hearing.ts, first_hearing.ts): a long
// file's first words are free, the agent cuts on them, and Scribe hears only
// what's kept, once; a cut that grows hears only its new footage; footage
// kept whole is heard whole; Script mode's words reach Edit with what it heard.

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import * as fs from "node:fs";

import type { Script } from "@edit/types/writer";

import * as realSpeech from "../src/mac_speech.ts";
import { MockServer, scribeAnswer } from "./mocks/server.ts";

// Apple's recogniser, here on any computer when a test says so: "rough words" every 2 s.
// The real ones kept first: the module's own names point at the stand-ins once it's mocked (for every later test file too).
const apple = { on: false, heard: 0 };
const real = { available: realSpeech.available, hear: realSpeech.hear };
void mock.module("../src/mac_speech.ts", () => ({
  ...realSpeech,
  available: async () => apple.on || (await real.available()),
  hear: async (file: string, target: string, signal?: AbortSignal, onProgress?: (said: string) => void) => {
    if (!apple.on) return real.hear(file, target, signal, onProgress);
    apple.heard++;
    const words = Array.from({ length: 300 }, (_, n) => ({ text: n % 2 === 0 ? "rough" : "words", start: n * 2, end: n * 2 + 0.4 }));
    const transcript = { model: realSpeech.MODEL, language: "en", words };
    fs.writeFileSync(target, JSON.stringify(transcript));
    return transcript;
  },
}));

const { timing: waits, transcriptOf } = await import("../src/captions_core.ts");
const kept = await import("../src/kept_hearing.ts");
const transcribe = await import("../src/transcribe.ts");
const tools = await import("../src/tools.ts");
const handoff = await import("../src/writer/handoff.ts");
const log = await import("../src/hearing_log.ts");
const watch = await import("../src/watch.ts");
const transcription = await import("../src/writer/transcription.ts");
const { join } = await import("../src/paths.ts");
const { clip } = await import("./helpers/model.ts");
const { fixtureHome, scratch, write } = await import("./helpers/home.ts");
type Media = import("../src/model.ts").Media;
type Project = import("../src/model.ts").Project;

const ffmpeg = Bun.which("ffmpeg");
let relay: MockServer;
let restore: () => void;
beforeAll(() => {
  relay = MockServer.start();
  restore = relay.useEnv();
  transcribe.timing.instant = true;
  waits.sleep = (ms: number) => Bun.sleep(Math.min(ms, 20));
  tools.forget();
});
afterAll(() => {
  restore();
  relay.stop();
  apple.on = false;
});

test("what's kept is heard padded and joined, less what was heard; stretches that touch are one", () => {
  // Two clips 4 s apart are one stretch; one far off is its own; 3 s either side.
  expect(kept.toHear([[10_000, 20_000], [24_000, 30_000], [100_000, 110_000]], [], 600_000)).toEqual([[7_000, 33_000], [97_000, 113_000]]);
  // Heard before: only the new footage, and nothing for a sliver already in the padding.
  expect(kept.toHear([[10_000, 60_000]], [[7_000, 33_000]], 600_000)).toEqual([[33_000, 63_000]]);
  expect(kept.toHear([[10_000, 31_000]], [[7_000, 33_000]], 600_000)).toEqual([]);
  expect(kept.union([[30, 40], [7, 33], [50, 60]])).toEqual([[7, 40], [50, 60]]);
  expect(transcribe.hearsAll({ heard: [[7, 33], [33, 63]] }, [[10, 60]])).toBe(true);
  // A gap shorter than a hearing's leftover is never heard on its own: taken as heard, not asked for again and again.
  expect(transcribe.hearsAll({ heard: [[97, 203], [204, 260]] }, [[100, 250]])).toBe(true);
  expect(transcribe.hearsAll({ heard: [[97, 203], [210, 260]] }, [[100, 250]])).toBe(false);
  // Apple's words an older build kept without `heard` are rough too.
  expect(kept.asKept({ model: "apple-speech", words: [{ text: "rough", start: 0, end: 1 }] })).toMatchObject({ heard: [], rough: "apple-speech" });
});

test("Scribe's words replace the rough ones over what was heard, a later round's voices its own", () => {
  const rough = { model: realSpeech.MODEL, words: [{ text: "rough", start: 5, end: 5.4 }, { text: "rough", start: 12, end: 12.4 }, { text: "after", start: 50, end: 50.4 }], heard: [] as [number, number][] };
  const first = kept.merged(rough, [[7_000, 33_000]], [[{ text: "Where", start: 12_000, end: 12_300, speaker: "speaker_0" }]], ["Kimberly"], "scribe_v3");
  expect(first.words.map((word) => [word.text, word.speaker])).toEqual([["rough", undefined], ["Where", "speaker_0"], ["after", undefined]]);
  expect([first.heard, first.keyterms, first.model]).toEqual([[[7, 33]], ["Kimberly"], "scribe_v3"]);
  const second = kept.merged(first, [[33_000, 63_000]], [[{ text: "Home.", start: 50_000, end: 50_400, speaker: "speaker_0" }]], ["Kimberly", "Ruetten"], "scribe_v3");
  expect(second.words.map((word) => [word.text, word.speaker])).toEqual([["rough", undefined], ["Where", "speaker_0"], ["Home.", "h2:speaker_0"]]);
  // The names every stretch was heard with.
  expect([second.heard, second.keyterms]).toEqual([[[7, 63]], ["Kimberly"]]);
  // A word the cut runs through is half a word: the rough one there stands (the Mac's check: "there-" beside "there is.").
  const edges = { model: realSpeech.MODEL, words: [{ text: "20,000,", start: 6.6, end: 7.4 }, { text: "there", start: 32.7, end: 33.2 }], heard: [] as [number, number][] };
  const cut = kept.merged(edges, [[7_000, 33_000]], [[
    { text: "thousand,", start: 7_000, end: 7_300, speaker: "speaker_0" },
    { text: "Where", start: 12_000, end: 12_300, speaker: "speaker_0" },
    { text: "there-", start: 32_700, end: 33_000, speaker: "speaker_1" },
  ]], [], "scribe_v3");
  expect(cut.words.map((word) => [word.text, word.speaker])).toEqual([["20,000,", undefined], ["Where", "speaker_0"], ["there", undefined]]);
  // Captions kept before Nov 11 are rough words like any first pass.
  expect(kept.asKept({ model: "youtube-captions", words: [{ text: "hi", start: 0, end: 1, speaker: "caption_turn_3" }] })).toMatchObject({ words: [{ text: "hi", start: 0, end: 1 }], heard: [] });
});

test("Script mode hands Edit its rough words, Scribe's where it heard exactly, voices only there", () => {
  const { dir, cleanup } = scratch("kept-handoff");
  try {
    write(join(dir, "transcript", "rec-2", "apple.json"), JSON.stringify({ model: realSpeech.MODEL, words: [{ text: "rough", start: 0, end: 1 }] }));
    const script = {
      words: [
        { id: "a", text: "Before", startMs: 61_000, endMs: 61_500, speaker: "2:t0001" },
        { id: "b", text: "Where", startMs: 70_200, endMs: 70_500, speaker: "2:speaker_0" },
        { id: "c", text: "home.", startMs: 71_000, endMs: 71_400, speaker: "2:speaker_1" },
      ],
      speakers: { "2:speaker_0": "Detective", "2:speaker_1": "Suspect" },
      exact: [[5_000, 9_000], [69_000, 75_000]],
      exactKeyterms: ["Kimberly"],
    } as unknown as Script;
    const recording = { file: null, source: "youtube:JTr4372yI1g", name: "tape", offsetMs: 60_000, lengthMs: 60_000, tag: "2", key: "rec-2" };
    const made = handoff.transcriptOf(dir, script, recording);
    expect(made.words.map((word) => [word.text, word.start, word.speaker])).toEqual([["Before", 1, undefined], ["Where", 10.2, "speaker_0"], ["home.", 11, "speaker_1"]]);
    expect([made.heard, made.keyterms, made.model]).toEqual([[[9, 15]], ["Kimberly"], "scribe_v3"]);
    // Nothing heard exactly yet: rough words, none heard, no names claimed.
    const none = handoff.transcriptOf(dir, { ...script, exact: [] } as Script, recording);
    expect([none.heard, none.keyterms, none.model]).toEqual([[], undefined, realSpeech.MODEL]);
  } finally {
    cleanup();
  }
});

test("each hearing says plainly which model it was, whether it was paid, and what file", () => {
  expect(log.said("scribe_v3")).toBe("Scribe v3 (scribe_v3, paid)");
  expect(log.said("apple-speech")).toBe("Apple's on-device recogniser (apple-speech, free)");
  expect(log.said("youtube-captions")).toBe("YouTube's captions (youtube-captions, free)");
  expect(log.labelOf("http://127.0.0.1:7745/api/cloud/preview?key=edit%2Fproxies%2Fyoutube%2F3NtaOHvqPq8%2F384384-957495.mp4")).toBe("youtube/3NtaOHvqPq8/384384-957495.mp4");
  expect(log.labelOf("/home/x/cache/ab/kept/joined-0123abcd/joined.wav")).toBe("the kept stretches, joined into one recording");
  expect(log.labelOf("/Users/x/Movies/bodycam.mp4")).toBe("bodycam.mp4");
  expect([log.clock(1298), log.clock(3723), log.took(155_000)]).toEqual(["21:38", "1:02:03", "2 min 35 s"]);
});

test("the watch's corrections find their words again when kept stretches were heard meanwhile", () => {
  const before = [{ text: "rough", start: 1, end: 1.4 }, { text: "Where", start: 12, end: 12.3 }, { text: "after", start: 50, end: 50.4 }];
  expect(watch.wordAt(before, before)(1)).toBe(1);
  // Scribe's words came in over 7–33 s: "Where" is now third, a word that's gone is left alone.
  const now = [{ text: "rough", start: 1, end: 1.4 }, { text: "Oh", start: 11, end: 11.2 }, { text: "Where", start: 12, end: 12.3 }, { text: "after", start: 50, end: 50.4 }];
  const at = watch.wordAt(before, now);
  expect([at(0), at(1), at(2)]).toEqual([0, 2, 3]);
  expect(watch.wordAt(before, now.slice(0, 2))(1)).toBe(-1);
});

test("a transcript says who heard what: Scribe over `heard`, the free model the rest", () => {
  const rough = { model: realSpeech.MODEL, words: [{ text: "rough", start: 50, end: 50.4 }], heard: [] as [number, number][], rough: realSpeech.MODEL };
  const once = kept.merged(rough, [[7_000, 33_000]], [[{ text: "Where", start: 12_000, end: 12_300, speaker: "speaker_0" }]], [], "scribe_v3");
  expect([once.model, once.rough]).toEqual(["scribe_v3", realSpeech.MODEL]);
  // Written and read back, the two stay apart.
  expect(JSON.parse(transcribe.serialize(once))).toMatchObject({ model: "scribe_v3", rough: realSpeech.MODEL, heard: [[7, 33]] });
  // Heard again for the case's names: those stretches take the names they were just heard with.
  const named = kept.merged({ ...once, keyterms: ["Kimberly"] }, [[7_000, 33_000]], [[{ text: "Where", start: 12_000, end: 12_300, speaker: "speaker_0" }]], ["Kimberly", "Ruetten"], "scribe_v3", true);
  expect(named.keyterms).toEqual(["Kimberly", "Ruetten"]);
});

test("Script mode takes what Edit already heard of a recording: all of it as its hearing, or Edit's stretches as heard exactly", async () => {
  const { dir, cleanup } = scratch("from-edit");
  const relayToken = relay.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  try {
    // Edit heard its kept stretches of one video.
    relay.cloud.put("edit/analysis/youtube/AAAAAAAAAAA/transcript.json", JSON.stringify({ model: "scribe_v3", rough: realSpeech.MODEL, words: [{ text: "rough", start: 1, end: 1.4 }, { text: "Where", start: 12, end: 12.3, speaker: "speaker_0" }], heard: [[7, 33]], keyterms: ["Kimberly"] }));
    const partial = await transcription.fromEdit("youtube:AAAAAAAAAAA", join(dir, "a"));
    expect(partial?.heard).toEqual([[7, 33]]);
    expect(transcription.roughOnly(join(dir, "a"))).toBe(true);
    const script = { exact: [[100_000, 110_000]], exactKeyterms: ["Kimberly", "Ruetten"] } as unknown as Script;
    transcription.withEditStretches(script, partial!, 60_000);
    expect([script.exact, script.exactKeyterms]).toEqual([[[67_000, 93_000], [100_000, 110_000]], ["Kimberly"]]);
    // Edit heard all of another: it's that recording's hearing here, nothing rough.
    relay.cloud.put("edit/analysis/youtube/BBBBBBBBBBB/transcript.json", JSON.stringify({ model: "scribe_v3", words: [{ text: "Heard", start: 0, end: 0.4, speaker: "speaker_0" }] }));
    const whole = await transcription.fromEdit("youtube:BBBBBBBBBBB", join(dir, "b"));
    expect(whole?.heard).toBeUndefined();
    expect(fs.existsSync(join(dir, "b", "transcript.json"))).toBe(true);
    // Only YouTube's captions there: Script mode reads its own first words.
    relay.cloud.put("edit/analysis/youtube/CCCCCCCCCCC/transcript.json", JSON.stringify({ model: "youtube-captions", words: [{ text: "caption", start: 0, end: 0.4 }] }));
    expect(await transcription.fromEdit("youtube:CCCCCCCCCCC", join(dir, "c"))).toBeNull();
  } finally {
    relayToken();
    cleanup();
  }
});

/** A 10-minute recording and its media. */
function tape(dir: string, name: string): Media {
  const path = `${dir}/${name}.m4a`;
  expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=600", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "16k", path]).exitCode).toBe(0);
  return { id: name, name, path, kind: "video", duration: 600, width: 0, height: 0, fps: 0, has_audio: true } as Media;
}

async function settled(app: { media: { status(path: string): { transcript: string } } }, path: string): Promise<string> {
  for (let tries = 0; tries < 500 && app.media.status(path).transcript === "working"; tries++) await Bun.sleep(10);
  return app.media.status(path).transcript;
}

test.skipIf(ffmpeg === null)("a long import is given free words, Scribe hears only what the cut keeps, and a cut that grows hears only its new footage", async () => {
  const { app, dir, cleanup } = fixtureHome("kept-edit");
  apple.on = true;
  // Naming the voices heard is Claude's; here it answers at once and names no one.
  (app.agents as { ask: unknown }).ask = async () => JSON.stringify({ speakers: [] });
  try {
    const media = tape(dir, "tape");
    const paid = () => relay.calls("/v1/transcribe", "POST").length;
    const before = paid();
    // The import: free words only (names or not), nothing paid.
    app.media.transcribe(media.path, true, [], false, true);
    expect(await settled(app, media.path)).toBe("ready");
    const rough = JSON.parse(fs.readFileSync(app.media.paths(media.path).transcript, "utf8"));
    expect([rough.model, rough.heard, rough.words.length, paid() - before]).toEqual([realSpeech.MODEL, [], 300, 0]);
    // The agent keeps 100–130 s: Scribe hears that stretch with 3 s either side, once.
    const base = structuredClone(app.store.create("Kimberly", { width: 1920, height: 1080, fps: 30 }).project) as Project;
    const cut = (from: number, seconds: number): Project => ({ ...base, media: [media], clips: [clip({ id: "a", type: "audio", track: "a4", start: 0, duration: seconds * 30, media: media.id, source_in: from, speed: 1 })] });
    relay.on("POST", "/v1/transcribe", () => Response.json(scribeAnswer(["(cut)", "Where", "were", "you?"])), 1);
    const heard = await transcriptOf(app, media, cut(100, 30));
    expect(paid() - before).toBe(1);
    expect(heard.heard).toEqual([[97, 133]]);
    expect(heard.words.filter((word) => word.start >= 97 && word.start < 133).map((word) => [word.text, word.speaker])).toEqual([["Where", "speaker_0"], ["were", "speaker_0"], ["you?", "speaker_0"]]);
    // Rough words elsewhere stay, for the agent to cut on.
    expect(heard.words.some((word) => word.text === "rough" && word.start > 200)).toBe(true);
    // Asked again for the same cut: nothing paid.
    await transcriptOf(app, media, cut(100, 30));
    expect(paid() - before).toBe(1);
    // The cut grows to 100–160 s: only 133–163 s is heard, its voices its own.
    relay.on("POST", "/v1/transcribe", () => Response.json(scribeAnswer(["(cut)", "Home."])), 1);
    const grown = await transcriptOf(app, media, cut(100, 60));
    expect(paid() - before).toBe(2);
    expect(grown.heard).toEqual([[97, 163]]);
    expect(grown.words.find((word) => word.text === "Home.")).toMatchObject({ start: 133.5, speaker: "h2:speaker_0" });
    expect(grown.words.filter((word) => word.text === "Where").length).toBe(1);
    // The case's names came after: what was heard (and what's kept) is heard once more with them, nothing else.
    relay.on("POST", "/v1/transcribe", () => Response.json(scribeAnswer(["(cut)", "Ruetten."])), 1);
    expect(await app.media.refine(media.path, [[100, 160]], ["John Ruetten", "Ruetten"], true)).toBe(true);
    expect(paid() - before).toBe(3);
    const named = JSON.parse(fs.readFileSync(app.media.paths(media.path).transcript, "utf8"));
    expect([named.heard, named.keyterms, named.rough]).toEqual([[[97, 163]], ["John Ruetten", "Ruetten"], realSpeech.MODEL]);
  } finally {
    apple.on = false;
    cleanup();
  }
});

test.skipIf(ffmpeg === null)("footage kept whole (a subtitled video) is heard whole, one request", async () => {
  const { app, dir, cleanup } = fixtureHome("kept-whole");
  apple.on = true;
  // Naming the voices heard is Claude's; here it answers at once and names no one.
  (app.agents as { ask: unknown }).ask = async () => JSON.stringify({ speakers: [] });
  try {
    const media = tape(dir, "whole");
    app.media.transcribe(media.path, true, [], false, true);
    expect(await settled(app, media.path)).toBe("ready");
    const base = structuredClone(app.store.create("Sub video", { width: 1920, height: 1080, fps: 30 }).project) as Project;
    const all = { ...base, media: [media], clips: [clip({ id: "a", type: "audio", track: "a4", start: 0, duration: 600 * 30, media: media.id, source_in: 0, speed: 1 })] };
    const before = relay.calls("/v1/transcribe", "POST").length;
    const heard = await transcriptOf(app, media, all);
    expect(relay.calls("/v1/transcribe", "POST").length - before).toBe(1);
    expect(heard.heard).toBeUndefined();
    expect(heard.words.some((word) => word.text === "rough")).toBe(false);
  } finally {
    apple.on = false;
    cleanup();
  }
});

test.skipIf(ffmpeg === null)("Edit's own watch in the background never pays for Scribe on footage not cut yet", async () => {
  const { app, dir, cleanup } = fixtureHome("kept-watch");
  apple.on = true;
  // Naming the voices heard is Claude's; here it answers at once and names no one.
  (app.agents as { ask: unknown }).ask = async () => JSON.stringify({ speakers: [] });
  try {
    const media = tape(dir, "raw");
    app.media.transcribe(media.path, true, [], false, true);
    expect(await settled(app, media.path)).toBe("ready");
    const base = structuredClone(app.store.create("Raw", { width: 1920, height: 1080, fps: 30 }).project) as Project;
    const all = { ...base, media: [media], clips: [clip({ id: "a", type: "audio", track: "a4", start: 0, duration: 600 * 30, media: media.id, source_in: 0, speed: 1 })] };
    const before = relay.calls("/v1/transcribe", "POST").length;
    const read = await transcriptOf(app, media, all, false);
    expect(read.heard).toEqual([]);
    expect(relay.calls("/v1/transcribe", "POST").length).toBe(before);
  } finally {
    apple.on = false;
    cleanup();
  }
});
