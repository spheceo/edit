// What reviews taught commentary builds: kept lessons (`<data>/lessons.json`,
// synced as `writer/lessons.json` so every Mac's builds read the same), and a
// draft as text with each block's place, as lessons and the story editor read it.

import * as fs from "node:fs";

import type { Cite, Draft, Lesson } from "@edit/types/writer";

import { writeAtomic } from "../files.ts";
import { join } from "../paths.ts";
import { clock } from "./paragraphs.ts";

/** The kept lessons, and the ids of those forgotten, so a Mac that still has one doesn't bring it back when the cloud merges them. */
export interface Shelf {
  lessons: Lesson[];
  forgotten: string[];
}

const path = (data: string): string => join(data, "lessons.json");

export function readShelf(data: string): Shelf {
  try {
    const shelf = JSON.parse(fs.readFileSync(path(data), "utf8")) as Partial<Shelf>;
    return { lessons: shelf.lessons ?? [], forgotten: shelf.forgotten ?? [] };
  } catch {
    return { lessons: [], forgotten: [] };
  }
}

/** Hooks: the cloud takes a changed shelf soon (cloud.ts sets it). */
export const hooks = { changed: () => {} };

/** Changes the shelf (one change at a time: JavaScript runs them in turn) and has the cloud take it soon. */
export function changeShelf<T>(data: string, change: (shelf: Shelf) => T): T {
  const shelf = readShelf(data);
  const out = change(shelf);
  writeAtomic(path(data), JSON.stringify(shelf));
  hooks.changed();
  return out;
}

/** Two shelves as one: every lesson either has (the later keep of one id wins), less every one forgotten on either. */
export function merge(a: Shelf, b: Shelf): Shelf {
  const forgotten = [...new Set([...a.forgotten, ...b.forgotten])].sort();
  const lessons: Lesson[] = [];
  for (const lesson of [...a.lessons, ...b.lessons]) {
    if (forgotten.includes(lesson.id)) continue;
    const at = lessons.findIndex((known) => known.id === lesson.id);
    if (at < 0) lessons.push(lesson);
    else if (lesson.keptAt > lessons[at]!.keptAt) lessons[at] = lesson;
  }
  lessons.sort((x, y) => x.keptAt - y.keptAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return { lessons, forgotten };
}

export const lessons = (data: string): Lesson[] => readShelf(data).lessons;

/** The lesson's text without its "# Lesson: …" line, which the title gives. */
function withoutTitle(text: string): string {
  const trimmed = text.trim();
  const at = trimmed.indexOf("\n");
  return at >= 0 && trimmed.startsWith("# ") ? trimmed.slice(at + 1).trim() : trimmed;
}

/** Every kept lesson as one text for a build's system prompt; `except` leaves out the one learned from that pull (a round testing it). */
export function lessonsText(data: string, except: { script: string; at: number } | null = null): string {
  return lessons(data)
    .filter((lesson) => except === null || !(lesson.script === except.script && lesson.pulledAt === except.at))
    .map((lesson) => `## ${lesson.title}\n${withoutTitle(lesson.text)}`)
    .join("\n\n");
}

/** A draft's blocks as reviewers place them: "Montage clip 1", "2. The Rise ¶3", "Check 2". */
export interface Placed {
  place: string;
  text: string;
}

const citeText = (cite: Cite): string => `[CLIP ${cite.video} ${clock(cite.startMs)}-${clock(cite.endMs)}${cite.quote.trim() === "" ? "" : `: "${cite.quote.trim()}"`}]`;

export function placedBlocks(draft: Draft): Placed[] {
  const out: Placed[] = draft.open.map((cite, index) => ({ place: `Montage clip ${index + 1}`, text: citeText(cite) }));
  for (const section of draft.sections) {
    out.push({ place: section.heading, text: `HEADING: ${section.heading}` });
    section.paragraphs.forEach((paragraph, index) => {
      let text = paragraph.pieces.map((piece) => (piece.kind === "say" ? piece.text.trim() : citeText(piece))).join(" ");
      if (paragraph.note !== undefined) text += ` [NOTE FOR EDITOR: ${paragraph.note.trim()}]`;
      out.push({ place: `${section.heading} ¶${index + 1}`, text });
    });
  }
  draft.checks.forEach((check, index) => out.push({ place: `Check ${index + 1}`, text: `CHECK: ${check}` }));
  return out;
}

/** The draft as one text, each block led by its place. */
export const scriptText = (draft: Draft): string => placedBlocks(draft).map((block) => `[${block.place}] ${block.text}`).join("\n");
