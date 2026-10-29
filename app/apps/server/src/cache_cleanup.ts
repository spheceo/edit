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
import * as cloud from "./cloud.ts";
import { playbackPath } from "./cloud_playback.ts";
import { Semaphore } from "./media.ts";
import * as diag from "./diag.ts";
import { carryAnalysis, localPath, readLocalOriginals, uploadingNow, writeLocalOriginals } from "./cloud_media.ts";
import { join } from "./paths.ts";
import * as research from "./research.ts";
import * as writerStore from "./writer/store.ts";
import { localBudgetBytes } from "./storage.ts";

/** Made again cheaply from the source. */
const REBUILT = /^(preview|thumbs|peaks|loudness|censor|light)/;
/** A write that never finished. */
const PARTIAL = /\.partial([.-]|$)|\.sb-[0-9a-f]+-/;
const DAY = 24 * 3600 * 1000;
/** Recently touched: maybe in use right now. */
const RECENT = 2 * DAY;
/** A cloud copy this new may be uploading or playing. */
const COPY_RECENT = 6 * 3600 * 1000;
/** A Drive download (its original in the cloud) not read by an export for this long goes. */
const DOWNLOADED = 3 * DAY;
/** The cache's size past which old projects' previews go: the one local-data budget (sub-1 GB). */
const CACHE_LIMIT = localBudgetBytes();
/** The disk's free space below which old projects' previews go (safety valve only). */
const FREE_FLOOR = 1e9;
/** Cloud-cache subtrees holding rebuildable copies of R2 objects (LRU-evicted past the budget); `blocks` are previews read for playback (cloud_blocks.ts). */
const CLOUD_EVICTABLE = ["proxies", "sound", "originals", "excerpts", "blocks"];
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

/**
 * Remove acknowledged cloud previews, including their legacy cache aliases.
 * Originals, paid analysis, directly referenced local media, and unfinished
 * uploads are never candidates. HEAD is required, not just project metadata.
 */
