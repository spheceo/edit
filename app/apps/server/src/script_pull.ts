// A project's script Doc read again after the edit was made from it (Oct 31,
// the team: start and end words added to CORRUPT Cops' Doc by hand, "we want
// to detect changes to the project and be able to refresh and pull those
// changes"). The Doc's blocks are matched to the script's in order; a footage
// range whose times or words changed takes the Doc's and its clip is cut to
// them again (realign), every other clip staying as the editor left it. What
// code can't decide alone (narration rewritten, ranges added or taken out) is
// reported for the agent to carry out. A range the Doc made longer than the
// footage downloaded for it gets a new excerpt of its original, cut from the
// cloud as the import cut the first, and its clip plays from that.

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { importMade } from "./import.ts";
import type { Project, ScriptBlock } from "./model.ts";
import { mediaOf, REUSE_LABEL, WHOLE_SOURCE_LABEL } from "./project.ts";
import * as script from "./script.ts";
import * as seams from "./seams.ts";
import * as youtube from "./youtube.ts";

type Footage = Extract<ScriptBlock, { kind: "footage" }>;
type Narration = Extract<ScriptBlock, { kind: "narration" }>;

export interface PullReport {
  doc: string;
  /** Footage ranges the Doc changed: taken, and their clips cut again when `apply`. */
  ranges: { clip: string | null; was: string; now: string; words: [string, string] | null; beyond?: string }[];
  /** Narration the Doc rewrote: the cut-in to speak again. */
  narration: { clip: string | null; was: string; now: string }[];
  /** Doc blocks the script doesn't have, after the script block they follow (null: at the start). */
  added: { after: string | null; block: string }[];
  /** Script blocks the Doc no longer has. */
  removed: { clip: string | null; block: string }[];
  /** Ranges given a new excerpt of their original, the footage downloaded before ending short of them, when applied. */
  footage?: { clip: string | null; range: string; media: string; covers: string }[];
  /** What realign moved, when applied. */
  recut?: unknown[];
}

const plain = (label: string) => label.replaceAll("‑", "-").replace(/\s+/gu, "");
const words = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean));

/** Whether a Doc block is the script block, changed or not. */
function same(was: ScriptBlock, now: ScriptBlock): boolean {
  if (was.kind === "footage" && now.kind === "footage") {
    return was.file === now.file && (plain(was.label) === plain(now.label) || (was.start < now.end && now.start < was.end));
  }
  if (was.kind === "narration" && now.kind === "narration") {
    if (was.text.trim() === now.text.trim()) return true;
    // A rewrite keeps most of its words.
    const [a, b] = [words(was.text), words(now.text)];
    const shared = [...a].filter((word) => b.has(word)).length;
    return shared / Math.max(a.size, b.size, 1) >= 0.5;
  }
  return false;
}

