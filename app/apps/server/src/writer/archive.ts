// Archived scripts. Repack's page archives a script to free space: its server
// deletes the footage on R2 and marks the script's row `archived: {at, by,
// freedBytes}`. When the cloud says so, this Mac deletes the script's footage
// too (originals, the preview, Drive recordings, heard audio); the script,
// its transcripts, versions, chat and every other small file stay, so it
// still lists and reads, read-only. A file from the Mac's disk outside the
// script's folder is the producer's own: never touched.
//
// Restore (the banner's button, or `restore` set on Repack's page) brings the
// footage back from its links (YouTube and Drive; storage.ts) and rebuilds the preview;
// the transcripts were kept, so nothing is heard again. What can't come back
// (a file from disk) is listed as missing.

import * as fs from "node:fs";

import type { Archive } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { writeAtomic } from "../files.ts";
import { join } from "../paths.ts";
import * as cloud from "./cloud.ts";
import { importing } from "./imports.ts";
import * as jobs from "./jobs.ts";
import * as storage from "./storage.ts";
import * as store from "./store.ts";

type State = { archived?: { at?: number; by?: string; freedBytes?: number } | null; restore?: unknown };
type Local = { purgedFor?: number | null; restoredFor?: number | null; restoring?: boolean; missing?: string[] };

const statesPath = (data: string) => join(data, "cloud", "archive.json");
const localPath = (data: string) => join(data, "cloud", "archive-local.json");

function read<T>(path: string): Record<string, T> {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, T>;
  } catch {
    return {};
  }
}

function changeLocal(data: string, id: string, edit: (local: Local) => void): void {
  const all = read<Local>(localPath(data));
  const local = all[id] ?? {};
  edit(local);
  all[id] = local;
  fs.mkdirSync(join(data, "cloud"), { recursive: true });
  writeAtomic(localPath(data), JSON.stringify(all));
}

/** The rows' archive states, as the cloud's pull reads them. */
export function keepStates(data: string, rows: Record<string, unknown>[]): void {
  const states = Object.fromEntries(rows.flatMap((row) => (typeof row.scriptId === "string" && (row.archived || row.restore) ? [[row.scriptId, { archived: row.archived ?? null, restore: row.restore ?? null }]] : [])));
  fs.mkdirSync(join(data, "cloud"), { recursive: true });
  writeAtomic(statesPath(data), JSON.stringify(states));
}

const archivedAt = (state: State | undefined): number | null => (typeof state?.archived?.at === "number" ? state.archived.at : null);

/** Whether the script is archived and not restored here since. */
export function archived(data: string, id: string): boolean {
  const at = archivedAt(read<State>(statesPath(data))[id]);
  return at !== null && read<Local>(localPath(data))[id]?.restoredFor !== at;
}

/** The script's archive, for the page to show, if it's archived. */
export function state(data: string, id: string): Archive | null {
  const found = read<State>(statesPath(data))[id];
  const at = archivedAt(found);
  if (at === null) return null;
  const local = read<Local>(localPath(data))[id] ?? {};
  if (local.restoredFor === at) return null;
  return { at, by: found?.archived?.by ?? "", freedBytes: found?.archived?.freedBytes ?? 0, restoring: local.restoring === true || (jobs.running(id) && typeof found?.restore === "object" && found.restore !== null), missing: local.missing ?? [] };
}

/** Acts on archives and restores heard from the cloud: frees an archived script's footage here, restores one asked back. */
export function react(app: App, data: string): void {
  for (const [id, found] of Object.entries(read<State>(statesPath(data)))) {
    if (jobs.running(id) || importing(id) || !store.idOk(id) || !fs.existsSync(store.scriptDir(data, id))) continue;
    const local = read<Local>(localPath(data))[id] ?? {};
    const at = archivedAt(found);
    if (at !== null && local.restoredFor === at) continue;
    if (typeof found.restore === "object" && found.restore !== null && !local.restoring) {
      try {
        startRestore(app, data, id);
      } catch (error) {
        diag.warn("writer", `${id.slice(0, 8)}: its restore didn't start: ${diag.messageOf(error)}`);
      }
      continue;
    }
    if (at !== null && local.purgedFor !== at) {
      const freed = storage.purge(store.scriptDir(data, id));
      diag.info("writer", `${jobs.named(id, "")}: archived by ${found.archived?.by ?? "Repack"}; its footage deleted here (${Math.round(freed / 1e6)} MB)`);
      changeLocal(data, id, (one) => void (one.purgedFor = at));
    }
  }
}

/** Restores the script: starts bringing its footage back. */
export function startRestore(app: App, data: string, id: string): import("@edit/types/writer").BuildStatus {
  if (state(data, id) === null) throw new Error("That script isn't archived.");
  changeLocal(data, id, (local) => void (local.restoring = true));
  const title = store.read(store.scriptDir(data, id)).title;
  return jobs.start(data, id, title, { kind: "restore" }, (job) => restore(app, data, id, job));
}

/** Brings an archived script's footage back, as a job. */
async function restore(app: App, data: string, id: string, job: jobs.Job): Promise<jobs.Outcome> {
  let missing: string[];
  try {
    missing = await storage.bringBack(app, data, id, job);
  } finally {
    changeLocal(data, id, (local) => void (local.restoring = false));
  }
  const at = archivedAt(read<State>(statesPath(data))[id]);
  changeLocal(data, id, (local) => Object.assign(local, { restoredFor: at, purgedFor: null, missing }));
  // Repack's row: no longer asked back, and the footage is here again.
  await cloud.convex("mutation", "writer:clearRestore", { scriptId: id }).catch(() => undefined);
  cloud.syncSoon();
  return [missing.length === 0 ? "The footage is back, and the transcripts as they were: nothing was heard again." : `The footage is back, but not ${missing.join(", ")}: it came from this Mac's disk, and the archive deleted it.`, 0];
}
