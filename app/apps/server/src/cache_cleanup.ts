// The cache kept to what's used (speed-plan 3.7): an 8 GB Mac's disk filled
// with previews of footage no project uses any more, and a half-written
// 1.6 GB preview an interrupted run left behind.
//
// Media folders (`<cache>/<media key>/`) of media no saved project uses lose
// what's made again cheaply (previews, thumbnails, waveforms, loudness and
// censor analysis); what cost money to make (transcripts, watch answers,
// seats, faces) stays, so a project that brings the footage back pays
// nothing again. Half-written files a day old go wherever they are. Nothing
// touched in the last two days is removed.
//
// Footage projects still use kept its previews forever, though: Oct 21 the
// Mac's disk was full with 36 GB of cache, mostly full-size previews of
// projects not opened for days (one comp's alone 8 GB). So the cache is kept
// under CACHE_LIMIT, and the disk over FREE_FLOOR free: past either, the
// previews of footage whose projects were saved longest ago go first (made
// again when the project is opened), never those of a project saved in the
// last two days. Runs a little after the server starts and then hourly;
// `POST /api/cache/clean` runs it now (`dry_run`).

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { readLocalOriginals, writeLocalOriginals } from "./cloud_media.ts";
import { join } from "./paths.ts";

/** Made again cheaply from the source. */
const REBUILT = /^(preview|thumbs|peaks|loudness|censor|light)/;
/** A write that never finished. */
const PARTIAL = /\.partial([.-]|$)|\.sb-[0-9a-f]+-/;
const DAY = 24 * 3600 * 1000;
/** Recently touched: maybe in use right now. */
const RECENT = 2 * DAY;
/** A Drive download (its original in the cloud) not read by an export for this long goes. */
const DOWNLOADED = 3 * DAY;
/** The cache's size past which old projects' previews go. */
const CACHE_LIMIT = 25e9;
/** The disk's free space below which old projects' previews go. */
const FREE_FLOOR = 10e9;
/** A preview file of a media folder (the picture, its light copy, the sound, the done mark). */
const PREVIEW = /^preview/;

/** When the cache trims used footage's previews: past `cacheBytes`, or with under `freeBytes` free (`free` overrides the disk's). */
export interface Limits {
  cacheBytes: number;
  freeBytes: number;
  free?: number;
}

export interface CleanReport {
  folders: number;
  files: number;
  bytes: number;
  removed: string[];
}

