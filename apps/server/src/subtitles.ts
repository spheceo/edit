// Subtitled videos the way Repack makes them: every line said in the
// footage, in the speaker's colour (Montserrat 48 on a 75% black box, soft
// shadow, glow in the text's colour, bottom middle), held a second after its
// last word unless the next starts first, one at a time; and the house
// words muted in the sound (cosine ramps) and starred out on screen.
//
// The rules are Repack's (apps/web/src/domain/subtitles.ts: `subtitleCues`,
// `muteSuggestions`, `shownCues`), ported number for number. Not ported:
// people shown side by side when they talk over each other, subtitle
// ranges, positions under faces, and review of each mute (all are muted).
//
// Geometry that lands in the project (box sizes, places) is f32 as it was in
// Rust (`f32` after every step), so the saved numbers come out the same.

import type { App } from "./app.ts";
import { hex, transcriptOf } from "./captions_core.ts";
import * as diag from "./diag.ts";
import type { Clip, Mute, Project, Rgba, Segment, TextStyle, Transform } from "./model.ts";
import {
  addTrack,
  clipEnd,
  fps as fpsOf,
  freshId,
  mediaOf,
  subtitledSpans,
  subtitlesTrack,
  trackOf,
} from "./project.ts";
import { byteLength, charCount, chars, f32, get, isAlphabetic, isAlphanumeric, isWhitespace, lines as linesOf, round, splitWhitespace, toI64, trim } from "./rust.ts";
import * as seats from "./seats.ts";
import type {
  ClipMutes,
  Cue,
  Found,
  HouseWords,
  Line,
  SubtitleOptions,
  Suggestion,
  TimedWord,
} from "./seams.ts";
import * as seams from "./seams.ts";
import * as speakers from "./speakers.ts";
import { compareKeys } from "./stable.ts";
import { isSubtitled, SUBTITLE_NAME } from "./store.ts";
import type { Transcript, Word } from "./transcribe.ts";

export type { ClipMutes, Cue, Found, HouseWords, Line, SubtitleOptions, Suggestion, TimedWord } from "./seams.ts";
export { isSubtitled };

/**
 * The editors' word lists. Muted and starred out: "word = s**t" sets how
 * one is starred, otherwise its first letter stays ("f***").
 */
export const HOUSE_TERMS = [
  "fuck = f***",
  "fucking = f******",
  "bitch = b****",
  "bitches = b*****",
  "nigga = n****",
  "nigger",
  "ass = a**",
  "shit = s**t",
  "motherfucker = motherf*****",
  "motherfucking = motherf******",
  "cock",
  "choke",
  "dick",
  "neglect",
  "weed",
  "stab",
  "sex",
  "sexual",
  "grooming",
  "predator",
  "porn",
  "pornography",
  "strangulation",
  "suicide",
  "suicidal",
  "rape",
  "rapist",
  "overdose",
  "abuse",
  "crack",
  "cocaine",
  "fentanyl",
  "meth",
  "methamphetamine",
  "heroin",
  "nude",
  "nudity",
  "masturbate",
] as const;
/** Words whose sound is muted but which stay readable in the subtitles. */
export const HOUSE_MUTE_ONLY = ["kill", "shot", "shoot", "drug", "drugs", "dead", "marijuana"] as const;
/** Muted and starred out too, only in a heavy neglect case. */
export const NEGLECT_TERMS = [
  "endangerment",
  "kick",
  "hit",
  "punch",
  "beat",
  "kill",
  "blood",
  "lash",
  "whoop",
  "butt",
  "slap",
  "strangle",
] as const;
/**
 * The listed words that are verbs: their other forms count as them too
 * ("punched", "hitting", "abusive", "fucker"; see `isFormOf`). Every
 * listed word also counts in the plural ("hits", "bitches").
 */
const VERBS = [
  "abuse",
  "beat",
  "choke",
  "drug",
  "fuck",
  "hit",
  "kick",
  "kill",
  "lash",
  "masturbate",
  "neglect",
  "overdose",
  "punch",
  "rape",
  "shoot",
  "slap",
  "stab",
  "strangle",
  "whoop",
];

/**
 * Whether `token` is `term` or a form of it: its plural, and for a verb its
 * past, participles and doers ("punch" → punched, punching, punchin',
 * puncher; "hit" → hitting; "choke" → choked, choking; "beat" → beaten;
 * "abuse" → abusive).
 */
export function isFormOf(token: string, term: string): boolean {
  if (token === term) return true;
  if (!token.startsWith(term)) return isVerbForm(token, term);
  const rest = token.slice(term.length);
  return rest === "s" || rest === "es" || isVerbForm(token, term);
}

function isVerbForm(token: string, term: string): boolean {
  if (!VERBS.includes(term)) return false;
  const letters = chars(term);
  const vowel = (c: string | undefined) => c !== undefined && "aeiou".includes(c);
  // hit → hitt-ing, slap → slapp-ed: a short vowel between two consonants.
  let doubled = false;
  if (letters.length >= 3) {
    const [a, b, c] = letters.slice(-3) as [string, string, string];
    doubled = !vowel(a) && vowel(b) && !vowel(c) && !"wxy".includes(c);
  }
  const base = term.endsWith("e") ? term.slice(0, -1) : term;
  const stems = [base, ...(doubled ? [`${term}${letters[letters.length - 1]}`] : [])];
  return stems.some(
    (stem) => token.startsWith(stem) && ["ed", "ing", "in", "er", "ers", "en", "ive"].includes(token.slice(stem.length)),
  );
}

/** A muted word is silenced from a little before it starts (ms). */
const MUTE_LEAD_MS = 30.0;
/** And a little after it ends (Repack's default padding, ms). */
const MUTE_PADDING_MS = 25.0;
/**
 * A word timed as an instant was said over someone else, earlier than its
 * time: its mute reaches back to the speaker's word before, at most this far.
 */
const COLLAPSED_REACH_MS = 1500.0;
/** How long a subtitle may stay after its last word, unless the next one starts first. */
export const DEFAULT_HOLD_MS = 1000.0;
/** Names the subtitle clips (as add_subtitles does), so either replaces the other. */
const NAME = SUBTITLE_NAME;

function collapsed(word: TimedWord): boolean {
  return word.end_ms - word.start_ms < 40.0;
}

/**
 * Repack's `subtitleCues`: a new subtitle on a change of speaker, a pause
 * over 750 ms, past 3.5 s, or past 52 characters; and after a sentence ends.
 */