export async function cleanCloudPreviews(
  app: App,
  dryRun: boolean,
  head: (key: string) => Promise<{ size: number } | null> = (key) => cloud.head(key),
  discardOrphanPreviews = false,
): Promise<CleanReport> {
  const report: CleanReport = { folders: 0, files: 0, bytes: 0, removed: [] };
  const cache = app.store.cacheDir();
  const paths = new Set<string>();
  const referenced = new Set<string>();
  const usedKeys = new Set<string>();
  const sources = new Map<string, Set<string>>();
  const add = (key: string, alias: string) => {
    let aliases = sources.get(key);
    if (aliases === undefined) sources.set(key, aliases = new Set());
    aliases.add(alias);
  };
  // Read the saved locations before store.get normalises them for playback.
  // An unreadable project makes the reference set incomplete: keep everything.
  for (const name of safeList(join(app.store.home, "projects")).filter((name) => name.endsWith(".json"))) {
    try {
      const project = JSON.parse(fs.readFileSync(join(app.store.home, "projects", name), "utf8")) as {
        media?: { path: string; kind: string; cloud?: { proxy?: string } | null }[];
      };
      for (const media of project.media ?? []) {
        if (typeof media.path !== "string") return report;
        referenced.add(media.path);
        usedKeys.add(app.native.mediaKey(media.path));
        if (media.cloud?.proxy === undefined || !cloud.validKey(media.cloud.proxy)) {
          paths.add(media.path);
          continue;
        }
        if (media.kind === "image") continue;
        const key = media.cloud.proxy;
        add(key, app.native.mediaKey(media.path));
        add(key, app.native.mediaKey(localPath(cache, key)));
        add(key, app.native.mediaKey(playbackPath(key, app.port)));
        // Carry paid analysis before the old proxy's metadata (and key) goes.
        if (!dryRun) carryAnalysis(cache, media.path, playbackPath(key, app.port));
      }
    } catch { return report; }
  }
  // Analysis carried from an original records its older media keys. Follow
  // those aliases so migrating a project doesn't strand its old previews.
  for (const aliases of sources.values()) {
    for (const alias of aliases) {
      try {
        const value = JSON.parse(fs.readFileSync(join(cache, alias, "watch", "keys.json"), "utf8")) as { keys?: unknown };
        if (Array.isArray(value.keys)) for (const key of value.keys) if (typeof key === "string" && /^[0-9a-f]{16}$/.test(key)) aliases.add(key);
      } catch { /* no older analysis */ }
    }
  }
  const pending = new Set<string>();
  try {
    const jobs = JSON.parse(fs.readFileSync(join(app.store.home, "jobs.json"), "utf8")) as { kind: string; args?: { local?: string } }[];
    for (const job of jobs) if (job.kind === "upload" && typeof job.args?.local === "string") pending.add(job.args.local);
  } catch {
    if (fs.existsSync(join(app.store.home, "jobs.json"))) return report;
  }
  const removed = new Set<string>();
  const slots = new Semaphore(3);
  const candidatesWithFiles = [...sources].filter(([key, aliases]) =>
    (key.startsWith("edit/proxies/") && fs.existsSync(localPath(cache, key))) ||
    [...aliases].some((alias) => safeList(join(cache, alias)).some((name) => /^preview(?:-light)?\.(?:mp4|m4a)$/.test(name))),
  );
  const confirmedKeys = new Map(await Promise.all(candidatesWithFiles.map(([key]) => slots.with(async () => {
    try { return [key, await head(key)] as const; } catch { return [key, null] as const; }
  }))));
  for (const [key, aliases] of sources) {
    const confirmed = confirmedKeys.get(key) ?? null;
    if (confirmed === null || confirmed.size <= 0) continue;
    const candidates = new Set<string>();
    if (key.startsWith("edit/proxies/")) {
      const path = localPath(cache, key);
      try { if (fs.statSync(path).size === confirmed.size) candidates.add(path); } catch { /* already cloud-only */ }
    }
    for (const alias of aliases) {
      const dir = join(cache, alias);
      for (const name of safeList(dir)) if (/^preview(?:-light)?\.(?:mp4|m4a|done)$/.test(name)) candidates.add(join(dir, name));
    }
    for (const path of candidates) {
      if (removed.has(path) || paths.has(path) || pending.has(path) || uploadingNow(path)) continue;
      try {
        const stat = fs.lstatSync(path);
        if (!stat.isFile()) continue;
        if (!dryRun) fs.rmSync(path);
        removed.add(path);
        report.files += 1;
        report.bytes += stat.size;
        if (report.removed.length < 50) report.removed.push(path);
      } catch { /* a concurrent job finished or removed it */ }
    }
  }
  report.folders = new Set([...removed].map((path) => path.slice(0, path.lastIndexOf("/")))).size;
  if (discardOrphanPreviews) {
    // Explicit migration of the pre-cloud cache: only completed generated
    // playback files in media-key folders which no saved media resolves to.
    // These aren't source media. A disconnected source can rebuild its
    // derived previews when it returns; keep the paid analysis beside them.
    for (const alias of safeList(cache)) {
      if (!/^[0-9a-f]{16}$/.test(alias) || usedKeys.has(alias) || app.media.busyKey(alias)) continue;
      const dir = join(cache, alias);
      // Both artifacts identify the old media processor's completed output.
      if (!fs.existsSync(join(dir, "preview.done"))) continue;
      for (const name of safeList(dir)) {
        if (!/^preview(?:-light)?\.(?:mp4|m4a|done)$/.test(name)) continue;
        const path = join(dir, name);
        if (removed.has(path) || referenced.has(path) || pending.has(path)) continue;
        try {
          const stat = fs.lstatSync(path);
          if (!stat.isFile()) continue;
          if (!dryRun) fs.rmSync(path);
          removed.add(path);
          report.files += 1;
          report.bytes += stat.size;
          if (report.removed.length < 50) report.removed.push(path);
        } catch { /* already gone */ }
      }
    }
    report.folders = new Set([...removed].map((path) => path.slice(0, path.lastIndexOf("/")))).size;
  }
  return report;
}

