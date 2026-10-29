// A script's footage lives in the cloud, not on this Mac (Oct 29, the user:
// "things shouldn't take up storage on the local devices… everything on the
// cloud!"). A script left alone for half an hour has its recordings shared
// with Edit's originals first if they aren't yet (handoff.ts: a script
// brought in from Writer, or one whose share failed), then every footage file
// the cloud holds is deleted here: one the script's own sync keeps on R2 at
// the same size and time (its ledger), or one in Edit's originals
// (`edit-shared.json`). The preview then plays from the cloud (cloud.stream);
// work that needs a file brings it back first (`bringBack`), from the cloud,
// else from its YouTube or Drive link. What only this Mac has (a reused
// case's pieces, a commentary's clip footage, a file from the producer's
// disk) stays.

import * as fs from "node:fs";

import type { App } from "../app.ts";
import * as editCloud from "../cloud.ts";
import * as diag from "../diag.ts";
import { isFile, join } from "../paths.ts";
import * as archive from "./archive.ts";
import * as cloud from "./cloud.ts";
import * as handoff from "./handoff.ts";
import { fetchVideo, importing } from "./imports.ts";
import * as jobs from "./jobs.ts";
import * as media from "./media.ts";
import { partSources, partTargets } from "./parts.ts";
import * as store from "./store.ts";
import { recordings } from "./transcription.ts";

/** A script untouched this long, and footage this old, is left to the cloud. */
const IDLE_MS = 30 * 60_000;
const EVERY_MS = 10 * 60_000;

/** What counts as footage in a script's folder: video and sound, the big files. */
export const isFootage = (name: string): boolean => ["mp4", "m4v", "mov", "mkv", "webm", "avi", "ts", "m4a", "mp3", "aac", "wav", "flac", "ogg", "opus", "part"].includes((name.split(".").pop() ?? "").toLowerCase());

/** Every footage file in a script's folder, by its path inside it; `all` takes in the hidden folders and `footage/` too. */
function footageFiles(dir: string, all = false): string[] {
  const out: string[] = [];
  const stack = [dir];
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        if (all || (!entry.name.startsWith(".") && path !== join(dir, "footage"))) stack.push(path);
      } else if (isFootage(entry.name) && !entry.name.endsWith(".partial")) out.push(path.slice(dir.length + 1));
    }
  }
  return out;
}

/** Deletes the footage in a script's folder (an archive), keeping everything else: the bytes freed. */
export function purge(dir: string): number {
  let freed = 0;
  for (const name of footageFiles(dir, true)) {
    const path = join(dir, name);
    freed += fs.statSync(path).size;
    fs.rmSync(path, { force: true });
  }
  return freed;
}

/** What of the script is in Edit's originals: its file (by its path in the folder) and key. */
function shared(dir: string): Map<string, string> {
  try {
    const kept = JSON.parse(fs.readFileSync(join(dir, "edit-shared.json"), "utf8")) as { file?: unknown; key?: unknown }[];
    return new Map(kept.flatMap((entry) => (typeof entry.file === "string" && typeof entry.key === "string" ? [[entry.file, entry.key] as const] : [])));
  } catch {
    return new Map();
  }
}

const busy = (id: string): boolean => jobs.running(id) || importing(id);
/** Scripts whose recordings were offered to Edit's originals since Edit started: once each, so one that can't be shared isn't tried every round. */
const offered = new Set<string>();

/** Leaves an idle script's footage to the cloud, as the module notes say: the bytes freed. */
export async function free(data: string, id: string, now = Date.now()): Promise<number> {
  if (busy(id) || archive.archived(data, id)) return 0;
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  if (script.status !== "ready" || now - script.updatedAt < IDLE_MS || cloud.revOf(data, id) === null || cloud.refused(id) !== null) return 0;
  const own = recordings(dir, script).flatMap((recording) => (recording.span === null && recording.file.startsWith(`${dir}/`) && isFile(recording.file) ? [recording.file.slice(dir.length + 1)] : []));
  if (own.some((name) => !shared(dir).has(name)) && !offered.has(id) && editCloud.enabled()) {
    offered.add(id);
    await handoff.share(data, id).catch((error: unknown) => diag.warn("writer", `${jobs.named(id, script.title)}: its footage wasn't shared with Edit, so it stays here: ${diag.messageOf(error)}`));
  }
  const inEdit = shared(dir);
  const leaving: string[] = [];
  let bytes = 0;
  for (const name of footageFiles(dir)) {
    const stat = fs.statSync(join(dir, name));
    if (now - stat.mtimeMs < IDLE_MS) continue;
    const kept = cloud.fileKey(data, id, name);
    if (!inEdit.has(name) && !(kept !== null && kept.key !== "" && kept.size === stat.size && kept.mtime === Math.floor(stat.mtimeMs))) continue;
    leaving.push(name);
    bytes += stat.size;
  }
  if (leaving.length === 0 || busy(id)) return 0;
  // Noted before they go, so a push in between keeps them in the cloud's list rather than dropping them.
  cloud.leftInCloud(data, id, leaving.filter((name) => !inEdit.has(name)));
  for (const name of leaving) fs.rmSync(join(dir, name), { force: true });
  diag.info("writer", `${jobs.named(id, script.title)}: ${Math.round(bytes / 1e6)} MB of footage left to the cloud (${leaving.join(", ")})`);
  return bytes;
}

