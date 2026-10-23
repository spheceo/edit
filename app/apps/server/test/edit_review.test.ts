// edit_review.ts's tests.

import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { calloutTiming, cutMidWord, lineFrames, offScript, spokenWords, subtitleCoverage, textLate, textNotSaid, unsubtitledSpeech } from "../src/edit_review.ts";
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

const bodycam = (words: [string, number, number][]): Transcript => ({
  model: "test",
  language: null,
  words: words.map(([text, start, end]) => ({ text, start, end, speaker: "speaker_0" })),
  speakers: {},
  roles: {},
  colors: {},
});

function footageProject(): Project {
  const p = newProject("p", "footage", SETTINGS);
  p.media.push({ id: "m7", name: "bodycam", path: "/b.mp4", kind: "video", duration: 600.0, width: 1920, height: 1080, fps: 30, has_audio: true });
  const v1 = p.tracks.find((track) => track.kind === "video")!.id;
  const a1 = p.tracks.find((track) => track.kind === "audio")!.id;
  // 272.2–277.2 s of the file, as Mom & Teen's first teaser played it.
  p.clips.push({
    id: "c24", track: v1, start: 0, duration: 150, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m7",
    source_in: 272.2, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1,
  } as Clip);
  p.clips.push(sound("c25", a1, "m7", 0, 150, { source_in: 272.2 }));
  return p;
}

const TEASER = bodycam([
  ["Start", 272.38, 272.5], ["us", 272.54, 272.6], ["a", 272.64, 272.66], ["medic", 272.7, 272.88], ["right", 272.92, 273.02],
  ["now", 273.06, 273.12], ["in", 273.14, 273.18], ["the", 273.2, 273.24], ["backyard.", 273.26, 273.62],
  ["Come", 274.0, 274.2], ["on,", 274.25, 274.4], ["baby.", 274.45, 274.8],
  ["Yeah,", 277.2, 277.28], ["there", 277.34, 277.44], ["it", 277.46, 277.52], ["is.", 277.56, 277.74], ["Goddamn", 277.82, 278.2], ["it.", 278.24, 278.36],
]);

test("footage_that_stops_short_of_its_script_range_is_flagged", () => {
  const p = footageProject();
  p.script = {
    source: "doc",
    blocks: [{ kind: "footage", url: "u", file: "f", start: 272, end: 278, label: "4:32-4:38", notes: ["start...it"], media: "m7", words: ["start", "it"], clip: "c24" }],
  } as Project["script"];
  const [issue] = offScript(p, new Map([["m7", TEASER]])) as Record<string, unknown>[];
  expect(issue).toMatchObject({ kind: "off_script", range: "4:32-4:38", clip: "c24" });
  expect(issue!.seconds_not_played).toBeGreaterThan(0.5);
  // Played whole, nothing to say.
  (p.clips[0] as { duration: number }).duration = 190;
  expect(offScript(p, new Map([["m7", TEASER]]))).toEqual([]);
});

test("a_caption_that_isnt_what_is_said_is_flagged", () => {
  const p = footageProject();
  const v2 = addTrack(p, "video");
  // "Come on, baby." said 1.8–2.6 s into the clip.
  p.clips.push({ ...words("wrong", v2, "Come on. Come out here.", 54, 24), name: "Caption · Officer" });
  p.clips.push({ ...words("right", v2, "Start us a medic right now in the backyard.", 5, 40), name: "Caption · Officer" });
  const issues = textNotSaid(p, new Map([["m7", TEASER]])) as Record<string, unknown>[];
  expect(issues.map((issue) => issue.clip)).toEqual(["wrong"]);
});

test("a line said over another's is what that one stacked beside it says, not words missing from it", () => {
  // Predator Doctor's "No. Absolutely not." under the detective's line: here "Come on, baby." over the medic call's end.
  const p = footageProject();
  const v2 = addTrack(p, "video");
  const v3 = addTrack(p, "video");
  p.clips.push({ ...words("short", v2, "Come on, baby.", 20, 64), name: "Subtitle · Victim" });
  expect((textNotSaid(p, new Map([["m7", TEASER]])) as Record<string, unknown>[]).map((issue) => issue.clip)).toEqual(["short"]);
  p.clips.push({ ...words("stacked", v3, "Start us a medic right now in the backyard.", 5, 40), name: "Subtitle · Officer" });
  expect(textNotSaid(p, new Map([["m7", TEASER]]))).toEqual([]);
});

test("a stacked subtitle (overlap) on its own track covers the speech under it", () => {
  const p = footageProject();
  const stacked = addTrack(p, "video");
  const end = Math.max(...p.clips.map((clip) => clip.start + clip.duration));
  p.clips.push({ ...words("all", stacked, "everything", 0, end), name: "Subtitle · Officer" });
  expect(unsubtitledSpeech(p, new Map([["m7", TEASER]]))).toEqual([]);
});

test("a caption over silent footage (B-roll under a narration) is flagged as unheard", () => {
  const p = footageProject();
  const v2 = addTrack(p, "video");
  const end = Math.max(...p.clips.map((clip) => clip.start + clip.duration));
  p.clips.push({ ...words("over", v2, "Start us a medic right now.", end + 30, 40), name: "Caption · Officer" });
  const issues = textNotSaid(p, new Map([["m7", TEASER]])) as Record<string, unknown>[];
  expect(issues.map((issue) => [issue.kind, issue.clip])).toEqual([["subtitle_unheard", "over"]]);
});

