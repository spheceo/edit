// A script's footage is kept in the cloud (Oct 29, the user: "things
// shouldn't take up storage on the local devices… everything on the
// cloud!"), and on this Mac only as much as its room allows (Sphe, Nov 6:
// the same capped rule as Edit's own footage, "this doesnt mean we clog
// storage with multi gb fotage right?"). Until then a script left alone for
// half an hour lost its footage here however much room the disk had, and the
// edit made from it read it back from R2 for every picture and export (JJ's
// Mac: the agent waited 47 minutes in 2.5 days on pictures decoded from the
// cloud). Now a round adds up the scripts' footage and Edit's cache, and only
// while they're past their budget (storage.ts `localBudgetBytes`: a quarter
// of the room, at most 50 GB) or the disk is nearly full does footage go,
// the scripts left alone longest first. A script that goes has its
// recordings shared with Edit's originals first if they aren't yet
// (handoff.ts: a script brought in from Writer, or one whose share failed),
// then every footage file the cloud holds is deleted here: one the script's
// own sync keeps on R2 at the same size and time (its ledger), or one in
// Edit's originals (`edit-shared.json`). The preview then plays from the cloud (cloud.stream);
// work that needs a file brings it back first (`bringBack`), from the cloud,
// else from its YouTube or Drive link. What only this Mac has (a reused
// case's pieces, a commentary's clip footage, a file from the producer's
// disk) stays.

import * as fs from "node:fs";

import { Effect, Schema } from "effect";

import type { App } from "../app.ts";
import * as editCloud from "../cloud.ts";
import * as diag from "../diag.ts";
import { idle, inArea, runPromise, runtime } from "../effect/runtime.ts";
import { isFile, join } from "../paths.ts";
import { FREE_FLOOR_BYTES, localBudgetBytes } from "../storage.ts";
import * as archive from "./archive.ts";
import * as cloud from "./cloud.ts";
import * as handoff from "./handoff.ts";
import { fetchVideo, importing } from "./imports.ts";
import * as jobs from "./jobs.ts";
import * as locks from "./locks.ts";
import * as media from "./media.ts";
import { partSources, partTargets } from "./parts.ts";
import * as store from "./store.ts";
import { recordings } from "./transcription.ts";

/** A script untouched this long, and footage this old, may be left to the cloud when room is short. */
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
      } else if (isFootage(entry.name) && !store.inTheMaking(entry.name)) out.push(path.slice(dir.length + 1));
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

/** Work running on it here, or its page open here: Edit.app's window plays its preview from the file (window_sources.ts), which must not go from under it. */
const busy = (id: string): boolean => jobs.running(id) || importing(id) || locks.openHere(id);
/** Scripts whose recordings were offered to Edit's originals since Edit started: once each, so one that can't be shared isn't tried every round. */
const offered = new Set<string>();

/** Leaves an idle script's footage to the cloud, as the module notes say: the bytes freed. */
export async function free(data: string, id: string, now = Date.now(), idle = IDLE_MS): Promise<number> {
  if (busy(id) || archive.archived(data, id)) return 0;
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  if (script.status !== "ready" || now - script.updatedAt < idle || cloud.revOf(data, id) === null || cloud.refused(id) !== null) return 0;
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
    if (now - stat.mtimeMs < idle) continue;
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

// ── The rounds (in Effect since Nov 1: docs/plans/2026-11-01-effect.md, part 5) ──
//
// Nov 1, Mathias's Mac: its problem report was 1,747 lines of one warning,
// "27739305: its footage stays here: That script is missing.", and the same
// for 140 other folders, a round every ten minutes for two days: folders in
// the scripts' root with no script.json, each a failure again at every round,
// which hid everything else the report had to say. A round now tells what it
// found apart: a folder with no script isn't a script (noted once a start,
// left as it is: footage there may be another project's), and a script whose
// footage can't go yet is said once, and again only when what's in the way
// changes.

/** A folder in the scripts' root with no script.json. */
export class NoScriptHere extends Schema.TaggedError<NoScriptHere>()("NoScriptHere", { id: Schema.String }) {}
/** A script's footage can't be left to the cloud this round (it's said why). */
export class FootageStays extends Schema.TaggedError<FootageStays>()("FootageStays", { id: Schema.String, message: Schema.String }) {}

/** One script's idle footage left to the cloud: the bytes freed. */
const freeOne = (data: string, id: string, now?: number, idle?: number) =>
  Effect.gen(function* () {
    if (!isFile(join(store.scriptDir(data, id), "script.json"))) return yield* new NoScriptHere({ id });
    return yield* Effect.tryPromise({
      try: () => free(data, id, now, idle),
      catch: (error) => new FootageStays({ id, message: diag.messageOf(error) }),
    });
  });

/** What a loop of rounds has said about each script, so a failure that hasn't changed isn't said again. */
type Said = Map<string, string>;

const sayOnce = (said: Said, error: FootageStays) =>
  said.get(error.id) === error.message ? Effect.void : Effect.sync(() => said.set(error.id, error.message)).pipe(Effect.andThen(Effect.logWarning(`${error.id.slice(0, 8)}: its footage stays here: ${error.message}`)));

/** Bytes of every file under `path` (0 when absent). */
function bytesUnder(path: string): number {
  let total = 0;
  const stack = [path];
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const one = join(at, entry.name);
      if (entry.isDirectory()) stack.push(one);
      else
        try {
          total += fs.lstatSync(one).size;
        } catch {
          // Gone meanwhile.
        }
    }
  }
  return total;
}