/** A footage file back from the cloud: the script's own copy, or Edit's original. False when the cloud has neither. */
async function fromCloud(data: string, id: string, dir: string, name: string, onPercent: (percent: number) => void): Promise<boolean> {
  const key = shared(dir).get(name);
  try {
    if (key !== undefined) await editCloud.download(key, join(dir, name), (done, total) => onPercent(Math.floor((done * 100) / Math.max(total, 1))));
    else if (cloud.fileKey(data, id, name)?.key) await cloud.fetchFile(data, id, name);
    else return false;
    return true;
  } catch (error) {
    diag.warn("writer", `${jobs.named(id, "")}: ${name} didn't come back from the cloud: ${diag.messageOf(error)}`);
    return false;
  }
}

/**
 * Each recording back on this Mac (from the cloud, else from its YouTube or
 * Drive link), then the preview: from the cloud when `preview` is asked for,
 * made again when the cloud has none (an archive deleted it). Answers what
 * couldn't come back.
 */
export async function bringBack(app: App, data: string, id: string, job?: jobs.Job, preview = false): Promise<string[]> {
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
    const inside = target.startsWith(`${dir}/`);
    if (inside && (await fromCloud(data, id, dir, target.slice(dir.length + 1), (percent) => job?.stage(`Bringing back ${title} · ${percent}%`)))) {
      files.push(target);
      continue;
    }
    const source = sources[index]?.[0] ?? null;
    const reused = script.parts?.[index]?.reuse ? (script.reuses ?? []).find((one) => one.url === script.parts![index]!.reuse) : undefined;
    const link = source?.startsWith("youtube:") ? `https://www.youtube.com/watch?v=${source.slice(8)}` : source?.startsWith("drive:") ? `https://drive.google.com/file/d/${source.slice(6)}/view` : (reused?.footage ?? reused?.url ?? null);
    if (!inside || link === null) {
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
  const proxy = store.proxyPath(dir);
  const inCloud = cloud.fileKey(data, id, "proxy.mp4") !== null && !archive.archived(data, id);
  if (!isFile(proxy) && inCloud && preview) await cloud.fetchPreview(data, id);
  else if (!isFile(proxy) && !inCloud && files.every((file) => file !== null)) {
    // The preview, as the import made it.
    job?.stage("Rebuilding the preview");
    if (joined) {
      const parts = await Promise.all(files.map(async (file, index) => ({ path: file!, streams: { ...(await media.streams(file!)), durationMs: script.parts![index]!.durationMs } })));
      await media.join(parts, proxy, (percent) => job?.stage(`Rebuilding the preview · ${percent}%`), job?.signal);
    } else if (files[0]) {
      const found = await media.streams(files[0]);
      if (found.video) await media.encodeProxy(files[0], proxy, script.durationMs, (percent) => job?.stage(`Rebuilding the preview · ${percent}%`), job?.signal);
      else await media.join([{ path: files[0], streams: { ...found, durationMs: script.durationMs } }], proxy, (percent) => job?.stage(`Rebuilding the preview · ${percent}%`), job?.signal);
    }
    cloud.forgetPurged(data, id, "proxy.mp4");
  }
  return missing;
}

/** Leaves idle scripts' footage to the cloud a couple of minutes after Edit starts, then every ten. */
export function start(data: string): void {
  let running = false;
  const round = async () => {
    if (running) return;
    running = true;
    let freed = 0;
    try {
      for (const id of store.ids(data)) freed += await free(data, id).catch((error: unknown) => (diag.warn("writer", `${id.slice(0, 8)}: its footage stays here: ${diag.messageOf(error)}`), 0));
      if (freed > 0) diag.info("writer", `${(freed / 1e9).toFixed(2)} GB of scripts' footage left to the cloud`);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void round(), 2 * 60_000);
  setInterval(() => void round(), EVERY_MS);
}
