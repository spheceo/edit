// voiceover.ts's tests. Ripples are the addon's (edit_core
// remove_time / speed_span_holding): those run against the real one when it's built.

import { expect, test } from "bun:test";

import type { Clip, Project, Track } from "../src/model.ts";
import { findAddon, useNative, wrap, type Native } from "../src/native/index.ts";
import { clipEnd, clipOf, duration } from "../src/project.ts";
import { footageSound, muteOf, suggestions, timedWords, writeMutes } from "../src/subtitles.ts";
import type { Word } from "../src/transcribe.ts";
import {
  find,
  readings,
  widen,
  garbled,
  isVoiceover,
  pauses,
  removePauses,
  same,
  speedUp,
  tightenPlan,
  voiceoverSound,
  wordsOf,
} from "../src/voiceover.ts";
import { clip, media, stubNative } from "./helpers/model.ts";

const said = (text: string, start: number, end: number): Word => ({ text, start, end });

const track = (id: string, kind: "video" | "audio"): Track => ({ id, kind, hidden: false, muted: false, locked: false });

/** A cut-in: a voice-over on A1 from 1 s into its recording, B-roll over it, and footage after it. */
function cutIn(): Project {
  return {
    version: 1,
    id: "p",
    name: "t",
    style: "bodycam",
    settings: { width: 1920, height: 1080, fps: 30 },
    media: [
      media({ id: "vo", name: "Narration", path: "/tmp/vo.wav", kind: "audio", duration: 60, has_audio: true }),
      media({ id: "m", name: "bodycam", path: "/tmp/b.mp4", kind: "video", duration: 600, has_audio: true }),
    ],
    tracks: [track("v1", "video"), track("v2", "video"), track("a1", "audio")],
    clips: [
      clip({ id: "voice", track: "a1", start: 0, duration: 300, name: "Voice-over", type: "audio", media: "vo", source_in: 1.0 }),
      clip({ id: "broll", track: "v1", start: 0, duration: 300, type: "video", media: "m", source_in: 20.0 }),
      clip({ id: "title", track: "v2", start: 150, duration: 60, type: "text", text: "Callout" }),
      clip({ id: "pic", track: "v1", start: 300, duration: 90, link: "f", type: "video", media: "m", source_in: 40.0 }),
      clip({ id: "snd", track: "a1", start: 300, duration: 90, link: "f", type: "audio", media: "m", source_in: 40.0 }),
    ],
    next_id: 1,
  } as unknown as Project;
}

function words(): Word[] {
  return [
    // Before the clip's source_in: not in the clip.
    said("Earlier", 0.0, 0.5),
    said("On", 1.2, 1.4),
    said("March", 1.45, 1.8),
    // A 1.2 s pause: shortened to 0.35.
    said("police", 3.0, 3.4),
    // 0.6 s: left.
    said("arrived.", 4.0, 4.5),
    // 2 s: shortened.
    said("Then", 6.5, 6.8),
    said("silence", 7.0, 7.5),
  ];
}

const ids = (clips: Clip[]) => clips.map((own) => own.id);
const byId = (project: Project, id: string) => clipOf(project, id)!;

/** The real addon in place for a test (its ripples), else null. */
function realNative(): Native | null {
  const path = findAddon();
  if (path === null) return null;
  const real = wrap(require(path) as Native);
  useNative(real);
  return real;
}

test("the_narrations_mute_keeps_the_words_first_sound", () => {
  const heard = [said("the", 1.0, 1.2), said("blood", 1.3, 1.7), said("was", 1.8, 2.0)];
  const timed = timedWords(heard, 0.0, 10.0);
  const [found] = suggestions(timed, true, 0, 10_000);
  // The footage's: the whole word and a little either side.
  expect(muteOf(found!, timed, false)).toEqual({ from: 1.27, to: 1.725 });
  // The narration's: "bl-" is heard (120 ms at most, 40% of the word).
  expect(muteOf(found!, timed, true)).toEqual({ from: 1.42, to: 1.725 });
});