export function segment(words: TimedWord[]): Cue[] {
  const cues: Cue[] = [];
  let from = 0;
  let to = 0;
  const flush = () => {
    if (to > from) {
      const part = words.slice(from, to);
      const first = part[0]!;
      cues.push({
        words: [from, to],
        start_ms: round(first.start_ms),
        end_ms: round(part.reduce((end, word) => Math.max(end, word.end_ms), -Number.MAX_VALUE)),
        text: part.map((word) => word.text).join(" "),
        speaker: first.speaker,
      });
    }
    from = to;
  };
  words.forEach((word, index) => {
    if (to > from) {
      const first = words[from]!;
      const last = words[to - 1]!;
      let joined = charCount(word.text);
      for (let at = from; at < to; at++) joined += charCount(words[at]!.text) + 1;
      if (
        word.speaker !== first.speaker ||
        // The same pause that still joins a muted phrase, so one
        // never spans two subtitles.
        word.start_ms - last.end_ms > 750.0 ||
        word.end_ms - first.start_ms > 3500.0 ||
        joined > 52
      ) {
        flush();
      }
    }
    if (to === from) {
      from = index;
      to = index;
    }
    to = index + 1;
    const end = chars(word.text).pop();
    if (end === "." || end === "!" || end === "?") flush();
  });
  flush();
  return cues;
}

/** Repack's tokeniser: /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu on lowercase text. */
export function tokens(text: string): string[] {
  const all = chars(text.toLowerCase());
  const out: string[] = [];
  let at = 0;
  while (at < all.length) {
    if (!isAlphanumeric(all[at])) {
      at += 1;
      continue;
    }
    const start = at;
    while (isAlphanumeric(all[at])) at += 1;
    if ((all[at] === "'" || all[at] === "’") && isAlphabetic(all[at + 1])) {
      at += 1;
      while (isAlphabetic(all[at])) at += 1;
    }
    out.push(all.slice(start, at).join(""));
  }
  return out;
}

/** "shit = s**t" as the word and how it is starred; a plain word has no set form. */
export function parseTerm(entry: string): [string, string | null] {
  const parts = entry.split("=").map(trim);
  const term = parts[0] ?? "";
  const display = parts[1];
  return [term, display === undefined || display === "" ? null : display];
}

/**
 * Repack's `muteSuggestions` with the house lists (and the neglect list
 * when `neglect`): whole words and phrases, longest first, a phrase's words
 * from one speaker with no pause over 750 ms; muted from 30 ms before the
 * first word (further back for a word timed as an instant) to 25 ms after
 * the last, within `fromMs`..`toMs`.
 */
export function suggestions(words: TimedWord[], neglect: boolean, fromMs: number, toMs: number): Suggestion[] {
  const stream: [string, number][] = [];
  words.forEach((word, index) => {
    for (const token of tokens(word.text)) stream.push([token, index]);
  });
  // A word on both lists is starred out.
  interface Listed {
    key: string;
    term: string;
    display: string | null;
    starred: boolean;
    parts: string[];
  }
  let listed: Listed[] = [];
  const add = (entry: string, starred: boolean) => {
    const [term, display] = parseTerm(entry);
    const parts = tokens(term);
    const key = parts.join(" ");
    if (parts.length === 0) return;
    const fresh: Listed = { key, term, display, starred, parts };
    const known = listed.findIndex((other) => other.key === key);
    if (known < 0) listed.push(fresh);
    else if (!listed[known]!.starred) listed[known] = fresh;
  };
  for (const entry of HOUSE_MUTE_ONLY) add(entry, false);
  if (neglect) {
    for (const entry of NEGLECT_TERMS) add(entry, true);
  }
  for (const entry of HOUSE_TERMS) add(entry, true);
  // Longest first (a stable sort, as Rust's).
  listed = [...listed].sort((a, b) => b.parts.length - a.parts.length);
  const out: Suggestion[] = [];
  let i = 0;
  while (i < stream.length) {
    // Words as listed first; then another form of one ("punched").
    matched: for (const loose of [false, true]) {
      for (const term of listed) {
        if (loose && term.parts.length !== 1) continue;
        if (i + term.parts.length > stream.length) continue;
        const found = stream.slice(i, i + term.parts.length);
        const fits = found.every(([token, index], j) => {
          const part = term.parts[j];
          if (part === undefined) return false;
          if (!(token === part || (loose && isFormOf(token, part)))) return false;
          if (j === 0) return true;
          const previous = found[j - 1]!;
          const word = words[index];
          const before = words[previous[1]];
          if (word === undefined || before === undefined) return false;
          return word.speaker === before.speaker && word.start_ms - before.end_ms <= 750.0;
        });
        if (!fits) continue;
        const firstIndex = found[0]![1];
        const lastIndex = found[found.length - 1]![1];
        const first = words[firstIndex];
        if (first === undefined) continue;
        let saidFrom = first.start_ms;
        if (collapsed(first)) {
          saidFrom = Math.max(first.start_ms - COLLAPSED_REACH_MS, 0.0);
          for (let back = firstIndex - 1; back >= 0; back--) {
            const before = words[back]!;
            if (before.end_ms <= saidFrom) break;
            if (before.speaker === first.speaker && !collapsed(before)) {
              saidFrom = before.end_ms;
              break;
            }
          }
        }
        const saidUntil = found.reduce((end, [, index]) => Math.max(end, words[index]?.end_ms ?? -Number.MAX_VALUE), -Number.MAX_VALUE);
        const startMs = round(Math.max(fromMs, saidFrom - MUTE_LEAD_MS));
        const endMs = round(Math.min(toMs, saidUntil + MUTE_PADDING_MS));
        const lastEnd = words[lastIndex]?.end_ms ?? -Number.MAX_VALUE;
        if (startMs < endMs && first.start_ms < toMs && lastEnd > fromMs) {
          // Another form is starred as written: "punched" → "p******".
          const token = found[0]![0];
          const [said, display] = loose && token !== term.key ? [token, null] : [term.term, term.display];
          out.push({
            term: said,
            starred: term.starred,
            display,
            word: firstIndex,
            at_ms: round(first.start_ms),
            start_ms: startMs,
            end_ms: endMs,
          });
        }
        i += term.parts.length - 1;
        break matched;
      }
    }
    i += 1;
  }
  return out;
}

/** A word starred out, its first letter kept: "n****". */
function starred(word: string): string {
  return chars(word)
    .map((c, i) => (i === 0 ? c : "*"))
    .join("");
}

/** A word's set form in the case it was written: "Shit" → "S**t". */
function inCase(display: string, written: string): string {
  const first = chars(written)[0];
  const upper = first !== undefined && first.toUpperCase() === first;
  const letters = chars(display);
  if (upper && letters.length > 0) return letters[0]!.toUpperCase() + letters.slice(1).join("");
  return display;
}

