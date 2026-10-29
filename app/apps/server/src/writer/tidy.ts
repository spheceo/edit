// Repack's mechanical clean-up of a cut (apps/web/src/domain/script.ts and
// script-plan.ts in Repack): breathing room at clip edges, the clip-edge
// review and its safe fixes, Courtroom's relaxed joins, and silence
// tightening read from word timings and the sound itself.

import * as fs from "node:fs";

import type { Clip, Part, Word } from "@edit/types/writer";

import { writeAtomic } from "../files.ts";
import { join } from "../paths.ts";
import { isCutIn } from "./blocks.ts";

/** Breathing room kept before a clip's first word and after its last. */
export const LEAD_MS = 150;
export const TAIL_MS = 400;
/** Breathing room never comes closer than this to a neighbouring word. */
const CLEAR_MS = 60;
/** Peaks are sampled every 20 ms of source audio. */
export const PEAK_MS = 20;
/** The beat a tightened pause keeps, and the hesitation before an answer. */
export const PAUSE_BEAT_MS = 1_000;
export const ANSWER_BEAT_MS = 2_000;
/** Courtroom, later on: pauses shorter than this stay, and a block's clips less than RELAXED_JOIN_MS apart play as one range. */
export const RELAXED_PAUSE_MS = 5_000;
const RELAXED_JOIN_MS = 10_000;
/** A FOIA video never runs shorter than this. */
export const FOIA_FLOOR_MS = 10 * 60_000;

const mid = (word: Word): number => Math.floor((word.startMs + word.endMs) / 2);
const less = (a: number, b: number): number => Math.max(0, a - b);

/** A word-anchored range with breathing room: up to `lead` before the first word and `tail` after the last, short of the words either side. */
export function breatheWith(words: Word[], startMs: number, endMs: number, durationMs: number, lead: number, tail: number): [number, number] {
  let next = words.findIndex((word) => word.startMs >= endMs);
  if (next < 0) next = words.length;
  const prev = words.slice(0, next).findLast((word) => word.endMs <= startMs);
  const floor = prev === undefined ? 0 : prev.endMs + CLEAR_MS;
  const ceiling = next < words.length ? less(words[next]!.startMs, CLEAR_MS) : Math.max(durationMs, endMs);
  return [Math.min(startMs, Math.max(less(startMs, lead), floor)), Math.max(endMs, Math.min(endMs + tail, ceiling))];
}

export const breathe = (words: Word[], startMs: number, endMs: number, durationMs: number): [number, number] =>
  breatheWith(words, startMs, endMs, durationMs, LEAD_MS, TAIL_MS);

