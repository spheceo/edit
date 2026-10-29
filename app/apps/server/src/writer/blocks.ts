// A script as blocks of text, each with an id that stays as the script is
// edited: what a review link shows and its notes anchor to, and what a fix is
// measured on. A footage script's blocks are its timeline items (a footage
// clip's words, a cut-in's narration); a commentary's are its montage, its
// section headings and its paragraphs. Offsets are UTF-16 units, as the
// review page counts them.

import type { Clip, Draft, Paragraph, Part, Script } from "@edit/types/writer";

import { splitWhitespace } from "../rust.ts";
import { citeLine, liveMarks, noteLines, paragraphText, WORDS_PER_MINUTE } from "./paragraphs.ts";

export { paragraphText };

export interface Popup {
  who: string;
  words: string;
  video: string;
  link?: string;
  startMs: number;
  endMs: number;
}

/** An edit note's words: offsets into the block's text, and the words there. */
export interface EditMark {
  note: number;
  start: number;
  end: number;
  quote: string;
  popup?: Popup;
}

export interface Block {
  id: string;
  kind: "footage" | "narration" | "montage" | "heading" | "paragraph";
  /** What a footage clip is printed as in the Doc: its range ("Audio 1:02–1:40"). */
  label?: string;
  text: string;
  /** A footage clip's transcript just outside it, for "start earlier" / "end later" notes. */
  before?: string;
  after?: string;
  /** Where a footage clip plays in the preview, ms. */
  previewMs?: [number, number];
  /** Each word of `text`, in order, as [start, end] ms in the preview. */
  words?: [number, number][];
  /** How long narration takes to read, at the channel's 150 words a minute. */
  readMs?: number;
  /** How long the block runs: a clip's length, narration's read time. */
  durationMs?: number;
  /** Notes for the video editor on it ("edit: …"). */
  editNotes?: string[];
  /** The words an edit note is on, when it's on part of the block. */
  editMarks?: EditMark[];
}

/** Part of a block's text a fix changed; empty (`start === end`) where something was taken out. */
export interface Range {
  blockId: string;
  start: number;
  end: number;
}

export const isCutIn = (clip: Clip): boolean => clip.kind === "cut-in";

/** Narration is read at the channel's pace. */
export function readMs(text: string): number {
  return Math.floor((splitWhitespace(text).length * 60_000) / WORDS_PER_MINUTE);
}

/** A commentary paragraph's note, every line of it, for Edit's agent: a line without "edit:" gets it. */
export function editorLines(notes: Iterable<string>): string[] {
  return [...notes]
    .flatMap((note) => note.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => (line.toLowerCase().startsWith("edit:") ? line : `edit: ${line}`));
}

/** The `edit:` lines of a note or notes. */
export function editLines(notes: Iterable<string>): string[] {
  return [...notes].flatMap((note) => note.split("\n")).map((line) => line.trim()).filter((line) => line.toLowerCase().startsWith("edit:"));
}

/** Words of context either side of a footage clip. */
const CONTEXT_WORDS = 25;

export function blocksOf(script: Script): Block[] {
  if (script.commentary) return script.commentary.draft ? commentaryBlocks(script.commentary.draft) : [];
  return footageBlocks(script);
}

export type Side = "text" | "before" | "after";

/** A footage clip's words as its block shows them: each word's index and its span in the stretch's text. */
export function wordSpans(script: Script, clip: Clip, side: Side): [number, number, number][] {
  const words = script.words;
  let indexes: number[];
  if (side === "text") indexes = words.flatMap((word, at) => (word.startMs < clip.endMs && word.endMs > clip.startMs ? [at] : []));
  else if (side === "before") indexes = words.flatMap((word, at) => (word.endMs <= clip.startMs ? [at] : [])).slice(-CONTEXT_WORDS);
  else indexes = words.flatMap((word, at) => (word.startMs >= clip.endMs ? [at] : [])).slice(0, CONTEXT_WORDS);
  let at = 0;
  return indexes.map((index) => {
    const word = words[index]!;
    const length = (script.corrections?.[word.id] ?? word.text).length;
    const span: [number, number, number] = [index, at, at + length];
    at += length + 1;
    return span;
  });
}