test("voiceovers_are_heard_for_house_words_beside_the_footage", () => {
  stubNative();
  const project = cutIn();
  expect(ids(voiceoverSound(project, 0, 400))).toEqual(["voice"]);
  expect(ids(footageSound(project, 0, 400))).toEqual(["snd"]);
  // Narration says a house word: its mute lands on the voice-over clip.
  const heard = [said("he", 2.0, 2.2), said("abused", 2.3, 2.9), said("her", 3.0, 3.2)];
  const timed = timedWords(heard, 1.0, 11.0);
  const found = suggestions(timed, true, 1000, 11_000);
  const mutes = found.map((hit) => ({ from: hit.start_ms / 1000, to: hit.end_ms / 1000 }));
  writeMutes(project, new Map([["voice", [1.0, 11.0, mutes]]]));
  const voice = byId(project, "voice");
  if (voice.type !== "audio") throw new Error("no voice-over");
  expect(voice.mutes?.length).toBe(1);
  expect(voice.mutes![0]!.from < 2.3 && voice.mutes![0]!.to > 2.9).toBe(true);
  // A muted track isn't heard, so nothing on it is muted.
  project.tracks.find((own) => own.id === "a1")!.muted = true;
  expect(voiceoverSound(project, 0, 400)).toEqual([]);
});

test("finds_only_long_pauses_between_words", () => {
  const project = cutIn();
  const found = pauses(project, byId(project, "voice"), words(), 0.7, 0.35);
  // March ends 0.8 s into the clip (24 frames); 0.175 s kept after it, and before police (2 s in, frame 60).
  expect(found.map((pause) => [pause.from, pause.to, pause.between[0]])).toEqual([
    [30, 54, "March"],
    [111, 159, "arrived."],
  ]);
  expect(Math.abs(found[0]!.seconds - 1.2)).toBeLessThan(1e-9);
  expect(isVoiceover(project, byId(project, "voice"))).toBe(true);
  expect(isVoiceover(project, byId(project, "snd"))).toBe(false);
});

test.skipIf(findAddon() === null)("tightening_ripples_the_broll_and_everything_after", () => {
  const real = realNative()!;
  let project = cutIn();
  const heard = new Map([["vo", words()]]);
  let [cut, left] = tightenPlan(project, heard, 0, duration(project), 0.7, 0.35);
  expect([cut.length, left.length]).toEqual([2, 0]);
  const removed = removePauses(project, cut);
  expect(removed).toBe(24 + 48);
  expect(real.projectValidate(JSON.stringify(project))).toBeNull();
  expect(byId(project, "pic").start).toBe(300 - removed);
  expect(byId(project, "snd").start).toBe(300 - removed);
  // The voice-over and its B-roll are cut at the same places.
  const pieces = (on: string) =>
    project.clips
      .filter((own) => own.track === on && own.start < 300 - removed)
      .map((own) => [own.start, own.duration])
      .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
  expect(pieces("a1")).toEqual([
    [0, 30],
    [30, 57],
    [87, 141],
  ]);
  expect(pieces("v1")).toEqual(pieces("a1"));
  // A pause with the footage heard over it is left.
  project = cutIn();
  const snd = byId(project, "snd");
  [snd.start, snd.duration, snd.track] = [0, 300, "a2"];
  project.tracks.push(track("a2", "audio"));
  [cut, left] = tightenPlan(project, heard, 0, 300, 0.7, 0.35);
  expect([cut.length, left.length]).toEqual([0, 2]);
});

test.skipIf(findAddon() === null)("speeding_a_voiceover_squeezes_what_is_over_it", () => {
  const real = realNative()!;
  const project = cutIn();
  expect(speedUp(project, 0, 300, 1.2)).toEqual([0, 300, 50]);
  expect(real.projectValidate(JSON.stringify(project))).toBeNull();
  const voice = byId(project, "voice");
  expect(voice.duration).toBe(250);
  expect(voice.type === "audio" && Math.abs(voice.speed - 1.2) < 1e-9).toBe(true);
  expect(byId(project, "broll").duration).toBe(250);
  const title = byId(project, "title");
  expect([title.start, title.duration]).toEqual([125, 50]);
  expect(byId(project, "pic").start).toBe(250);
  // Not the footage, nor too fast.
  expect(() => speedUp(cutIn(), 0, 400, 1.3)).toThrow();
  const overFootage = cutIn();
  byId(overFootage, "snd").start = 200;
  byId(overFootage, "snd").track = "a2";
  overFootage.tracks.push(track("a2", "audio"));
  expect(() => speedUp(overFootage, 0, 300, 1.1)).toThrow();
});