/** The script's blocks paired with the Doc's, in order (the longest run of matches): [script index, Doc index]. */
export function pair(was: ScriptBlock[], now: ScriptBlock[]): [number, number][] {
  const longest = Array.from({ length: was.length + 1 }, () => new Array<number>(now.length + 1).fill(0));
  for (let i = was.length - 1; i >= 0; i--) {
    for (let j = now.length - 1; j >= 0; j--) {
      longest[i]![j] = same(was[i]!, now[j]!) ? longest[i + 1]![j + 1]! + 1 : Math.max(longest[i + 1]![j]!, longest[i]![j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let [i, j] = [0, 0];
  while (i < was.length && j < now.length) {
    if (same(was[i]!, now[j]!) && longest[i]![j] === longest[i + 1]![j + 1]! + 1) pairs.push([i++, j++]);
    else if (longest[i + 1]![j]! >= longest[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/** A whole video (reused, or a case's footage whole) plays to its end, whatever its times in the Doc: only a range can change. */
const whole = (block: Footage) => block.label === REUSE_LABEL || block.label === WHOLE_SOURCE_LABEL;

const rangeChanged = (was: Footage, now: Footage): boolean =>
  !whole(was) && (was.start !== now.start || was.end !== now.end || JSON.stringify(was.words ?? null) !== JSON.stringify(now.words ?? null));

const named = (block: ScriptBlock): string => (block.kind === "footage" ? `footage ${block.label}` : `"${block.text.slice(0, 80)}${block.text.length > 80 ? "…" : ""}"`);

/** What changed between the script and the Doc as it is now. */
export function compare(was: ScriptBlock[], now: ScriptBlock[], doc: string, beyond: (block: Footage, start: number, end: number) => string | null = () => null): PullReport {
  const report: PullReport = { doc, ranges: [], narration: [], added: [], removed: [] };
  const pairs = pair(was, now);
  const paired = new Map(pairs);
  const taken = new Set(pairs.map(([, j]) => j));
  for (const [i, j] of pairs) {
    const [a, b] = [was[i]!, now[j]!];
    if (a.kind === "footage" && b.kind === "footage" && rangeChanged(a, b)) {
      const past = beyond(a, b.start, b.end);
      report.ranges.push({ clip: a.clip ?? null, was: a.label, now: b.label, words: b.words ?? null, ...(past === null ? {} : { beyond: past }) });
    }
    if (a.kind === "narration" && b.kind === "narration" && a.text.trim() !== b.text.trim()) report.narration.push({ clip: (a as Narration).clip ?? null, was: a.text, now: b.text });
  }
  was.forEach((block, i) => {
    if (!paired.has(i)) report.removed.push({ clip: block.clip ?? null, block: named(block) });
  });
  now.forEach((block, j) => {
    if (taken.has(j)) return;
    // After the last script block paired before it.
    const before = pairs.filter(([, k]) => k < j).at(-1);
    report.added.push({ after: before === undefined ? null : named(was[before[0]]!), block: named(block) });
  });
  return report;
}

/** The Doc's blocks as they are now. */
async function readDoc(doc: string): Promise<ScriptBlock[]> {
  const [html, title] = await script.fetchDoc(doc);
  const parsed = script.parse(html);
  await script.joinCases(parsed, async (other) => (await script.fetchDoc(other))[0], new Set([doc]));
  if (!parsed.blocks.some((block) => block.kind === "footage")) throw new Error(`${title || "The Doc"} has no linked footage ranges now.`);
  return parsed.blocks;
}

/** The script compared with the Doc, a footage range longer than its downloaded footage said so. */
function compared(project: Project, now: ScriptBlock[]): PullReport {
  return compare(project.script?.blocks ?? [], now, project.script?.source ?? "", (block, start, end) => beyond(project, block, start, end));
}

/** Why a range's footage can't play all of start–end (what was downloaded covers less), or null when it can. */
function beyond(project: Project, block: Footage, start: number, end: number): string | null {
  const media = block.media === undefined || block.media === null ? undefined : mediaOf(project, block.media);
  if (media === undefined) return null;
  const from = block.media_start ?? 0;
  const to = from + media.duration;
  if (start >= from - 0.05 && end <= to + 0.05) return null;
  return `the footage downloaded covers ${clock(from)}-${clock(to)} of the file: the rest needs downloading`;
}

/** The Doc's ranges, by their placed clip, whose footage ends short of them (the Doc made them longer since the import). */
function short(project: Project, now: ScriptBlock[]): Map<string, { file: string; start: number; end: number; label: string }> {
  const was = project.script?.blocks ?? [];
  const out = new Map<string, { file: string; start: number; end: number; label: string }>();
  for (const [i, j] of pair(was, now)) {
    const [a, b] = [was[i]!, now[j]!];
    if (a.kind !== "footage" || b.kind !== "footage" || whole(a) || a.clip === undefined || a.clip === null) continue;
    if (beyond(project, a, b.start, b.end) !== null) out.set(a.clip, { file: a.file, start: b.start, end: b.end, label: b.label });
  }
  return out;
}

/**
 * A new excerpt of a YouTube original covering start–end, cut from the cloud
 * as the import cut the first (the original's in the registry: only the
 * excerpt is made), added to the project as media. Null for footage of
 * another kind (a Drive file's range is still reported as short).
 */
async function widen(app: App, id: string, file: string, start: number, end: number): Promise<{ media: string; from: number; to: number } | null> {
  if (youtube.idOf(file) === null) return null;
  const cut = await seams.cloudMedia.youtubeExcerpts(app.store.home, app.store.cacheDir(), file, [[start, end]]);
  const excerpt = cut.find((one) => one.from <= start + 0.05 && one.to >= end - 0.05);
  if (excerpt === undefined || excerpt.cloud === null) return null;
  const [, ids, errors] = await importMade(app, id, [excerpt.cloud], false, "agent");
  if (errors.length > 0 || ids[0] === undefined) throw new Error(`the new footage for ${file} couldn't be added: ${errors.join("; ")}`);
  return { media: ids[0], from: excerpt.from, to: excerpt.to };
}

/** What the editor's bar shows, the Doc read at most every CHECK_MS per project; an edit not made from a Doc has nothing to pull. */
const CHECK_MS = 60_000;
const checked = new Map<string, { at: number; doc: string; blocks: ScriptBlock[] }>();

export async function changes(app: App, id: string): Promise<PullReport> {
  const live = app.store.get(id);
  if (live === null) throw new Error("no such project");
  const source = live.project.script?.source ?? "";
  const doc = script.docId(source);
  if (doc === null) return { doc: "", ranges: [], narration: [], added: [], removed: [] };
  let kept = checked.get(id);
  if (kept === undefined || kept.doc !== doc || Date.now() - kept.at > CHECK_MS) {
    kept = { at: Date.now(), doc, blocks: await readDoc(doc) };
    checked.set(id, kept);
  }
  return compared(live.project, kept.blocks);
}

/** Reads the project's script Doc again and compares it with the script; `apply` takes the changed ranges and cuts their clips again. */
export async function pull(app: App, id: string, apply: boolean): Promise<PullReport> {
  const live = app.store.get(id);
  if (live === null) throw new Error("no such project");
  const source = live.project.script?.source ?? "";
  const doc = script.docId(source);
  if (doc === null) throw new Error("This edit wasn't made from a script Doc, so there's nothing to pull.");
  const now = await readDoc(doc);
  checked.set(id, { at: Date.now(), doc, blocks: now });
  // Only reading: the project isn't saved again.
  if (!apply) return compared(live.project, now);
  // Footage for the ranges the Doc made longer than what was downloaded, before the one save that takes it all.
  const widened = new Map<string, { media: string; from: number; to: number; label: string }>();
  for (const [clip, range] of short(live.project, now)) {
    try {
      const got = await widen(app, id, range.file, range.start, range.end);
      if (got !== null) widened.set(clip, { ...got, label: range.label });
    } catch (error) {
      diag.warn("script", `${id}: ${range.label} needs more footage than was downloaded, and fetching it failed: ${diag.messageOf(error)}`);
    }
  }
  let report: PullReport | null = null;
  const touched = new Set<string>();
  await app.store.update(id, "agent", (project) => {
    const was = project.script?.blocks ?? [];
    // The range and its clips (picture and linked sound) play from the new excerpt: the same moments, another file.
    for (const block of was) {
      const found = block.kind === "footage" && block.clip !== undefined && block.clip !== null ? widened.get(block.clip) : undefined;
      if (found === undefined || block.kind !== "footage" || block.clip === undefined || block.clip === null) continue;
      const [old, offset] = [block.media, block.media_start ?? 0];
      const clip = project.clips.find((one) => one.id === block.clip);
      for (const one of project.clips) {
        if (one.type !== "video" && one.type !== "audio") continue;
        if (one.media !== old || !(one.id === block.clip || (clip?.link !== undefined && clip.link !== null && one.link === clip.link))) continue;
        one.source_in += offset - found.from;
        one.media = found.media;
      }
      block.media = found.media;
      block.media_start = found.from;
      touched.add(block.clip);
    }
    report = compared(project, now);
    for (const [i, j] of pair(was, now)) {
      const [a, b] = [was[i]!, now[j]!];
      if (a.kind !== "footage" || b.kind !== "footage" || !rangeChanged(a, b)) continue;
      Object.assign(a, { url: b.url, label: b.label, start: b.start, end: b.end });
      if (b.notes === undefined) delete a.notes;
      else a.notes = b.notes;
      if (b.words === undefined || b.words === null) delete a.words;
      else a.words = b.words;
      delete a.cut;
      if (a.clip !== undefined && a.clip !== null) touched.add(a.clip);
    }
  });
  if (report === null) throw new Error("no such project");
  const done = report as PullReport;
  if (widened.size > 0) done.footage = [...widened].map(([clip, got]) => ({ clip, range: got.label, media: got.media, covers: `${clock(got.from)}-${clock(got.to)}` }));
  if (apply && touched.size > 0) done.recut = await script.realign(app, id, null, touched);
  return done;
}

const clock = (seconds: number): string => {
  const whole = Math.floor(seconds);
  const [h, m, s] = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};