/**
 * Where `term` is written in `text` as whole words with any punctuation or
 * spacing between them (Repack's `termPattern`): char ranges, in order.
 */
function termSpans(text: string[], term: string): [number, number][] {
  const parts = tokens(term).map(chars);
  if (parts.length === 0) return [];
  const lower = text.map((c) => chars(c.toLowerCase())[0] ?? c);
  const word = (at: number) => isAlphanumeric(lower[at]);
  const spans: [number, number][] = [];
  let start = 0;
  scan: while (start < lower.length) {
    if (start > 0 && word(start - 1)) {
      start += 1;
      continue;
    }
    let at = start;
    for (let n = 0; n < parts.length; n++) {
      const part = parts[n]!;
      if (n > 0) {
        const gap = at;
        while (at < lower.length && !word(at)) at += 1;
        if (at === gap) {
          start += 1;
          continue scan;
        }
      }
      if (at + part.length > lower.length || part.some((c, j) => lower[at + j] !== c)) {
        start += 1;
        continue scan;
      }
      at += part.length;
    }
    if (word(at)) {
      start += 1;
      continue;
    }
    spans.push([start, at]);
    start = Math.max(at, start + 1);
  }
  return spans;
}

/**
 * A subtitle's text with its starred terms starred out: their set form
 * ("f***") in the written case, else each word's first letter and stars.
 */
export function star(text: string, found: Suggestion[]): string {
  let letters = chars(text);
  const done: string[] = [];
  for (const suggestion of found.filter((s) => s.starred)) {
    if (done.includes(suggestion.term)) continue;
    done.push(suggestion.term);
    const out: string[] = [];
    let at = 0;
    for (const [from, to] of termSpans(letters, suggestion.term)) {
      out.push(...letters.slice(at, from));
      const written = letters.slice(from, to).join("");
      if (suggestion.display !== null) {
        out.push(...chars(inCase(suggestion.display, written)));
      } else {
        let run = "";
        for (const c of chars(written)) {
          if (isAlphanumeric(c)) {
            run += c;
          } else {
            out.push(...chars(starred(run)));
            run = "";
            out.push(c);
          }
        }
        out.push(...chars(starred(run)));
      }
      at = to;
    }
    out.push(...letters.slice(at));
    letters = out;
  }
  return letters.join("");
}

/**
 * Repack's `shownCues`, one at a time: each held `holdMs` after its last
 * word but never past the next one's start or `untilMs`; one starting while
 * another is up waits for it; one left no time is dropped. Lines of `silent`
 * speakers (radio, background talk: they talk over the conversation rather
 * than instead of it) are left out first and cut nothing short; lines of
 * `hidden` ones that aren't silent (only the narrator) still end the line
 * before them, then go.
 *
 * `together` (interrogations): people talking over each other are shown at
 * once. Each person's lines go one at a time; a line ends at the next one
 * that doesn't talk over it (the same person's, or anyone's starting after
 * it is said).
 */
export function shown(
  given: Line[],
  holdMs: number,
  fromMs: number,
  untilMs: number,
  together: boolean,
  silent: (speaker: string) => boolean,
  hidden: (speaker: string) => boolean,
): Line[] {
  const cues: Line[] = given
    .filter((line) => line.start_ms < untilMs && line.end_ms > fromMs)
    .filter((line) => trim(line.text) !== "" && !silent(line.speaker))
    .map((line) => ({ ...line, start_ms: Math.max(line.start_ms, fromMs), end_ms: Math.min(line.end_ms, untilMs) }));
  cues.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const nextStart: (number | null)[] = new Array(cues.length).fill(null);
  for (let i = cues.length - 1; i >= 0; i--) {
    const cue = cues[i]!;
    const next = cues[i + 1];
    nextStart[i] = next !== undefined && next.start_ms > cue.start_ms ? next.start_ms : (nextStart[i + 1] ?? null);
  }
  let shownUntil = 0.0;
  const speakerUntil = new Map<string, number>();
  let out: Line[] = [];
  cues.forEach((cue, i) => {
    if (together) {
      let tied = false;
      for (let j = i + 1; j < cues.length && cues[j]!.start_ms === cue.start_ms; j++) {
        if (cues[j]!.speaker === cue.speaker) tied = true;
      }
      const cut = cues.slice(i + 1).find((next) => next.start_ms > cue.start_ms && (next.speaker === cue.speaker || next.start_ms >= cue.end_ms));
      const cutAt = cut === undefined ? Number.POSITIVE_INFINITY : cut.start_ms;
      let endMs = Math.min(cue.end_ms + (tied ? 0.0 : holdMs), untilMs, cutAt);
      const startMs = Math.max(cue.start_ms, speakerUntil.get(cue.speaker) ?? 0.0);
      // Readable however quick the reply after it: a line held into
      // another speaker's stacks over it (overlap mode's way).
      endMs = Math.max(endMs, Math.min(startMs + MIN_SHOWN_MS, untilMs));
      speakerUntil.set(cue.speaker, endMs);
      out.push({ ...cue, start_ms: startMs, end_ms: endMs });
      return;
    }
    const tied = cues[i + 1]?.start_ms === cue.start_ms;
    let endMs = Math.min(cue.end_ms + (tied ? 0.0 : holdMs), untilMs, nextStart[i] ?? Number.POSITIVE_INFINITY);
    const startMs = Math.max(cue.start_ms, shownUntil);
    if (endMs < startMs) endMs = startMs;
    shownUntil = Math.max(shownUntil, endMs);
    out.push({ ...cue, start_ms: startMs, end_ms: endMs });
  });
  out = out.filter((cue) => cue.end_ms > cue.start_ms && !hidden(cue.speaker));
  if (!together) holdReadable(out, untilMs);
  return out;
}

/**
 * The least time a line stays up: under this it flashes past unread (a
 * finished subtitled video had 28 lines, "No.", "Yeah.", up for a single
 * frame, squeezed in before a quick answer).
 */
export const MIN_SHOWN_MS = 400.0;

/**
 * Holds every line at least MIN_SHOWN_MS (not past `untilMs`), starting the
 * next one that much later: its own hold after its last word absorbs it.
 */
function holdReadable(cues: Line[], untilMs: number): void {
  let shownUntil = Number.NEGATIVE_INFINITY;
  for (const cue of cues) {
    cue.start_ms = Math.max(cue.start_ms, shownUntil);
    const least = Math.min(cue.start_ms + MIN_SHOWN_MS, untilMs);
    cue.end_ms = Math.max(cue.end_ms, least);
    shownUntil = cue.end_ms;
  }
}

