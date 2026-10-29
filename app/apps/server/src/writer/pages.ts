// How many Letter pages a footage script runs, worked out from its text
// alone, as Repack's scriptPages does (apps/web/src/domain/script-pages.ts):
// 12 pt Arial at 1.15 on a Letter sheet's text area, a 19 pt bold heading, a
// timestamp line or cut-in that would cross the bottom starting the next page
// whole. A compilation's script runs 6 to 7 pages.

import type { Clip, Script } from "@edit/types/writer";

import ARIAL from "./arial.json" with { type: "json" };
import { isCutIn, stamp } from "./blocks.ts";
import { style } from "./formats.ts";
import { partAt } from "./tidy.ts";

/** The page's geometry in CSS px. */
const WIDTH = 624;
const HEIGHT = 864;
const TEXT = 16;
const LINE = 18.4;
const HEADING = (19 * 96) / 72;
const RANGE_GAP = 4.8;

/** A compilation's script, in pages. */
export const COMPILATION_PAGES: [number, number] = [6, 7];

interface Face {
  widths: Record<string, number>;
  pairs: Record<string, number>;
}

const FACES = ARIAL as { regular: Face; bold: Face };

/** Arial's advance widths and kerning pairs, as Repack measured them in Chrome. */
export function textWidth(text: string, px: number, bold: boolean): number {
  const face = bold ? FACES.bold : FACES.regular;
  const digit = face.widths["0"] ?? 556;
  let total = 0;
  let previous: string | null = null;
  for (const char of text) {
    total += face.widths[char] ?? digit;
    if (previous !== null) total += face.pairs[previous + char] ?? 0;
    previous = char;
  }
  return (total * px) / 1000;
}

/** Lines a paragraph takes when wrapped at spaces, a word wider than the line broken wherever it must be. */
export function lineCount(text: string, px: number, bold: boolean): number {
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    lines++;
    let line = "";
    for (const word of paragraph.split(" ")) {
      const next = line === "" ? word : `${line} ${word}`;
      if (textWidth(next, px, bold) <= WIDTH) {
        line = next;
        continue;
      }
      if (line !== "") lines++;
      line = word;
      while (textWidth(line, px, bold) > WIDTH) {
        const chars = [...line];
        let fit = 1;
        while (fit + 1 <= chars.length && textWidth(chars.slice(0, fit + 1).join(""), px, bold) <= WIDTH) fit++;
        line = chars.slice(fit).join("");
        lines++;
      }
    }
  }
  return lines;
}

/** A range as the script prints it: on its own recording's clock, marked when the recording is audio only. */
function clipRange(clip: Clip, script: Script): string {
  const parts = script.parts ?? [];
  const part = parts.length > 1 ? parts[partAt(parts, clip.startMs)] : undefined;
  const offset = part?.startMs ?? 0;
  return `${part?.audio ? "Audio " : ""}${stamp(Math.max(0, clip.startMs - offset))}–${stamp(Math.max(0, clip.endMs - offset))}`;
}

/** The script's title line, as its Doc heads it. */
export function heading(script: Script): string {
  const own = script.heading?.trim();
  if (own) return own;
  const series = script.kind === "foia" ? "FOIA" : script.kind === "courtroom" ? "COURT" : "INTERRO";
  const suspects = script.suspects ?? [];
  return script.compilation || suspects.length === 0 ? `${series} ${script.title}` : `${series} ${suspects.join(" & ")} - ${script.title}`;
}

/** How many of the script's assets it lists: a compilation's videos, else its one link. */
function assetCount(script: Script): number {
  const link = (url: string) => (url.startsWith("http://") || url.startsWith("https://")) && !/\s/u.test(url);
  const parts = script.parts ?? [];
  // A reused case's footage is linked from its transition, not listed.
  const urls = parts.filter((part) => part.reuse === undefined).flatMap((part) => (part.url !== undefined && link(part.url) ? [part.url] : []));
  if (script.compilation) return urls.length;
  // One case across videos lists each video once.
  if (script.sourceKind === "compilation" && parts.length > 1) return new Set(urls).size;
  return link(script.sourceUrl) ? 1 : 0;
}

/** How many Letter pages the script runs, as its Doc lays it out. */
export function pageCount(script: Script, clips: Clip[]): number {
  const assets = assetCount(script);
  let used = lineCount(heading(script), HEADING, true) * HEADING * 1.15 + 32 + (assets > 0 ? LINE + 6 : 0) + assets * LINE + (16 + LINE);
  let gap = 32;
  let page = 0;
  const place = (taken: number, height: number, keep: number) => {
    const top = used + taken;
    if (top > 1 && top + height + keep > HEIGHT + 1) {
      page++;
      used = height;
    } else used = top + height;
  };
  // Blocks: the footage before each cut-in, and that cut-in.
  const blocks: [Clip[], Clip | null][] = [];
  let footage: Clip[] = [];
  for (const clip of clips) {
    if (isCutIn(clip)) {
      blocks.push([footage, clip]);
      footage = [];
    } else footage.push(clip);
  }
  if (footage.length > 0) blocks.push([footage, null]);
  // Where a compilation's cases start: its transitions, and a hidden one's first block.
  const hidden = style(script.title) === "hidden";
  const starts = script.compilation ? blocks.flatMap(([own], index) => (own.length === 0 || (index === 0 && hidden) ? [index] : [])) : [];
  const running = script.kind === "courtroom" && !script.compilation;
  const narrationLines = (cue: Clip) => lineCount(cue.narration ?? "", TEXT, false);
  for (const [index, [own, cue]] of blocks.entries()) {
    const divider = starts.indexOf(index) > 0;
    if (own.length > 0) {
      let rows = 1;
      let row = 0;
      for (const [at, clip] of own.entries()) {
        const pieces: number[] = [];
        if (at > 0) pieces.push(textWidth("+", TEXT, false));
        pieces.push(textWidth("(", TEXT, false) + textWidth(clipRange(clip, script), TEXT, false) + textWidth(")", TEXT, false));
        for (const piece of pieces) {
          if (row > 0 && row + RANGE_GAP + piece > WIDTH) {
            rows++;
            row = piece;
          } else row += (row > 0 ? RANGE_GAP : 0) + piece;
        }
      }
      if (divider) {
        place(gap, LINE, 16 + rows * LINE);
        gap = 16;
      }
      place(gap, rows * LINE, 0);
      gap = running ? (cue !== null && index === 0 ? 16 : 0) : cue !== null ? 16 : 32;
    }
    if (cue !== null) {
      if (divider && own.length === 0) {
        place(gap, LINE, 16 + narrationLines(cue) * LINE);
        gap = 16;
      }
      place(gap, narrationLines(cue) * LINE, 0);
      gap = running ? 0 : 32;
    }
  }
  if (script.kind === "courtroom") place(32, LINE, 0);
  return page + 1;
}
