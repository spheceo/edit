// A footage script's versions, as Repack keeps them: every save records the
// cut as it then stood, the same author's edits within ten minutes merged into
// one version, each with who made it and a line saying what changed.
// Restoring one saves it as the script again, itself a new version. Kept
// beside the script (`versions/`), so they sync with it.

import * as fs from "node:fs";

import type { Script, Snapshot, Version } from "@edit/types/writer";

import { writeAtomic } from "../files.ts";
import { join } from "../paths.ts";
import { isCutIn } from "./blocks.ts";

/** Edits by one author this close together are one version. */
const MERGE_MS = 10 * 60_000;
/** Versions kept; the oldest go first. */
const KEPT = 200;

export type Author = "you" | "claude";

export const snapshotOf = (script: Script): Snapshot => ({ clips: script.clips, corrections: script.corrections ?? {}, heading: script.heading ?? null });

const folder = (dir: string): string => join(dir, "versions");

export function list(dir: string): Version[] {
  try {
    return JSON.parse(fs.readFileSync(join(folder(dir), "index.json"), "utf8")) as Version[];
  } catch {
    return [];
  }
}

export function read(dir: string, id: string): Snapshot {
  if (id === "" || !/^[0-9a-fA-F-]+$/.test(id)) throw new Error("Unknown version.");
  let text: string;
  try {
    text = fs.readFileSync(join(folder(dir), `${id}.json`), "utf8");
  } catch {
    throw new Error("That version is missing.");
  }
  try {
    const snapshot = JSON.parse(text) as Snapshot;
    return { clips: snapshot.clips, corrections: snapshot.corrections ?? {}, heading: snapshot.heading ?? null };
  } catch {
    throw new Error("That version could not be read.");
  }
}

const sameCorrections = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

/** What changed between two cuts, in a line, as Repack's version list says it. */
export function summary(before: Snapshot, after: Snapshot): string {
  const footage = (snap: Snapshot) => new Map(snap.clips.filter((clip) => !isCutIn(clip)).map((clip) => [clip.id, `${clip.startMs}-${clip.endMs}`]));
  const cues = (snap: Snapshot) => new Map(snap.clips.filter(isCutIn).map((clip) => [clip.id, clip.narration ?? ""]));
  const notes = (snap: Snapshot) => snap.clips.reduce((sum, clip) => sum + (clip.notes?.length ?? 0), 0);
  const was = footage(before);
  const now = footage(after);
  const said = cues(before);
  const says = cues(after);
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const kept = [...now.keys()].filter((id) => was.has(id)).length;
  if (was.size > 0 && now.size > 0 && kept === 0) parts.push("Rebuilt the cut");
  else {
    const added = [...now.keys()].filter((id) => !was.has(id)).length;
    const removed = [...was.keys()].filter((id) => !now.has(id)).length;
    const trimmed = [...now].filter(([id, range]) => was.has(id) && was.get(id) !== range).length;
    const order = (snap: Snapshot) => snap.clips.map((clip) => clip.id).filter((id) => was.has(id) && now.has(id)).join("\n");
    if (added > 0) parts.push(`${plural(added, "clip", "clips")} added`);
    if (removed > 0) parts.push(`${plural(removed, "clip", "clips")} removed`);
    if (trimmed > 0) parts.push(`${plural(trimmed, "clip", "clips")} trimmed`);
    if (order(before) !== order(after)) parts.push("clips moved");
  }
  const written = [...says].filter(([id, text]) => text.trim() !== "" && (said.get(id) ?? "").trim() === "").length;
  const rewritten = [...says].filter(([id, text]) => said.has(id) && said.get(id)!.trim() !== "" && said.get(id) !== text).length;
  const cut = [...said.keys()].filter((id) => !says.has(id)).length;
  if (written > 0) parts.push(`wrote ${plural(written, "cut-in", "cut-ins")}`);
  if (rewritten > 0) parts.push(`rewrote ${plural(rewritten, "cut-in", "cut-ins")}`);
  if (cut > 0) parts.push(`${plural(cut, "cut-in", "cut-ins")} removed`);
  const [n0, n1] = [notes(before), notes(after)];
  if (n1 > n0) parts.push(`${plural(n1 - n0, "comment", "comments")} added`);
  else if (n0 > n1) parts.push(`${plural(n0 - n1, "comment", "comments")} deleted`);
  if (!sameCorrections(before.corrections, after.corrections)) parts.push("spelling fixed");
  if ((before.heading ?? null) !== (after.heading ?? null)) parts.push("heading changed");
  if (parts.length === 0) return "No change to the cut";
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** Records a save: `before` as the script was, `after` as it is now. Never fails a save. */
export function keep(dir: string, author: Author, before: Script, after: Script): void {
  try {
    record(dir, author, snapshotOf(before), snapshotOf(after), null);
  } catch {
    // A version that can't be written is skipped.
  }
}

/** Records a restore of the version made at `restored`, never merged with another. */
export function keepRestored(dir: string, before: Script, after: Script, restored: number): void {
  try {
    record(dir, "you", snapshotOf(before), snapshotOf(after), restored);
  } catch {
    // As above.
  }
}

function record(dir: string, author: Author, before: Snapshot, after: Snapshot, restored: number | null): void {
  const root = folder(dir);
  fs.mkdirSync(root, { recursive: true });
  const put = (id: string, snapshot: Snapshot) => writeAtomic(join(root, `${id}.json`), JSON.stringify(snapshot));
  const versions = list(dir);
  const now = Date.now();
  // The first recorded edit keeps the script as it was before it too.
  if (versions.length === 0 && before.clips.length > 0) {
    const id = crypto.randomUUID();
    put(id, before);
    versions.push({ id, at: now - 1, author: "before", summary: "Before the first recorded edit" });
  }
  const last = versions.at(-1);
  const merge = restored === null && last !== undefined && last.author === author && last.restored === undefined && now - last.at < MERGE_MS;
  if (merge) {
    let base = before;
    if (last.base !== undefined) {
      try {
        base = read(dir, last.base);
      } catch {
        base = before;
      }
    }
    put(last.id, after);
    last.at = now;
    last.summary = summary(base, after);
  } else {
    const id = crypto.randomUUID();
    put(id, after);
    versions.push({
      id,
      at: now,
      author,
      summary: restored === null ? summary(before, after) : "Restored an earlier version",
      ...(last ? { base: last.id } : {}),
      ...(restored === null ? {} : { restored }),
    });
  }
  while (versions.length > KEPT) {
    const gone = versions.shift()!;
    fs.rmSync(join(root, `${gone.id}.json`), { force: true });
  }
  writeAtomic(join(root, "index.json"), JSON.stringify(versions));
}