/** Bytes under `path`, each file once however many hard links it has (a proxy and its preview are one file). */
function size(path: string, seen = new Set<string>()): number {
  try {
    const stat = fs.statSync(path);
    if (!stat.isDirectory()) {
      const inode = `${stat.dev}:${stat.ino}`;
      if (seen.has(inode)) return 0;
      seen.add(inode);
      return stat.size;
    }
    return fs.readdirSync(path).reduce((total, name) => total + size(join(path, name), seen), 0);
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
function used(app: App): { paths: Set<string>; keys: Set<string>; saved: Map<string, number>; missing: number } | null {
  const paths = new Set<string>();
  // Files a project uses that aren't here (a drive unplugged): their key can't be known.
  let missing = 0;
  const keys = new Set<string>();
  // Each key's latest save of a project using it.
  const saved = new Map<string, number>();
  const dir = join(app.store.home, "projects");
  for (const name of safeList(dir).filter((name) => name.endsWith(".json"))) {
    let media: { path?: unknown; cloud?: { proxy?: unknown } | null }[] = [];
    let at = 0;
    try {
      at = fs.statSync(join(dir, name)).mtimeMs;
      const value = JSON.parse(fs.readFileSync(join(dir, name), "utf8")) as { media?: { path?: unknown; cloud?: { proxy?: unknown } | null }[] };
      media = Array.isArray(value.media) ? value.media : [];
    } catch (error) {
      diag.warn("cache", `${name} won't read, so nothing it might use is cleaned (${diag.messageOf(error)})`);
      return null;
    }
    for (const item of media) {
      if (typeof item.path !== "string") continue;
      paths.add(item.path);
      // A missing file keys differently (no size or time): its folder would look unused.
      if (!fs.existsSync(item.path)) {
        if (typeof item.cloud?.proxy !== "string" || !cloud.validKey(item.cloud.proxy)) missing += 1;
        continue;
      }
      try {
        const key = app.native.mediaKey(item.path);
        keys.add(key);
        saved.set(key, Math.max(saved.get(key) ?? 0, at));
      } catch {
        // A path the addon can't key: nothing of it is touched either way.
      }
    }
  }
  return { paths, keys, saved, missing };
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
  // A home that isn't one (EDIT_HOME="") cleans nothing: its cache would be "/cache".
  if (app.store.home.trim() === "" || app.store.home === "/") return { folders: 0, files: 0, bytes: 0, removed: [] };
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
  // Only Edit's own Drive downloads (<media root>/media/[<project>/]drive/<file id>/<file>),
  // never a file of the user's whose path happens to say "drive" or "uploads".
  const roots = new Set<string>([join(app.store.home, "media")]);
  try {
    roots.add(join(app.store.layout().mediaRoot(), "media"));
  } catch {
    // The media drive isn't connected: only the internal one's.
  }
  for (const [key, entry] of Object.entries(known)) {
    const root = [...roots].find((one) => entry.path.startsWith(`${one}/`));
    if (root === undefined || !/^(?:[A-Za-z0-9_-]+\/)?drive\/[A-Za-z0-9_-]{10,}\/[^/]+$/.test(entry.path.slice(root.length + 1))) continue;
    // Not while its upload to the cloud is still going.
    if (uploadingNow(entry.path)) continue;
    if (inUse === null || inUse.paths.has(entry.path) || now - (entry.used_ms ?? entry.mtime_ms) < DOWNLOADED) continue;
    remove(entry.path);
    if (!dryRun) {
      delete known[key];
      dropped = true;
    }
  }
  if (dropped) writeLocalOriginals(cache, known);
  // What Edit made or fetched that no project uses any more (Oct 29, the user:
  // "things shouldn't take up storage on the local devices… everything on the
  // cloud!"): smoothed shots a project moved to the cloud or made again
  // (404 of them, 2.85 GB on this Mac), YouTube videos downloaded for a script
  // (the registry has the original), and the team library's sounds (Drive has
  // them; a cloud project's sound is its cloud copy). Each comes back when
  // it's asked for again.
  if (inUse !== null) {
    // A script's original can be one of these when it couldn't be hard-linked (a media drive on another disk).
    const scripts = writerStore.originals(writerStore.dataDir(app.store.home));
    const generated = (relative: string) => /(?:^|\/)smooth\/[^/]+$/.test(relative) || /^(?:[A-Za-z0-9_-]+\/)?drive\/youtube\/[A-Za-z0-9_-]{6,}\/[^/]+$/.test(relative);
    const places: [string, (relative: string) => boolean][] = [...[...roots].map((root): [string, (relative: string) => boolean] => [root, generated]), [join(app.store.home, "library"), () => true]];
    for (const [root, wanted] of places) {
      const stack = [root];
      for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
        for (const name of safeList(at)) {
          const path = join(at, name);
          let stat: fs.Stats;
          try {
            stat = fs.statSync(path);
          } catch {
            continue;
          }
          if (stat.isDirectory()) stack.push(path);
          else if (wanted(path.slice(root.length + 1)) && !inUse.paths.has(path) && !scripts.has(path) && !uploadingNow(path) && now - stat.mtimeMs >= (PARTIAL.test(name) ? DAY : RECENT)) remove(path);
        }
      }
    }
  }
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
    // With a used file missing, no folder can be known unused (its key is unknown).
    const unused = inUse !== null && inUse.missing === 0 && !inUse.keys.has(name);
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
  // A review copy is removed once its share is published; one a share that
  // failed left (Oct 29: a 669 MB one, two days old) goes after a few days.
  const reviewsDir = join(cache, "reviews");
  for (const project of safeList(reviewsDir)) {
    for (const entry of safeList(join(reviewsDir, project))) {
      if (!entry.endsWith(".mp4")) continue;
      const path = join(reviewsDir, project, entry);
      if (age(path, now) >= DOWNLOADED) remove(path);
    }
  }
  // Research images no project links any more (research.ts's pool).
  const pooled = research.prunePool(app.store.home, dryRun);
  if (pooled > 0) {
    report.bytes += pooled;
    report.files += 1;
    if (report.removed.length < 50) report.removed.push(research.poolDir(app.store.home));
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
      // Finished previews only, not one being made, and none made lately.
      const previews = safeList(dir).filter((entry) => PREVIEW.test(entry) && !PARTIAL.test(entry) && age(join(dir, entry), now) >= RECENT);
      if (previews.length === 0) continue;
      const before = report.bytes;
      for (const entry of previews) remove(join(dir, entry));
      if (!dryRun) app.media.forgetKey(key);
      over -= report.bytes - before;
      report.folders += 1;
    }
  }
  // Cloud cache past the one budget: copies of R2 objects (proxies, sound,
  // originals, excerpts) go least-recently-touched first. Files from the last
  // few hours stay (one may be uploading or playing), and while an export
  // runs (it mixes from the sound copies) the last two days'; the canonical
  // copy is on R2, and a later need fetches or streams it again.
  {
    let exporting = true;
    try {
      exporting = app.exports.running();
    } catch {
      // No exports here to ask (tests): kept as if one ran.
    }
    const fresh = exporting ? RECENT : COPY_RECENT;
    let over = size(cache) - (dryRun ? report.bytes : 0) - limits.cacheBytes;
    if (over > 0) {
      const candidates: { path: string; at: number; bytes: number }[] = [];
      const collect = (dir: string) => {
        for (const name of safeList(dir)) {
          const path = join(dir, name);
          try {
            const stat = fs.statSync(path);
            if (stat.isDirectory()) collect(path);
            else if (now - stat.mtimeMs >= fresh) candidates.push({ path, at: stat.mtimeMs, bytes: stat.size });
          } catch { /* gone */ }
        }
      };
      for (const sub of CLOUD_EVICTABLE) collect(join(cache, "cloud", sub));
      candidates.sort((a, b) => a.at - b.at);
      for (const candidate of candidates) {
        if (over <= 0) break;
        const before = report.bytes;
        remove(candidate.path);
        over -= report.bytes - before;
      }
    }
  }
  // Project history is metadata, but unbounded it breaks the budget alone:
  // past a quarter of it, the oldest snapshots go (the live projects stay).
  {
    const history = join(app.store.home, "projects", "history");
    let over = size(history) - Math.floor(localBudgetBytes() / 4);
    if (over > 0) {
      const files = safeList(history).map((name) => {
        const path = join(history, name);
        try { const s = fs.statSync(path); return { path, at: s.mtimeMs }; } catch { return null; }
      }).filter((f): f is { path: string; at: number } => f !== null).sort((a, b) => a.at - b.at);
      for (const file of files) {
        if (over <= 0) break;
        const before = report.bytes;
        remove(file.path);
        over -= report.bytes - before;
      }
    }
  }
  return report;
}

/** Cleans now and then: a few minutes after the start, then hourly (a day of imports and exports filled the disk). */
export function startCleaning(app: App): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const cloud = await cleanCloudPreviews(app, false);
      const report = cleanCache(app, false);
      report.bytes += cloud.bytes;
      report.files += cloud.files;
      if (report.files > 0) {
        diag.info("cache", `freed ${(report.bytes / 1e9).toFixed(2)} GB: ${report.files} files in ${report.folders} media folders (no project uses them, half-written, or old projects' previews past the cache's limit)`);
      }
    } catch (error) {
      diag.warn("cache", `cleaning the cache: ${diag.messageOf(error)}`);
    } finally { running = false; }
  };
  const first = setTimeout(run, 10 * 60 * 1000);
  const hourly = setInterval(run, 3600 * 1000);
  return () => {
    clearTimeout(first);
    clearInterval(hourly);
  };
}
