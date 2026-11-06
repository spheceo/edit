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
// under its budget, and the disk over FREE_FLOOR free: past either, the
// previews of footage whose projects were saved longest ago go first (made
// again when the project is opened), never those of a project saved in the
// last two days. Runs a little after the server starts and then hourly;
// `POST /api/cache/clean` runs it now (`dry_run`).
//
// The budget is sized to the disk (storage.ts `localBudgetBytes`: a quarter
// of the room, 400 MB to 50 GB; it was 400 MB until Nov 2, when Edit moved
// its exports and playback renders off Modal and back onto the Macs, and
// every preview a project played was evicted and read from R2 again). Past
// it, copies of R2 objects go by project: footage no project here uses
// first, then a done or archived project's, then the projects this Mac had
// open longest ago (`opened.ts`; saved, for one not opened since). A project
// open now or in the last twelve hours keeps all of its, so nothing an edit
// in progress plays or exports from goes from under it; only with the disk
// nearly full do those go too, never one open in the last ten minutes.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import { playbackPath } from "./cloud_playback.ts";
import { Semaphore } from "./media.ts";
import * as diag from "./diag.ts";
import * as drive from "./drive.ts";
import { aheadFile, beingRead } from "./exports.ts";
import * as retention from "./export_retention.ts";
import * as later from "./later.ts";
import { exportRoots } from "./export_folder.ts";
import * as reviews from "./reviews.ts";
import { carryAnalysis, localPath, readLocalOriginals, uploadingNow, writeLocalOriginals } from "./cloud_media.ts";
import { createHash } from "node:crypto";

import { pinned } from "./export_excerpts.ts";
import { openedTimes } from "./opened.ts";
import { join } from "./paths.ts";
import * as research from "./research.ts";
import * as writerStore from "./writer/store.ts";
import { DEFAULT_LOCAL_BUDGET_BYTES, FREE_FLOOR_BYTES, localBudgetBytes } from "./storage.ts";

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
/** Exports made ahead (export_ahead.ts) kept: the ones made last. */
const AHEAD_KEPT = 2;
/** The disk's free space below which old projects' previews go (safety valve only). */
const FREE_FLOOR = FREE_FLOOR_BYTES;
/** A project open this lately keeps all of its cache (an edit in progress). */
const SESSION = 12 * 3600 * 1000;
/** With the disk nearly full, only a project open this lately keeps its. */
const OPEN_NOW = 10 * 60 * 1000;
/** Cloud-cache subtrees holding rebuildable copies of R2 objects (LRU-evicted past the budget); `blocks` are previews read for playback (cloud_blocks.ts). */
const CLOUD_EVICTABLE = ["proxies", "sound", "originals", "excerpts", "blocks", "scrub", "pieces"];
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
function used(app: App): Used | null {
  const paths = new Set<string>();
  // Files a project uses that aren't here: their key can't be known.
  let missing = 0;
  const keys = new Set<string>();
  // Each key's latest save of a project using it.
  const saved = new Map<string, number>();
  const projects = new Map<string, UsedProject>();
  const keyProjects = new Map<string, Set<string>>();
  const dir = join(app.store.home, "projects");
  for (const name of safeList(dir).filter((name) => name.endsWith(".json"))) {
    let media: { path?: unknown; cloud?: { source?: unknown; original?: unknown; proxy?: unknown } | null }[] = [];
    let at = 0;
    try {
      at = fs.statSync(join(dir, name)).mtimeMs;
      const value = JSON.parse(fs.readFileSync(join(dir, name), "utf8")) as { media?: typeof media };
      media = Array.isArray(value.media) ? value.media : [];
    } catch (error) {
      diag.warn("cache", `${name} won't read, so nothing it might use is cleaned (${diag.messageOf(error)})`);
      return null;
    }
    const id = name.slice(0, -".json".length);
    const project: UsedProject = { saved: at, tokens: new Set(), blocks: new Set() };
    projects.set(id, project);
    for (const item of media) {
      const cloudMedia = item.cloud;
      if (cloudMedia !== null && typeof cloudMedia === "object") {
        for (const key of [cloudMedia.original, cloudMedia.proxy]) {
          if (typeof key !== "string") continue;
          const token = ownerToken(key);
          if (token !== null) project.tokens.add(token);
          project.blocks.add(blockFolder(key));
        }
        if (typeof cloudMedia.source === "string") {
          const token = sourceToken(cloudMedia.source);
          if (token !== null) project.tokens.add(token);
        }
      }
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
        let users = keyProjects.get(key);
        if (users === undefined) keyProjects.set(key, users = new Set());
        users.add(id);
      } catch {
        // A path the addon can't key: nothing of it is touched either way.
      }
    }
  }
  return { paths, keys, saved, missing, projects, keyProjects };
}