/**
 * Whether a role's lines are hidden: the narrator, radio traffic and
 * background talk (a second conversation behind the one followed).
 */
export function hiddenRole(role: string): boolean {
  return role === "narrator" || role === "dispatch" || role === speakers.BACKGROUND;
}

/**
 * Whether a hidden role's lines also cut nothing short: every hidden one
 * but the narrator, since they talk over the conversation rather than
 * instead of it (Repack's silentRadio).
 */
export function silentRole(role: string): boolean {
  return hiddenRole(role) && role !== "narrator";
}

/**
 * A voice's role: the one the transcript gives, else read from its name
 * (only what decides whether it shows: narrator or radio).
 */
export function roleOf(role: string | null | undefined, name: string): string {
  if (role !== null && role !== undefined) return role;
  const words = tokens(name);
  const has = (list: string[]) => words.some((word) => list.includes(word));
  if (has(["narrator"])) return "narrator";
  if (has(["dispatch", "dispatcher", "radio", "scanner"])) return "dispatch";
  return "other";
}

/**
 * Repack's house style at this project's size, in `color`: Montserrat
 * SemiBold 48 on a 75% black box (padding 12 × 8), drop shadow 0.65 at 3 px
 * and 112°, size 6, blur 8, a glow in the text's own colour (0.5, radius
 * 46), as wide as 80% of the frame, bottom middle (y 90%).
 */
export function houseStyle(width: number, height: number, color: Rgba): TextStyle {
  const k = f32(height / 1080.0);
  return {
    font: "Montserrat",
    weight: 600,
    size: round(f32(48.0 * k)),
    color,
    tracking: 0.0,
    line_height: 1.15,
    glow: { enabled: true, color: null, radius: f32(46.0 * k), strength: 0.5 },
    max_width: round(f32(f32(f32(width) * f32(0.8)) - f32(24.0 * k))),
    background: { color: [0, 0, 0, 1], opacity: 0.75, pad_x: f32(12.0 * k), pad_y: f32(8.0 * k), border: 0, border_color: [1, 1, 1, 1] },
    shadow: { color: [0, 0, 0, 1], opacity: 0.65, distance: f32(3.0 * k), angle: 112.0, size: f32(6.0 * k), blur: f32(8.0 * k) },
  };
}

/**
 * Segments covering `[0, duration)`: the gaps between `given` (sorted) as
 * footage, overlaps trimmed, and neighbours of one kind (and note) joined.
 */
export function fillSegments(given: Segment[], duration: number): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  const push = (segment: Segment) => {
    if (segment.end <= segment.start) return;
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === segment.kind && (last.note ?? "") === (segment.note ?? "")) {
      last.end = segment.end;
      return;
    }
    out.push(segment);
  };
  for (const segment of given) {
    const start = Math.max(segment.start, at);
    const end = Math.min(segment.end, duration);
    if (end <= start) continue;
    push({ start: at, end: start, kind: "footage" });
    push({ ...segment, start, end });
    at = end;
  }
  push({ start: at, end: duration, kind: "footage" });
  return out;
}

/** Faster than anyone talks (characters a second): the words' times are wrong. */
const CRAMMED_CPS = 25.0;
/** How long a line needs to be read at least: this many ms a character… */
const READ_MS_PER_CHAR = 60.0;
/** …and never less than this. */
const READ_MS = 800.0;

/**
 * Lines whose words are crammed faster than anyone talks ("Anything in your
 * pocket?" in 0.4 s, after a word stretched over the silence where it was
 * really said) get the time they need to be read: taken from the gap
 * before them, where the words most likely were, else the next line waits
 * (`shown` sequences them).
 */
export function uncram(lines: Line[]): void {
  lines.sort((a, b) => a.start_ms - b.start_ms);
  let before = Number.NEGATIVE_INFINITY;
  for (const line of lines) {
    const count = chars(line.text).filter((c) => !isWhitespace(c)).length;
    const span = line.end_ms - line.start_ms;
    if (count >= 8.0 && span < (count / CRAMMED_CPS) * 1000.0) {
      const needed = Math.max(count * READ_MS_PER_CHAR, READ_MS);
      line.start_ms = Math.max(Math.min(line.start_ms, Math.max(line.end_ms - needed, before)), 0.0);
      if (line.end_ms - line.start_ms < needed) line.end_ms = line.start_ms + needed;
    }
    before = Math.max(before, line.end_ms);
  }
}

/**
 * The longest anyone takes to say `word` (ms): transcription sometimes
 * stretches a word's end over the silence after it ("right." for 9 s), which
 * would hold its subtitle up and rush the next. About a second for a short
 * word, more for a long one; numbers ("$8,320") are said in many words, so
 * they keep their time.
 */
export function longestMs(word: string): number {
  if (/[0-9]/.test(word)) return Number.POSITIVE_INFINITY;
  const letters = chars(word).filter(isAlphabetic).length;
  return Math.max(120.0 * letters + 500.0, 1000.0);
}

/** Between two subtitles stacked because their people talk at once, in 1080p pixels. */
const STACK_GAP = 12.0;

/**
 * Where a face in a footage clip is on the project's frame (both in %): the
 * clip's picture fitted to the frame, scaled and moved by its transform.
 */
export function onProject(dot: seats.Dot, media: [number, number], transform: Transform, frame: [number, number]): seats.Dot {
  const [fw, fh] = [Math.max(frame[0], 1), Math.max(frame[1], 1)];
  const [mw, mh] = [Math.max(media[0], 1), Math.max(media[1], 1)];
  const fit = Math.min(fw / mw, fh / mh) * f32(transform.scale);
  const x = fw / 2.0 + f32(transform.x) + (dot.x / 100.0 - 0.5) * mw * fit;
  const y = fh / 2.0 + f32(transform.y) + (dot.y / 100.0 - 0.5) * mh * fit;
  return { x: (x / fw) * 100.0, y: (y / fh) * 100.0, h: (dot.h * mh * fit) / fh };
}

/**
 * A footage clip as subtitles look it up: start, end (frames), media,
 * source_in, speed, transform and the media's size.
 */
type Footage = [start: number, end: number, media: string, sourceIn: number, speed: number, transform: Transform, size: [number, number]];

/**
 * About how big a house-style subtitle's box is (project pixels) with its
 * text wrapped at `textWidth`: Montserrat SemiBold averages ~0.58 em.
 */
