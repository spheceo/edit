// The house rule that a subtitle is one line (Marc, Judge EXPLODES v2: "We
// want to avoid double line subtitles"; "Again we have double line
// subtitles"). Enforced by the store on every write (`Store.update` and
// `Store.commit`), so no tool, agent or click can leave one: a subtitle that's
// new or changed and would wrap at its width is split into consecutive cues,
// each one line, at the most natural break (a sentence end, then a comma or
// dash, then the most even split), its time shared by the words' own times
// when it has them, else by length. Measured exactly as the renderer wraps it
// (`textLines`, edit-render). Projects are checked as they are with
// `twoLineSubtitles`, which changes nothing.

import type { Clip, Project, TextClip } from "./model.ts";
import { native } from "./native/index.ts";
import { freshId } from "./project.ts";

/** How every subtitle's clip name starts (store.ts SUBTITLE_NAME). */
const SUBTITLE_PREFIX = "Subtitle · ";

/** The shortest a piece of a split subtitle is on screen (frames at 30 fps: ~0.5 s). */
const MIN_PIECE_FRAMES = 15;

export function isSubtitle(clip: Clip): clip is TextClip {
  return clip.type === "text" && typeof clip.name === "string" && clip.name.startsWith(SUBTITLE_PREFIX);
}

/** The text as it's drawn: in capitals, letter for letter, when the style says so (edit-core eval.rs `capitals`; capitals are wider). */
function shown(clip: TextClip, text: string): string {
  if (clip.style.uppercase !== true) return text;
  return [...text].map((c) => (c.toUpperCase().length === 1 ? c.toUpperCase() : c)).join("");
}

/** The lines `clip`'s text takes on screen. */
export function linesOf(clip: TextClip): string[] {
  const style = clip.style;
  return native().textLines(shown(clip, clip.text), style.font, style.weight, style.size, style.tracking, style.max_width ?? null);
}

function fits(clip: TextClip, text: string): boolean {
  const style = clip.style;
  return native().textLines(shown(clip, text), style.font, style.weight, style.size, style.tracking, style.max_width ?? null).length <= 1;
}

