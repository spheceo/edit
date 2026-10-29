// A commentary draft's paragraphs: what the narrator reads, the editor's note
// lines and the words each is on, and the clock times clips are written in.
// Offsets are UTF-16 units, as everywhere in JavaScript (Writer's Rust kept
// bytes here and turned them into units at the edges).

import type { Cite, Draft, NoteMark, Paragraph } from "@edit/types/writer";

import { isAlphanumeric, splitWhitespace } from "../rust.ts";

/** Narration is read at about this pace. */
export const WORDS_PER_MINUTE = 150;

/** What the narrator reads, piece by piece: [piece index, text]. */
export function said(paragraph: Paragraph): [number, string][] {
  return paragraph.pieces.flatMap((piece, index): [number, string][] => (piece.kind === "say" ? [[index, piece.text]] : []));
}

/** The note's lines, in order, each trimmed. */
export function noteLines(paragraph: Paragraph): string[] {
  return (paragraph.note ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

/** Where a mark's words are: the narration piece and the range in it. */
export function findIn(paragraph: Paragraph, words: string): [number, number, number] | null {
  for (const [index, text] of said(paragraph)) {
    const at = findWords(text, words);
    if (at !== null) return [index, at[0], at[1]];
  }
  return null;
}

/** The marks whose line is still in the note and whose words are still said, with where they are. */
export function liveMarks(paragraph: Paragraph): [NoteMark, [number, number, number]][] {
  const lines = noteLines(paragraph);
  return (paragraph.marks ?? []).flatMap((mark): [NoteMark, [number, number, number]][] => {
    if (!lines.includes(mark.line.trim())) return [];
    const at = findIn(paragraph, mark.on);
    return at === null ? [] : [[mark, at]];
  });
}

/** A quote pop-up's line in the note, for whoever reads only the note. */
export function popupLine(who: string, quote: Cite): string {
  return `Quote pop-up (typewriter): “${quote.quote.trim()}” (${who}, ${quote.video} ${clock(quote.startMs)}-${clock(quote.endMs)})`;
}

function canon(char: string): string {
  if (char === "‘" || char === "’" || char === "ʼ") return "'";
  if (char === "“" || char === "”") return '"';
  if (/^\s$/u.test(char)) return " ";
  return char.toLowerCase();
}

const QUOTE_OR_SPACE = /^["“”'‘’\s]+|["“”'‘’\s]+$/gu;

/**
 * Where `words` are in `text`: letter for letter, ignoring case, curly or
 * straight quotes and runs of spaces, and the quotation marks or stops at
 * either end of `words`. Whole words only ("lied" isn't in "applied").
 */
export function findWords(text: string, words: string): [number, number] | null {
  const wanted: string[] = [];
  for (const char of words.trim().replace(QUOTE_OR_SPACE, "")) {
    const c = canon(char);
    if (!(c === " " && wanted.at(-1) === " ")) wanted.push(c);
  }
  if (wanted.filter((c) => isAlphanumeric(c)).length < 2) return null;
  // The text as canonical characters, runs of spaces as one, each with its offset and length.
  const have: [number, string, number][] = [];
  let at = 0;
  for (const char of text) {
    const c = canon(char);
    if (!(c === " " && have.at(-1)?.[1] === " ")) have.push([at, c, char.length]);
    at += char.length;
  }
  const tryFind = (want: string[]): [number, number] | null => {
    for (let from = 0; from + want.length <= have.length; from++) {
      const before = from === 0 || !isAlphanumeric(have[from - 1]![1]) || !isAlphanumeric(want[0]);
      const next = have[from + want.length];
      const after = next === undefined || !isAlphanumeric(next[1]) || !isAlphanumeric(want[want.length - 1]);
      if (!before || !after) continue;
      if (!want.every((c, i) => have[from + i]![1] === c)) continue;
      const last = have[from + want.length - 1]!;
      return [have[from]![0], last[0] + last[2]];
    }
    return null;
  };
  const found = tryFind(wanted);
  if (found !== null) return found;
  // A stop or comma copied at the end that the narration doesn't have there.
  let end = wanted.length;
  while (end > 0 && !isAlphanumeric(wanted[end - 1])) end--;
  return end === 0 ? null : tryFind(wanted.slice(0, end));
}

/** Every clip the draft plays: the montage, then each paragraph's. */
export function cites(draft: Draft): Cite[] {
  return [
    ...draft.open,
    ...draft.sections.flatMap((section) =>
      section.paragraphs.flatMap((paragraph) => paragraph.pieces.flatMap((piece) => (piece.kind === "clip" ? [piece] : []))),
    ),
  ];
}

/** Words the narrator reads. Headings go on screen. */
export function draftWords(draft: Draft): number {
  return draft.sections
    .flatMap((section) => section.paragraphs.flatMap((paragraph) => paragraph.pieces))
    .reduce((sum, piece) => sum + (piece.kind === "say" ? splitWhitespace(piece.text).length : 0), 0);
}

/** Gives every paragraph without an id one; says whether any was given. */
export function ensureIds(draft: Draft): boolean {
  const taken = new Set(draft.sections.flatMap((section) => section.paragraphs.map((paragraph) => paragraph.id ?? "")));
  let given = false;
  for (const paragraph of draft.sections.flatMap((section) => section.paragraphs)) {
    if (paragraph.id) continue;
    let id = freshId();
    while (taken.has(id)) id = freshId();
    taken.add(id);
    paragraph.id = id;
    given = true;
  }
  return given;
}

const freshId = (): string => `p${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

/** How long the narration and the clips run, ms: (narration, clips). */
export function timing(draft: Draft): [number, number] {
  const narration = Math.floor((draftWords(draft) * 60_000) / WORDS_PER_MINUTE);
  const clips = cites(draft).reduce((sum, cite) => sum + (cite.endMs - cite.startMs), 0);
  return [narration, clips];
}

/**
 * A clip time as plans and timed transcripts write it: "m:ss" or "h:mm:ss",
 * seconds always two digits, a tenth after a point kept ("01:43.5").
 */
export function parseTime(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const [whole, fraction = ""] = parts.at(-1)!.split(/\.(.*)/s);
  if (!/^\d{2}$/.test(whole!) || !/^\d*$/.test(fraction)) return null;
  const seconds = Number(whole);
  if (seconds >= 60) return null;
  let ms = seconds * 1000 + (fraction === "" ? 0 : Number(fraction[0]) * 100);
  const numbers = parts.slice(0, -1).map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : null));
  if (numbers.some((value) => value === null)) return null;
  const [first, second] = numbers as number[];
  if (numbers.length === 1) return ms + first! * 60_000;
  if (second! >= 60) return null;
  ms += first! * 3_600_000 + second! * 60_000;
  return ms;
}

/** A moment as m:ss (h:mm:ss from an hour), whole seconds rounded down. */
export function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

/** A clip on its own line, as the review page and the Doc read it: `[video m:ss–m:ss] "quote"`. */
export function citeLine(cite: Cite): string {
  const quote = cite.quote.trim() === "" ? "" : ` "${cite.quote.trim()}"`;
  return `[${cite.video} ${clock(cite.startMs)}–${clock(cite.endMs)}]${quote}`;
}

/** A paragraph as one text: narration as written, each clip on its own line. */
export function paragraphText(paragraph: Paragraph): string {
  return paragraph.pieces.map((piece) => (piece.kind === "say" ? piece.text : citeLine(piece))).join("\n");
}

/** "2 min 5 s", or "45 s". */
export function minutes(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`;
}