export function boxSize(text: string, textWidth: number, k: number): [number, number] {
  const size = f32(48.0 * k);
  const width = Math.max(f32(textWidth), size);
  let count = 0.0;
  let widest = 0.0;
  for (const line of linesOf(text)) {
    const natural = f32(f32(charCount(line) * f32(0.58)) * size);
    count = f32(count + Math.max(Math.ceil(f32(natural / width)), 1.0));
    widest = Math.max(widest, Math.min(natural, width));
  }
  return [f32(widest + f32(24.0 * k)), f32(f32(f32(Math.max(count, 1.0) * size) * f32(1.15)) + f32(16.0 * k))];
}

/**
 * A line under its speaker's face, the way Repack lays it out
 * (subtitleLayout): 80 px under the face (more for a big face), at most
 * 40% of the frame wide (less near an edge, never under 28%), beside the
 * face, towards the middle, when under it would leave the frame; none for
 * a face in a bottom corner (those stay bottom middle). Returns the box's
 * centre from the frame's centre, the text's wrap width and the box's size.
 */
export function underFace(
  dot: seats.Dot,
  text: string,
  width: number,
  height: number,
  k: number,
): [x: number, y: number, textWidth: number, boxWidth: number, boxHeight: number] | null {
  const [x, y] = [f32(dot.x), f32(dot.y)];
  if (y >= 60.0 && (x <= 33.0 || x >= 67.0)) return null;
  const [fw, fh] = [f32(width), f32(height)];
  const share = Math.min(80.0, Math.max(28.0, Math.min(40.0, f32(2.0 * Math.min(x, f32(100.0 - x))))));
  const textWidth = f32(f32(f32(fw * share) / 100.0) - f32(24.0 * k));
  const [w, h] = boxSize(text, textWidth, k);
  const [faceX, faceY] = [f32(f32(fw * x) / 100.0), f32(f32(fh * y) / 100.0)];
  const gap = Math.max(f32(80.0 * k), f32(f32(f32(f32(0.9) * fh) * f32(dot.h)) / 100.0));
  const beside = f32(f32(faceY + gap) + h) > f32(fh - f32(50.0 * k));
  const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
  const cy = clamp(beside ? faceY : f32(f32(faceY + gap) + f32(h / 2.0)), f32(h / 2.0), Math.max(f32(fh - f32(h / 2.0)), f32(h / 2.0)));
  const cx = clamp(
    beside
      ? faceX > f32(fw / 2.0)
        ? f32(f32(faceX - f32(110.0 * k)) - f32(w / 2.0))
        : f32(f32(faceX + f32(110.0 * k)) + f32(w / 2.0))
      : faceX,
    f32(w / 2.0),
    Math.max(f32(fw - f32(w / 2.0)), f32(w / 2.0)),
  );
  return [f32(cx - f32(fw / 2.0)), f32(cy - f32(fh / 2.0)), textWidth, w, h];
}

/** One voice in the footage, for the summary and the subtitles' colour. */
export interface Voice {
  name: string;
  role: string;
  color: string;
}

/** A BTreeMap<String, _>'s keys in order. */
function sortedKeys<T>(map: Map<string, T>): string[] {
  return [...map.keys()].sort(compareKeys);
}

/**
 * The narrator only speaks in narration: a "narrator" line inside a footage
 * segment is someone in the room whose voice diarisation lumped in with the
 * narrator's (an interrogator's 475 words were hidden that way). Such lines
 * go to the shown voice sharing a name with it ("JT Palmer (Narrator)" →
 * "Palmer (Undersheriff)"), else to the same voice shown, as "Other".
 */
export function narratorsInFootage(project: Project, voices: Map<string, Voice>, lines: Line[]): void {
  const fps = fpsOf(project);
  const footage = (project.segments ?? [])
    .filter((segment) => segment.kind === "footage")
    .map((segment) => [(segment.start / fps) * 1000.0, (segment.end / fps) * 1000.0] as [number, number]);
  if (footage.length === 0) return;
  const generic = ["the", "officer", "detective", "deputy", "sergeant", "narrator", "police", "speaker", "unknown"];
  const names = (name: string) => person(name)[0].filter((word) => byteLength(word) > 1 && !generic.includes(word));
  for (const line of lines) {
    const voice = voices.get(line.speaker);
    if (voice === undefined) continue;
    if (voice.role !== "narrator" || !footage.some(([start, end]) => start <= line.start_ms && line.start_ms < end)) continue;
    const words = names(voice.name);
    const mediaId = line.speaker.split("/")[0] ?? "";
    const matched = sortedKeys(voices).find((key) => {
      const other = voices.get(key)!;
      return key.startsWith(`${mediaId}/`) && !hiddenRole(other.role) && names(other.name).some((word) => words.includes(word));
    });
    let key: string;
    if (matched !== undefined) {
      key = matched;
    } else {
      key = `${line.speaker}#footage`;
      if (!voices.has(key)) voices.set(key, { name: "Other", role: "other", color: voice.color });
    }
    line.speaker = key;
  }
}

/**
 * A speaker's name as compared: its words (lower case) and the role in its
 * brackets, "Romania Hunter (Mother)" → (["romania", "hunter"], "mother").
 */
function person(name: string): [string[], string] {
  const at = name.indexOf("(");
  if (at < 0) return [tokens(name), ""];
  return [tokens(name.slice(0, at)), trim(name.slice(at + 1).replace(/\)+$/, "")).toLowerCase()];
}

/**
 * Whether two speaker names are one person: the same name, or (with the
 * same role in brackets) one name the start of the other ("Romania
 * (Mother)" and "Romania Hunter (Mother)"). Bare labels ("Deputy 2",
 * "Deputy 3") only match exactly.
 */
export function samePerson(a: string, b: string): boolean {
  const [[aWords, aRole], [bWords, bRole]] = [person(a), person(b)];
  if (aWords.length === 0 || bWords.length === 0) return false;
  const equal = (x: string[], y: string[]) => x.length === y.length && x.every((word, index) => word === y[index]);
  if (equal(aWords, bWords) && aRole === bRole) return true;
  const shorter = Math.min(aWords.length, bWords.length);
  return aRole !== "" && aRole === bRole && equal(aWords.slice(0, shorter), bWords.slice(0, shorter));
}

/**
 * One person, one colour: the watcher can name several of the
 * transcript's voices as the same person, each with its own colour (a boy
 * in three colours). Merges them into the voice with the most lines (its
 * colour), under the fullest name.
 */