function size(path: string): number {
  try {
    const stat = fs.statSync(path);
    if (!stat.isDirectory()) return stat.size;
    return fs.readdirSync(path).reduce((total, name) => total + size(join(path, name)), 0);
  } catch {
    return 0;
  }
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function age(path: string, now: number): number {
  try {
    return now - fs.statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Every saved project's media paths and their media keys (`mediaKey`), read
 * from the project files (not loaded as live projects: no memory kept, no
 * media work started). Null when a project file won't read: then nothing it
 * might use is known, so everything counts as used.
 */
function used(app: App): { paths: Set<string>; keys: Set<string>; saved: Map<string, number> } | null {
  const paths = new Set<string>();
  const keys = new Set<string>();
  // Each key's latest save of a project using it.
  const saved = new Map<string, number>();
  const dir = join(app.store.home, "projects");
  for (const name of safeList(dir).filter((name) => name.endsWith(".json"))) {
    let media: { path?: unknown }[] = [];
    let at = 0;
    try {
      at = fs.statSync(join(dir, name)).mtimeMs;
      const value = JSON.parse(fs.readFileSync(join(dir, name), "utf8")) as { media?: { path?: unknown }[] };
      media = Array.isArray(value.media) ? value.media : [];
    } catch {
      return null;
    }
    for (const item of media) {
      if (typeof item.path !== "string") continue;
      paths.add(item.path);
      try {
        const key = app.native.mediaKey(item.path);
        keys.add(key);
        saved.set(key, Math.max(saved.get(key) ?? 0, at));
      } catch {
        // A path the addon can't key: nothing of it is touched either way.
      }
    }
  }
  return { paths, keys, saved };
}

function freeSpace(dir: string): number {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Cleans the cache as the module notes say; with `dryRun`, only says what would go. */
export function cleanCache(
  app: App,
  dryRun: boolean,
  now = Date.now(),
  limits: Limits = { cacheBytes: CACHE_LIMIT, freeBytes: FREE_FLOOR },
): CleanReport {
  const cache = app.store.cacheDir();
  const inUse = used(app);
  const report: CleanReport = { folders: 0, files: 0, bytes: 0, removed: [] };
  const remove = (path: string) => {
    const bytes = size(path);
    if (!dryRun) {
      try {
        fs.rmSync(path, { recursive: true, force: true });
      } catch (error) {
        diag.warn("cache", `couldn't remove ${path}: ${diag.messageOf(error)}`);
        return;
      }
    }
    report.files += 1;
    report.bytes += bytes;
    if (report.removed.length < 50) report.removed.push(path);
  };
  let names: string[];
  try {
    names = fs.readdirSync(cache);
  } catch {
    return report;
  }
  // Footage Edit downloaded from Drive (drive_import.ts) whose original is in
  // the cloud: the copy only speeds exports up, so it goes once unused a while.
  const known = readLocalOriginals(cache);
  let dropped = false;
  for (const [key, entry] of Object.entries(known)) {
    const downloaded = entry.path.startsWith(`${app.store.home}/`) || entry.path.includes("/uploads/");
    if (!downloaded || !/\/drive\/[A-Za-z0-9_-]{10,}\//.test(entry.path)) continue;
    if (inUse === null || inUse.paths.has(entry.path) || now - (entry.used_ms ?? entry.mtime_ms) < DOWNLOADED) continue;
    remove(entry.path);
    if (!dryRun) {
      delete known[key];
      dropped = true;
    }
  }
  if (dropped) writeLocalOriginals(cache, known);
  // Chunks an export left when it stopped part-way (the engine's chunks.rs):
  // a run again soon carries on from them; after a few days they go.
  const chunksDir = join(cache, "export-chunks");
  for (const project of safeList(chunksDir)) {
    for (const entry of safeList(join(chunksDir, project))) {
      if (!entry.endsWith(".mp4")) continue;
      const path = join(chunksDir, project, entry);
      if (age(path, now) >= DOWNLOADED) remove(path);
    }
  }
  for (const name of names) {
    if (!/^[0-9a-f]{16}$/.test(name)) continue;
    const dir = join(cache, name);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const unused = inUse !== null && !inUse.keys.has(name);
    let touched = false;
    for (const entry of entries) {
      const path = join(dir, entry);
      if (age(path, now) < (PARTIAL.test(entry) ? DAY : RECENT)) continue;
      if (PARTIAL.test(entry) || (unused && REBUILT.test(entry))) {
        remove(path);
        touched = true;
      }
    }
    if (touched) report.folders += 1;
  }
  // Over the limit (or the disk nearly full): used footage's previews, the
  // projects saved longest ago first.
  if (inUse !== null) {
    const freed = report.bytes;
    const free = limits.free !== undefined ? limits.free + freed : freeSpace(cache) + (dryRun ? freed : 0);
    let over = Math.max(size(cache) - (dryRun ? freed : 0) - limits.cacheBytes, limits.freeBytes - free);
    const oldest = [...inUse.saved].filter(([, at]) => now - at >= RECENT).sort((a, b) => a[1] - b[1]);
    for (const [key] of oldest) {
      if (over <= 0) break;
      const dir = join(cache, key);
      const previews = safeList(dir).filter((entry) => PREVIEW.test(entry));
      if (previews.length === 0) continue;
      const before = report.bytes;
      for (const entry of previews) remove(join(dir, entry));
      over -= report.bytes - before;
      report.folders += 1;
    }
  }
  return report;
}

/** Cleans now and then: a few minutes after the start, then hourly (a day of imports and exports filled the disk). */
export function startCleaning(app: App): () => void {
  const run = () => {
    try {
      const report = cleanCache(app, false);
      if (report.files > 0) {
        diag.info("cache", `freed ${(report.bytes / 1e9).toFixed(2)} GB: ${report.files} files in ${report.folders} media folders (no project uses them, half-written, or old projects' previews past the cache's limit)`);
      }
    } catch (error) {
      diag.warn("cache", `cleaning the cache: ${diag.messageOf(error)}`);
    }
  };
  const first = setTimeout(run, 10 * 60 * 1000);
  const hourly = setInterval(run, 3600 * 1000);
  return () => {
    clearTimeout(first);
    clearInterval(hourly);
  };
}