test.skipIf(findAddon() === null)("speeding_a_voiceover_leaves_the_music_and_sound_effects_at_their_speed", () => {
  const real = realNative()!;
  const project = cutIn();
  project.media.push(media({ id: "bed", name: "Nothing Much", path: "/tmp/bed.wav", kind: "audio", duration: 120, has_audio: true }));
  project.tracks.push(track("a2", "audio"), track("a3", "audio"));
  // A bed from the cut-in's start on past it, and a hit inside it.
  project.clips.push(
    clip({ id: "music", track: "a2", start: 0, duration: 390, type: "audio", media: "bed", source_in: 0.0 }),
    clip({ id: "hit", track: "a3", start: 120, duration: 15, type: "audio", media: "bed", source_in: 30.0 }),
  );
  const [, , saved] = speedUp(project, 0, 300, 1.2);
  expect(saved).toBe(50);
  expect(real.projectValidate(JSON.stringify(project))).toBeNull();
  const speed = (id: string) => {
    const own = byId(project, id);
    if (own.type !== "audio") throw new Error("not audio");
    return own.speed;
  };
  // The bed plays on unbroken at its own speed and ends as the timeline does.
  const beds = project.clips.filter((own) => own.type === "audio" && own.media === "bed" && own.track === "a2");
  expect(beds.length).toBe(1);
  expect([beds[0]!.start, clipEnd(beds[0]!)]).toEqual([0, 340]);
  expect(Math.abs(speed("music") - 1)).toBeLessThan(1e-9);
  // The hit moves with the words it was on, at its own speed.
  expect(byId(project, "hit").start).toBe(100);
  expect(Math.abs(speed("hit") - 1)).toBeLessThan(1e-9);
  // The narration itself is sped.
  expect(Math.abs(speed("voice") - 1.2)).toBeLessThan(1e-9);
});

test("finds_the_stretch_that_reads_a_cut_in", () => {
  const recording = wordsOf(
    "This mother had absolutely no idea that her son had played a central role. On July 13, 2024, Kent police officers were dispatched to a chilling report of a devastating crash.",
  );
  const cutInWords = wordsOf("On July 13, 2024, Kent police officers were dispatched to a chilling report");
  const found = find(cutInWords, recording)!;
  expect(recording[found.first]).toBe("on");
  expect(recording[found.last]).toBe("report");
  expect(found.matched).toBe(cutInWords.length);
});

test("tolerates_a_slip_and_a_skipped_word", () => {
  const recording = wordsOf("the officers managed to pull alizar from the wreckage but while the rescue");
  // Written "Alizar" heard "alizar"; "were" said but not written; "wreckage" heard as "wreckege".
  const cutInWords = wordsOf("Fortunately, the officers managed to pull Alizar from the wreckege. But while rescue");
  const found = find(cutInWords, recording)!;
  expect(recording[found.first]).toBe("the");
  expect(recording[found.last]).toBe("rescue");
  expect(found.matched >= cutInWords.length - 2).toBe(true);
});

test("a_take_with_a_few_stray_words_for_its_length_is_garbled", () => {
  const word = (text: string) => ({ text, start: 0, end: 0.1 });
  expect(garbled([word("."), word("latest"), word("卧")], 18.96)).toBe(true);
  expect(garbled(Array.from({ length: 50 }, () => word("said")), 18.96)).toBe(false);
  // A short take may say very little.
  expect(garbled([word("Hello.")], 3)).toBe(false);
});

test("words_compare_loosely_only_when_long", () => {
  expect(same("wreckage", "wreckege")).toBe(true);
  expect(same("officer", "officers")).toBe(true);
  expect(same("on", "in")).toBe(false);
  expect(same("crash", "cash1x")).toBe(false);
});

test("footage tightening cuts a source excerpt's own gaps, word to word, and leaves the voice-over alone", () => {
  const project = cutIn();
  project.script = { source: "writer:w", blocks: [{ kind: "footage", file: "youtube:x", start: 40, end: 43, label: "", clip: "pic" }] } as unknown as Project["script"];
  // The excerpt plays the bodycam from 40 s: "Stop" … 0.9 s … "now".
  const heard = new Map([["m", [said("Stop", 40.1, 40.4), said("now", 41.3, 41.6)]]]);
  const [cut] = tightenPlan(project, heard, 0, 400, 0.4, 0.15, true);
  expect(cut.map((pause) => [pause.clip, pause.between])).toEqual([["snd", ["Stop", "now"]]]);
  expect(tightenPlan(project, heard, 0, 400, 0.4, 0.15, false)[0]).toEqual([]);
});

test("a block's first word said a little differently stays in its voice-over", () => {
  const written = ["hes", "streamed", "with", "kanye", "west"];
  const heard = ["the", "planet", "he", "streamed", "with", "kanye", "west", "collaborated"];
  const aligned = find(written, heard)!;
  expect(aligned.first).toBe(3);
  expect(widen(written, heard, aligned)).toMatchObject({ first: 2, last: 6 });
});