export function samePersonSameColour(voices: Map<string, Voice>, lines: Line[]): void {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line.speaker, (counts.get(line.speaker) ?? 0) + 1);
  const keys = sortedKeys(voices).sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  const into = new Map<string, string>();
  keys.forEach((key, index) => {
    if (into.has(key)) return;
    const name = voices.get(key)?.name;
    if (name === undefined) return;
    for (const other of keys.slice(index + 1)) {
      if (into.has(other)) continue;
      const voice = voices.get(other);
      if (voice !== undefined && samePerson(name, voice.name)) into.set(other, key);
    }
  });
  for (const [merged, kept] of into) {
    const gone = voices.get(merged);
    if (gone === undefined) continue;
    voices.delete(merged);
    const voice = voices.get(kept);
    if (voice !== undefined && byteLength(gone.name) > byteLength(voice.name)) voice.name = gone.name;
  }
  for (const line of lines) {
    const kept = into.get(line.speaker);
    if (kept !== undefined) line.speaker = kept;
  }
}

/**
 * No two people alike across the files (each transcript picks its colours
 * on its own), and no official in pink (`speakers.distinct`).
 */
function spreadColours(voices: Map<string, Voice>, lines: Line[]): void {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line.speaker, (counts.get(line.speaker) ?? 0) + 1);
  const keys = sortedKeys(voices);
  const colours = speakers.distinct(
    keys.map((key) => {
      const voice = voices.get(key)!;
      return { role: voice.role, lines: counts.get(key) ?? 0, color: voice.color };
    }),
  );
  keys.forEach((key, index) => {
    const voice = voices.get(key);
    const colour = colours[index];
    if (voice !== undefined && colour !== undefined) voice.color = colour;
  });
}

/** `(source_ms) → timeline ms` for an audio clip. */
function onTimelineOf(clip: Clip & { type: "audio" }, fps: number): (sourceMs: number) => number {
  return (sourceMs) => (clip.start / fps + (sourceMs / 1000.0 - clip.source_in) / clip.speed) * 1000.0;
}

/** The stretch of an audio clip's source (seconds) seen between frames `from` and `to`. */
function visible(clip: Clip & { type: "audio" }, from: number, to: number, fps: number): [number, number] {
  return [
    clip.source_in + ((Math.max(from, clip.start) - clip.start) / fps) * clip.speed,
    clip.source_in + ((Math.min(to, clipEnd(clip)) - clip.start) / fps) * clip.speed,
  ];
}

/**
 * Subtitles and mutes the Repack way for everything said in the footage
 * between `from` and `to`: replaces subtitles made before in that span (by
 * this or add_subtitles) and the mutes on the footage's sound there.
 */