/** The scripts' footage here, in bytes. */
function scriptsFootage(data: string): number {
  let total = 0;
  for (const id of store.ids(data)) {
    const dir = store.scriptDir(data, id);
    for (const name of footageFiles(dir, true)) {
      try {
        total += fs.statSync(join(dir, name)).size;
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return total;
}

/**
 * How many bytes of footage must go for the scripts' footage and Edit's cache
 * (`cache`) to fit their budget, with the disk past its floor; 0 or less when
 * they fit.
 */
export function overBudget(data: string, cache: string, freeBytes = freeAt(cache)): number {
  const used = scriptsFootage(data) + bytesUnder(cache);
  return Math.max(used - localBudgetBytes({ freeBytes, cacheBytes: used }), FREE_FLOOR_BYTES - freeBytes);
}

function freeAt(path: string): number {
  try {
    const stat = fs.statfsSync(path);
    return stat.bavail * stat.bsize;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** When a script was last changed (0 when it can't be read: tried first, and said why). */
function changedAt(data: string, id: string): number {
  try {
    return store.read(store.scriptDir(data, id)).updatedAt;
  } catch {
    return 0;
  }
}

/**
 * One round over every script: while `over` bytes must still go, the idle
 * footage of the scripts left alone longest; the bytes freed. Folders with no
 * script are gathered into `strays` whether or not anything must go.
 */
const round = (data: string, said: Said, strays: Set<string>, over: number) =>
  Effect.gen(function* () {
    const order = store.ids(data).map((id) => ({ id, at: changedAt(data, id) })).sort((a, b) => a.at - b.at);
    let freed = 0;
    for (const { id } of order) {
      if (!isFile(join(store.scriptDir(data, id), "script.json"))) {
        strays.add(id);
        continue;
      }
      if (freed >= over) continue;
      freed += yield* freeOne(data, id).pipe(
        Effect.tap(() => Effect.sync(() => said.delete(id))),
        Effect.catchTags({
          NoScriptHere: (stray) => Effect.sync(() => strays.add(stray.id)).pipe(Effect.as(0)),
          FootageStays: (stays) => sayOnce(said, stays).pipe(Effect.as(0)),
        }),
      );
    }
    return freed;
  });

// Nov 4, JJ's Mac: 12,032 such folders, every one a clone of one deleted
// script (Writer's sync kept "this Mac's version" of it every 30 s for days,
// found no script in the copy and left it; Edit brought them in with Writer's
// scripts). Each of Edit's passes over the scripts read them all, 64 ms a
// pass instead of 1. A folder with no script is cleared once nothing can need
// it: untouched a day, not a script the cloud has (a pull cut short comes
// down again), nothing at work on it, and no project's media inside it.

/** How long a folder with no script is left untouched before it's cleared. */
const STRAY_QUIET_MS = 24 * 60 * 60_000;

/** The latest change anywhere in a folder. */
function newest(dir: string): number {
  let latest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const at = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      latest = Math.max(latest, fs.statSync(at).mtimeMs);
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(join(at, entry.name));
      else
        try {
          latest = Math.max(latest, fs.lstatSync(join(at, entry.name)).mtimeMs);
        } catch {
          // Gone meanwhile.
        }
    }
  }
  return latest;
}

/** The script folders Edit's projects play media from, or null when a project won't read (then nothing is cleared). */
function usedByProjects(data: string, projects: string): Set<string> | null {
  const root = `${store.scriptsRoot(data)}/`;
  const used = new Set<string>();
  let names: string[];
  try {
    names = fs.readdirSync(projects).filter((name) => name.endsWith(".json"));
  } catch {
    return fs.existsSync(projects) ? null : used;
  }
  for (const name of names) {
    let media: unknown;
    try {
      media = (JSON.parse(fs.readFileSync(join(projects, name), "utf8")) as { media?: unknown }).media;
    } catch {
      return null;
    }
    for (const item of Array.isArray(media) ? (media as { path?: unknown }[]) : []) {
      if (typeof item?.path === "string" && item.path.startsWith(root)) used.add(item.path.slice(root.length).split("/")[0]!);
    }
  }
  return used;
}

/** Of `strays`, the folders nothing needs, removed: their ids. */
export const clearStrays = (data: string, projects: string, strays: Iterable<string>, now = Date.now()) =>
  Effect.gen(function* () {
    const live = cloud.liveInCloud();
    const used = usedByProjects(data, projects);
    const cleared: string[] = [];
    if (live === null || used === null) return cleared;
    for (const id of strays) {
      const dir = store.scriptDir(data, id);
      if (live.has(id) || used.has(id) || importing(id) || jobs.running(id) || isFile(join(dir, "script.json"))) continue;
      if (now - newest(dir) < STRAY_QUIET_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      cleared.push(id);
      // A few at a time, so a Mac's thousands don't hold up the server.
      if (cleared.length % 50 === 0) yield* idle(0);
    }
    return cleared;
  });

/** Up to ten folders' short ids, for the log. */
const named = (ids: string[]): string => `${ids.slice(0, 10).map((id) => id.slice(0, 8)).join(", ")}${ids.length > 10 ? `, and ${ids.length - 10} more` : ""}`;

/** Rounds a couple of minutes after Edit starts, then every ten, for as long as Edit runs. */
const rounds = (data: string, projects: string, cache: string) =>
  Effect.gen(function* () {
    const said: Said = new Map();
    let told = 0;
    yield* idle(2 * 60_000);
    for (;;) {
      const strays = new Set<string>();
      const freed = yield* round(data, said, strays, overBudget(data, cache));
      if (freed > 0) yield* Effect.logInfo(`${(freed / 1e9).toFixed(2)} GB of scripts' footage left to the cloud`);
      const cleared = yield* clearStrays(data, projects, strays);
      if (cleared.length > 0) yield* Effect.logInfo(`cleared ${cleared.length} folder${cleared.length === 1 ? "" : "s"} among the scripts with no script.json, which nothing needed (${named(cleared)})`);
      const gone = new Set(cleared);
      const kept = [...strays].filter((id) => !gone.has(id));
      if (kept.length > told) yield* Effect.logWarning(`${kept.length} folder${kept.length === 1 ? "" : "s"} among the scripts ha${kept.length === 1 ? "s" : "ve"} no script.json, kept as something may still need them (${named(kept)})`);
      told = kept.length;
      yield* idle(EVERY_MS);
    }
  }).pipe(inArea("writer"));

/**
 * Leaves the idle scripts' footage to the cloud as room runs short, a couple
 * of minutes after Edit starts and then every ten (`cache` is Edit's cache,
 * counted with it): only files the cloud holds as they are here go. A preview
 * was deleted the moment the cloud had it (the user, Oct 30); now it stays
 * while there's room, so the edit made from the script plays and exports it
 * from this Mac.
 */
export function start(data: string, projects: string, cache: string): void {
  runtime.runFork(rounds(data, projects, cache));
}

/** One round, as the loop runs it, for tests: the bytes freed (while `over` must go), and the folders found with no script. */
export function roundForTests(data: string, said: Said = new Map(), over = Number.POSITIVE_INFINITY): Promise<{ freed: number; strays: string[] }> {
  const strays = new Set<string>();
  return runPromise(round(data, said, strays, over).pipe(Effect.map((freed) => ({ freed, strays: [...strays] })), inArea("writer")));
}