/** How natural a break after `word` is: a sentence end, then a clause, then any. */
function breakScore(word: string): number {
  if (/[.?!…]["”’)]*$/u.test(word)) return 3;
  if (/[,;:—–-]["”’)]*$/u.test(word)) return 2;
  return 1;
}

/**
 * `words` cut into the fewest pieces that each fit on one line, each cut at
 * the most natural break that still lets the rest fit; null when even one
 * word doesn't fit (it can't be split by words).
 */
export function pieces(clip: TextClip, words: string[]): string[][] | null {
  // The longest run from each word that fits on one line, and the fewest
  // pieces the rest needs from there (greedy is fewest for line breaking).
  const runs = new Map<number, number>();
  const run = (from: number): number => {
    if (!runs.has(from)) {
      let end = from;
      while (end < words.length && fits(clip, words.slice(from, end + 1).join(" "))) end += 1;
      runs.set(from, end);
    }
    return runs.get(from)!;
  };
  const counts = new Map<number, number>();
  const fewest = (from: number): number => {
    if (from >= words.length) return 0;
    if (!counts.has(from)) {
      const end = run(from);
      counts.set(from, end === from ? Number.POSITIVE_INFINITY : 1 + fewest(end));
    }
    return counts.get(from)!;
  };
  if (!Number.isFinite(fewest(0))) return null;
  const out: string[][] = [];
  let at = 0;
  while (at < words.length) {
    const end = run(at);
    // Among the cuts that keep the fewest pieces, the most natural (a sentence
    // end, then a clause), the latest of equals.
    let cut = end;
    let best = 0;
    if (end < words.length) {
      for (let i = end; i > at; i--) {
        if (fewest(i) !== fewest(end)) continue;
        const score = breakScore(words[i - 1]!);
        if (score > best) {
          best = score;
          cut = i;
        }
      }
    }
    out.push(words.slice(at, cut));
    at = cut;
  }
  return out;
}

/**
 * A two-line subtitle split into one-line cues in `project` (in place): the
 * first keeps its id, the rest follow it on the same track. False when it
 * already fits, or can't be split (a word wider than the box, or too short to
 * share): it's left for the audit.
 */
export function splitToOneLine(project: Project, clip: TextClip): boolean {
  if (linesOf(clip).length <= 1) return false;
  const words = clip.text.replace(/\s+/gu, " ").trim().split(" ");
  const parts = pieces(clip, words);
  if (parts === null || parts.length < 2 || clip.duration < parts.length * MIN_PIECE_FRAMES) return false;
  // When each piece starts: the words' own times (`words` animation), else by length.
  const times = clip.word_times !== undefined && clip.word_times !== null && clip.word_times.length === words.length ? clip.word_times : null;
  const total = parts.reduce((sum, part) => sum + part.join(" ").length, 0);
  const starts: number[] = [];
  let index = 0;
  let chars = 0;
  for (const part of parts) {
    starts.push(times !== null ? Math.round(times[index]!) : Math.round((clip.duration * chars) / total));
    index += part.length;
    chars += part.join(" ").length;
  }
  // Each piece at least MIN_PIECE_FRAMES, in order, inside the clip.
  for (let i = 1; i < starts.length; i++) starts[i] = Math.max(starts[i]!, starts[i - 1]! + MIN_PIECE_FRAMES);
  for (let i = starts.length - 1; i >= 1; i--) starts[i] = Math.min(starts[i]!, clip.duration - (starts.length - i) * MIN_PIECE_FRAMES);
  starts[0] = 0;
  const made: TextClip[] = parts.map((part, i) => {
    const offset = starts[i]!;
    const length = (i + 1 < starts.length ? starts[i + 1]! : clip.duration) - offset;
    const piece: TextClip = { ...structuredClone(clip), start: clip.start + offset, duration: length, text: part.join(" ") };
    if (i > 0) piece.id = freshId(project, "c");
    if (times !== null) piece.word_times = times.slice(parts.slice(0, i).reduce((n, p) => n + p.length, 0)).slice(0, part.length).map((t) => Math.max(t - offset, 0));
    else delete piece.word_times;
    // The fade in on the first piece, the fade out on the last.
    if (i > 0) piece.fade_in = 0;
    if (i + 1 < parts.length) piece.fade_out = 0;
    return piece;
  });
  const at = project.clips.indexOf(clip);
  project.clips.splice(at, 1, ...made);
  return true;
}

/** What makes a subtitle's look on screen: a change to any is a change to check. */
function shapeKey(clip: TextClip): string {
  const style = clip.style;
  return JSON.stringify([clip.text, style.font, style.weight, style.size, style.tracking, style.max_width ?? null, style.uppercase === true]);
}

/**
 * The store's rule on every write: subtitles in `after` that are new or
 * changed since `before` (null: all) and would take two lines are split
 * (in place). Subtitles left as they were are left: an older project isn't
 * rewritten by an unrelated edit. How many were split.
 */
export function enforceOneLine(before: Project | null, after: Project): number {
  const was = new Map<string, string>();
  for (const clip of before?.clips ?? []) if (isSubtitle(clip)) was.set(clip.id, shapeKey(clip));
  let split = 0;
  for (const clip of [...after.clips]) {
    if (!isSubtitle(clip)) continue;
    if (before !== null && was.get(clip.id) === shapeKey(clip)) continue;
    if (splitToOneLine(after, clip)) split += 1;
  }
  return split;
}

/** The subtitles in `project` that take two lines or more, for the audit and the check across projects (changes nothing). */
export function twoLineSubtitles(project: Project): { id: string; start: number; text: string; lines: number }[] {
  return project.clips.filter(isSubtitle).flatMap((clip) => {
    const lines = linesOf(clip).length;
    return lines > 1 ? [{ id: clip.id, start: clip.start, text: clip.text, lines }] : [];
  });
}
