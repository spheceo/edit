// Archived scripts. Repack's page archives a script to free space: its server
// deletes the footage on R2 and marks the script's row `archived: {at, by,
// freedBytes}`. When the cloud says so, this Mac deletes the script's footage
// too (originals, the preview, Drive recordings, heard audio); the script,
// its transcripts, versions, chat and every other small file stay, so it
// still lists and reads, read-only. A file from the Mac's disk outside the
// script's folder is the producer's own: never touched.
//
// Restore (the banner's button, or `restore` set on Repack's page) brings the
// footage back from its links (YouTube and Drive) and rebuilds the preview;
// the transcripts were kept, so nothing is heard again. What can't come back
// (a file from disk) is listed as missing.

import * as fs from "node:fs";

import type { Archive } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { writeAtomic } from "../files.ts";
import { isFile, join } from "../paths.ts";
import * as cloud from "./cloud.ts";
import { fetchVideo } from "./imports.ts";
import { importing } from "./imports.ts";
import * as jobs from "./jobs.ts";
import * as media from "./media.ts";
import { partSources, partTargets } from "./parts.ts";
import * as store from "./store.ts";
import { recordings } from "./transcription.ts";

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

/** What counts as footage in a script's folder: video and sound, the big files an archive frees. */
export const isFootage = (name: string): boolean => ["mp4", "m4v", "mov", "mkv", "webm", "avi", "ts", "m4a", "mp3", "aac", "wav", "flac", "ogg", "opus", "part"].includes((name.split(".").pop() ?? "").toLowerCase());

/** Deletes the footage in a script's folder, keeping everything else: the bytes freed. */
export function purge(dir: string): number {
  let freed = 0;
  const stack = [dir];
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (isFootage(entry.name)) {
        freed += fs.statSync(path).size;
        fs.rmSync(path, { force: true });
      }
    }
  }
  return freed;
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
      const freed = purge(store.scriptDir(data, id));
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
    missing = await restoreFootage(app, data, id, job);
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

/** Each recording again (from its YouTube or Drive link), then the preview; answers what couldn't come back. */
export async function restoreFootage(app: App, data: string, id: string, job?: jobs.Job): Promise<string[]> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  const all = recordings(dir, script);
  const sources = partSources(dir, script);
  const targets = partTargets(dir, script);
  const joined = (script.parts ?? []).length > 1;
  const missing: string[] = [];
  const files: (string | null)[] = [];
  for (const [index] of all.entries()) {
    const title = joined ? script.parts![index]!.title : script.title;
    const target = joined ? (targets[index] ?? join(dir, ".reuse", `restored-${String(index).padStart(2, "0")}.mp4`)) : script.originalPath;
    if (await media.readable(target)) {
      files.push(target);
      continue;
    }
    job?.stage(`Bringing back ${title}`);
    const source = sources[index]?.[0] ?? null;
    const reused = script.parts?.[index]?.reuse ? (script.reuses ?? []).find((one) => one.url === script.parts![index]!.reuse) : undefined;
    const link = source?.startsWith("youtube:") ? `https://www.youtube.com/watch?v=${source.slice(8)}` : source?.startsWith("drive:") ? `https://drive.google.com/file/d/${source.slice(6)}/view` : (reused?.footage ?? reused?.url ?? null);
    if (!target.startsWith(`${dir}/`) || link === null) {
      missing.push(title);
      files.push(null);
      continue;
    }
    try {
      fs.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      await fetchVideo(app, link, target, (percent) => job?.stage(`Bringing back ${title} · ${percent}%`), job?.signal);
      files.push(target);
    } catch (error) {
      diag.warn("writer", `${jobs.named(id, script.title)}: ${title} can't come back: ${diag.messageOf(error)}`);
      missing.push(title);
      files.push(null);
    }
  }
  // The preview, as the import made it.
  const proxy = store.proxyPath(dir);
  if (!isFile(proxy) && files.every((file) => file !== null)) {
    job?.stage("Rebuilding the preview");
    if (joined) {
      const parts = await Promise.all(files.map(async (file, index) => ({ path: file!, streams: { ...(await media.streams(file!)), durationMs: script.parts![index]!.durationMs } })));
      await media.join(parts, proxy, (percent) => job?.stage(`Rebuilding the preview · ${percent}%`), job?.signal);
    } else if (files[0]) {
      const found = await media.streams(files[0]);
      if (found.video) await media.encodeProxy(files[0], proxy, script.durationMs, (percent) => job?.stage(`Rebuilding the preview · ${percent}%`), job?.signal);
      else await media.join([{ path: files[0], streams: { ...found, durationMs: script.durationMs } }], proxy, (percent) => job?.stage(`Rebuilding the preview · ${percent}%`), job?.signal);
    }
  }
  for (const name of ["proxy.mp4"]) cloud.forgetPurged(data, id, name);
  return missing;
}
