// Older exports on the Mac go once they're no longer wanted (off Modal, step
// 9; Sphe, Nov 2). Finished exports were most of the tens of gigabytes the
// team's Macs filled: an 80-minute export at the High tier is ~5 GB, and
// Kroger had v4, v5 and v6 in ~/Movies/Edit.
//
// The newest export of a project always stays: a re-export copies its
// unchanged chunks out of it (Kroger 65 min → 6.5 min, Young Actress 16 s
// after one subtitle). An older one goes once a newer export of the project
// is at least seven days old, whether or not it was shared: one that was is
// still on the project's review link (or, a subtitle video, on Drive), and
// the exports list keeps its entry, marked removed with where it still is.
// Never the newest, never one exporting, being read (a share making its
// copies), or uploading to Drive, and only a file Edit wrote into its own
// export folders (the one chosen in Settings, ~/Movies/Edit, <home>/exports)
// and listed in <home>/exports.json. With the disk nearly full (under the
// cache's floor, storage.ts FREE_FLOOR_BYTES: Sphe, Nov 2), older versions go
// at once, without the week's wait, the oldest first, until there's room
// again; still never the newest or one in use. Every deletion is logged with
// the project, the version and why. Runs with the cache's cleaner
// (cache_cleanup.ts `startCleaning`); `report` says what it would delete
// without deleting.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { join } from "./paths.ts";

/** How old a newer export is before the ones before it go. */
export const AFTER_MS = 7 * 24 * 3600 * 1000;

/** What retention reads of an exports.json entry (exports.ts `ExportRecord`). */
export interface Kept {
  path: string;
  name: string;
  finished_ms: number;
  bytes: number | null;
  cloudKey?: string;
  removed?: Removed;
}

/** Why a version's file went, and where it still is. */
export interface Removed {
  at: number;
  reason: string;
  /** Its version on the project's review link, when it was shared. */
  review?: number;
  /** On Drive (a subtitle video). */
  drive?: boolean;
}

/** What retention asks of the rest of Edit. */
export interface Context {
  now: number;
  /** The folders Edit writes exports into. */
  roots: string[];
  /** The review link's version holding the file at `path` of project `id`, if it was shared. */
  reviewed(id: string, path: string): number | null;
  /** When project `id`'s video was last put on Drive (ms), if it was. */
  onDrive(id: string): number | null;
  /** Whether the file is in use: exporting, being read, uploading. */
  busy(id: string, path: string): boolean;
  /** The disk's free space short of the floor (bytes; 0 or less: room enough). */
  short?: number;
}

export interface Decision {
  project: string;
  path: string;
  name: string;
  /** Its place in the project's exports, oldest 1. */
  version: number;
  bytes: number;
  remove: boolean;
  why: string;
  removed?: Removed;
}

const inside = (path: string, roots: string[]) => roots.some((root) => root !== "" && path.startsWith(root.endsWith("/") ? root : `${root}/`));

/** What becomes of each export of each project here, by the rule above. */
export function decide(records: Record<string, Kept[]>, context: Context): Decision[] {
  const out: Decision[] = [];
  for (const [project, own] of Object.entries(records)) {
    const ordered = [...own].sort((a, b) => a.finished_ms - b.finished_ms);
    const newest = ordered.at(-1);
    ordered.forEach((record, index) => {
      if (record.removed !== undefined) return;
      let bytes = 0;
      try {
        bytes = fs.statSync(record.path).size;
      } catch {
        // Not here (archived to the cloud, or deleted by hand): nothing to free.
        return;
      }
      const decision: Decision = { project, path: record.path, name: record.name, version: index + 1, bytes, remove: false, why: "" };
      const settle = (remove: boolean, why: string, removed?: Removed) => out.push({ ...decision, remove, why, ...(removed === undefined ? {} : { removed }) });
      if (record === newest) return settle(false, "the newest: re-exports copy from it");
      if (!inside(record.path, context.roots)) return settle(false, "not in Edit's export folders");
      const later = ordered.slice(index + 1);
      const full = (context.short ?? 0) > 0;
      if (!full && !later.some((one) => context.now - one.finished_ms >= AFTER_MS)) return settle(false, "no newer export a week old yet");
      if (context.busy(project, record.path)) return settle(false, "in use (exporting, sharing or uploading)");
      const review = context.reviewed(project, record.path);
      const drive = context.onDrive(project);
      const onDrive = drive !== null && drive >= record.finished_ms;
      const where = review !== null ? `still on the review link as v${review}` : onDrive ? "still on Drive" : "never shared";
      const weekOld = later.some((one) => context.now - one.finished_ms >= AFTER_MS);
      return settle(true, `${weekOld ? "a newer export is a week old" : "the disk is nearly full"}; ${where}`, { at: context.now, reason: where, ...(review !== null ? { review } : {}), ...(onDrive ? { drive: true } : {}) });
    });
  }
  // Nearly full: only as many as bring it back over the floor, the oldest first (those a week's rule takes go anyway).
  const short = context.short ?? 0;
  if (short > 0) {
    const finished = new Map(Object.entries(records).flatMap(([project, own]) => own.map((one) => [`${project}\n${one.path}`, one.finished_ms] as const)));
    const at = (one: Decision) => finished.get(`${one.project}\n${one.path}`) ?? 0;
    let freed = 0;
    for (const one of out.filter((decision) => decision.remove).sort((a, b) => at(a) - at(b))) {
      const weekly = one.why.startsWith("a newer export is a week old");
      if (!weekly && freed >= short) {
        one.remove = false;
        one.why = "the disk has room again";
        delete one.removed;
        continue;
      }
      freed += one.bytes;
    }
  }
  return out;
}

/**
 * Applies `decisions` to the files and to the exports list in `home`: each
 * file to remove goes, its entry kept and marked removed. `dryRun` only says.
 */
export function apply(home: string, decisions: Decision[], dryRun: boolean): { files: number; bytes: number } {
  const done = { files: 0, bytes: 0 };
  const removed = new Map<string, Removed>();
  for (const decision of decisions) {
    if (!decision.remove || decision.removed === undefined) continue;
    const said = `${decision.project}: v${decision.version} (${decision.name}, ${(decision.bytes / 1e9).toFixed(2)} GB): ${decision.why}`;
    if (dryRun) {
      diag.info("export", `would delete ${said}`);
    } else {
      try {
        fs.rmSync(decision.path, { force: true });
      } catch (error) {
        diag.warn("export", `couldn't delete ${said}: ${diag.messageOf(error)}`);
        continue;
      }
      diag.info("export", `deleted ${said}`);
      removed.set(`${decision.project}\n${decision.path}`, decision.removed);
    }
    done.files += 1;
    done.bytes += decision.bytes;
  }
  if (removed.size > 0) {
    const file = join(home, "exports.json");
    const records = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Kept[]>;
    for (const [project, own] of Object.entries(records)) {
      for (const record of own) {
        const mark = removed.get(`${project}\n${record.path}`);
        if (mark !== undefined) record.removed = mark;
      }
    }
    writeAtomic(file, JSON.stringify(records, null, 1));
  }
  return done;
}