test("a cut-in the narrator said his own way gets the recording between its neighbours' readings", () => {
  const said = "this guy appears to be an entire mystery and we will not get answers soon pacman master stands still in a grey filter while creepy noises play in the back and then he promotes music in his posts rony is not ai but something far more disturbing";
  let at = 0;
  const words = said.split(" ").map((text) => ({ text, start: (at += 0.4) - 0.4, end: at - 0.05 }));
  const blocks = [
    { kind: "narration" as const, text: "This guy appears to be an entire mystery, and we will not get answers soon.", clip: "a" },
    { kind: "footage" as const, url: "", file: "x", start: 0, end: 1, label: "" },
    // Written as a draft; read quite differently.
    { kind: "narration" as const, text: "Case 3: Pacman Master. His content mainly features him standing motionless with a greyscale filter.", clip: "b" },
    { kind: "narration" as const, text: "Rony is not AI, but something far more disturbing.", clip: "c" },
  ];
  const [matches, byOrder] = readings(blocks, [["vo", words]]);
  expect([...byOrder]).toEqual([2]);
  const [, , gap] = matches.get(2)!;
  expect(words[gap.first]!.text).toBe("pacman");
  expect(words[gap.last]!.text).toBe("posts");
  // Two unread in a row share the stretch by their length, cut at the longest pause near it.
  // A breath after "back" (word 29), near where the lengths put the cut.
  const paused = words.map((word, n) => (n >= 30 ? { ...word, start: word.start + 1, end: word.end + 1 } : word));
  const twice = [blocks[0]!, { ...blocks[2]!, clip: "b1", text: "Case three is a strange stillness piece, eerie and quiet." }, { ...blocks[2]!, clip: "b2", text: "Which also helps other artists get heard, oddly." }, blocks[3]!];
  const [split, ordered] = readings(twice, [["vo", paused]]);
  expect([...ordered]).toEqual([1, 2]);
  expect(paused[split.get(1)![2].last]!.text).toBe("back");
  expect(paused[split.get(2)![2].first]!.text).toBe("and");
  expect(paused[split.get(2)![2].last]!.text).toBe("posts");
  // What the narrator says after the script's last line is the last cut-in's.
  const extra = [...words, ...["and", "one", "more", "case", "to", "end"].map((text, n) => ({ text, start: 100 + n, end: 100.5 + n }))];
  const [ended, endedBy] = readings(blocks, [["vo", extra]]);
  expect(endedBy.has(3)).toBe(true);
  expect(ended.get(3)![2].last).toBe(extra.length - 1);
});

test("a line whose opening the narrator reworded keeps its opening: the reading reaches back over his words to a pause", () => {
  // The horror recording, Nov 5: "If you haven't been living under a rock" for the script's "If you're not living under a rock".
  const timed: [string, number, number][] = [["If", 0.16, 0.26], ["you", 0.34, 0.42], ["haven't", 0.48, 0.7], ["been", 0.72, 0.84], ["living", 0.88, 1.08], ["under", 1.14, 1.34], ["a", 1.4, 1.44], ["rock,", 1.52, 1.9],
    ["you", 2.12, 2.2], ["already", 2.26, 2.54], ["know", 2.6, 2.8], ["that", 2.85, 3.0], ["Instagram", 3.05, 3.5], ["reels", 3.55, 3.8], ["are", 3.85, 3.95], ["weird.", 4.0, 4.4],
    ["But", 5.6, 5.7], ["it", 5.75, 5.8], ["gets", 5.85, 6.0], ["even", 6.05, 6.2], ["worse,", 6.25, 6.6], ["let", 6.8, 6.9], ["me", 6.95, 7.0], ["explain", 7.05, 7.4]];
  const words = timed.map(([text, start, end]) => ({ text, start, end }));
  const blocks = [
    { kind: "narration" as const, text: "If you're not living under a rock, you should know by now that Instagram Reels are weird.", clip: "a" },
    { kind: "narration" as const, text: "But it gets even worse, let me explain.", clip: "b" },
  ];
  const [matches] = readings(blocks, [["vo", words]]);
  expect(matches.get(0)![2].first).toBe(0);
  // The next line's reading stays its own.
  expect(matches.get(1)![2].first).toBe(16);
  expect(matches.get(0)![2].last).toBeLessThan(16);
});