interface UsedProject {
  /** When its file was last written here. */
  saved: number;
  /** Its cloud footage's places in keys (`ownerToken`): `drive/<id>`, `sha256/<hex>`, `youtube/<id>`. */
  tokens: Set<string>;
  /** Its proxies' and originals' block folders (cloud_blocks.ts). */
  blocks: Set<string>;
}

interface Used {
  paths: Set<string>;
  keys: Set<string>;
  saved: Map<string, number>;
  missing: number;
  projects: Map<string, UsedProject>;
  /** The projects using each media key. */
  keyProjects: Map<string, Set<string>>;
}

/** Folders under `edit/` whose keys name a source's place next (`edit/<folder>/<place>…`); a sound copy's is its original's key again. */
const KEYED = ["originals/", "excerpts/", "proxies/", "sound/", "analysis/", "scrub/", "pieces/"];

/** The footage `key` (an R2 key, `edit/…`) is of, as `<kind>/<id>` (`drive/1AbC…`), or the project's for a playback render (`playback:<project>`); null for anything else. */
export function ownerToken(key: string): string | null {
  let rest = key.startsWith("edit/") ? key.slice("edit/".length) : key;
  if (rest.startsWith("exports/playback/")) rest = rest.slice("exports/".length);
  if (rest.startsWith("playback/")) {
    const project = rest.slice("playback/".length).split("/")[0];
    return project ? `playback:${project}` : null;
  }
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const folder of KEYED) {
      if (rest.startsWith(folder)) {
        rest = rest.slice(folder.length);
        stripped = true;
      }
    }
  }
  // A pieced proxy's layout version (proxy_pieces.ts `baseKey`).
  rest = rest.replace(/^v\d+\//, "");
  const match = /^(drive|youtube|sha256)\/([A-Za-z0-9_-]+)/.exec(rest);
  return match === null ? null : `${match[1]}/${match[2]}`;
}

/** A registry source's place (`drive:<id>#<range>` → `drive/<id>`). */
function sourceToken(source: string): string | null {
  const match = /^(drive|youtube|sha256):([A-Za-z0-9_-]+)/.exec(source);
  return match === null ? null : `${match[1]}/${match[2]}`;
}

/** A key's folder under `cloud/blocks` (cloud_blocks.ts names them so). */
function blockFolder(key: string): string {
  return createHash("sha1").update(key).digest("hex");
}

/**
 * When each project was last worked on here, for the cache's order: its last
 * open (opened.ts), else its last save; 0 for a done or archived one, so its
 * footage goes before an active project's.
 */
function lastUsed(app: App, inUse: Used, done: Set<string>): Map<string, number> {
  const opened = openedTimes(app.store.home);
  let archived: Record<string, unknown> = {};
  try {
    archived = JSON.parse(fs.readFileSync(join(app.store.home, "cloud", "archived.json"), "utf8")) as Record<string, unknown>;
  } catch {
    // None archived here.
  }
  const times = new Map<string, number>();
  for (const [id, project] of inUse.projects) {
    times.set(id, done.has(id) || archived[id] !== undefined ? 0 : (opened[id] ?? project.saved));
  }
  return times;
}