export async function repackSubtitles(app: App, projectId: string, options: SubtitleOptions): Promise<unknown> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const project = live.project;
  const fps = fpsOf(project);
  const { from, to, neglect, hold_ms: holdMs, overlap, faces } = options;
  if (to <= from) throw new Error("the span is empty");
  const sound = footageSound(project, from, to).sort((a, b) => a.start - b.start);
  const transcripts = new Map<string, Transcript>();
  const voices = new Map<string, Voice>();
  const lines: Line[] = [];
  const mutes: ClipMutes = new Map();
  const muted: unknown[] = [];
  for (const clip of sound) {
    if (clip.type !== "audio") continue;
    const media = mediaOf(project, clip.media);
    if (media === undefined) continue;
    if (!transcripts.has(media.id)) transcripts.set(media.id, await transcriptOf(app, media));
    const transcript = transcripts.get(media.id)!;
    const [visibleFrom, visibleTo] = visible(clip, from, to, fps);
    const words = timedWords(transcript.words, visibleFrom, visibleTo);
    const onTimeline = onTimelineOf(clip, fps);
    const found = suggestions(words, neglect, visibleFrom * 1000.0, visibleTo * 1000.0);
    for (const cue of segment(words)) {
      const mine = found.filter((suggestion) => cue.words[0] <= suggestion.word && suggestion.word < cue.words[1]);
      const voice = cue.speaker ?? "unknown";
      const key = `${media.id}/${voice}`;
      if (!voices.has(key)) {
        const name = get(transcript.speakers, voice) ?? voice;
        voices.set(key, {
          role: roleOf(get(transcript.roles, voice), name),
          color: get(transcript.colors, voice) ?? "#ffffff",
          name,
        });
      }
      // A cue of only a transcriber's mark ("...") says nothing: no subtitle.
      if (!chars(cue.text).some(isAlphanumeric)) continue;
      lines.push({
        start_ms: onTimeline(cue.start_ms),
        end_ms: onTimeline(cue.end_ms),
        text: star(cue.text, mine),
        speaker: key,
      });
    }
    let entry = mutes.get(clip.id);
    if (entry === undefined) mutes.set(clip.id, (entry = [visibleFrom, visibleTo, []]));
    for (const suggestion of found) {
      entry[2].push({ from: suggestion.start_ms / 1000.0, to: suggestion.end_ms / 1000.0 });
      muted.push({
        term: suggestion.term,
        time: round(onTimeline(suggestion.at_ms) / 10.0) / 100.0,
        starred: suggestion.starred,
        clip: clip.id,
      });
    }
  }
  narratorsInFootage(project, voices, lines);
  samePersonSameColour(voices, lines);
  spreadColours(voices, lines);
  uncram(lines);
  const role = (key: string) => voices.get(key)?.role ?? "other";
  const shownLines = shown(
    lines,
    holdMs,
    (from / fps) * 1000.0,
    (to / fps) * 1000.0,
    overlap,
    (key) => silentRole(role(key)),
    (key) => hiddenRole(role(key)),
  );
  const { width, height } = project.settings;
  const frame = (ms: number) => toI64(round((ms / 1000.0) * fps));
  // Where each speaker sits, per file, for lines under their face.
  const seated = new Map<string, seats.Seats>();
  if (faces) {
    for (const [mediaId, transcript] of transcripts) {
      const media = mediaOf(project, mediaId);
      if (media === undefined) continue;
      try {
        seated.set(mediaId, await seats.seats(media.path, transcript));
      } catch (error) {
        diag.warn("subtitles", `no face positions for ${media.name}: ${diag.messageOf(error)}; bottom middle`);
      }
    }
  }
  const [after, [placed, skipped, outside, texts]] = await app.store.update(projectId, "agent", (edited) => {
    // Stacked lines (overlap) go on tracks of their own under the
    // subtitles' track, made as needed; a re-run removes them by name.
    const tracks: string[] = [];
    const stacked = edited.tracks
      .filter((track) => track.kind === "video" && track.subtitles !== true)
      .filter((track) => {
        const mine = edited.clips.filter((clip) => clip.track === track.id);
        return mine.length > 0 && mine.every((clip) => (clip.name ?? "").startsWith(NAME));
      })
      .map((track) => track.id)
      .reverse();
    edited.clips = edited.clips.filter(
      (clip) => !((clip.name ?? "").startsWith(NAME) && clip.start < to && clipEnd(clip) > from),
    );
    writeMutes(edited, mutes);
    tracks.push(subtitlesTrack(edited));
    tracks.push(...stacked);
    const baseY = f32(f32(height) * f32(0.4));
    const k = f32(height / 1080.0);
    // The footage the seats were found in, to find where a line is in it.
    const footage: Footage[] = [];
    for (const clip of edited.clips) {
      if (clip.type !== "video" || !seated.has(clip.media)) continue;
      const found = mediaOf(edited, clip.media);
      if (found === undefined) continue;
      footage.push([clip.start, clipEnd(clip), clip.media, clip.source_in, clip.speed, clip.transform, [found.width, found.height]]);
    }
    // Lines up now: when each ends (frames), its centre (x, y) and box size.
    let open: [until: number, x: number, w: number, y: number, h: number][] = [];
    let placedCount = 0;
    let skippedCount = 0;
    // Only inside footage segments: a line across a segment's edge shows
    // only inside it (narration and already-subtitled stretches get none).
    const pieces: [Line, number, number][] = [];
    for (const line of shownLines) {
      const [start, end] = [Math.max(frame(line.start_ms), from), Math.min(frame(line.end_ms), to)];
      for (const [s, e] of subtitledSpans(edited, start, end)) pieces.push([line, s, e]);
    }
    const counted = new Set<Line>(pieces.map(([line]) => line));
    const outsideCount = shownLines.length - counted.size;
    for (const [line, start, end] of pieces) {
      if (end <= start) {
        skippedCount += 1;
        continue;
      }
      const free = (track: string) =>
        !edited.clips.some((clip) => clip.track === track && clip.start < end && start < clipEnd(clip));
      let track = tracks.find(free);
      if (track === undefined) {
        if (!overlap) {
          skippedCount += 1;
          continue;
        }
        track = addTrack(edited, "video");
        tracks.push(track);
      }
      const voice = voices.get(line.speaker);
      // Under the speaker's face when they're seen there (where the
      // line starts), else bottom middle.
      let face: seats.Dot | null = null;
      if (voice !== undefined) {
        const clip = footage.find(([s, e]) => s <= start && start < e);
        if (clip !== undefined) {
          const [clipStart, , mediaId, sourceIn, speed, transform, size] = clip;
          const at = sourceIn + ((start - clipStart) / fps) * speed;
          const dot = seated.get(mediaId)?.dot(voice.name, at) ?? null;
          if (dot !== null) face = onProject(dot, size, transform, [width, height]);
        }
      }
      const laid = (face === null ? null : underFace(face, line.text, width, height, k)) ?? (() => {
        const wrap = f32(f32(f32(width) * f32(0.8)) - f32(24.0 * k));
        const [w, h] = boxSize(line.text, wrap, k);
        return [0.0, baseY, wrap, w, h] as [number, number, number, number, number];
      })();
      const [x, , textWidth, boxWidth, boxHeight] = laid;
      let y = laid[1];
      // Stacked: a line whose box would cover one already up goes
      // above it (below when there's no room above).
      open = open.filter(([until]) => until > start);
      for (let pass = 0, passes = open.length; pass <= passes; pass++) {
        const over = open.find(
          ([, otherX, otherWidth, otherY, otherHeight]) =>
            Math.abs(f32(x - otherX)) < f32(f32(boxWidth + otherWidth) / 2.0) &&
            Math.abs(f32(y - otherY)) < f32(f32(f32(boxHeight + otherHeight) / 2.0) + f32(f32(STACK_GAP * k) / 2.0)),
        );
        if (over === undefined) break;
        const [, , , overY, overHeight] = over;
        const above = f32(f32(f32(overY - f32(overHeight / 2.0)) - f32(STACK_GAP * k)) - f32(boxHeight / 2.0));
        y =
          f32(above - f32(boxHeight / 2.0)) >= f32(-f32(height) / 2.0)
            ? above
            : f32(f32(f32(overY + f32(overHeight / 2.0)) + f32(STACK_GAP * k)) + f32(boxHeight / 2.0));
      }
      open.push([end, x, boxWidth, y, boxHeight]);
      const color: Rgba = (voice === undefined ? null : hex(voice.color)) ?? [1, 1, 1, 1];
      const who = voice?.name ?? "Speaker";
      const id = freshId(edited, "c");
      edited.clips.push({
        id,
        track,
        start,
        duration: end - start,
        color: "cyan",
        name: `${NAME} · ${who}`,
        fade_in: 0,
        fade_out: 0,
        type: "text",
        text: line.text,
        style: { ...houseStyle(width, height, color), max_width: round(textWidth) },
        transform: { x, y, scale: 1, rotation: 0 },
        animation: { preset: "none", duration: 12, stagger: 1.5 },
        opacity: 1,
      });
      placedCount += 1;
    }
    // Every other text on screen too (captions, callouts, charges), all of the video.
    const starredTexts = starOnScreen(edited, 0, Number.POSITIVE_INFINITY, neglect);
    return [placedCount, skippedCount, outsideCount, starredTexts] as const;
  });
  const counts = new Map<string, number>();
  for (const line of shownLines) counts.set(line.speaker, (counts.get(line.speaker) ?? 0) + 1);
  const listedSpeakers = sortedKeys(voices).map((key) => {
    const voice = voices.get(key)!;
    return {
      voice: key,
      name: voice.name,
      role: voice.role,
      color: voice.color,
      lines: counts.get(key) ?? 0,
      shown: !hiddenRole(voice.role),
    };
  });
  return {
    rev: after.rev,
    subtitles: placed,
    skipped,
    outside_segments: outside,
    texts_starred: texts,
    speakers: listedSpeakers,
    mutes: muted,
  };
}

/**
 * The footage's own sound in the span: audio clips of video files (not
 * music or sound effects) on tracks that are heard.
 */
export function footageSound(project: Project, from: number, to: number): Clip[] {
  return project.clips.filter((clip) => {
    const track = trackOf(project, clip.track);
    if (track === undefined || track.kind !== "audio" || track.muted) return false;
    if (!(clip.start < to && clipEnd(clip) > from) || clip.type !== "audio") return false;
    const media = mediaOf(project, clip.media);
    return media !== undefined && media.kind === "video" && media.has_audio;
  });
}