function spoken(script: Script, indexes: number[]): string {
  return indexes.map((at) => script.corrections?.[script.words[at]!.id] ?? script.words[at]!.text).join(" ");
}

function footageBlocks(script: Script): Block[] {
  return script.clips.map((clip): Block => {
    const editNotes = editLines((clip.notes ?? []).map((note) => note.text));
    if (isCutIn(clip)) {
      const text = clip.narration ?? "";
      const read = readMs(text);
      return { id: clip.id, kind: "narration", text, readMs: read, durationMs: read, ...(editNotes.length ? { editNotes } : {}) };
    }
    const inside = wordSpans(script, clip, "text");
    const context = (side: Side) => {
      const found = wordSpans(script, clip, side);
      return found.length === 0 ? undefined : spoken(script, found.map(([index]) => index));
    };
    const before = context("before");
    const after = context("after");
    return {
      id: clip.id,
      kind: "footage",
      label: range(clip.startMs, clip.endMs, script.parts ?? []),
      text: spoken(script, inside.map(([index]) => index)),
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      previewMs: [clip.startMs, clip.endMs],
      ...(inside.length ? { words: inside.map(([index]): [number, number] => [script.words[index]!.startMs, script.words[index]!.endMs]) } : {}),
      durationMs: Math.max(0, clip.endMs - clip.startMs),
      ...(editNotes.length ? { editNotes } : {}),
    };
  });
}

function commentaryBlocks(draft: Draft): Block[] {
  const out: Block[] = [];
  // The team's layout (and the Doc's): the first section's heading, the montage line under it, then its paragraphs.
  let montage: Block | null =
    draft.open.length === 0
      ? null
      : {
          id: "open",
          kind: "montage",
          text: draft.open.map(citeLine).join("\n"),
          durationMs: draft.open.reduce((sum, cite) => sum + Math.max(0, cite.endMs - cite.startMs), 0),
        };
  const takeMontage = () => {
    if (montage !== null) out.push(montage);
    montage = null;
  };
  if (draft.sections.every((section) => section.paragraphs.length === 0)) takeMontage();
  for (const section of draft.sections) {
    const first = section.paragraphs[0];
    if (first !== undefined) {
      out.push({ id: `${first.id ?? ""}:heading`, kind: "heading", text: section.heading });
      takeMontage();
    }
    for (const paragraph of section.paragraphs) {
      const words = paragraph.pieces.flatMap((piece) => (piece.kind === "say" ? [piece.text] : [])).join(" ");
      const clips = paragraph.pieces.reduce((sum, piece) => sum + (piece.kind === "clip" ? Math.max(0, piece.endMs - piece.startMs) : 0), 0);
      const read = readMs(words);
      const editNotes = editorLines(paragraph.note === undefined ? [] : [paragraph.note]);
      const editMarks = marksOf(paragraph);
      out.push({
        id: paragraph.id ?? "",
        kind: "paragraph",
        text: paragraphText(paragraph),
        readMs: read,
        durationMs: read + clips,
        ...(editNotes.length ? { editNotes } : {}),
        ...(editMarks.length ? { editMarks } : {}),
      });
    }
  }
  return out;
}

/** Where in a paragraph's block text each of its marked notes is (its lines are `editNotes` in order). */
export function marksOf(paragraph: Paragraph): EditMark[] {
  const lines = noteLines(paragraph);
  const spans = pieceSpans(paragraph);
  return liveMarks(paragraph).flatMap(([mark, [piece, start, end]]): EditMark[] => {
    const one = paragraph.pieces[piece];
    if (one?.kind !== "say") return [];
    const note = lines.indexOf(mark.line.trim());
    if (note < 0) return [];
    const at = spans[piece]![0];
    const popup = mark.quote
      ? {
          who: mark.quote.who,
          words: mark.quote.said.quote.trim(),
          video: mark.quote.said.video,
          ...(mark.quote.said.link ? { link: mark.quote.said.link } : {}),
          startMs: mark.quote.said.startMs,
          endMs: mark.quote.said.endMs,
        }
      : undefined;
    return [{ note, start: at + start, end: at + end, quote: one.text.slice(start, end), ...(popup ? { popup } : {}) }];
  });
}