test("footage cut inside a word is flagged, with where the word ends; a cut the next clip carries on isn't", () => {
  // Corrupt Cop's "Unintentionally, sir." cut before "sir" finished: here "baby." (274.45–274.8) is cut at 274.6.
  const p = footageProject();
  const sound25 = p.clips.find((clip) => clip.id === "c25") as AudioClip;
  sound25.duration = 72;
  const issues = cutMidWord(p, new Map([["m7", TEASER]])) as Record<string, unknown>[];
  expect(issues).toEqual([{ kind: "cut_mid_word", clip: "c25", at: 72, side: "out", word: "baby.", word_ends: 274.8, fix: expect.stringContaining("extend_clip") }]);
  // The same moment carried on by the next clip: no cut heard.
  p.clips.push(sound("c26", sound25.track, "m7", 72, 30, { source_in: 274.6 }));
  expect(cutMidWord(p, new Map([["m7", TEASER]]))).toEqual([]);
  // A word the transcriber squeezed to 40 ms is still heard for ~0.2 s: Corrupt Cop's "sir." (286.62–286.66) cut at 286.69.
  const squeezed = bodycam([["Unintentionally,", 285.84, 286.56], ["sir.", 286.62, 286.66]]);
  const short = footageProject();
  Object.assign(short.clips.find((clip) => clip.id === "c25")!, { source_in: 285.0, duration: 51 });
  expect(cutMidWord(short, new Map([["m7", squeezed]]))).toEqual([{ kind: "cut_mid_word", clip: "c25", at: 51, side: "out", word: "sir.", word_ends: 286.82, fix: expect.stringContaining("extend_clip") }]);
  // Played past the word: nothing to say.
  p.clips.pop();
  sound25.duration = 80;
  expect(cutMidWord(p, new Map([["m7", TEASER]]))).toEqual([]);
});

test("a desktop profile's lines are timed to the narration that says them, and flagged when they're off it", () => {
  const p = footageProject();
  const heard = spokenWords(p, new Map([["m7", TEASER]]));
  // "medic" at 272.79 s is frame 18; "baby" at 274.62 s is frame 73; "goddamn" never comes before frame 60 in order.
  expect(lineFrames(["- MEDIC IN THE BACKYARD", "- BABY", "- NOT SAID HERE"], heard, 0, 150)).toEqual([18, 73, null]);
  // "sept" is heard as the start of "september" ("fired" is too short a stem to tie it).
  expect(lineFrames(["- FIRED SEPT. 9"], [[40, "fir"], [44, "september"]], 0, 150)).toEqual([44]);
  p.markers = [{ frame: 120, name: "desktop line", note: "- MEDIC IN THE BACKYARD" }];
  expect(calloutTiming(p, new Map([["m7", TEASER]]))).toEqual([{ kind: "profile_line_off_speech", start: 120, said_at: 18, text: "- MEDIC IN THE BACKYARD" }]);
  p.markers = [{ frame: 20, name: "desktop line", note: "- MEDIC IN THE BACKYARD" }];
  expect(calloutTiming(p, new Map([["m7", TEASER]]))).toEqual([]);
});

test("speech heard with no subtitle or caption on screen is unsubtitled_speech, the intro's too; a caption over it covers it", () => {
  const p = footageProject();
  const found = unsubtitledSpeech(p, new Map([["m7", TEASER]])) as Record<string, unknown>[];
  expect(found.length).toBeGreaterThan(0);
  expect(found[0]).toMatchObject({ kind: "unsubtitled_speech" });
  const v2 = addTrack(p, "video");
  const end = Math.max(...p.clips.map((clip) => clip.start + clip.duration));
  p.clips.push({ ...words("all", v2, "everything", 0, end), name: "Caption · Officer" });
  expect(unsubtitledSpeech(p, new Map([["m7", TEASER]]))).toEqual([]);
});

test("words on screen after they're said are late, with where they should start; before them is right", () => {
  // "medic" is heard at frame 18 (272.79 s); a label naming it at frame 40 comes too late.
  const p = footageProject();
  const v2 = addTrack(p, "video");
  const label = (id: string, start: number, text: string, name = "Label"): TextClip =>
    ({ id, track: v2, start, duration: 45, color: "red", fade_in: 0, fade_out: 0, keyframes: {}, type: "text", name, text, style: {}, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, animation: { preset: "none", duration: 0, stagger: 0 }, opacity: 1 }) as unknown as TextClip;
  p.clips.push(label("t1", 40, "MEDIC CALLED"), label("t2", 0, "BACKYARD"), label("t3", 40, "medic", "Subtitle · Officer"));
  const issues = textLate(p, new Map([["m7", TEASER]])) as Record<string, unknown>[];
  expect(issues).toEqual([{ kind: "text_late", clip: "t1", start: 40, said_at: 18, start_by: 0, text: "MEDIC CALLED" }]);
  // A desktop line typed after its words too.
  p.clips = p.clips.filter((clip) => clip.type !== "text");
  p.markers = [{ frame: 60, name: "desktop line", note: "- Baby in the backyard" }];
  expect((textLate(p, new Map([["m7", TEASER]])) as Record<string, unknown>[]).map((issue) => issue.kind)).toEqual(["text_late"]);
});