/** Writes `mutes` onto their audio clips: each clip's mutes inside the stretch looked at are replaced, the rest kept. */
export function writeMutes(project: Project, mutes: ClipMutes): void {
  for (const clip of project.clips) {
    const entry = mutes.get(clip.id);
    if (entry === undefined || clip.type !== "audio") continue;
    const [visibleFrom, visibleTo, fresh] = entry;
    const kept: Mute[] = (clip.mutes ?? []).filter((mute) => mute.to <= visibleFrom || mute.from >= visibleTo);
    kept.push(...fresh.map((mute) => ({ ...mute })));
    kept.sort((a, b) => a.from - b.from);
    clip.mutes = kept;
  }
}

/**
 * A clip's transcript words between `from` and `to` (source seconds), each
 * ending when it could have been said (`longestMs`).
 */
export function timedWords(words: Word[], from: number, to: number): TimedWord[] {
  return words
    .filter((word) => word.start >= from && word.end <= to + 0.05)
    .map((word) => ({
      text: trim(word.text),
      start_ms: word.start * 1000.0,
      end_ms: Math.min(word.end * 1000.0, word.start * 1000.0 + longestMs(word.text)),
      speaker: word.speaker ?? null,
    }))
    .filter((word) => word.text !== "");
}

/**
 * Finds the house words (and the neglect list's when `neglect`) said in the
 * footage and the voice-overs between `from` and `to` (timeline frames), and
 * the mutes for them. Only the footage's go in `found` (they star subtitles).
 */
export async function houseWords(app: App, project: Project, from: number, to: number, neglect: boolean): Promise<HouseWords> {
  const fps = fpsOf(project);
  const sound: [Clip, boolean][] = [
    ...footageSound(project, from, to).map((clip) => [clip, false] as [Clip, boolean]),
    ...seams.voiceover.voiceoverSound(project, from, to).map((clip) => [clip, true] as [Clip, boolean]),
  ];
  sound.sort((a, b) => a[0].start - b[0].start);
  const transcripts = new Map<string, Transcript>();
  const out: HouseWords = { mutes: new Map(), found: [], listed: [] };
  for (const [clip, voiceOver] of sound) {
    if (clip.type !== "audio") continue;
    const media = mediaOf(project, clip.media);
    if (media === undefined) continue;
    if (!transcripts.has(media.id)) transcripts.set(media.id, await transcriptOf(app, media));
    const transcript = transcripts.get(media.id)!;
    const [visibleFrom, visibleTo] = visible(clip, from, to, fps);
    const words = timedWords(transcript.words, visibleFrom, visibleTo);
    const onTimeline = onTimelineOf(clip, fps);
    let entry = out.mutes.get(clip.id);
    if (entry === undefined) out.mutes.set(clip.id, (entry = [visibleFrom, visibleTo, []]));
    for (const suggestion of suggestions(words, neglect, visibleFrom * 1000.0, visibleTo * 1000.0)) {
      entry[2].push({ from: suggestion.start_ms / 1000.0, to: suggestion.end_ms / 1000.0 });
      const listed: Record<string, unknown> = {
        term: suggestion.term,
        time: round(onTimeline(suggestion.at_ms) / 10.0) / 100.0,
        starred: suggestion.starred,
        clip: clip.id,
      };
      if (voiceOver) {
        listed.voice_over = true;
        out.listed.push(listed);
        continue;
      }
      out.listed.push(listed);
      out.found.push({
        clip: clip.id,
        timeline_ms: [onTimeline(suggestion.at_ms), onTimeline(suggestion.end_ms)],
        suggestion,
      });
    }
  }
  return out;
}

/**
 * The starred words of `found` said while a subtitle from `start` to `end`
 * (timeline frames) is up, give or take half a second.
 */
function saidDuring(found: Found[], start: number, end: number, fps: number): Suggestion[] {
  const [fromMs, toMs] = [(start / fps) * 1000.0 - 500.0, (end / fps) * 1000.0 + 500.0];
  return found.filter((one) => one.timeline_ms[0] < toMs && one.timeline_ms[1] > fromMs).map((one) => one.suggestion);
}

/**
 * Mutes the house words in the footage's sound and the voice-overs between
 * `from` and `to` (timeline frames) and stars them out in the subtitles already there,
 * moving nothing: for subtitles finished by hand. Replaces the mutes made
 * before in that span.
 */
export async function muteHouseWords(app: App, projectId: string, from: number, to: number, neglect: boolean): Promise<unknown> {
  if (to <= from) throw new Error("the span is empty");
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const fps = fpsOf(live.project);
  const house = await houseWords(app, live.project, from, to, neglect);
  const [after, [starredCount, onScreen]] = await app.store.update(projectId, "agent", (project) => {
    writeMutes(project, house.mutes);
    const count = starSubtitles(project, house.found, from, to, fps);
    return [count, starOnScreen(project, from, to, neglect)] as const;
  });
  return { rev: after.rev, subtitles_starred: starredCount, texts_starred: onScreen, mutes: house.listed };
}

/**
 * Stars out `found` in the subtitles between `from` and `to` (timeline
 * frames) that are up while each is said; how many changed. Words keep
 * their places, so per-word timing (`word_times`) still fits.
 */
export function starSubtitles(project: Project, found: Found[], from: number, to: number, fps: number): number {
  let changed = 0;
  for (const clip of project.clips) {
    if (!(clip.name ?? "").startsWith(NAME) || clip.start >= to || clipEnd(clip) <= from) continue;
    const mine = saidDuring(found, clip.start, clipEnd(clip), fps);
    if (clip.type !== "text") continue;
    const starredText = star(clip.text, mine);
    if (starredText !== clip.text) {
      clip.text = starredText;
      changed += 1;
    }
  }
  return changed;
}

/**
 * `text` with the starred house words in it (and the neglect list's when
 * `neglect`) starred out, whatever is said: for any text on screen. Words
 * keep their places and lengths, so word timings still fit.
 */
export function starText(text: string, neglect: boolean): string {
  const words: TimedWord[] = splitWhitespace(text).map((word, index) => ({
    text: word,
    start_ms: index * 100.0,
    end_ms: index * 100.0 + 50.0,
    speaker: null,
  }));
  return star(text, suggestions(words, neglect, -Number.MAX_VALUE, Number.MAX_VALUE));
}

/**
 * Stars out the house words in every text clip on screen between `from`
 * and `to` (timeline frames): subtitles, speaker captions, callouts,
 * quotes, charges, labels. How many changed.
 */
export function starOnScreen(project: Project, from: number, to: number, neglect: boolean): number {
  let changed = 0;
  for (const clip of project.clips) {
    if (clip.start >= to || clipEnd(clip) <= from || clip.type !== "text") continue;
    const starredText = starText(clip.text, neglect);
    if (starredText !== clip.text) {
      clip.text = starredText;
      changed += 1;
    }
  }
  return changed;
}