/** When a project open now uses this copy of the cloud: the newest of their `lastUsed`; -1 for none (footage no project here uses). */
function copyUsed(path: string, cache: string, inUse: Used, times: Map<string, number>): number {
  const cloudDir = join(cache, "cloud");
  const relative = path.slice(cloudDir.length + 1);
  let owners: (project: UsedProject, id: string) => boolean;
  if (relative.startsWith("blocks/")) {
    const folder = relative.slice("blocks/".length).split("/")[0] ?? "";
    let token: string | null = null;
    try {
      const meta = JSON.parse(fs.readFileSync(join(cloudDir, "blocks", folder, "meta.json"), "utf8")) as { key?: unknown };
      if (typeof meta.key === "string") token = ownerToken(meta.key);
    } catch {
      // A folder from before keys were kept: known by its name alone.
    }
    owners = (project, id) => project.blocks.has(folder) || (token !== null && (project.tokens.has(token) || token === `playback:${id}`));
  } else {
    const token = ownerToken(`edit/${relative}`);
    if (token === null) return -1;
    owners = (project, id) => project.tokens.has(token) || token === `playback:${id}`;
  }
  let newest = -1;
  for (const [id, project] of inUse.projects) if (owners(project, id)) newest = Math.max(newest, times.get(id) ?? 0);
  return newest;
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
  given?: Limits,
  done: Set<string> = new Set(),
): CleanReport {
  // A home that isn't one (EDIT_HOME="") cleans nothing: its cache would be "/cache".
  if (app.store.home.trim() === "" || app.store.home === "/") return { folders: 0, files: 0, bytes: 0, removed: [] };
  const cache = app.store.cacheDir();
  const limits: Limits = given ?? { cacheBytes: localBudgetBytes({ freeBytes: freeSpace(cache), cacheBytes: size(cache) }), freeBytes: FREE_FLOOR };
  const inUse = used(app);
  const times = inUse === null ? new Map<string, number>() : lastUsed(app, inUse, done);
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
    // A script's original can be one of these when it couldn't be hard-linked (another disk).
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
    // Its sound kept a minute at a time (smooth playback's, the engine's mix.rs render_kept), the same way.
    for (const entry of safeList(join(chunksDir, project, "sound"))) {
      const path = join(chunksDir, project, "sound", entry);
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
  // Exports made ahead (export_ahead.ts), each about as big as the export: the
  // two made last stay while they're under three days old; the one being made
  // is never touched (its `.json` comes only once it's done, so it's not listed).
  {
    const aheadDir = join(cache, "ahead");
    const made = safeList(aheadDir)
      .filter((name) => name.endsWith(".mp4.json"))
      .map((name) => {
        try {
          return { path: join(aheadDir, name.slice(0, -".json".length)), at: fs.statSync(join(aheadDir, name)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((one): one is { path: string; at: number } => one !== null)
      .sort((a, b) => b.at - a.at);
    // The project whose export is being made again now: it copies its unchanged chunks out of the last one.
    const making = makingAhead(app);
    for (const [index, one] of made.entries()) {
      if (index < AHEAD_KEPT && now - one.at < DOWNLOADED) continue;
      if (making !== null && one.path === aheadFile(cache, making)) continue;
      remove(one.path);
      remove(`${one.path}.json`);
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
    // By when their projects were last worked on here (a key several use: the latest), none in an edit in progress.
    const worked = (key: string) => Math.max(...[...(inUse.keyProjects.get(key) ?? [])].map((id) => times.get(id) ?? 0), 0);
    const oldest = [...inUse.saved]
      .filter(([key, at]) => now - at >= RECENT && now - worked(key) >= SESSION)
      .map(([key]) => [key, worked(key)] as const)
      .sort((a, b) => a[1] - b[1]);
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
  // Cloud cache past the budget, or the disk nearly full: copies of R2
  // objects (proxies, sound, originals, excerpts, blocks), by project as the
  // notes at the top say, the least recently touched first within one. Files
  // from the last few hours stay (one may be uploading or playing), and while
  // an export runs (it mixes from the sound copies) the last two days'; the
  // canonical copy is on R2, and a later need fetches or streams it again.
  {
    let exporting = true;
    try {
      exporting = app.exports.running();
    } catch {
      // No exports here to ask (tests): kept as if one ran.
    }
    const fresh = exporting ? RECENT : COPY_RECENT;
    const free = limits.free !== undefined ? limits.free + report.bytes : freeSpace(cache) + (dryRun ? report.bytes : 0);
    const full = limits.freeBytes - free > 0;
    let over = Math.max(size(cache) - (dryRun ? report.bytes : 0) - limits.cacheBytes, limits.freeBytes - free);
    if (over > 0) {
      const candidates: { path: string; at: number; bytes: number; worked: number }[] = [];
      const collect = (dir: string) => {
        for (const name of safeList(dir)) {
          const path = join(dir, name);
          try {
            const stat = fs.statSync(path);
            if (stat.isDirectory()) collect(path);
            else if (now - stat.mtimeMs >= fresh && name !== "meta.json" && !pinned(path)) {
              const worked = inUse === null ? Number.POSITIVE_INFINITY : copyUsed(path, cache, inUse, times);
              // An edit in progress keeps its own (with the disk nearly full, only one open now).
              if (now - worked < (full ? OPEN_NOW : SESSION)) continue;
              candidates.push({ path, at: stat.mtimeMs, bytes: stat.size, worked });
            }
          } catch { /* gone */ }
        }
      };
      for (const sub of CLOUD_EVICTABLE) collect(join(cache, "cloud", sub));
      // Exports made ahead go before footage a project still edits from: made again from it if they're wanted.
      for (const name of safeList(join(cache, "ahead"))) {
        if (!name.endsWith(".mp4.json")) continue;
        const path = join(cache, "ahead", name.slice(0, -".json".length));
        const making = makingAhead(app);
        if (making !== null && path === aheadFile(cache, making)) continue;
        try {
          const stat = fs.statSync(path);
          candidates.push({ path, at: stat.mtimeMs, bytes: stat.size, worked: Number.NEGATIVE_INFINITY });
        } catch { /* gone */ }
      }
      candidates.sort((a, b) => a.worked - b.worked || a.at - b.at);
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
    let over = size(history) - Math.floor(DEFAULT_LOCAL_BUDGET_BYTES / 4);
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

/** The project whose export is being made ahead now (exports.ts `aheadFor`); none where there are no exports (tests). */
function makingAhead(app: App): string | null {
  try {
    return (app.exports as { aheadFor?: () => string | null }).aheadFor?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Older exports of each project that are no longer wanted (export_retention.ts):
 * with `dryRun` only logged ("would delete …").
 */
export function cleanExports(app: App, dryRun: boolean, now = Date.now()): { files: number; bytes: number; decisions: retention.Decision[] } {
  const home = app.store.home;
  let records: Record<string, retention.Kept[]> = {};
  try {
    records = JSON.parse(fs.readFileSync(join(home, "exports.json"), "utf8")) as Record<string, retention.Kept[]>;
  } catch {
    return { files: 0, bytes: 0, decisions: [] };
  }
  const roots = new Set(exportRoots(home));
  const shared = reviews.read(home).shared;
  const free = freeSpace(app.store.cacheDir());
  const decisions = retention.decide(records, {
    now,
    roots: [...roots],
    reviewed: (id, path) => shared[id]?.versions.find((version) => version.path === path)?.n ?? null,
    onDrive: (id) => app.store.get(id)?.project.drive?.uploaded_ms ?? null,
    busy: (id, path) => {
      let exporting = false;
      try {
        exporting = app.exports.runningFor?.(id)?.output === path;
      } catch {
        // No exports here (tests).
      }
      return exporting || beingRead(path) || reviews.sharingNow(id) || drive.uploading(id);
    },
    short: Number.isFinite(free) ? FREE_FLOOR - free : 0,
  });
  return { ...retention.apply(home, decisions, dryRun), decisions };
}

/** Cleans now and then: a few minutes after the start, then hourly (a day of imports and exports filled the disk). */
export function startCleaning(app: App): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const cloud = await cleanCloudPreviews(app, false);
      // Edits marked done on Home: their footage goes before an active one's.
      const done = new Set<string>();
      try {
        for (const entry of await later.list()) if (entry.done === true && entry.key.startsWith("edit:")) done.add(entry.key.slice("edit:".length));
      } catch {
        // Later unreachable: ordered by last open alone.
      }
      const report = cleanCache(app, false, Date.now(), undefined, done);
      const old = cleanExports(app, false);
      report.bytes += old.bytes;
      report.files += old.files;
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