/** A paragraph's pieces with their spans in its block text (each on its own line). */
export function pieceSpans(paragraph: Paragraph): [number, number][] {
  let at = 0;
  return paragraph.pieces.map((piece) => {
    const length = (piece.kind === "say" ? piece.text : citeLine(piece)).length;
    const span: [number, number] = [at, at + length];
    at += length + 1;
    return span;
  });
}

/** A place in the script to jump to, for the review page's outline rail. */
export interface Mark {
  blockId: string;
  title: string;
  /** `section`, `case` (a compilation's) or `recording` (a joined case's). */
  kind: string;
}

/** Where the script's parts begin: a commentary's sections; a footage script's opening, each case or recording, its ending. */
export function outline(script: Script, blocks: Block[]): Mark[] {
  const mark = (blockId: string, title: string, kind: string): Mark => ({ blockId, title, kind });
  if (script.commentary) {
    const headed = blocks.some((block) => block.kind === "heading");
    return blocks.flatMap((block) => {
      // The montage belongs to the first section, under its heading, as in the Doc.
      if (block.kind === "montage" && !headed) return [mark(block.id, "Montage", "section")];
      if (block.kind === "heading") return [mark(block.id, block.text, "section")];
      return [];
    });
  }
  const out: Mark[] = [];
  const first = script.clips[0];
  if (first !== undefined) out.push(mark(first.id, "Opening", "section"));
  const parts = script.parts ?? [];
  if (parts.length > 1) {
    let cases = 0;
    for (const [index, part] of parts.entries()) {
      const end = part.startMs + part.durationMs;
      const clip = script.clips.find((one) => !isCutIn(one) && one.startMs >= part.startMs && one.startMs < end);
      if (clip === undefined) continue;
      let title: string;
      let kind: string;
      if (part.reuse !== undefined) [title, kind] = [`Reused: ${part.title}`, "case"];
      else if (script.compilation) [title, kind] = [`Case ${++cases}: ${part.title}`, "case"];
      else [title, kind] = [`Recording ${index + 1}: ${part.title}`, "recording"];
      if (!out.some((kept) => kept.blockId === clip.id)) out.push(mark(clip.id, title, kind));
    }
  }
  const ending = script.clips.findLast((clip) => clip.narrationRole === "conclusion");
  if (ending !== undefined) out.push(mark(ending.id, "Ending", "section"));
  // In play order.
  const order = (id: string) => {
    const at = blocks.findIndex((block) => block.id === id);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  return out.sort((a, b) => order(a.blockId) - order(b.blockId));
}

/** The compilation's own videos, its cases: every part but a reused case's footage. */
export const caseCount = (parts: Part[] = []): number => parts.filter((part) => part.reuse === undefined).length;

/** The format's length, as its guide sets it: [low, aim, high] ms; null where it sets no runtime. */
export function targetMs(script: Script): [number, number, number] | null {
  const minutes = (low: number, aim: number, high: number): [number, number, number] => [low * 60_000, aim * 60_000, high * 60_000];
  if (script.commentary) return null;
  const kind = script.kind ?? "interrogation";
  if (script.compilation) {
    const cases = Math.max(caseCount(script.parts), 1);
    return kind === "courtroom" ? minutes(8 * cases, 10 * cases, 12 * cases) : null;
  }
  if (kind === "foia") return minutes(20, 25, 30);
  if (kind === "courtroom") return minutes(18, 21.5, 25);
  return minutes(30, 40, 50);
}

/** A moment as the Doc prints it: whole seconds, rounded down. */
export function stamp(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

/** A clip's range as the Doc prints it: on its own recording's clock in a joined case, marked when that recording is sound only. */
export function range(startMs: number, endMs: number, parts: Part[]): string {
  let part: Part | undefined;
  if (parts.length > 1) {
    const index = parts.findIndex((one) => startMs < one.startMs + one.durationMs);
    part = parts[index < 0 ? parts.length - 1 : index];
  }
  const offset = part?.startMs ?? 0;
  const audio = part?.audio ? "Audio " : "";
  return `${audio}${stamp(Math.max(0, startMs - offset))}–${stamp(Math.max(0, endMs - offset))}`;
}

/**
 * What changed from `before` to `after`, word by word, on `after`'s text: a
 * new block whole, a block whose words changed by each run of changed words
 * (an empty range where words were only taken out), a footage clip whose range
 * moved whole, and a block taken out by an empty range at the next block kept.
 */
export function changed(before: Block[], after: Block[]): Range[] {
  const out: Range[] = [];
  for (const block of after) {
    const old = before.find((one) => one.id === block.id);
    if (old === undefined) out.push({ blockId: block.id, start: 0, end: block.text.length });
    else if (old.text !== block.text) out.push(...wordRanges(old.text, block.text).map(([start, end]) => ({ blockId: block.id, start, end })));
    else if (old.label !== block.label) out.push({ blockId: block.id, start: 0, end: block.text.length });
  }
  const kept = new Set(after.map((block) => block.id));
  for (const [index, old] of before.entries()) {
    if (kept.has(old.id)) continue;
    const blockId = before.slice(index + 1).find((later) => kept.has(later.id))?.id ?? after.at(-1)?.id;
    if (blockId !== undefined && !out.some((one) => one.blockId === blockId && one.start === 0)) out.push({ blockId, start: 0, end: 0 });
  }
  return out;
}

/** Words with their offsets. */
function wordsOf(text: string): [string, number, number][] {
  const out: [string, number, number][] = [];
  for (const match of text.matchAll(/\S+/gu)) out.push([match[0], match.index, match.index + match[0].length]);
  return out;
}

/** The runs of `after`'s words not in the longest common run with `before`; runs a word or two apart are one. */
function wordRanges(before: string, after: string): [number, number][] {
  const old = wordsOf(before);
  const next = wordsOf(after);
  const n = old.length;
  const m = next.length;
  // Past this, the table is too big to be worth it: the whole block changed.
  if (n * m > 4_000_000) return [[0, after.length]];
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = old[i]![0] === next[j]![0] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  // Walk it: each new word is kept or changed, and each place words were only taken out is marked.
  const changedWords = new Array<boolean>(m).fill(false);
  const removedBefore: number[] = [];
  let i = 0;
  let j = 0;
  let dropped = false;
  while (i < n || j < m) {
    if (i < n && j < m && old[i]![0] === next[j]![0]) {
      if (dropped) {
        removedBefore.push(j);
        dropped = false;
      }
      i++;
      j++;
    } else if (j < m && (i === n || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      changedWords[j] = true;
      dropped = false;
      j++;
    } else {
      dropped = true;
      i++;
    }
  }
  if (dropped) removedBefore.push(m);
  const runs: [number, number][] = [];
  for (let k = 0; k < m; ) {
    if (!changedWords[k]) {
      k++;
      continue;
    }
    const first = k;
    while (k < m && changedWords[k]) k++;
    const start = next[first]![1];
    const end = next[k - 1]![2];
    const last = runs.at(-1);
    // Close enough to the run before (a word or two between): one run.
    if (last !== undefined && next.filter((word) => word[1] >= last[1] && word[2] <= start).length <= 2) last[1] = end;
    else runs.push([start, end]);
  }
  for (const at of removedBefore) {
    if (changedWords[at] === true || (at > 0 && changedWords[at - 1] === true)) continue;
    const point = at < m ? next[at]![1] : after.length;
    if (!runs.some(([start, end]) => point >= start && point <= end)) runs.push([point, point]);
  }
  return runs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
