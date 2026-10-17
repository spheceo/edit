// The cache kept to what's used (speed-plan 3.7): an 8 GB Mac's disk filled
// with previews of footage no project uses any more, and a half-written
// 1.6 GB preview an interrupted run left behind.
//
// Media folders (`<cache>/<media key>/`) of media no saved project uses lose
// what's made again cheaply (previews, thumbnails, waveforms, loudness and
// censor analysis); what cost money to make (transcripts, watch answers,
// seats, faces) stays, so a project that brings the footage back pays
// nothing again. Half-written files a day old go wherever they are. Nothing
// touched in the last two days is removed. Runs a little after the server
// starts and then daily; `POST /api/cache/clean` runs it now (`dry_run`).

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { join } from "./paths.ts";

/** Made again cheaply from the source. */
const REBUILT = /^(preview|thumbs|peaks|loudness|censor|light)/;
/** A write that never finished. */
const PARTIAL = /\.partial([.-]|$)|\.sb-[0-9a-f]+-/;
const DAY = 24 * 3600 * 1000;
/** Recently touched: maybe in use right now. */
const RECENT = 2 * DAY;

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

function age(path: string, now: number): number {
  try {
    return now - fs.statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The media keys of everything a saved project uses (`mediaKey` of each
 * media's path), read from the project files (not loaded as live projects:
 * no memory kept, no media work started).
 */
export function usedKeys(app: App): Set<string> {
  const used = new Set<string>();
  const dir = join(app.store.home, "projects");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    names = [];
  }
  for (const name of names) {
    let media: { path?: unknown }[] = [];
    try {
      const value = JSON.parse(fs.readFileSync(join(dir, name), "utf8")) as { media?: { path?: unknown }[] };
      media = Array.isArray(value.media) ? value.media : [];
    } catch {
      // A project that won't read: its media are kept as if used.
      return new Set(["*"]);
    }
    for (const item of media) {
      if (typeof item.path !== "string") continue;
      try {
        used.add(app.native.mediaKey(item.path));
      } catch {
        // A path the addon can't key: nothing of it is touched either way.
      }
    }
  }
  return used;
}

/** Cleans the cache as the module notes say; with `dryRun`, only says what would go. */
export function cleanCache(app: App, dryRun: boolean, now = Date.now()): CleanReport {
  const cache = app.store.cacheDir();
  const used = usedKeys(app);
  const report: CleanReport = { folders: 0, files: 0, bytes: 0, removed: [] };
  // A project file that wouldn't read: everything counts as used.
  const all = used.has("*");
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
  for (const name of names) {
    if (!/^[0-9a-f]{16}$/.test(name)) continue;
    const dir = join(cache, name);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const unused = !all && !used.has(name);
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
  return report;
}

/** Cleans now and then: a few minutes after the start, then daily. */
export function startCleaning(app: App): () => void {
  const run = () => {
    try {
      const report = cleanCache(app, false);
      if (report.files > 0) {
        diag.info("cache", `freed ${(report.bytes / 1e9).toFixed(2)} GB: ${report.files} files in ${report.folders} media folders no project uses (or left half-written)`);
      }
    } catch (error) {
      diag.warn("cache", `cleaning the cache: ${diag.messageOf(error)}`);
    }
  };
  const first = setTimeout(run, 10 * 60 * 1000);
  const daily = setInterval(run, DAY);
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}
