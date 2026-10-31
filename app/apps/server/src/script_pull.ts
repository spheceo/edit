// A project's script Doc read again after the edit was made from it (Oct 31,
// the team: start and end words added to CORRUPT Cops' Doc by hand, "we want
// to detect changes to the project and be able to refresh and pull those
// changes"). The Doc's blocks are matched to the script's in order; a footage
// range whose times or words changed takes the Doc's and its clip is cut to
// them again (realign), every other clip staying as the editor left it. What
// code can't decide alone (narration rewritten, ranges added or taken out) is
// reported for the agent to carry out.

import type { App } from "./app.ts";
import type { ScriptBlock } from "./model.ts";
import { mediaOf } from "./project.ts";
import * as script from "./script.ts";

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

const rangeChanged = (was: Footage, now: Footage): boolean =>
  was.start !== now.start || was.end !== now.end || JSON.stringify(was.words ?? null) !== JSON.stringify(now.words ?? null);

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

/** Reads the project's script Doc again and compares it with the script; `apply` takes the changed ranges and cuts their clips again. */
export async function pull(app: App, id: string, apply: boolean): Promise<PullReport> {
  const live = app.store.get(id);
  if (live === null) throw new Error("no such project");
  const source = live.project.script?.source ?? "";
  const doc = script.docId(source);
  if (doc === null) throw new Error("This edit wasn't made from a script Doc, so there's nothing to pull.");
  const [html, title] = await script.fetchDoc(doc);
  const parsed = script.parse(html);
  await script.joinCases(parsed, async (other) => (await script.fetchDoc(other))[0], new Set([doc]));
  const now = parsed.blocks;
  if (!now.some((block) => block.kind === "footage")) throw new Error(`${title || "The Doc"} has no linked footage ranges now.`);
  let report: PullReport | null = null;
  const touched = new Set<string>();
  await app.store.update(id, "agent", (project) => {
    const was = project.script?.blocks ?? [];
    // The footage downloaded for a range covers only so much of its file.
    const beyond = (block: Footage, start: number, end: number): string | null => {
      const media = block.media === undefined || block.media === null ? undefined : mediaOf(project, block.media);
      if (media === undefined) return null;
      const from = block.media_start ?? 0;
      const to = from + media.duration;
      if (start >= from - 0.05 && end <= to + 0.05) return null;
      return `the footage downloaded covers ${clock(from)}-${clock(to)} of the file: the rest needs downloading`;
    };
    report = compare(was, now, source, beyond);
    if (!apply) return;
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
  if (apply && touched.size > 0) done.recut = await script.realign(app, id, null, touched);
  return done;
}

const clock = (seconds: number): string => {
  const whole = Math.floor(seconds);
  const [h, m, s] = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};
