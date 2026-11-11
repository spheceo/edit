// A script's chosen stretches, heard in Script mode, handed to Edit: only
// those words go (writer/handoff.ts), and Edit hears the file itself when its
// timeline plays past them (captions_core.transcriptOf, edit_tools).

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import type { Script } from "@edit/types/writer";

import { timing as waits, transcriptOf } from "../src/captions_core.ts";
import { cachedTranscripts } from "../src/edit_tools.ts";
import * as macSpeech from "../src/mac_speech.ts";
import type { Media, Project } from "../src/model.ts";
import { join } from "../src/paths.ts";
import * as tools from "../src/tools.ts";
import { hearsAll, serialize, timing } from "../src/transcribe.ts";
import * as handoff from "../src/writer/handoff.ts";
import { clip } from "./helpers/model.ts";
import { fixtureHome, scratch, write } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

const ffmpeg = Bun.which("ffmpeg");
let mock: MockServer;
let restore: () => void;
beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv();
  timing.instant = true;
  waits.sleep = (ms: number) => Bun.sleep(Math.min(ms, 20));
  tools.forget();
});
afterAll(() => {
  restore();
  mock.stop();
});

test("a file heard whole hears everything; stretches only what stays inside them, touching ones as one", () => {
  expect(hearsAll({}, [[0, 500]])).toBe(true);
  const heard: { heard: [number, number][] } = { heard: [[10, 20], [20.1, 30], [50, 60]] };
  expect(hearsAll(heard, [[12, 28]])).toBe(true);
  // A cut's boundary a little past the stretch is still heard.
  expect(hearsAll(heard, [[9.9, 15]])).toBe(true);
  expect(hearsAll(heard, [[25, 55]])).toBe(false);
  expect(hearsAll(heard, [[61, 70]])).toBe(false);
  expect(hearsAll({ heard: [] }, [[0, 1]])).toBe(false);
});

test("a rough recording gives Edit only its stretches heard exactly, on its own clock, with the names they were heard with", () => {
  const { dir, cleanup } = scratch("heard-handoff");
  try {
    // Apple's words for the second recording of a joined case (it starts 60 s into the script).
    write(join(dir, "transcript", "rec-2", "apple.json"), JSON.stringify({ model: macSpeech.MODEL, words: [{ text: "rough", start: 0, end: 1 }] }));
    const script = {
      words: [
        { id: "a", text: "Before", startMs: 61_000, endMs: 61_500, speaker: "2:speaker_0" },
        { id: "b", text: "Where", startMs: 70_200, endMs: 70_500, speaker: "2:speaker_0" },
        { id: "c", text: "home.", startMs: 71_000, endMs: 71_400, speaker: "2:speaker_1" },
        { id: "d", text: "After", startMs: 90_000, endMs: 90_400, speaker: "2:speaker_1" },
      ],
      speakers: { "2:speaker_0": "Detective", "2:speaker_1": "Suspect", "1:speaker_0": "Officer" },
      exact: [[5_000, 9_000], [69_000, 75_000]],
      exactKeyterms: ["Kimberly"],
    } as unknown as Script;
    const recording: handoff.Shared = { file: null, source: "youtube:JTr4372yI1g", name: "tape", offsetMs: 60_000, lengthMs: 60_000, tag: "2", key: "rec-2" };
    const made = handoff.transcriptOf(dir, script, recording);
    expect(made.words.map((word) => [word.text, word.start, word.speaker])).toEqual([["Where", 10.2, "speaker_0"], ["home.", 11, "speaker_1"]]);
    expect(made.heard).toEqual([[9, 15]]);
    expect(made.keyterms).toEqual(["Kimberly"]);
    expect(made.speakers).toEqual({ speaker_0: "Detective", speaker_1: "Suspect" });
    // Heard whole in Script mode: every word, and no stretches.
    write(join(dir, "transcript", "rec-2", "transcript.json"), serialize({ model: "scribe_v3", words: script.words.map((word) => ({ text: word.text, start: (word.startMs - 60_000) / 1000, end: (word.endMs - 60_000) / 1000 })) }));
    const whole = handoff.transcriptOf(dir, script, recording);
    expect(whole.words.length).toBe(4);
    expect(whole.heard).toBeUndefined();
  } finally {
    cleanup();
  }
});

test.skipIf(ffmpeg === null)("Edit hears a file itself, whole, once its timeline plays past the stretches it was given", async () => {
  const { app, dir, cleanup } = fixtureHome("heard-stretches");
  try {
    const source = `${dir}/tape.wav`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", source]).exitCode).toBe(0);
    const media: Media = { id: "m", name: "tape", path: source, kind: "video", duration: 120, width: 0, height: 0, fps: 0, has_audio: true } as Media;
    write(app.media.paths(source).transcript, serialize({ model: "scribe_v3", words: [{ text: "Where", start: 10.2, end: 10.5 }], heard: [[9, 15]] }));
    const base = structuredClone(app.store.create("Kimberly", { width: 1920, height: 1080, fps: 30 }).project) as Project;
    // 10–14 s of the file: inside what was heard.
    const inside = { ...base, media: [media], clips: [clip({ id: "a", type: "audio", track: "a4", start: 0, duration: 120, media: "m", source_in: 10, speed: 1 })] };
    const first = mock.calls("/v1/transcribe", "POST").length;
    expect((await transcriptOf(app, media, inside)).heard).toEqual([[9, 15]]);
    expect(cachedTranscripts(app, inside, true).has("m")).toBe(true);
    expect(mock.calls("/v1/transcribe", "POST").length).toBe(first);
    // Lengthened to 10–40 s: the tools take it as not heard there, and the subtitles' read hears it whole.
    const past = { ...inside, clips: [clip({ id: "a", type: "audio", track: "a4", start: 0, duration: 900, media: "m", source_in: 10, speed: 1 })] };
    expect(cachedTranscripts(app, past, true).has("m")).toBe(false);
    const heard = await transcriptOf(app, media, past);
    expect(mock.calls("/v1/transcribe", "POST").length).toBe(first + 1);
    expect(heard.heard).toBeUndefined();
    expect(fs.readFileSync(app.media.paths(source).transcript, "utf8")).not.toContain('"heard"');
  } finally {
    cleanup();
  }
});