const CLOSERS = /["”’')\]]+$/u;

function finished(text: string): boolean {
  return /[.?!…]$/u.test(text.replace(CLOSERS, ""));
}

/** A word bare of the punctuation after it, lowercased, for the filler lists. */
function core(text: string): string {
  return text.replace(/[,.!?…]+$/u, "").toLowerCase();
}

/** "um", "ummm", "uh", "uhm", "hmm", "mm", "mhm" and their kin. */
function noise(word: string, mm: boolean, mhm: boolean): boolean {
  return /^u(m+|h+)$/.test(word) || word === "uhm" || /^hm+$/.test(word) || (mm && /^m{2,}$/.test(word)) || (mhm && word === "mhm");
}

const TRAILING = new Set(["yeah", "yes", "yep", "okay", "ok", "right", "so", "and", "but", "well", "like", "alright", "anyway", "or", "now"]);
const HANGING = new Set(["so", "and", "but", "well", "like", "or", "now"]);
const HESITANT = new Set(["so", "and", "but", "well", "like", "okay", "ok", "yeah", "or", "now"]);

/** Words that trail a finished thought, or lead into the next one. */
const trailing = (text: string): boolean => noise(core(text), true, true) || TRAILING.has(core(text));
/** Hesitations that leave a line hanging wherever they fall. */
const hanging = (text: string): boolean => noise(core(text), false, false) || HANGING.has(core(text));
const hesitant = (text: string): boolean => noise(core(text), true, false) || HESITANT.has(core(text));

/** A clip edge that probably doesn't land where the thought does, with the word to move it to and how many words that cuts or (`adds`) brings in. */
export interface Issue {
  id: string;
  end: boolean;
  issue: string;
  fix: Fix | null;
}

export interface Fix {
  word: number;
  dropped: number;
  adds: boolean;
}

/**
 * Repack's boundaryIssues: trailing past a finished thought into fillers
 * ("no. Yeah, so"), stopping mid-sentence, ending on the other speaker's brief
 * reaction, starting on a filler, or starting mid-sentence.
 */
export function boundaryIssues(clips: Clip[], words: Word[], corrections: Record<string, string> = {}): Issue[] {
  const text = (i: number): string => corrections[words[i]!.id] ?? words[i]!.text;
  const span = (a: number, b: number): string => {
    const from = Math.max(a, 0);
    const to = Math.min(Math.max(b, 0), words.length);
    const out: string[] = [];
    for (let i = from; i < Math.max(to, from); i++) out.push(text(i));
    return out.join(" ");
  };
  const issues: Issue[] = [];
  for (const clip of clips) {
    if (isCutIn(clip)) continue;
    const inside: number[] = [];
    let started = false;
    for (const [i, word] of words.entries()) {
      if (!started && mid(word) < clip.startMs) continue;
      started = true;
      if (word.startMs >= clip.endMs) break;
      if (mid(word) >= clip.startMs && mid(word) < clip.endMs) inside.push(i);
    }
    const a = inside[0];
    const b = inside.at(-1);
    if (a === undefined || b === undefined) continue;
    const lastFinished = (from: number): number | null => {
      for (let i = from; i >= Math.max(from - 12, a); i--) if (finished(text(i))) return i;
      return null;
    };
    const fix = (i: number, dropped: number): Fix | null => (i >= a ? { word: i, dropped, adds: false } : null);
    // End: trailing fillers after a finished thought, or fillers left hanging.
    let k = 0;
    while (b >= a + k && trailing(text(b - k)) && k < 4) k++;
    const speaker = words[b]!.speaker;
    const reply =
      speaker != null &&
      b > a &&
      speaker !== words[b - 1]!.speaker &&
      !text(b - 1).replace(/["”’')]+$/u, "").endsWith("?") &&
      inside.filter((i) => words[i]!.speaker === speaker && i + 4 > b).length <= 3;
    if (k > 0 && b >= a + k && finished(text(b - k))) {
      issues.push({ id: clip.id, end: true, issue: `runs on past the end of the thought into "${span(b - k + 1, b + 1)}"`, fix: fix(b - k, k) });
    } else if (hanging(text(b))) {
      let n = 1;
      while (b >= a + n && hanging(text(b - n)) && n < 4) n++;
      const at = b >= a + n ? lastFinished(b - n) : null;
      issues.push({ id: clip.id, end: true, issue: `ends on a filler, "${span(b - n + 1, b + 1)}"`, fix: at === null ? null : fix(at, b - at) });
    } else if (reply) {
      let r = b;
      while (r > a && words[r - 1]!.speaker === speaker) r--;
      issues.push({ id: clip.id, end: true, issue: "ends on the other speaker's brief reaction", fix: fix(r - 1, b - r + 1) });
    } else if (!finished(text(b)) && words[b + 1] !== undefined && less(words[b + 1]!.startMs, words[b]!.endMs) < 600) {
      // Finishing the sentence beats cutting it back, when it ends within a few words.
      let ahead = b + 1;
      while (ahead < words.length && ahead - b <= 8 && words[ahead]!.speaker === speaker && !finished(text(ahead))) ahead++;
      const finishes = ahead < words.length && ahead - b <= 8 && words[ahead]!.speaker === speaker;
      const back = lastFinished(b);
      issues.push({
        id: clip.id,
        end: true,
        issue: "stops mid-sentence",
        fix: finishes ? { word: ahead, dropped: ahead - b, adds: true } : back === null ? null : fix(back, b - back),
      });
    }
    // Start: mid-sentence, straight on from the same speaker's unfinished words.
    if (a > 0) {
      const before = words[a - 1]!;
      if (!finished(text(a - 1)) && before.speaker === words[a]!.speaker && less(words[a]!.startMs, before.endMs) < 1_500) {
        let from = a - 1;
        while (from > Math.max(a - 15, 0) && !finished(text(from - 1))) from--;
        const found = from > 0 && finished(text(from - 1));
        // The sentence's first real word: fillers dropped from its front leave a clean start.
        let opens = from;
        while (opens < a && hesitant(text(opens))) opens++;
        if (found && opens >= a) continue;
        issues.push({
          id: clip.id,
          end: false,
          issue: `starts mid-sentence, cutting off "${span(Math.max(opens, a - 8), a)}"`,
          fix: found ? { word: opens, dropped: a - opens, adds: true } : null,
        });
        continue;
      }
    }
    // Start: a filler or connector opening the clip.
    let h = 0;
    while (a + h <= b && hesitant(text(a + h)) && h < 4) h++;
    if (h > 0 && a + h <= b) issues.push({ id: clip.id, end: false, issue: `starts on a filler, "${span(a, a + h)}"`, fix: { word: a + h, dropped: h, adds: false } });
  }
  return issues;
}

/**
 * Repack's polishClips: every safe edge fix (at most 4 words cut, or 8
 * brought in to finish a thought) and breathing room around every clip's
 * words. The clips, and how many edges it fixed.
 */
export function polish(clips: Clip[], words: Word[], corrections: Record<string, string>, durationMs: number): [Clip[], number] {
  const MAX_DROP = 4;
  const fixes = boundaryIssues(clips, words, corrections).filter((issue) => issue.fix !== null && issue.fix.dropped <= (issue.fix.adds ? MAX_DROP * 2 : MAX_DROP));
  const polished = clips.map((clip): Clip => {
    if (isCutIn(clip)) return clip;
    let startMs = clip.startMs;
    let endMs = clip.endMs;
    for (const issue of fixes) {
      if (issue.id !== clip.id) continue;
      const word = words[issue.fix!.word];
      if (word === undefined) continue;
      if (issue.end) endMs = word.endMs;
      else startMs = word.startMs;
    }
    // Fixes at both ends of a short clip can cross: then it keeps its edges.
    if (endMs < startMs + 200) [startMs, endMs] = [clip.startMs, clip.endMs];
    const first = words.find((word) => mid(word) >= startMs);
    const last = words.findLast((word) => mid(word) < endMs);
    if (first === undefined || last === undefined || last.endMs <= first.startMs) return { ...clip, startMs, endMs };
    const room = breathe(words, first.startMs, last.endMs, durationMs);
    // As far as an edge may go without touching a neighbouring word.
    const reach = breatheWith(words, first.startMs, last.endMs, durationMs, Infinity, Infinity);
    // An edge cutting into a neighbour comes back to the breathing room; otherwise it keeps whichever gives the words more room.
    return {
      ...clip,
      startMs: startMs < reach[0] ? room[0] : Math.min(startMs, room[0]),
      endMs: endMs > reach[1] ? room[1] : Math.max(endMs, room[1]),
    };
  });
  return [polished, fixes.length];
}

/** Which recording a moment is in; 0 for one recording. */
export function partAt(parts: Part[], ms: number): number {
  const at = parts.findIndex((part) => ms < part.startMs + part.durationMs);
  return at < 0 ? Math.max(parts.length - 1, 0) : at;
}

/** Where a moment of footage first plays in the cut, on the edited clock. */
function sourcePosition(clips: Clip[], sourceMs: number): number | null {
  let cursor = 0;
  for (const clip of clips) {
    if (!isCutIn(clip) && sourceMs >= clip.startMs && sourceMs < clip.endMs) return cursor + sourceMs - clip.startMs;
    cursor += clip.endMs - clip.startMs;
  }
  return null;
}

/** Where Courtroom's relaxed pacing begins: a compilation's second transition, a single case's halfway point. */
function relaxedFrom(clips: Clip[], compilation: boolean): number {
  if (compilation) {
    let at = 0;
    let transitions = 0;
    let footage = false;
    for (const clip of clips) {
      if (isCutIn(clip)) {
        if (!footage && ++transitions === 2) return at;
        footage = false;
      } else footage = true;
      at += clip.endMs - clip.startMs;
    }
  }
  return Math.floor(clips.reduce((sum, clip) => sum + clip.endMs - clip.startMs, 0) / 2);
}

/** Where the pacing is relaxed, two clips of a block from one recording less than 10 s apart play as one range; never across a narrator. */
export function joinLate(clips: Clip[], words: Word[], speakers: Record<string, string>, parts: Part[], compilation: boolean): Clip[] {
  const from = relaxedFrom(clips, compilation);
  const narrated = (a: number, b: number) =>
    words.some((word) => word.startMs < b && word.endMs > a && word.speaker != null && (speakers[word.speaker] ?? "").toLowerCase().startsWith("narrator"));
  const joined: Clip[] = [];
  for (const clip of clips) {
    const last = joined.at(-1);
    if (
      last !== undefined &&
      !isCutIn(last) &&
      !isCutIn(clip) &&
      clip.startMs > last.endMs &&
      clip.startMs - last.endMs < RELAXED_JOIN_MS &&
      partAt(parts, last.startMs) === partAt(parts, clip.startMs) &&
      (sourcePosition(clips, last.startMs) ?? 0) >= from &&
      !narrated(last.endMs, clip.startMs)
    ) {
      last.endMs = clip.endMs;
      continue;
    }
    joined.push({ ...clip });
  }
  return joined;
}

/** A stretch with no speech: where a cut would take it from, how long the wait was, and how much of it is as loud as speech (0 to 1). */
export interface Silence {
  startMs: number;
  endMs: number;
  gapMs: number;
  sound: number;
}

/**
 * Repack's silences: every gap of `minMs` or more between words, less the
 * beat it keeps (the longer `answerKeepMs` after a question), rated by how
 * much of what a cut removes is as loud as the recording's typical speech.
 */
export function silences(words: Word[], peaks: ArrayLike<number>, durationMs: number, minMs: number, keepMs: number, answerKeepMs: number): Silence[] {
  const index = (ms: number) => Math.floor(ms / PEAK_MS);
  const speech: number[] = [];
  for (const word of words) {
    const end = Math.min(Math.ceil(word.endMs / PEAK_MS), peaks.length);
    for (let i = index(word.startMs); i < end; i++) speech.push(peaks[i]!);
  }
  speech.sort((a, b) => a - b);
  const typical = speech[Math.floor(speech.length / 2)] ?? 0;
  const found: Silence[] = [];
  const add = (from: number, to: number, previous: Word | null) => {
    const gapMs = less(to, from);
    if (gapMs < minMs) return;
    const question = previous !== null && previous.text.replace(/["”']+$/u, "").endsWith("?");
    const answer = question && gapMs < 60_000;
    const keep = answer ? answerKeepMs : keepMs;
    const startMs = from > 0 ? from + Math.floor(keep / 2) : 0;
    const endMs = to < durationMs ? less(to, Math.floor(keep / 2)) : durationMs;
    if (endMs < startMs + 100) return;
    const a = Math.min(index(startMs), peaks.length);
    const b = Math.max(Math.min(Math.ceil(endMs / PEAK_MS), peaks.length), a);
    let loud = 0;
    if (typical > 0) for (let i = a; i < b; i++) if (peaks[i]! >= typical) loud++;
    found.push({ startMs, endMs, gapMs, sound: b === a ? 0 : loud / (b - a) });
  };
  let spoken = 0;
  let previous: Word | null = null;
  for (const word of words) {
    add(spoken, word.startMs, previous);
    if (word.endMs >= spoken) previous = word;
    spoken = Math.max(spoken, word.endMs);
  }
  add(spoken, durationMs, previous);
  return found;
}

/** Stretches of over a second inside a range far quieter than its own speech, read from the sound alone; each keeps 150 ms at both ends. */
export function quietRuns(peaks: ArrayLike<number>, startMs: number, endMs: number): [number, number][] {
  const MIN_MS = 1_000;
  const KEEP_MS = 150;
  const from = Math.ceil(startMs / PEAK_MS);
  const to = Math.min(Math.floor(endMs / PEAK_MS), peaks.length);
  if (to <= from || (to - from) * PEAK_MS < MIN_MS) return [];
  const levels = Array.from({ length: to - from }, (_, i) => peaks[from + i]!);
  const sorted = [...levels].sort((a, b) => a - b);
  const quiet = sorted[Math.floor(sorted.length * 0.9)]! * 0.2;
  const runs: [number, number][] = [];
  let run: number | null = null;
  for (let i = 0; i <= levels.length; i++) {
    const still = i < levels.length && levels[i]! <= quiet;
    if (still && run === null) run = i;
    else if (!still && run !== null) {
      if ((i - run) * PEAK_MS >= MIN_MS) runs.push([(from + run) * PEAK_MS + KEEP_MS, (from + i) * PEAK_MS - KEEP_MS]);
      run = null;
    }
  }
  return runs;
}

/** Whether any footage clip still includes some of a source interval. */
const kept = (clips: Clip[], startMs: number, endMs: number): boolean => clips.some((clip) => !isCutIn(clip) && startMs < clip.endMs && endMs > clip.startMs);

const newId = (): string => crypto.randomUUID();

/** Removes a source interval from every footage clip, keeping what sits outside it. */
export function removeRange(clips: Clip[], startMs: number, endMs: number): Clip[] {
  if (endMs <= startMs) return clips;
  return clips.flatMap((clip): Clip[] => {
    if (isCutIn(clip) || clip.endMs <= startMs || clip.startMs >= endMs) return [clip];
    const pieces: Clip[] = [];
    if (clip.startMs < startMs) pieces.push({ ...clip, endMs: startMs });
    // A second piece is a new timestamp: the comments stay on the first.
    if (clip.endMs > endMs) pieces.push(pieces.length === 0 ? { ...clip, startMs: endMs } : { ...clip, id: newId(), startMs: endMs, notes: [] });
    return pieces;
  });
}

/** The longest spill of a clip into the next recording that is left out. */
const SPILL_MS = 1_000;

/**
 * Splits a footage clip running across two recordings, so each clip is cut
 * from one. A piece under 100 ms is left out, and so is a spill under a second
 * beside a longer piece (it showed as "[0:00–0:00]").
 */
export function fitToParts(clips: Clip[], parts: Part[]): Clip[] {
  if (parts.length < 2) return clips;
  return clips.flatMap((clip): Clip[] => {
    if (isCutIn(clip)) return [clip];
    let pieces: Clip[] = [];
    for (const part of parts) {
      const startMs = Math.max(clip.startMs, part.startMs);
      const endMs = Math.min(clip.endMs, part.startMs + part.durationMs);
      if (endMs < startMs + 100) continue;
      pieces.push(pieces.length === 0 ? { ...clip, startMs, endMs } : { ...clip, id: newId(), startMs, endMs, notes: [] });
    }
    if (pieces.length > 1) {
      const longest = Math.max(...pieces.map((piece) => piece.endMs - piece.startMs));
      const { id, notes } = pieces[0]!;
      pieces = pieces.filter((piece) => piece.endMs - piece.startMs >= SPILL_MS || piece.endMs - piece.startMs === longest);
      if (pieces[0] !== undefined) pieces[0] = { ...pieces[0], id, notes };
    }
    return pieces;
  });
}

/** The shortest beat, from `beatMs` up, whose tightened cut still runs the floor; null when even an untightened cut falls short. */
export function beatForFloor(runtimeAt: (beat: number) => number, beatMs: number, floorMs: number, untightenedMs: number): number | null {
  if (runtimeAt(beatMs) >= floorMs) return beatMs;
  if (runtimeAt(untightenedMs) < floorMs) return null;
  let low = beatMs;
  let high = untightenedMs;
  while (high - low > 100) {
    const middle = Math.floor((low + high) / 2);
    if (runtimeAt(middle) >= floorMs) high = middle;
    else low = middle;
  }
  return high;
}

/** How a cut was tightened: the clips, and how many quiet pauses and stalls inside intro clips it cut. */
export interface Tightened {
  clips: Clip[];
  pauses: number;
  stalls: number;
}

/** What tightening needs to know of the script. */
export interface Footage {
  words: Word[];
  peaks: ArrayLike<number>;
  parts: Part[];
  durationMs: number;
  compilation: boolean;
  /** Courtroom: the second half (or second case on) is let breathe. */
  relaxed: boolean;
}

/**
 * Repack's silence tightening at one beat: quiet gaps in the kept footage cut
 * to the beat (two before an answer), relaxed Courtroom pauses under 5 s kept,
 * gaps with sound under them kept, then pauses over a second inside intro
 * clips cut from the sound. `intro` says which footage blocks are intro.
 */
export function tighten(footage: Footage, clips: Clip[], beatMs: number, intro: (block: number) => boolean): Tightened {
  const gaps = silences(footage.words, footage.peaks, footage.durationMs, 2_000, beatMs, Math.max(ANSWER_BEAT_MS, beatMs));
  const relaxedAt = relaxedFrom(clips, footage.compilation);
  const quiet = gaps.filter(
    (gap) =>
      gap.sound < 0.1 &&
      kept(clips, gap.startMs, gap.endMs) &&
      !(footage.relaxed && gap.gapMs < RELAXED_PAUSE_MS && (sourcePosition(clips, gap.startMs) ?? -1) >= relaxedAt),
  );
  let cut = fitToParts(clips, footage.parts);
  for (const gap of quiet) cut = removeRange(cut, gap.startMs, gap.endMs);
  // Intro clips are quick proof: a pause over a second inside one stalls the opening, so it is read from the sound.
  let block = 0;
  let stalls = 0;
  const out: Clip[] = [];
  for (const clip of cut) {
    if (isCutIn(clip)) {
      block++;
      out.push(clip);
      continue;
    }
    const runs = intro(block) ? quietRuns(footage.peaks, clip.startMs, clip.endMs) : [];
    if (runs.length === 0) {
      out.push(clip);
      continue;
    }
    let from = clip.startMs;
    const pieces: Clip[] = [];
    for (const [start, end] of runs) {
      pieces.push({ ...clip, id: newId(), startMs: from, endMs: start, notes: [] });
      from = end;
      stalls++;
    }
    pieces.push({ ...clip, id: newId(), startMs: from, endMs: clip.endMs, notes: [] });
    const playable = pieces.filter((piece) => piece.endMs >= piece.startMs + 100);
    // The timestamp keeps its id and comments on its first piece.
    if (playable[0] !== undefined) playable[0] = { ...playable[0], id: clip.id, notes: clip.notes ?? [] };
    out.push(...playable);
  }
  return { clips: joinSlivers(out, footage.parts), pauses: quiet.length, stalls };
}

/** A piece this short, left by cutting a pause, plays as a blip (a lone "The", then a jump): the pause stays. */
const SLIVER_MS = 1_200;
/** Only across a pause the tightening cut, never between clips the plan chose apart. */
const SLIVER_GAP_MS = 3_000;

export function joinSlivers(clips: Clip[], parts: Part[]): Clip[] {
  const out: Clip[] = [];
  const short = (piece: Clip) => piece.endMs - piece.startMs < SLIVER_MS;
  for (const clip of clips) {
    const last = out.at(-1);
    const beside =
      last !== undefined &&
      !isCutIn(clip) &&
      !isCutIn(last) &&
      clip.startMs >= last.endMs &&
      clip.startMs - last.endMs <= SLIVER_GAP_MS &&
      partAt(parts, clip.startMs) === partAt(parts, last.startMs);
    if (beside && (short(last) || short(clip))) {
      last.endMs = clip.endMs;
      last.notes = [...(last.notes ?? []), ...(clip.notes ?? [])];
      continue;
    }
    out.push({ ...clip });
  }
  return out;
}

/** The footage's 20 ms peaks kept beside the script (`peaks.bin`, u16 little-endian), or null. */
export function readPeaks(dir: string): Float32Array | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(join(dir, "peaks.bin"));
  } catch {
    return null;
  }
  const out = new Float32Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = bytes.readUInt16LE(i * 2) / 65_535;
  return out;
}

export function keepPeaks(dir: string, peaks: ArrayLike<number>): void {
  const bytes = Buffer.alloc(peaks.length * 2);
  for (let i = 0; i < peaks.length; i++) bytes.writeUInt16LE(Math.round(Math.min(Math.max(peaks[i]!, 0), 1) * 65_535), i * 2);
  writeAtomic(join(dir, "peaks.bin"), bytes);
}
