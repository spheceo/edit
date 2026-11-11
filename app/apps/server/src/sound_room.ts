// How far each footage sound may play past its own edges in a cut's crossfade,
// where one is asked for (an audio clip's `crossfade`; edit-core's `audio_segments`; JJ, Nov 10: at a cut "the two sounds
// overlapping and blended", not one fading down and the next up). A crossfade
// plays source the edit cut out, so it may only play source with no word in
// it: an audio clip's `room` is that stretch around it, in seconds of its file,
// from the file's words. The store sets it on every save (`enforceSoundRoom`),
// so however a clip was cut, trimmed or moved, by the agent or by hand, its
// room is its file's as it is now. Measured on Nov 11 over 712 cuts in the dev
// edits: at 39% a word starts or ends within 0.1 s of one side, a quarter on
// the cut itself, so a crossfade made blind would bring back a syllable at
// more than a third of them.

import fs from "node:fs";
import type { Clip, Media, Project, Word } from "./model.ts";

/** How far from a clip's edges wordless source is looked for (seconds): as far as a crossfade reaches (edit-core's CROSSFADE_REACH, 1 s). */
const LOOK = 1;
/** A word overlapping an edge by less than this (seconds) isn't one cut into: times rounded either side of a cut. */
const SLACK = 0.01;
/**
 * Each word taken as this much longer at each end (seconds): a recogniser's
 * times run a few tens of milliseconds late on a word's first sound (on
 * Nov 11's dev edits, source with no word by the times was 13 dB louder
 * than the room just before a cut-out word, and a kept start faded that no
 * word was timed in).
 */
const GUARD = 0.05;

/** A file's words, by start: each word's start and end in seconds. */
export interface Words {
  starts: Float64Array;
  ends: Float64Array;
}

export function wordsOf(words: readonly Word[]): Words {
  const sorted = words.filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && typeof word.text === "string" && word.text.trim() !== "").sort((a, b) => a.start - b.start);
  return { starts: Float64Array.from(sorted, (word) => word.start), ends: Float64Array.from(sorted, (word) => word.end) };
}

/** The first index whose start is at or past `time`. */
function firstFrom(starts: Float64Array, time: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid]! < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A clip's room (seconds of its file): the wordless source either side of it, and where its own words start and end. */
export interface Room {
  from: number;
  to: number;
  words_from: number;
  words_to: number;
}

/**
 * The room of a clip playing `[from, to)` of a file `length` long: back from
 * `from` to the end of the last word before it and on from `to` to the start
 * of the first word after it, and in from each edge to its own first and
 * last word (each word GUARD longer), each at most LOOK; a word across an
 * edge leaves none on that side.
 */
export function roomAround(words: Words, from: number, to: number, length: number): Room {
  let before = Math.max(0, from - LOOK);
  let wordsFrom = Math.min(to, from + LOOK);
  let wordsTo = Math.max(from, to - LOOK);
  let after = Math.min(length, to + LOOK);
  // A word's end is past its start, and words don't run long: only those starting in the 30 s before an edge reach it.
  for (let index = firstFrom(words.starts, from - LOOK - 30); index < words.starts.length && words.starts[index]! - GUARD < after; index++) {
    const start = words.starts[index]! - GUARD;
    const end = words.ends[index]! + GUARD;
    // Before the clip (starting before it): the latest end, up to `from`.
    if (start < from - SLACK) before = Math.max(before, Math.min(end, from));
    // In it (or across an edge): the first start and the last end, kept inside it.
    if (end > from + SLACK && start < to - SLACK) {
      wordsFrom = Math.min(wordsFrom, Math.max(start, from));
      wordsTo = Math.max(wordsTo, Math.min(end, to));
    }
    // After it (ending after it): the earliest start, from `to` on.
    if (end > to + SLACK) after = Math.min(after, Math.max(start, to));
  }
  // Rounded to the millisecond towards the words, so a rounding never lets a crossfade reach one.
  const ms = (value: number, up: boolean) => (up ? Math.ceil(value * 1000 - 1e-6) : Math.floor(value * 1000 + 1e-6)) / 1000;
  return {
    from: Math.max(0, Math.min(from, ms(before, true))),
    to: Math.max(to, ms(after, false)),
    words_from: Math.max(from, Math.min(to, ms(wordsFrom, false))),
    words_to: Math.min(to, Math.max(from, ms(wordsTo, true))),
  };
}

/** Footage's sound: a file with sound that isn't from the team's library (music and effects keep their own fades). */
function isFootage(media: Media | undefined): media is Media {
  return media !== undefined && media.has_audio && (media.library === undefined || media.library === null);
}

const sameEdges = (a: Clip, b: Clip): boolean =>
  a.type === "audio" && b.type === "audio" && a.media === b.media && a.source_in === b.source_in && a.duration === b.duration && a.speed === b.speed;

/**
 * Sets every footage sound's `room` in `after` from its file's words
 * (`read`: null when they aren't known on this machine). Without words a
 * room carried over stays while the clip's edges do (a project from another
 * Mac), and goes when they've changed. Returns how many clips changed.
 */
export function enforceSoundRoom(before: Project | null, after: Project, read: (media: Media) => Words | null): number {
  const fps = after.settings.ntsc === true ? (after.settings.fps * 1000) / 1001 : after.settings.fps;
  const media = new Map(after.media.map((one) => [one.id, one]));
  const was = new Map((before?.clips ?? []).map((clip) => [clip.id, clip]));
  const words = new Map<string, Words | null>();
  let changed = 0;
  for (const clip of after.clips) {
    if (clip.type !== "audio") continue;
    const file = media.get(clip.media);
    if (!isFootage(file)) {
      if (clip.room !== undefined) {
        delete clip.room;
        changed++;
      }
      continue;
    }
    if (!words.has(file.id)) words.set(file.id, read(file));
    const known = words.get(file.id) ?? null;
    let room = clip.room;
    if (known !== null) {
      const speed = clip.speed ?? 1;
      const from = clip.source_in ?? 0;
      room = roomAround(known, from, from + (clip.duration / fps) * speed, file.duration);
    } else {
      const old = was.get(clip.id);
      if (old === undefined || !sameEdges(old, clip)) room = undefined;
    }
    if (room?.from === clip.room?.from && room?.to === clip.room?.to && room?.words_from === clip.room?.words_from && room?.words_to === clip.room?.words_to) continue;
    if (room === undefined) delete clip.room;
    else clip.room = room;
    changed++;
  }
  return changed;
}

/** A transcript file's words, read again only when the file changes (by size and time); null without one. */
export function transcriptWords(): (path: string) => Words | null {
  const kept = new Map<string, { stamp: string; words: Words | null }>();
  return (path) => {
    let stamp: string;
    try {
      const stat = fs.statSync(path);
      stamp = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null;
    }
    const cached = kept.get(path);
    if (cached?.stamp === stamp) return cached.words;
    let words: Words | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as { words?: unknown };
      if (Array.isArray(parsed.words)) words = wordsOf(parsed.words as Word[]);
    } catch {
      words = null;
    }
    kept.delete(path);
    kept.set(path, { stamp, words });
    // A few dozen files' words: a long video's are ~20,000 of them, 300 kB here.
    while (kept.size > 48) kept.delete(kept.keys().next().value!);
    return words;
  };
}
