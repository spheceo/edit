// voiceover.rs's tests, same names. Ripples are the addon's (edit_core
// remove_time / speed_span_holding): those run against the real one when it's built.

import { expect, test } from "bun:test";

import type { Clip, Project, Track } from "../src/model.ts";
import { findAddon, useNative, wrap, type Native } from "../src/native/index.ts";
import { clipEnd, clipOf, duration } from "../src/project.ts";
import { suggestions, timedWords, writeMutes, footageSound } from "../src/subtitles.ts";
import type { Word } from "../src/transcribe.ts";
import {
  find,
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

test("words_compare_loosely_only_when_long", () => {
  expect(same("wreckage", "wreckege")).toBe(true);
  expect(same("officer", "officers")).toBe(true);
  expect(same("on", "in")).toBe(false);
  expect(same("crash", "cash1x")).toBe(false);
});
