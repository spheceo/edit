// edit_review.rs's tests, same names.

import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { calloutTiming, subtitleCoverage } from "../src/edit_review.ts";
import type { AudioClip, Clip, Project, TextClip } from "../src/model.ts";
import { addTrack, newProject } from "../src/project.ts";
import type { Transcript } from "../src/transcribe.ts";

const SETTINGS = { width: 1920, height: 1080, fps: 30 };

function sound(id: string, track: string, media: string, start: number, duration: number, extra: Partial<AudioClip> = {}): AudioClip {
  return { id, track, start, duration, color: "blue", fade_in: 0, fade_out: 0, type: "audio", media, source_in: 0, speed: 1, volume_db: 0, ...extra };
}

function words(id: string, track: string, text: string, start: number, duration: number): TextClip {
  return {
    id,
    track,
    start,
    duration,
    color: "blue",
    fade_in: 0,
    fade_out: 0,
    type: "text",
    text,
    style: { font: "Geist", weight: 700, size: 96, color: [1, 1, 1, 1], tracking: 0, line_height: 1.15, glow: { enabled: true, color: null, radius: 46, strength: 0.5 } },
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    animation: { preset: "none", duration: 12, stagger: 1.5 },
    opacity: 1,
  };
}

/** Audits a real project read-only: EDIT_AUDIT_PROJECT=<project.json> EDIT_AUDIT_CACHE=<~/.edit/cache> (the transcripts by media key folder are read as they are). */
test.skipIf(process.env.EDIT_AUDIT_PROJECT === undefined)("audit_a_real_project", () => {
  const project = JSON.parse(fs.readFileSync(process.env.EDIT_AUDIT_PROJECT!, "utf8")) as Project;
  // The censor half is native (edit-engine); this prints the callouts' timing.
  console.log(JSON.stringify(calloutTiming(project, new Map()), null, 2));
});

test("a_callout_after_its_words_were_said_is_flagged", () => {
  const p = newProject("p", "callouts", SETTINGS);
  p.media.push({ id: "vo", name: "voice-over", path: "/vo.mp3", kind: "audio", duration: 30.0, width: 0, height: 0, fps: 0, has_audio: true });
  const said = (list: [string, number][]): Transcript => ({
    model: "test",
    language: null,
    words: list.map(([text, start]) => ({ text, start, end: start + 0.3 })),
    speakers: {},
    roles: {},
    colors: {},
  });
  // "...a floor that looked freshly mopped (4.5 s), all pointed the same way, out the back door."
  let transcripts = new Map([
    [
      "vo",
      said([
        ["floor", 3.3],
        ["freshly", 4.0],
        ["mopped", 4.5],
        ["same", 6.0],
        ["way", 6.3],
        ["back", 7.5],
        ["door.", 7.8],
      ]),
    ],
  ]);
  p.clips.push({ ...sound("voice", "a4", "vo", 0, 600), name: "Voice-over" });
  // Up 1.6 s after "mopped": flagged. A plain caption isn't a quote.
  const late = words("late", "v2", "“Like they mopped or something?”", 185, 78);
  p.clips.push(late);
  p.clips.push(words("label", "v3", "Freshly mopped", 300, 30));
  const issues = calloutTiming(p, transcripts) as { said_at: number }[];
  expect(issues.length).toBe(1);
  expect(issues[0]!.said_at).toBe(140);
  // On the word, it's fine.
  late.start = 130;
  expect(calloutTiming(p, transcripts)).toEqual([]);
  // A quote nobody nearby says (the narration only points to it) is left to judgement.
  late.text = "“I knew her for years”";
  late.start = 400;
  expect(calloutTiming(p, transcripts)).toEqual([]);
  // Said a moment before, but paraphrased under it ("she thought her mother
  // was" under "I think she was pregnant"): where it belongs.
  transcripts = new Map([
    [
      "vo",
      said([
        ["pregnant", 3.7],
        ["until", 4.2],
        ["she", 9.2],
        ["thought", 10.2],
        ["her", 10.4],
        ["mother", 10.5],
        ["was.", 10.8],
      ]),
    ],
  ]);
  late.text = "“I think she\nwas pregnant.”";
  late.start = 210;
  late.duration = 142;
  expect(calloutTiming(p, transcripts)).toEqual([]);
});

test("coverage_reports_missing_speech_and_skips_hidden_roles_and_segments", () => {
  const p = newProject("p", "review", SETTINGS);
  p.media.push({ id: "m", name: "source", path: "/unused", kind: "video", duration: 10.0, width: 1920, height: 1080, fps: 30.0, has_audio: true, markers: [] });
  const a = p.tracks.find((track) => track.kind === "audio")!.id;
  const v = addTrack(p, "video");
  p.tracks.find((track) => track.id === v)!.subtitles = true;
  const clips: Clip[] = [sound("audio", a, "m", 0, 300, { source_in: 2, speed: 0.5 }), words("sub", v, "covered", 0, 60)];
  p.clips = clips;
  const transcript: Transcript = {
    model: "test",
    language: null,
    words: [
      { text: "covered", start: 2.2, end: 2.4 },
      { text: "missing", start: 3.5, end: 3.7 },
      { text: "radio", start: 4.0, end: 4.2, speaker: "radio" },
    ],
    speakers: {},
    roles: { radio: "dispatch" },
    colors: {},
  };
  const transcripts = new Map([["m", transcript]]);
  const review = subtitleCoverage(p, transcripts) as { checked_words: number; uncovered_words: number; examples_seconds: { words: string }[] };
  expect(review.checked_words).toBe(2);
  expect(review.uncovered_words).toBe(1);
  expect(review.examples_seconds[0]!.words).toBe("missing");
  p.segments = [{ start: 60, end: 300, kind: "narration" }];
  expect((subtitleCoverage(p, transcripts) as { uncovered_words: number }).uncovered_words).toBe(0);
});