test("a line the narrator carried on past its last written word, without a pause, keeps the rest of his sentence", () => {
  const timed: [string, number, number][] = [["the", 521.03, 521.11], ["backstory", 521.15, 521.57], ["behind", 521.61, 521.93], ["it", 521.97, 522.07], ["goes", 522.13, 522.37], ["far", 522.43, 522.61], ["deeper", 522.65, 522.91],
    ["than", 522.93, 523.05], ["you", 523.09, 523.17], ["might", 523.21, 523.35], ["expect.", 523.41, 523.93], ["In", 524.21, 524.31], ["1966,", 524.33, 525.39], ["while", 525.5, 525.7], ["imprisoned", 525.75, 526.3]];
  const words = timed.map(([text, start, end]) => ({ text, start, end }));
  const blocks = [
    { kind: "narration" as const, text: "However, the backstory behind it is far deeper:", clip: "a" },
    { kind: "narration" as const, text: "In 1966, while imprisoned", clip: "b" },
  ];
  const [matches] = readings(blocks, [["vo", words]]);
  expect(matches.get(0)![2].last).toBe(10);
  expect(matches.get(1)![2].first).toBe(11);
});

test("the narrator's words cut off a voice-over are flagged for extend_clip; words another clip plays are not", async () => {
  const { narrationCutOff } = await import("../src/edit_review.ts");
  const timed: [string, number, number][] = [["If", 0.16, 0.26], ["you", 0.34, 0.42], ["haven't", 0.48, 0.7], ["been", 0.72, 0.84], ["living", 0.88, 1.08], ["under", 1.14, 1.34], ["a", 1.4, 1.44], ["rock,", 1.52, 1.9],
    ["you", 2.12, 2.2], ["know.", 2.26, 2.54], ["than", 2.6, 2.7], ["you", 2.75, 2.8], ["expect.", 2.85, 3.2], ["Next", 4.5, 4.7], ["line", 4.75, 5.0]];
  const words = timed.map(([text, start, end]) => ({ text, start, end }));
  const p = { settings: { width: 1920, height: 1080, fps: 30 }, media: [{ id: "vo", name: "vo.wav", path: "/vo.wav", kind: "audio", duration: 10, width: 0, height: 0, fps: 0, has_audio: true }],
    tracks: [{ id: "a1", kind: "audio", hidden: false, muted: false, locked: false }],
    clips: [clip({ id: "line", type: "audio", media: "vo", track: "a1", start: 100, duration: 51, source_in: 0.86, name: "Voice-over" }),
      clip({ id: "next", type: "audio", media: "vo", track: "a1", start: 300, duration: 18, source_in: 4.45, name: "Voice-over" })], script: null } as never;
  const found = narrationCutOff(p, new Map([["vo", { words } as never]])) as { clip: string; side: string; words: string }[];
  expect(found).toEqual([
    expect.objectContaining({ clip: "line", side: "in", words: "If you haven't been" }),
    expect.objectContaining({ clip: "line", side: "out", words: "than you expect." }),
  ]);
});

test("a phrase lost between two voice-overs is flagged once, for the line it runs into", async () => {
  const { narrationCutOff } = await import("../src/edit_review.ts");
  const timed: [string, number, number][] = [["one", 0.1, 0.4], ["line.", 0.45, 0.9], ["He", 1.2, 1.3], ["makes", 1.35, 1.6], ["noises", 1.65, 2.0], ["while", 2.05, 2.3], ["filming", 2.35, 2.8]];
  const words = timed.map(([text, start, end]) => ({ text, start, end }));
  const p = { settings: { width: 1920, height: 1080, fps: 30 }, media: [{ id: "vo", name: "vo.wav", path: "/vo.wav", kind: "audio", duration: 10, width: 0, height: 0, fps: 0, has_audio: true }],
    tracks: [{ id: "a1", kind: "audio", hidden: false, muted: false, locked: false }],
    clips: [clip({ id: "a", type: "audio", media: "vo", track: "a1", start: 0, duration: 28, source_in: 0.05, name: "Voice-over" }),
      clip({ id: "b", type: "audio", media: "vo", track: "a1", start: 100, duration: 25, source_in: 2.0, name: "Voice-over" })], script: null } as never;
  const found = narrationCutOff(p, new Map([["vo", { words } as never]])) as { clip: string; side: string; words: string }[];
  expect(found).toEqual([expect.objectContaining({ clip: "b", side: "in", words: "He makes noises" })]);
});
