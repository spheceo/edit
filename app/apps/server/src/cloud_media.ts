// Footage of cloud projects: originals and proxies on R2
// (`cloud.ts`), only the small proxies on this machine. A media's `cloud` says
// where its files are; its `path` is this machine's copy of the proxy.
//
// Cloud mode is on when `cloud.enabled()` (a relay token is set); without it
// nothing here runs and media work as before.
//
// Sources (the keys of Convex's footage registry, `edit:getMedia` /
// `putMedia`, one record per thing on R2, shared by every project and
// machine, so nothing is uploaded or encoded twice):
// - `drive:<file id>`: a Google Drive file, whole.
// - `drive:<file id>#<start ms>-<end ms>`: an excerpt of one (a script uses
//   minutes of hours of footage): `start` is the keyframe it begins on, both
//   in whole milliseconds of the Drive file.
// - `sha256:<hex>`: a file from a disk (added files, browser uploads,
//   voice-over takes, library sounds, stills), by its content.
// - `youtube:<video id>` and `youtube:<video id>#<start ms>-<end ms>`: a
//   YouTube video (downloaded here with yt-dlp, `youtube.ts`) and its
//   excerpts, as Drive's; keys `edit/{originals,excerpts,proxies,analysis}/youtube/<id>/…`.
//
// R2 keys (all under `edit/`):
// - `edit/originals/drive/<file id>/<name>` and `edit/originals/sha256/<hex>/<name>`:
//   full-quality originals, as they came.
// - `edit/excerpts/drive/<file id>/<start ms>-<end ms>.<ext>`: full-quality
//   excerpts (picture copied, sound AAC 192k: what `script.cut` makes).
// - `edit/proxies/drive/<file id>.mp4`, `edit/proxies/drive/<file id>/<start ms>-<end ms>.mp4`,
//   `edit/proxies/sha256/<hex>.mp4`: proxies (the addon's `makeCloudProxy`:
//   ≤1080p H.264 at 4 Mbit/s with half-second keyframes, no B-frames, BT.709,
//   AAC 160k stereo; ~31 MB a minute). The proxy is also the media's preview
//   (linked, not encoded again) and what transcription, the watcher, frame
//   grabs and the agent's looks read.
// - `edit/analysis/<source path>/<file>`: analysis that costs money to redo
//   (transcript, faces, seats, the watcher's answers), beside the source.
//
// Sounds and pictures (no proxy needed: they're small) keep their own file as
// `path`, and their `proxy` is the original's key.
//
// This machine's copy of a key is `<cache>/cloud/<key without edit/>`
// (`localPath`), so another machine finds (or fetches) the same file in its
// own cache: `ensureLocal`. Exports read the originals (`forExport`).
// Scratch files (an excerpt between cutting and uploading) live in
// `<cache>/cloud/tmp` and are removed when done or failed.
//
// Fixed while porting (not in the Rust): when a media's `path` becomes its
// proxy (an upload made here: `importLocal` of a file analysed before, or the
// backfill of one), its analysis stayed under the original's cache key, so
// the transcript, the watcher's answers, faces and seats it had paid for were
// orphaned. `carryAnalysis` copies them to the proxy's cache folder (the
// watcher's answers with the old key named in `watch/keys.json`, which the
// watcher reads: its answers are named by the media key), and the next
// `shareAnalysis` puts them in the cloud.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import * as endpoints from "./endpoints.ts";
import { copyFile, ioMessage, nextFileId, nowMs, writeAtomic } from "./files.ts";
import { isBug } from "./guard.ts";
import * as jobs from "./jobs.ts";
import { mediaKey, Semaphore } from "./media.ts";
import * as youtube from "./youtube.ts";
import type { Clip, Media, Probe, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { canonical, extension, fileStem, isFile, join, parent } from "./paths.ts";
import { mediaOf } from "./project.ts";
import { charCount, debugStr, takeChars, trim } from "./rust.ts";
import * as seams from "./seams.ts";
import type { Excerpt, Made, Original, Originals } from "./seams.ts";
import * as tools from "./tools.ts";
import { stableStringify } from "./stable.ts";

export { isLocalCopy } from "./media.ts";
export type { Made, Original } from "./seams.ts";

const HOUR = 3600;
/** Proxies fetched at once. */
const PARALLEL = 3;
/** Analysis files fetched at once per source (each a few KB). */
const ANALYSIS_AT_ONCE = 8;

/**
 * What this module uses of the script package (its seam), here so tests can
 * stand in for it before it lands.
 */
export const scriptParts = {
  safeName: (name: string): string => seams.script.safeName(name),
  clock: (seconds: number): string => seams.script.clock(seconds),
  resolve: (file: string, scratch: string) => seams.script.resolve(file, scratch),
  durationOf: (path: string): Promise<number> => seams.script.durationOf(path),
  keyframeBefore: (path: string, time: number): Promise<number> => seams.script.keyframeBefore(path, time),
  spans: (ranges: [number, number][], duration: number): [number, number][] => seams.script.spans(ranges, duration),
  cut: (source: string, start: number, to: number, out: string): Promise<void> => seams.script.cut(source, start, to, out),
};

// ---------------------------------------------------------------------------
// The footage registry (Convex, `edit:` functions through the relay).

/** A registry record (`edit:getMedia`). */
export interface Record_ {
  source: string;
  name: string;
  originalKey: string;
  originalReady: boolean;
  proxyKey: string | null;
  proxyReady: boolean;
  size: number;
  duration: number | null;
}

export type { Record_ as Record };

function typeName(value: unknown): string {
  if (typeof value === "boolean") return `boolean \`${value}\``;
  if (typeof value === "number") return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (Array.isArray(value)) return "sequence";
  if (value === null) return "null";
  return "map";
}

/** A record as serde reads it (camelCase, every field defaulted); throws serde's complaint. */
export function readRecord(value: unknown): Record_ {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid type: ${typeName(value)}, expected struct Record`);
  }
  const fields = value as Record<string, unknown>;
  const text = (key: string): string => {
    const given = fields[key];
    if (given === undefined) return "";
    if (typeof given !== "string") throw new Error(`invalid type: ${typeName(given)}, expected a string`);
    return given;
  };
  const flag = (key: string): boolean => {
    const given = fields[key];
    if (given === undefined) return false;
    if (typeof given !== "boolean") throw new Error(`invalid type: ${typeName(given)}, expected a boolean`);
    return given;
  };
  const optionalText = (key: string): string | null => {
    const given = fields[key];
    if (given === undefined || given === null) return null;
    if (typeof given !== "string") throw new Error(`invalid type: ${typeName(given)}, expected a string`);
    return given;
  };
  const number = (key: string): number | null => {
    const given = fields[key];
    if (given === undefined || given === null) return null;
    if (typeof given !== "number") throw new Error(`invalid type: ${typeName(given)}, expected f64`);
    return given;
  };
  if (fields.size === null) throw new Error("invalid type: null, expected f64");
  return {
    source: text("source"),
    name: text("name"),
    originalKey: text("originalKey"),
    originalReady: flag("originalReady"),
    proxyKey: optionalText("proxyKey"),
    proxyReady: flag("proxyReady"),
    size: number("size") ?? 0,
    duration: number("duration"),
  };
}

export function readyProxy(record: Record_ | null): string | null {
  if (record === null) return null;
  const key = record.proxyKey;
  return key !== null && record.proxyReady && cloud.validKey(key) ? key : null;
}

export function readyOriginal(record: Record_ | null): string | null {
  if (record === null) return null;
  return record.originalReady && cloud.validKey(record.originalKey) ? record.originalKey : null;
}

export async function getRecord(source: string): Promise<Record_ | null> {
  const value = await cloud.query("edit:getMedia", { source });
  if (value === null || value === undefined) return null;
  try {
    return readRecord(value);
  } catch (error) {
    throw new Error(`the footage registry answered oddly: ${diag.messageOf(error)}`);
  }
}

export async function listRecords(sources: string[]): Promise<Record_[]> {
  const value = await cloud.query("edit:listMedia", { sources });
  const out: Record_[] = [];
  for (const record of Array.isArray(value) ? value : []) {
    if (record === null) continue;
    try {
      out.push(readRecord(record));
    } catch {
      // Skipped, as serde's `.ok()` skips it.
    }
  }
  return out;
}

/** Upserts a record by `fields.source` (a new one needs name, originalKey, size). */
async function putRecord(fields: Record<string, unknown>): Promise<void> {
  await cloud.mutation("edit:putMedia", fields);
}

// ---------------------------------------------------------------------------
// Sources, keys and local copies.

export function driveIdOk(id: string): boolean {
  return id !== "" && id.length <= 200 && /^[A-Za-z0-9_-]+$/.test(id);
}

function millis(seconds: number): number {
  return Math.max(Math.round(seconds * 1000), 0);
}

/** An excerpt's source: of a Drive file id, or of a source (`youtube:<id>`). */
export function excerptSource(file: string, start: number, end: number): string {
  const base = file.includes(":") ? file : `drive:${file}`;
  return `${base}#${millis(start)}-${millis(end)}`;
}

/** A whole source's place in keys: `drive/<id>`, `youtube/<id>`. */
function sourcePath(source: string): string {
  const colon = source.indexOf(":");
  return `${source.slice(0, colon)}/${source.slice(colon + 1)}`;
}

/** The proxy's key for a source (see the notes at the top). */
export function proxyKey(source: string): string | null {
  let key: string;
  const kind = ["drive:", "youtube:"].find((prefix) => source.startsWith(prefix));
  if (kind !== undefined) {
    const rest = source.slice(kind.length);
    const hash = rest.indexOf("#");
    const id = hash >= 0 ? rest.slice(0, hash) : rest;
    if (kind === "youtube:" && youtube.idOf(`youtube:${id}`) === null) return null;
    const dir = `edit/proxies/${kind.slice(0, -1)}`;
    key = hash >= 0 ? `${dir}/${id}/${rest.slice(hash + 1)}.mp4` : `${dir}/${id}.mp4`;
  } else if (source.startsWith("sha256:")) {
    key = `edit/proxies/sha256/${source.slice("sha256:".length)}.mp4`;
  } else {
    return null;
  }
  return cloud.validKey(key) ? key : null;
}

const CONTROL = /^\p{Cc}$/u;

/** A file name fit for a key's last segment (and a file here). */
export function segment(name: string): string {
  const cleaned = [...scriptParts.safeName(name)].filter((char) => !CONTROL.test(char) && char !== "\\" && char !== "/").join("");
  const trimmed = trim(cleaned);
  if (charCount(trimmed) <= 120) return trimmed;
  // Long names keep their extension.
  const ext = extension(trimmed);
  const kept = ext !== null && ext.length + 1 <= 10 ? `.${ext}` : "";
  const stem = trim(takeChars(trimmed, 110));
  return `${stem}${kept}`;
}

/** A file extension fit for a key: letters and digits, else mp4. */
export function extensionOf(name: string): string {
  const ext = extension(name)?.toLowerCase();
  return ext !== undefined && ext !== "" && ext.length <= 8 && /^[a-z0-9]+$/.test(ext) ? ext : "mp4";
}

/** This machine's copy of `key`: `<cache>/cloud/<key without edit/>`. */
export function localPath(cache: string, key: string): string {
  return join(cache, "cloud", key.startsWith("edit/") ? key.slice("edit/".length) : key);
}

/** `<cache>/cloud/tmp`, for files on their way up; anything left there by a run that died over half a day ago is removed. */
export function scratchDir(cache: string): string {
  const dir = join(cache, "cloud", "tmp");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new Error(ioMessage(error));
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  for (const name of names) {
    try {
      if (Date.now() - fs.statSync(join(dir, name)).mtimeMs > 12 * HOUR * 1000) fs.rmSync(join(dir, name), { force: true });
    } catch {
      // Gone already.
    }
  }
  return dir;
}

/** A scratch file's name (removed with `rmSync` when done). */
function scratchFile(dir: string, ext: string): string {
  return join(dir, `${process.pid}-${nowMs()}-${nextFileId()}.${ext}`);
}

/** `text` with every URL replaced: presigned URLs are credentials, never shown or logged. */
export const scrub = diag.scrub;

function getUrl(key: string, lasting: number): Promise<string> {
  return cloud.presign(key, "GET", lasting);
}

/** Probes the object at a presigned URL (the addon scrubs its errors). */
function probeUrl(url: string): Promise<Probe> {
  return native().probe(url);
}

/** Downloads in progress, by destination: a second ask for the same file waits for the first and finds it. */
const fetching = new Map<string, Promise<void>>();

/** Downloads `key` to `local` unless it's there already, one download per file at a time. */
export async function fetchKey(key: string, local: string): Promise<void> {
  for (;;) {
    const running = fetching.get(local);
    if (running === undefined) break;
    await running.catch(() => {});
  }
  if (isFile(local)) return;
  const job = cloud.download(key, local);
  fetching.set(local, job);
  try {
    await job;
  } finally {
    if (fetching.get(local) === job) fetching.delete(local);
  }
}

/**
 * Where this machine has a cloud original's very file (it was imported from
 * here), so an export reads it from the disk with AVFoundation instead of
 * fetching it from the cloud: a 29-minute subtitled video's sound alone took
 * 3.5 minutes over the network. `<cache>/cloud/local-originals.json`, key →
 * the file, its size and modification time; machine-local, never shared.
 * The user's file is only ever read.
 */
export interface LocalOriginal {
  path: string;
  size: number;
  mtime_ms: number;
  /** When an export last read it (or it was noted): copies Edit downloaded go a few days after. */
  used_ms?: number;
}

function localOriginalsFile(cache: string): string {
  return join(cache, "cloud", "local-originals.json");
}

export function readLocalOriginals(cache: string): Record<string, LocalOriginal> {
  try {
    const value = JSON.parse(fs.readFileSync(localOriginalsFile(cache), "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, LocalOriginal>) : {};
  } catch {
    return {};
  }
}

/** Notes that `path` (on this machine) is the original stored at `key`. */
export function rememberLocalOriginal(cache: string, key: string, path: string): void {
  try {
    const stat = fs.statSync(path);
    const known = readLocalOriginals(cache);
    known[key] = { path, size: stat.size, mtime_ms: stat.mtimeMs, used_ms: Date.now() };
    fs.mkdirSync(join(cache, "cloud"), { recursive: true });
    writeAtomic(localOriginalsFile(cache), JSON.stringify(known, null, 1));
  } catch (error) {
    diag.warn("cloud", `couldn't note ${path} as the original of ${key}: ${diag.messageOf(error)}`);
  }
}

/** Replaces the notes (cache_cleanup.ts drops the copies it removes). */
export function writeLocalOriginals(cache: string, known: Record<string, LocalOriginal>): void {
  fs.mkdirSync(join(cache, "cloud"), { recursive: true });
  writeAtomic(localOriginalsFile(cache), JSON.stringify(known, null, 1));
}

/**
 * The file on this machine that is still the original at `key` (same size and
 * modification time), if any; `use`: an export reads it now (noted, so a
 * copy Edit downloaded stays while it's used).
 */
export function localOriginal(cache: string, key: string, use = false): string | null {
  const known = readLocalOriginals(cache);
  const entry = known[key];
  if (entry === undefined || typeof entry.path !== "string") return null;
  try {
    const stat = fs.statSync(entry.path);
    if (!(stat.isFile() && stat.size === entry.size && stat.mtimeMs === entry.mtime_ms)) return null;
  } catch {
    return null;
  }
  if (use) {
    try {
      entry.used_ms = Date.now();
      writeLocalOriginals(cache, known);
    } catch {
      // Only a note.
    }
  }
  return entry.path;
}

/** The SHA-256 of a file, in lowercase hex. */
export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  let fd: number;
  try {
    fd = fs.openSync(path, "r");
  } catch (error) {
    throw new Error(ioMessage(error));
  }
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    let position = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (read === 0) break;
      hasher.update(buffer.subarray(0, read));
      position += read;
      // Big files: let other work run between megabytes.
      if (position % (64 << 20) === 0) await Bun.sleep(0);
    }
  } catch (error) {
    throw new Error(ioMessage(error));
  } finally {
    fs.closeSync(fd);
  }
  return hasher.digest("hex");
}

function sizeOf(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

/** The thrown error's text (a bug's thrown on). */
function failure(error: unknown): string {
  if (isBug(error)) throw error;
  return diag.messageOf(error);
}

/**
 * Uploads a local original (unless it's up already) while its proxy is made
 * at `local` (unless it's here already), then uploads the proxy, recording
 * each in the registry as it's done. A proxy made here is removed again when
 * anything fails, so a failure leaves nothing behind.
 */
/**
 * An import's uploads, left to finish after the import answered: the
 * original (when the cloud hasn't it) and the proxy made here (when the
 * cloud hasn't it), then the registry told they're ready.
 */
export interface Upload {
  file: string;
  source: string;
  size: number;
  duration: number;
  originalKey: string;
  uploadOriginal: boolean;
  /** The proxy's key and this machine's copy, when it goes up too. */
  proxy: string | null;
  local: string | null;
  /** `file` is Edit's own copy (a browser upload): removed once it's all up, never before. */
  removeAfter?: boolean;
}

/** Uploads imports left running, by the file imported: whether they all went up. */
const uploading = new Map<string, { key: string; home: string; upload: Upload; done: Promise<boolean> }>();
/** One at a time, beside whatever else uses the network. */
const uploadSlot = new Semaphore(1);

/**
 * Resolves once the uploads importing `file` started are done (at once when
 * there are none): true when they all went up, false when one failed (it's
 * tried again when Edit starts).
 */
export function uploaded(file: string): Promise<boolean> {
  return uploading.get(file)?.done ?? Promise.resolve(true);
}

/**
 * Removes `file` (Edit's own copy of a browser upload) once its upload is
 * safely in the cloud: now if nothing is uploading it, else when that
 * upload succeeds, here or after a restart. A failed upload keeps it, as
 * the only copy of the original.
 */
export function removeWhenUploaded(file: string): void {
  const running = uploading.get(file);
  if (running === undefined) {
    fs.rmSync(file, { force: true });
    return;
  }
  running.upload.removeAfter = true;
  // Noted with the job, so a restart's retry removes it too.
  jobs.begin(running.home, "upload", "-", { ...running.upload }, running.upload.source);
}

/**
 * Starts `upload` in the background, noted in `<home>/jobs.json` so a
 * restart carries on with it; a failure is logged and stays noted, so the
 * next start tries again.
 */
export function uploadLater(home: string, upload: Upload): void {
  const key = jobs.begin(home, "upload", "-", { ...upload }, upload.source);
  const entry = { key, home, upload, done: Promise.resolve(true) };
  entry.done = uploadSlot
    .with(() => diag.timeOnAsync("cloud", "cloud: upload import", upload.file, () => runUpload(upload)))
    .then(
      () => {
        jobs.end(home, key);
        if (upload.removeAfter === true) fs.rmSync(upload.file, { force: true });
        return true;
      },
      (error: unknown) => {
        diag.error("cloud", `uploading ${upload.file}: ${scrub(failure(error))} (tried again when Edit starts)`);
        return false;
      },
    )
    .finally(() => {
      if (uploading.get(upload.file) === entry) uploading.delete(upload.file);
    });
  uploading.set(upload.file, entry);
}

async function runUpload(upload: Upload): Promise<void> {
  if (upload.uploadOriginal) {
    await cloud.uploadFile(upload.file, upload.originalKey);
    await putRecord({ source: upload.source, originalReady: true, size: upload.size, duration: upload.duration });
  }
  if (upload.proxy !== null && upload.local !== null) {
    await cloud.uploadFile(upload.local, upload.proxy);
    await putRecord({ source: upload.source, proxyKey: upload.proxy, proxyReady: true });
  }
}

/** A noted upload a restart cut short (jobs.ts), started again while its files are still here. */
export function resumeUpload(home: string, args: Record<string, unknown>): void {
  const upload = args as unknown as Upload;
  if (typeof upload.file !== "string" || typeof upload.source !== "string" || typeof upload.originalKey !== "string") {
    throw new Error("not an upload");
  }
  if (upload.uploadOriginal && !isFile(upload.file)) throw new Error(`${upload.file} is gone`);
  if (upload.local !== null && !isFile(upload.local)) throw new Error(`${upload.local} is gone`);
  uploadLater(home, upload);
}

async function publish(
  file: string,
  probe: Probe,
  source: string,
  originalKey: string,
  uploadOriginal: boolean,
  proxy: string,
  local: string,
  later: string | null = null,
): Promise<void> {
  if (later !== null) {
    // The import needs only the proxy here: the uploads go on after it answers.
    if (!isFile(local)) {
      await diag.timeOnAsync("cloud", "cloud: make proxy", source, async () => {
        if (parent(local) !== null) fs.mkdirSync(parent(local)!, { recursive: true });
        try {
          await native().makeCloudProxy(file, probe, local);
        } catch (error) {
          fs.rmSync(local, { force: true });
          throw error;
        }
      });
    }
    uploadLater(later, { file, source, size: sizeOf(file), duration: probe.duration, originalKey, uploadOriginal, proxy, local });
    return;
  }
  const makeHere = !isFile(local);
  const settle = (work: Promise<void>) => work.then(() => null, (error: unknown) => error);
  const [sent, proxied] = await Promise.all([
    settle(uploadOriginal ? cloud.uploadFile(file, originalKey) : Promise.resolve()),
    settle(
      makeHere
        ? diag.timeOnAsync("cloud", "cloud: make proxy", source, async () => {
            if (parent(local) !== null) fs.mkdirSync(parent(local)!, { recursive: true });
            await native().makeCloudProxy(file, probe, local);
          })
        : Promise.resolve(),
    ),
  ]);
  try {
    if (sent !== null) throw sent;
    if (uploadOriginal) {
      await putRecord({ source, originalReady: true, size: sizeOf(file), duration: probe.duration });
    }
    if (proxied !== null) throw proxied;
    await cloud.uploadFile(local, proxy);
    await putRecord({ source, proxyKey: proxy, proxyReady: true });
  } catch (error) {
    if (makeHere) fs.rmSync(local, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Files from a disk (`import.importPaths`).

/**
 * Puts a file from this machine in the cloud (deduplicated by content) and
 * returns the media to add: footage as its proxy (made here, or fetched when
 * the cloud has it already), a sound or picture as the file itself. The file
 * is never changed or removed.
 */
export function importLocal(cache: string, path: string, probe: Probe, name: string): Promise<Made> {
  // Footage answers once its proxy is made here; the uploads carry on behind
  // (`uploadLater`), so an import never waits for gigabytes to go up.
  return putLocal(cache, path, probe, name, probe.kind !== "video", parent(cache));
}

/**
 * `importLocal`; `own`: the file goes up as it is and is its own proxy
 * (sounds, pictures, short renders Edit made), else it gets a proxy. With
 * `later` (the data folder), footage's uploads finish in the background.
 */
async function putLocal(cache: string, path: string, probe: Probe, name: string, own: boolean, later: string | null = null): Promise<Made> {
  const hex = await sha256File(path);
  const source = `sha256:${hex}`;
  const size = sizeOf(path);
  const record = await getRecord(source);
  const known = record !== null && cloud.validKey(record.originalKey) ? record.originalKey : null;
  const originalKey = known ?? `edit/originals/sha256/${hex}/${segment(name)}`;
  if (record === null) await putRecord({ source, name, originalKey, size });
  const needOriginal = readyOriginal(record) === null;
  if (own) {
    if (needOriginal) await cloud.uploadFile(path, originalKey);
    if (needOriginal || readyProxy(record) === null) {
      await putRecord({ source, originalReady: true, proxyKey: originalKey, proxyReady: true, duration: probe.duration });
    }
    return { path, name, probe, cloud: { source, original: originalKey, proxy: originalKey, size } };
  }
  // Exports read this very file while it's here; elsewhere, its sound copy.
  rememberLocalOriginal(cache, originalKey, path);
  if (probe.has_audio) shareSound(cache, path, originalKey);
  const ready = readyProxy(record);
  const proxy = ready ?? proxyKey(source);
  if (proxy === null) throw new Error("no proxy key");
  const local = localPath(cache, proxy);
  if (ready !== null) {
    if (needOriginal && later !== null) {
      uploadLater(later, { file: path, source, size, duration: probe.duration, originalKey, uploadOriginal: true, proxy: null, local: null });
    } else if (needOriginal) {
      await cloud.uploadFile(path, originalKey);
      await putRecord({ source, originalReady: true, size });
    }
    await fetchKey(proxy, local);
  } else {
    await publish(path, probe, source, originalKey, needOriginal, proxy, local, later);
  }
  const made = canonical(local);
  carryAnalysis(cache, path, made);
  return { path: made, name, probe, cloud: { source, original: originalKey, proxy, size } };
}

// ---------------------------------------------------------------------------
// Google Drive footage (`script.start` in cloud mode).

/** The protocols a Drive download may use (and be redirected to): curl's `--proto` for Google calls. */
function googleProtocols(): string[] {
  return endpoints.googleProto() === "=http,https" ? ["http:", "https:"] : ["https:"];
}

/**
 * Puts Drive file `file` on R2, streamed from Drive straight into the upload
 * (no copy on this disk), unless the registry has it already.
 * `progress(bytes, total, name)` as it goes.
 */
export async function driveOriginal(
  file: string,
  scratch: string,
  progress: (bytes: number, total: number | null, name: string) => void,
): Promise<Original> {
  if (!driveIdOk(file)) throw new Error(`${debugStr(file)} isn't a Drive file id`);
  const source = `drive:${file}`;
  const record = await getRecord(source);
  const ready = readyOriginal(record);
  if (record !== null && ready !== null) {
    const size = Math.max(Math.trunc(record.size), 0);
    progress(size, size, record.name);
    return { file, source, key: ready, name: record.name, size };
  }
  const [url, head] = await scriptParts.resolve(file, join(scratch, `.probe-${file}`));
  const name = scriptParts.safeName(head.name ?? `${file}.mp4`);
  const key = record !== null && cloud.validKey(record.originalKey) ? record.originalKey : `edit/originals/drive/${file}/${segment(name)}`;
  if (record === null) await putRecord({ source, name, originalKey: key, size: head.total ?? 0 });
  progress(0, head.total, name);
  // Copied in the cloud where the relay can (it finishes without this Mac),
  // else streamed through this Mac as before.
  const size =
    (await driveInTheCloud(file, key, (sent) => progress(sent, head.total, name))) ??
    (await streamDrive(url, key, head.total, (sent) => progress(sent, head.total, name)));
  let duration: number | null = null;
  try {
    duration = await scriptParts.durationOf(await getUrl(key, HOUR));
  } catch {
    duration = null;
  }
  const done: Record<string, unknown> = { source, originalReady: true, size };
  if (duration !== null) done.duration = duration;
  await putRecord(done);
  return { file, source, key, name, size };
}

/**
 * Puts YouTube video `file` (`youtube:<id>`) on R2 unless the registry has
 * it: downloaded whole into `scratch` with yt-dlp, uploaded, and the local
 * copy returned (`local`) for the excerpts to be cut from; the caller removes
 * it. `progress(bytes, total, name)` as it downloads.
 */
export async function youtubeOriginal(
  home: string,
  file: string,
  scratch: string,
  progress: (bytes: number, total: number | null, name: string) => void,
): Promise<[Original, string | null]> {
  const id = youtube.idOf(file);
  if (id === null) throw new Error(`${debugStr(file)} isn't a YouTube video`);
  const source = file;
  const record = await getRecord(source);
  const ready = readyOriginal(record);
  if (record !== null && ready !== null) {
    const size = Math.max(Math.trunc(record.size), 0);
    progress(size, size, record.name);
    return [{ file, source, key: ready, name: record.name, size }, null];
  }
  const dir = join(scratch, `youtube-${id}`);
  const got = await youtube.download(home, id, dir, progress);
  const name = scriptParts.safeName(got.name);
  const key = record !== null && cloud.validKey(record.originalKey) ? record.originalKey : `edit/originals/youtube/${id}/${segment(name)}`;
  if (record === null) await putRecord({ source, name, originalKey: key, size: got.size });
  await diag.timeOnAsync("cloud", "cloud: upload youtube", source, () => cloud.uploadFile(got.path, key));
  let duration: number | null = null;
  try {
    duration = await scriptParts.durationOf(got.path);
  } catch {
    duration = null;
  }
  const done: Record<string, unknown> = { source, originalReady: true, size: got.size };
  if (duration !== null) done.duration = duration;
  await putRecord(done);
  return [{ file, source, key, name, size: got.size }, got.path];
}

/** How often a cloud copy is asked how far it's got, and how long it may sit still before this Mac takes over. */
export const jobTiming = { poll: 2000, stall: 10 * 60_000, sleep: (ms: number) => Bun.sleep(ms) };

/**
 * Drive file `file` copied to R2 `key` by the relay's cloud job (speed-plan
 * 7.1: apps/relay/src/jobs.ts), following its progress; the bytes stored, or
 * null when the relay can't (an older relay, no Google sign-in there, the
 * job failed or stood still), so this Mac streams it instead.
 * `EDIT_CLOUD_JOBS=0` never asks.
 */
async function driveInTheCloud(file: string, key: string, progress: (sent: number) => void): Promise<number | null> {
  if (process.env.EDIT_CLOUD_JOBS === "0") return null;
  let id: string;
  try {
    const started = await cloud.relayJson("jobs/drive", { file, key });
    if (typeof started.id !== "string") return null;
    id = started.id;
  } catch (error) {
    const message = diag.messageOf(error);
    if (!/\b404\b|not found|not configured/i.test(message)) diag.warn("cloud", `copying ${file} in the cloud: ${scrub(message)}; streaming it through this Mac`);
    return null;
  }
  diag.info("cloud", `copying Drive file ${file} to the cloud there (job ${id})`);
  let last = -1;
  let moved = Date.now();
  for (;;) {
    let status: Record<string, unknown>;
    try {
      status = await cloud.relayJson("jobs/status", { id, key });
    } catch (error) {
      // The relay unreachable for a moment: the job carries on there.
      diag.warn("cloud", `asking about job ${id}: ${scrub(diag.messageOf(error))}`);
      status = { status: "running" };
    }
    const state = String(status.status);
    const bytes = typeof status.bytes === "number" ? status.bytes : null;
    if (state === "complete") {
      const size = bytes ?? 0;
      progress(size);
      return size;
    }
    if (state === "errored" || state === "terminated" || state === "unknown") {
      diag.warn("cloud", `the cloud copy of ${file} ${state === "unknown" ? "was lost" : `failed (${String(status.error ?? state)})`}; streaming it through this Mac`);
      return null;
    }
    // Only forward: the parts' list empties as they're joined into the file.
    if (bytes !== null && bytes > last) {
      last = bytes;
      moved = Date.now();
      progress(bytes);
    }
    if (Date.now() - moved > jobTiming.stall) {
      diag.warn("cloud", `the cloud copy of ${file} stood still for ${jobTiming.stall / 60_000} minutes; streaming it through this Mac`);
      try {
        await cloud.relayJson("jobs/cancel", { id, key });
      } catch {
        // It stops on its own.
      }
      return null;
    }
    await jobTiming.sleep(jobTiming.poll);
  }
}

/**
 * A Drive download as a source: an early end (the transfer failed) is an
 * error, so a cut-off download never completes an upload. Redirects are
 * followed only to the protocols Google calls may use.
 */
async function driveSource(url: string, stall: cloud.Stall): Promise<cloud.Source> {
  const allowed = googleProtocols();
  let target = url;
  let response: Response | null = null;
  const stopped = (why: string) => new Error(`the Drive download stopped (${scrub(why)})`);
  for (let hop = 0; hop <= 50; hop++) {
    if (!allowed.includes(new URL(target).protocol)) throw stopped(`Protocol "${new URL(target).protocol.slice(0, -1)}" not supported or disabled in libcurl`);
    try {
      response = await fetch(target, { redirect: "manual", signal: stall.signal });
    } catch (error) {
      throw stopped(stall.why(error));
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel().catch(() => {});
      target = new URL(location, target).toString();
      continue;
    }
    break;
  }
  stall.connected();
  if (response === null || (response.status >= 300 && response.status < 400)) throw stopped("Maximum (50) redirects followed");
  if (response.status >= 400) {
    await response.body?.cancel().catch(() => {});
    throw stopped(`The requested URL returned error: ${response.status}`);
  }
  const body = response.body;
  if (body === null) return { read: async () => null };
  const inner = cloud.streamSource(body as ReadableStream<Uint8Array>);
  return {
    async read(max) {
      try {
        const chunk = await inner.read(max);
        if (chunk !== null) stall.moved(chunk.length);
        return chunk;
      } catch (error) {
        throw stopped(stall.why(error));
      }
    },
  };
}

/**
 * Streams `url` (Drive) into R2 at `key`; the bytes stored. A short or failed
 * download aborts the upload (nothing is stored).
 */
async function streamDrive(url: string, key: string, total: number | null, progress: (sent: number) => void): Promise<number> {
  const stall = new cloud.Stall(20_000);
  let sent: number;
  try {
    const source = await driveSource(url, stall);
    sent = await cloud.uploadStream(source, key, total, (bytes) => progress(bytes));
  } catch (error) {
    // The download failing before the first byte reads as the upload's read failing, as curl's did.
    const message = failure(error);
    throw new Error(message.startsWith("the Drive download stopped") ? `reading the upload: ${message}` : message);
  } finally {
    stall.stop();
  }
  if (total !== null && total !== sent) {
    try {
      await cloud.remove([key]);
    } catch {
      // Overwritten by the retry.
    }
    throw new Error("The download ended early. Retry to start it again.");
  }
  return sent;
}

/**
 * The media a script plays from Drive file `original`: an excerpt per span
 * the `ranges` need (cut from R2 through a presigned URL, so only those bytes
 * are fetched), or the whole file when it's mostly used, as `script.excerpts`
 * does on a disk. Each is on R2 at full quality with its proxy; only the
 * proxies are kept here.
 */
export async function driveExcerpts(
  cache: string,
  original: Original,
  ranges: [number, number][],
  input: string | null = null,
): Promise<Excerpt[]> {
  // A copy still on this disk (a YouTube download on its way up) is cut from here.
  const url = input ?? (await getUrl(original.key, 6 * HOUR));
  // Read here even when the registry knows it: a URL FFmpeg can't read would
  // otherwise only show as keyframes not found (excerpts from the start).
  const duration = await scriptParts.durationOf(url);
  const spans = scriptParts.spans(ranges, duration);
  const used = spans.reduce((sum, [from, to]) => sum + (to - from), 0);
  if (spans.length === 0 || used >= duration * 0.6) {
    const made = await wholeMedia(cache, original, url);
    return [{ path: made.path, from: 0, to: duration, cloud: made }];
  }
  const stem = takeChars(fileStem(original.name) ?? "footage", 40);
  const ext = extensionOf(original.name);
  const out: Excerpt[] = [];
  for (const [from, to] of spans) {
    const start = await scriptParts.keyframeBefore(url, from);
    const made = await excerptMedia(cache, original, url, start, to, stem, ext);
    out.push({ path: made.path, from: start, to, cloud: made });
  }
  return out;
}

/** The whole Drive file as one media: its proxy made straight from R2. */
async function wholeMedia(cache: string, original: Original, url: string): Promise<Made> {
  const probe = await probeUrl(url);
  const record = await getRecord(original.source);
  const ready = readyProxy(record);
  const proxy = ready ?? proxyKey(original.source);
  if (proxy === null) throw new Error("no proxy key");
  const local = localPath(cache, proxy);
  if (ready !== null) {
    await fetchKey(proxy, local);
  } else {
    const madeHere = !isFile(local);
    try {
      if (madeHere) {
        await diag.timeOnAsync("cloud", "cloud: make proxy", original.source, async () => {
          if (parent(local) !== null) fs.mkdirSync(parent(local)!, { recursive: true });
          await native().makeCloudProxy(url, probe, local);
        });
      }
      await cloud.uploadFile(local, proxy);
      await putRecord({ source: original.source, proxyKey: proxy, proxyReady: true });
    } catch (error) {
      if (madeHere) fs.rmSync(local, { force: true });
      throw error;
    }
  }
  return {
    path: canonical(local),
    name: original.name,
    probe,
    cloud: { source: original.source, original: original.key, proxy, size: original.size },
  };
}

/**
 * One excerpt (`start`..`end` seconds of the Drive file) as media: reused
 * when the registry has it, else cut into a scratch file, uploaded with its
 * proxy, and the scratch file removed.
 */
async function excerptMedia(
  cache: string,
  original: Original,
  url: string,
  start: number,
  end: number,
  stem: string,
  ext: string,
): Promise<Made> {
  const source = excerptSource(original.file, start, end);
  const name = `${stem} ${scriptParts.clock(start)}-${scriptParts.clock(end)}.${ext}`;
  const record = await getRecord(source);
  const readyKey = readyOriginal(record);
  const readyProxyKey = readyProxy(record);
  if (record !== null && readyKey !== null && readyProxyKey !== null) {
    // Its full-quality file says what the media is (the proxy is smaller).
    const probe = await probeUrl(await getUrl(readyKey, HOUR));
    const local = localPath(cache, readyProxyKey);
    await fetchKey(readyProxyKey, local);
    return {
      path: canonical(local),
      name: record.name,
      probe,
      cloud: { source, original: readyKey, proxy: readyProxyKey, size: Math.max(Math.trunc(record.size), 0) },
    };
  }
  const key = `edit/excerpts/${sourcePath(original.source)}/${millis(start)}-${millis(end)}.${ext}`;
  const proxy = proxyKey(source);
  if (proxy === null) throw new Error("no proxy key");
  const local = localPath(cache, proxy);
  const scratch = scratchFile(scratchDir(cache), ext);
  try {
    await diag.timeOnAsync("cloud", "cloud: cut excerpt", source, () => scriptParts.cut(url, start, end, scratch));
    const probe = await native().probe(scratch);
    const size = sizeOf(scratch);
    await putRecord({ source, name, originalKey: key, size });
    await publish(scratch, probe, source, key, true, proxy, local);
    return { path: canonical(local), name, probe, cloud: { source, original: key, proxy, size } };
  } finally {
    fs.rmSync(scratch, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Opening a cloud project here.

/**
 * Makes every cloud media of project `id` playable here: fetches proxies this
 * machine doesn't have yet and points their `path` at them. Called when a
 * cloud project is opened (it may have been edited on another machine).
 * Media whose file is here are left alone; a proxy already in this machine's
 * cache isn't fetched again. The analysis other machines shared comes too
 * (`fetchAnalysis`). Media that are neither here nor in the cloud (made on a
 * machine that hasn't backfilled them yet) are named in the error and in the
 * project's cloud status (`missing`), never silently left out.
 */
export function ensureLocal(app: App, id: string): Promise<void> {
  // One at a time per project: a second ask (another open, a pull) shares it.
  const running = ensuring.get(id);
  if (running !== undefined) return running;
  const done = ensureLocalNow(app, id).finally(() => ensuring.delete(id));
  ensuring.set(id, done);
  return done;
}

/** `ensureLocal`s under way, by project. */
const ensuring = new Map<string, Promise<void>>();

async function ensureLocalNow(app: App, id: string): Promise<void> {
  let fetched: string | null = null;
  try {
    await fetchProxies(app, id);
  } catch (error) {
    fetched = failure(error);
  }
  // After the proxies: analysis goes in the folder named after each media's file here.
  await fetchAnalysis(app, id);
  const live = app.store.get(id);
  const left = live === null ? [] : stranded(live.project);
  const one = left.length === 1;
  const missing =
    left.length === 0
      ? null
      : `${left.length} ${one ? "file isn't" : "files aren't"} on this machine and not in the cloud (${left.join(", ")}): open the project on the machine that made ${one ? "it" : "them"} so ${one ? "it" : "they"} upload${one ? "s" : ""}`;
  cloudProjectsOf(app)?.setMissing(id, missing);
  if (missing !== null) diag.warn("cloud", `${id}: ${missing}`);
  if (fetched === null && missing === null) return;
  if (fetched === null) throw new Error(missing!);
  if (missing === null) throw new Error(fetched);
  throw new Error(`${fetched}; ${missing}`);
}

/**
 * Fetches the proxies of `id`'s cloud media that aren't here (`ensureLocal`).
 * A media replaced while its proxy downloaded (another source under the same
 * id) isn't given the old one; its own is fetched in another round.
 */
async function fetchProxies(app: App, id: string, round = 0): Promise<void> {
  const live = app.store.get(id);
  if (live === null) throw new Error("no such project");
  const cache = app.store.cacheDir();
  // Media whose file isn't here: (media id, name, source, proxy key if known).
  const missing: [string, string, string, string | null][] = [];
  for (const media of live.project.media) {
    if (isFile(media.path) || media.cloud === undefined || media.cloud === null) continue;
    missing.push([media.id, media.name, media.cloud.source, media.cloud.proxy ?? null]);
  }
  if (missing.length === 0) return;
  const enabled = cloud.enabled();
  // A proxy another machine finished after this project was saved.
  const unknown = missing.filter(([, , , proxy]) => proxy === null).map(([, , source]) => source);
  let records: Record_[] = [];
  if (enabled && unknown.length > 0) {
    try {
      records = await listRecords(unknown);
    } catch (error) {
      diag.warn("cloud", `listing proxies: ${failure(error)}`);
      records = [];
    }
  }
  // A media whose upload another machine hasn't finished has no proxy yet.
  const unready: string[] = [];
  const jobs: [string, string, string, string][] = [];
  for (const [media, name, source, proxy] of missing) {
    let key = proxy ?? readyProxy(records.find((record) => record.source === source) ?? null);
    if (key !== null && !cloud.validKey(key)) key = null;
    if (key === null) {
      unready.push(name);
      continue;
    }
    jobs.push([media, key, localPath(cache, key), source]);
  }
  // Three at a time; the ones already in this machine's cache cost nothing.
  const results: ({ ok: [string, string, string, string] } | { error: string })[] = [];
  for (let at = 0; at < jobs.length; at += PARALLEL) {
    const batch = jobs.slice(at, at + PARALLEL);
    results.push(
      ...(await Promise.all(
        batch.map(async ([media, key, local, source]) => {
          if (!isFile(local) && !enabled) {
            return { error: `${key} isn't on this machine and the cloud isn't set up (EDIT_RELAY_TOKEN)` };
          }
          try {
            await diag.timeOnAsync("cloud", "cloud: fetch proxy", key, () => fetchKey(key, local));
            return { ok: [media, key, canonical(local), source] as [string, string, string, string] };
          } catch (error) {
            return { error: failure(error) };
          }
        }),
      )),
    );
  }
  const errors: string[] = [];
  if (unready.length > 0) errors.push(`still uploading from another machine: ${unready.join(", ")}`);
  const found: [string, string, string, string][] = [];
  for (const result of results) {
    if ("ok" in result) found.push(result.ok);
    else errors.push(result.error);
  }
  // Media replaced while their proxies downloaded: fetched again.
  let replaced = 0;
  if (found.length > 0) {
    const repoint = (project: Project) => {
      replaced = 0;
      for (const [mediaId, key, local, source] of found) {
        const media = project.media.find((item) => item.id === mediaId);
        if (media?.cloud === undefined || media.cloud === null) continue;
        // Still the media it was fetched for, and still not here.
        if (media.cloud.source !== source || isFile(media.path)) {
          replaced += 1;
          continue;
        }
        media.path = local;
        media.cloud.proxy = key;
      }
    };
    // One change (one undo step, one event), retried if another writer lands in between.
    let saved: Project | null = null;
    for (let tries = 1; saved === null; tries++) {
      try {
        const [now] = await app.store.update(id, "cloud", (project) => {
          repoint(project);
        });
        saved = now.project;
      } catch (error) {
        const message = failure(error);
        if (tries < 3 && message.includes("retry")) continue;
        // A cloud project another machine is editing is read-only here, but
        // where its files are on this machine is this machine's business:
        // saved here only, as a pull is (the next pull brings the other
        // machine's paths, and this runs again).
        const current = app.store.checkout(id);
        if (current === null) throw new Error("no such project");
        repoint(current.project);
        try {
          saved = app.store.putFromCloud(current.project, "cloud").project;
        } catch (local) {
          throw new Error(`${message}; ${failure(local)}`);
        }
      }
    }
    // Previews, thumbnails and waveforms for the files now here.
    for (const [mediaId] of found) {
      const media = mediaOf(saved, mediaId);
      if (media !== undefined && isFile(media.path)) app.media.ensure(media.path, probeOf(media));
    }
  }
  if (replaced > 0 && round < 3) {
    await fetchProxies(app, id, round + 1);
  }
  if (errors.length > 0) {
    diag.warn("cloud", `${id}: ${errors.join("; ")}`);
    throw new Error(`some of the project's files couldn't be fetched: ${errors.join("; ")}`);
  }
}

// ---------------------------------------------------------------------------
// Exports read the originals.

/** What an export made on the side (waveform levels for its originals); removed by `release`. */
class ExportOriginals implements Originals {
  readonly dirs: string[] = [];
  readonly sounds: Record<string, string> = {};

  release(): void {
    for (const dir of this.dirs) fs.rmSync(dir, { recursive: true, force: true });
    this.dirs.length = 0;
  }
}

/** The media frames `start..end` of `project` use (pictures, sounds and the waveforms drawn from them). */
export function usedMedia(project: Project, start: number, end: number): string[] {
  const used: string[] = [];
  for (const clip of project.clips) {
    if (clip.start >= end || clip.start + clip.duration <= start) continue;
    const media = clipSource(clip);
    if (media !== null && !used.includes(media)) used.push(media);
  }
  return used;
}

function clipSource(clip: Clip): string | null {
  if (clip.type === "video" || clip.type === "audio") return clip.media;
  if (clip.type === "waveform") return clip.media ?? null;
  return null;
}

/**
 * `project` as an export of frames `start..end` reads it: every cloud media
 * it uses points at its full-quality original on R2 instead of the proxy, as
 * a presigned URL. Nothing big is downloaded: FFmpeg reads just the byte
 * ranges it needs (decoding on the Mac's media engine) and hands the frames
 * to the native renderer and encoder. Sounds and pictures whose own file is
 * here are used as they are.
 */
export async function forExport(project: Project, start: number, end: number, cache: string): Promise<[Project, Originals]> {
  const out = structuredClone(project) as Project;
  const originals = new ExportOriginals();
  const needed: [string, string][] = [];
  // Originals imported from this machine and still here: read from the disk.
  const onDisk = new Map<string, string>();
  // In an edit with cloud media, one that's neither here nor in the cloud was
  // made on another machine that hasn't uploaded it: say so.
  const cloudEdit = project.media.some((media) => media.cloud !== undefined && media.cloud !== null);
  const strandedNames: string[] = [];
  for (const mediaId of usedMedia(project, start, end)) {
    const media = mediaOf(project, mediaId);
    if (media === undefined) continue;
    const where = media.cloud;
    if (where === undefined || where === null) {
      if (cloudEdit && !isFile(media.path)) strandedNames.push(media.name);
      continue;
    }
    const own = where.proxy === where.original;
    if (own && isFile(media.path)) continue;
    const here = localOriginal(cache, where.original, true);
    if (here !== null) {
      onDisk.set(mediaId, here);
      continue;
    }
    needed.push([mediaId, where.original]);
  }
  if (strandedNames.length > 0) {
    throw new Error(
      `the edit uses files that aren't on this machine or in the cloud (${strandedNames.join(", ")}): open the project on the machine that made them so they upload, then export again`,
    );
  }
  for (const [mediaId, path] of onDisk) {
    const media = out.media.find((item) => item.id === mediaId);
    if (media !== undefined) media.path = path;
  }
  if (onDisk.size > 0) diag.info("export", `${project.id}: reading ${onDisk.size} cloud originals from this machine's copies`);
  if (needed.length === 0) return [out, originals];
  if (!cloud.enabled()) throw new Error("this edit's footage is in the cloud: exporting it needs the cloud (EDIT_RELAY_TOKEN)");
  const urls = new Map<string, string>();
  for (const [mediaId, key] of needed) {
    // Long enough for any export.
    const url = await getUrl(key, 24 * HOUR);
    urls.set(mediaId, url);
    const media = out.media.find((item) => item.id === mediaId);
    if (media !== undefined) media.path = url;
  }
  // The sound is mixed from each original's sound copy, on this machine.
  const heard = needed.filter(([mediaId]) => mediaOf(project, mediaId)?.has_audio === true);
  const copies = new Semaphore(3);
  await Promise.all(
    heard.map(async ([mediaId, key]) => {
      const release = await copies.acquire();
      try {
        const copy = await soundCopy(cache, key, urls.get(mediaId)!);
        if (copy !== null) originals.sounds[mediaId] = copy;
      } finally {
        release();
      }
    }),
  );
  // Waveforms read their levels from the proxy's cache: the originals share them.
  out.media.forEach((media, index) => {
    const before = project.media[index];
    if (before === undefined || media.path === before.path || onDisk.has(media.id)) return;
    const from = join(cache, mediaKey(before.path), "peaks.bin");
    if (!isFile(from)) return;
    const to = join(cache, mediaKey(media.path));
    try {
      fs.mkdirSync(to, { recursive: true });
      copyFile(from, join(to, "peaks.bin"));
      originals.dirs.push(to);
    } catch {
      // Drawn without levels.
    }
  });
  diag.info("export", `${project.id}: reading ${needed.length} cloud originals straight from the cloud`);
  return [out, originals];
}

/** Freeze only the assets this export plays. Cloud footage stays in R2;
 * local graphics/sounds are content-addressed once, three files at a time.
 * ETags pin originals that another import might replace during the export.
 */
export async function forWorker(project: Project, start: number, end: number): Promise<{ project: Project; assets: import("@edit/types/worker").WorkerAsset[] }> {
  const out = structuredClone(project) as Project;
  const used = usedMedia(project, start, end);
  const assets: import("@edit/types/worker").WorkerAsset[] = [];
  for (let first = 0; first < used.length; first += 3) {
    const batch = await Promise.all(used.slice(first, first + 3).map(async id => {
      const media = project.media.find(m => m.id === id);
      if (!media) throw new Error(`missing export media ${id}`);
      let key = media.cloud?.original;
      if (!key) {
        if (!isFile(media.path)) throw new Error(`${media.name} must finish uploading before a cloud export`);
        const digest = await sha256File(media.path);
        key = `edit/exports/assets/${digest}.${extensionOf(media.path).replace(/^\./, "") || "bin"}`;
        if (await cloud.head(key) === null) await cloud.uploadFile(media.path, key);
        // A file being rendered/replaced while it uploads isn't a snapshot.
        if (await sha256File(media.path) !== digest) throw new Error(`${media.name} changed while preparing the cloud export; try again`);
      }
      const head = await cloud.head(key);
      if (!head || !head.etag || head.size <= 0) throw new Error(`${media.name} has not finished uploading to the cloud`);
      return { media: id, key, size: head.size, etag: head.etag };
    }));
    assets.push(...batch);
  }
  // No workstation paths or expiring links are persisted in the manifest.
  for (const media of out.media) media.path = `asset:${media.id}`;
  return { project: out, assets };
}

// ---------------------------------------------------------------------------
// Sound copies (speed-plan 4.1): an export of footage that's only in the
// cloud decoded its sound over the network, clip by clip (11 minutes of a
// 32-minute export, before its picture started). Each original's sound is
// copied out without re-encoding (seconds, ~1% of the file) and kept beside
// it in the cloud, so an export fetches that small file once and mixes it
// locally with AVFoundation.

/** The cloud key of `original`'s sound copy. */
export function soundKey(original: string): string {
  return `edit/sound/${original.startsWith("edit/") ? original.slice("edit/".length) : original}.mov`;
}

/** Copies the first sound of `input` (a file or URL) into `out` as it is (MOV: AVFoundation reads it). */
export async function copySound(input: string, out: string): Promise<void> {
  fs.mkdirSync(parent(out) ?? ".", { recursive: true });
  const partial = `${out}.partial.mov`;
  try {
    await tools.run([
      tools.ffmpeg(),
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-protocol_whitelist",
      tools.protocols(input),
      ...tools.urlArgs(input),
      "-i",
      input,
      "-vn",
      "-map",
      "0:a:0",
      "-c:a",
      "copy",
      "-f",
      "mov",
      partial,
    ]);
    fs.renameSync(partial, out);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw new Error(scrub(diag.messageOf(error)));
  }
}

/** Makes `path`'s sound copy and puts it in the cloud for `original`, in the background. */
function shareSound(cache: string, path: string, original: string): void {
  const key = soundKey(original);
  const local = localPath(cache, key);
  void (async () => {
    try {
      if ((await cloud.head(key)) !== null) return;
      if (!isFile(local)) await copySound(path, local);
      await cloud.uploadFile(local, key);
    } catch (error) {
      diag.warn("cloud", `the sound copy of ${fileStem(path) ?? path}: ${diag.messageOf(error)}`);
    }
  })();
}

/**
 * A copy of cloud original `key`'s sound on this machine, for an export: one
 * kept from before, the cloud's, or made now from the original at `url` (and
 * then shared). Null when none can be had (the mix reads the original).
 */
export async function soundCopy(cache: string, key: string, url: string): Promise<string | null> {
  const copy = soundKey(key);
  const local = localPath(cache, copy);
  if (isFile(local)) return local;
  try {
    if ((await cloud.head(copy)) !== null) {
      await fetchKey(copy, local);
      return local;
    }
  } catch (error) {
    diag.warn("export", `fetching a sound copy: ${diag.messageOf(error)}`);
  }
  try {
    await diag.timeOnAsync("export", "export: sound copy", copy, () => copySound(url, local));
  } catch (error) {
    diag.warn("export", `copying the sound out of a cloud original: ${diag.messageOf(error)}`);
    return null;
  }
  void cloud.uploadFile(local, copy).catch((error: unknown) => {
    diag.warn("cloud", `sharing a sound copy: ${diag.messageOf(error)}`);
  });
  return local;
}

// ---------------------------------------------------------------------------
// Everything else a cloud project uses: the backfill.

/** A video Edit made up to this size goes up as it is and is its own proxy (a smoothed shot, a map render); bigger is footage and gets a proxy. */
const OWN_FILE_MAX = 256 << 20;

/** A file that failed to go up isn't tried again for this long (unless asked), and a media's shared analysis isn't looked for again sooner. */
const RETRY_AFTER = 600_000;

/**
 * Puts a file Edit made itself (or one that never went up) in the cloud, as
 * `importLocal` does an added file: deduplicated by content; a sound,
 * picture or short render as the file itself, footage-sized video with a
 * proxy (then `Made.path` is the proxy).
 */
export function uploadMade(cache: string, path: string, probe: Probe, name: string): Promise<Made> {
  const own = probe.kind !== "video" || (isFile(path) && sizeOf(path) <= OWN_FILE_MAX);
  return putLocal(cache, path, probe, name, own);
}

function probeOf(media: Media): Probe {
  return {
    kind: media.kind,
    duration: media.duration,
    width: media.width,
    height: media.height,
    fps: media.fps,
    has_audio: media.has_audio,
  };
}

/**
 * What this module asks of the store's cloud projects (cloud_projects.ts's
 * `Cloud`, seen through the store's hook so the import goes one way).
 */
interface CloudProjectsView {
  isCloud(id: string): boolean;
  setMissing(id: string, missing: string | null): void;
}

function cloudProjectsOf(app: App): CloudProjectsView | null {
  const hook = app.store.cloud() as Partial<CloudProjectsView> | null;
  return hook !== null && typeof hook.isCloud === "function" && typeof hook.setMissing === "function" ? (hook as CloudProjectsView) : null;
}

/** Whether `id` is a cloud project on this machine (and cloud is on). */
function cloudProject(app: App, id: string): boolean {
  return cloud.enabled() && cloudProjectsOf(app)?.isCloud(id) === true;
}

const backfills = {
  /** Projects waiting for a backfill (one runs at a time, for every project). */
  queued: new Set<string>(),
  /** Files that failed to go up, and when (performance.now()). */
  failed: new Map<string, number>(),
};

/** One backfill at a time: uploads are big and the network is shared. */
const backfillSlot = new Semaphore(1);

/**
 * Starts a backfill of cloud project `id` in the background (one waiting per
 * project is enough: it reads the project when it starts). Called after
 * every push, on opening, and wherever Edit makes media itself (smoothed
 * shots, map renders), so whatever a cloud project uses ends up in the
 * cloud. Nothing happens for a project only on this machine.
 */
export function backfillSoon(app: App, id: string): void {
  if (!cloudProject(app, id) || backfills.queued.has(id)) return;
  backfills.queued.add(id);
  void (async () => {
    const release = await backfillSlot.acquire();
    try {
      backfills.queued.delete(id);
      await backfillNow(app, id, false);
    } catch (error) {
      diag.warn("cloud", `backfill ${id}: ${diag.messageOf(error)}`);
    } finally {
      release();
    }
  })();
}

/**
 * `POST /api/projects/{id}/cloud/backfill` (`edit cloud backfill <id>`): a
 * backfill now, failed files tried again; answers what it did.
 */
export async function backfill(app: App, id: string): Promise<Record<string, unknown>> {
  if (app.store.get(id) === null) throw new Error("no such project");
  if (!cloud.enabled()) throw new Error("cloud is off here (Settings → Cloud)");
  if (!cloudProject(app, id)) throw new Error("this isn't a cloud project (Move to cloud first)");
  return backfillSlot.with(() => backfillNow(app, id, true));
}

/** Whether `path` is a map shot's first frame standing in for footage still rendering (broll's). */
function isMapStandIn(path: string): boolean {
  try {
    return seams.broll.isMapStandIn(path);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith(" is not available")) return false;
    throw error;
  }
}

/**
 * Uploads every media of cloud project `id` that has no cloud copy but whose
 * file is here (made by Edit, added while cloud was off, an upload that
 * failed), and shares the media's analysis (`shareAnalysis`). A map shot's
 * first frame standing in for it waits for the footage. Saved one media at a
 * time, so a long backfill keeps what it has done.
 */
async function backfillNow(app: App, id: string, retryFailed: boolean): Promise<Record<string, unknown>> {
  const live = app.store.get(id);
  if (live === null) throw new Error("no such project");
  const at = performance.now();
  const skipped: string[] = [];
  for (const [path, when] of backfills.failed) {
    if (Math.max(at - when, 0) >= RETRY_AFTER) backfills.failed.delete(path);
  }
  const todo: [string, string, Probe, string][] = [];
  for (const media of live.project.media) {
    if ((media.cloud !== undefined && media.cloud !== null) || !isFile(media.path)) continue;
    if (isMapStandIn(media.path)) {
      skipped.push(`${media.name} (a map still rendering)`);
      continue;
    }
    if (!retryFailed && backfills.failed.has(media.path)) continue;
    todo.push([media.id, media.path, probeOf(media), media.name]);
  }
  const missing = stranded(live.project);
  // Someone else editing it: refused (their machine has their files).
  if (todo.length > 0) await app.store.mayWrite(id);
  const cache = app.store.cacheDir();
  const uploaded: Record<string, unknown>[] = [];
  const failed: Record<string, unknown>[] = [];
  for (const [mediaId, path, probe, name] of todo) {
    let made: Made;
    try {
      made = await diag.timeOnAsync("cloud", "cloud: backfill", path, () => uploadMade(cache, path, probe, name));
    } catch (error) {
      backfills.failed.set(path, at);
      failed.push({ error: scrub(failure(error)), media: mediaId, name });
      continue;
    }
    let saved: boolean | null = null;
    let problem: string | null = null;
    for (let tries = 1; saved === null && problem === null; tries++) {
      try {
        const [, changed] = await app.store.update(id, "cloud", (project) => {
          // Only while it's still that file with no cloud copy.
          const media = project.media.find(
            (item) => item.id === mediaId && item.path === path && (item.cloud === undefined || item.cloud === null),
          );
          if (media === undefined) return false;
          media.path = made.path;
          if (made.cloud !== null) media.cloud = made.cloud;
          else delete media.cloud;
          return true;
        });
        saved = changed;
      } catch (error) {
        const message = failure(error);
        if (tries < 3 && message.includes("retry")) continue;
        problem = message;
      }
    }
    if (problem !== null) {
      failed.push({ error: problem, media: mediaId, name });
      break;
    }
    if (saved === true) {
      if (made.path !== path) app.media.ensure(made.path, probe);
      uploaded.push({ media: mediaId, name });
    } else {
      skipped.push(`${name} (changed meanwhile)`);
    }
  }
  if (uploaded.length > 0 || failed.length > 0) {
    diag.info("cloud", `${id}: backfill put ${uploaded.length} media in the cloud, ${failed.length} failed`);
  }
  const shared = await shareAnalysis(app, id);
  return { analysis_shared: shared, failed, missing, skipped, uploaded };
}

/** Media of `project` that aren't on this machine and have no cloud copy: only the machine that made them has them. */
export function stranded(project: Project): string[] {
  return project.media.filter((media) => (media.cloud === undefined || media.cloud === null) && !isFile(media.path)).map((media) => media.name);
}

// ---------------------------------------------------------------------------
// Analysis that costs money to redo, shared beside the media.

/**
 * Files of a media's cache dir another machine reuses rather than paying for
 * again: its transcript, the faces and seats found in it, the watcher's
 * answers (`watch/<hash>.json`). Under `edit/analysis/<source path>/<file>`.
 */
const ANALYSIS = ["transcript.json", "faces-v1.json", "seats-v2.json"];
/** What went up from (or came down to) a cache dir: file → size and mtime, so each version goes once. */
const SHARED = "cloud-shared.json";
/**
 * The media keys the watcher's answers in a cache dir were asked under
 * (`watch/keys.json`, read by `watch.ts`): its answers are named by the media
 * key, which differs once they're carried to a proxy or fetched by another
 * machine. A watch file like the others, so it's shared like them.
 */
export const WATCH_KEYS = "watch/keys.json";

/** `edit/analysis/drive/<id>[/<s>-<e>]/` or `edit/analysis/sha256/<hex>/`. */
export function analysisPrefix(source: string): string | null {
  const proxy = proxyKey(source);
  if (proxy === null || !proxy.startsWith("edit/proxies/") || !proxy.endsWith(".mp4")) return null;
  return `edit/analysis/${proxy.slice("edit/proxies/".length, -".mp4".length)}/`;
}

/** Whether `name` (relative to a media's cache dir) is shared analysis. */
export function isAnalysis(name: string): boolean {
  if (ANALYSIS.includes(name)) return true;
  if (!name.startsWith("watch/")) return false;
  const file = name.slice("watch/".length);
  return file.endsWith(".json") && !file.startsWith(".") && /^[A-Za-z0-9._-]+$/.test(file);
}

/** The shared analysis in a media's cache dir: (name, file). */
function analysisFiles(dir: string): [string, string][] {
  const files: [string, string][] = ANALYSIS.map((name): [string, string] => [name, join(dir, name)]).filter(([, path]) => isFile(path));
  let names: string[] = [];
  try {
    names = fs.readdirSync(join(dir, "watch"));
  } catch {
    names = [];
  }
  for (const entry of names) {
    const name = `watch/${entry}`;
    if (isAnalysis(name) && isFile(join(dir, name))) files.push([name, join(dir, name)]);
  }
  return files;
}

function stamp(path: string): string {
  try {
    const stat = fs.statSync(path);
    return `${stat.size}-${Math.floor(stat.mtimeMs)}`;
  } catch {
    return "0-0";
  }
}

function readShared(dir: string): Record<string, unknown> {
  try {
    const value = JSON.parse(fs.readFileSync(join(dir, SHARED), "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeShared(dir: string, shared: Record<string, unknown>): void {
  try {
    fs.writeFileSync(join(dir, SHARED), stableStringify(shared));
  } catch {
    // Sent again next time.
  }
}

/** The media keys named in a cache dir's `watch/keys.json`. */
export function watchKeys(dir: string): string[] {
  return keysIn(join(dir, WATCH_KEYS));
}

/** The media keys a keys file names (`{"keys": [...]}`). */
function keysIn(path: string): string[] {
  try {
    const value = JSON.parse(fs.readFileSync(path, "utf8")) as { keys?: unknown };
    return Array.isArray(value.keys) ? value.keys.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

/** Adds `keys` to a cache dir's `watch/keys.json` (only written when it changes). */
function addWatchKeys(dir: string, keys: string[]): void {
  const had = watchKeys(dir);
  const all = [...had];
  for (const key of keys) if (!all.includes(key)) all.push(key);
  if (all.length === had.length) return;
  try {
    fs.mkdirSync(join(dir, "watch"), { recursive: true });
    fs.writeFileSync(join(dir, WATCH_KEYS), stableStringify({ keys: all }));
  } catch (error) {
    diag.warn("cloud", `noting the watcher's keys in ${dir}: ${ioMessage(error)}`);
  }
}

/**
 * Carries the analysis made for the file at `from` (its transcript, faces,
 * seats and the watcher's answers) to the cache folder of `to`, the proxy
 * that file is now edited from, unless `to` has its own already. The
 * watcher's answers keep their names, and `from`'s media key is noted beside
 * them so the watcher still finds them. Nothing is removed: the original may
 * still be in another project.
 */
export function carryAnalysis(cache: string, from: string, to: string): number {
  if (from === to) return 0;
  const fromKey = mediaKey(from);
  const fromDir = join(cache, fromKey);
  const toDir = join(cache, mediaKey(to));
  if (fromDir === toDir) return 0;
  let carried = 0;
  let watched = false;
  for (const [name, path] of analysisFiles(fromDir)) {
    if (name === WATCH_KEYS) continue;
    const dest = join(toDir, name);
    if (name.startsWith("watch/")) watched = true;
    if (fs.existsSync(dest)) continue;
    try {
      fs.mkdirSync(parent(dest)!, { recursive: true });
      fs.copyFileSync(path, dest);
      carried += 1;
    } catch (error) {
      diag.warn("cloud", `carrying ${name} to ${to}'s cache: ${ioMessage(error)}`);
    }
  }
  if (watched) addWatchKeys(toDir, [fromKey, ...watchKeys(fromDir)]);
  if (carried > 0) diag.info("cloud", `${to}: carried ${carried} analysis files over from ${from}`);
  return carried;
}

/** `id`'s cloud footage and sounds whose file is here: (source, cache dir, media key). */
function analysisDirs(app: App, id: string): [string, string, string][] {
  const live = app.store.get(id);
  if (live === null) return [];
  const cache = app.store.cacheDir();
  const out: [string, string, string][] = [];
  for (const media of live.project.media) {
    if (media.kind !== "video" && media.kind !== "audio") continue;
    if (media.cloud === undefined || media.cloud === null || !isFile(media.path)) continue;
    const key = mediaKey(media.path);
    out.push([media.cloud.source, join(cache, key), key]);
  }
  return out;
}

/** Uploads the analysis of `id`'s cloud media made here since it last went up. Returns how many files went. */
export async function shareAnalysis(app: App, id: string): Promise<number> {
  let sent = 0;
  for (const [source, dir, key] of analysisDirs(app, id)) {
    const prefix = analysisPrefix(source);
    if (prefix === null) continue;
    const shared = readShared(dir);
    let changed = false;
    const files = analysisFiles(dir);
    // Answers asked here are named by this machine's key: say so to whoever fetches them.
    if (files.some(([name]) => name.startsWith("watch/") && name !== WATCH_KEYS) && !watchKeys(dir).includes(key)) {
      addWatchKeys(dir, [key]);
      if (!files.some(([name]) => name === WATCH_KEYS)) files.push([WATCH_KEYS, join(dir, WATCH_KEYS)]);
    }
    for (const [name, path] of files) {
      const now = stamp(path);
      if (shared[name] === now) continue;
      try {
        await cloud.uploadFile(path, `${prefix}${name}`);
        shared[name] = now;
        changed = true;
        sent += 1;
      } catch (error) {
        diag.warn("cloud", `sharing ${name} of ${source}: ${scrub(failure(error))}`);
      }
    }
    if (changed) writeShared(dir, shared);
  }
  return sent;
}

/** When each source's shared analysis was last looked for. */
const checked = new Map<string, number>();

/**
 * Fetches the analysis other machines shared for `id`'s cloud media into
 * this machine's cache (what's here already is kept). Each source is looked
 * up at most every ten minutes.
 */
async function fetchAnalysis(app: App, id: string): Promise<void> {
  if (!cloud.enabled()) return;
  const at = performance.now();
  const dirs = analysisDirs(app, id).filter(([source]) => {
    const last = checked.get(source);
    const due = last === undefined || Math.max(at - last, 0) >= RETRY_AFTER;
    if (due) checked.set(source, at);
    return due;
  });
  if (dirs.length === 0) return;
  let fetched = 0;
  for (let index = 0; index < dirs.length; index += PARALLEL) {
    const counts = await Promise.all(dirs.slice(index, index + PARALLEL).map(([source, dir]) => fetchAnalysisOf(source, dir).catch(() => 0)));
    fetched += counts.reduce((sum, count) => sum + count, 0);
  }
  if (fetched > 0) diag.info("cloud", `${id}: ${fetched} analysis files from the cloud`);
}

async function fetchAnalysisOf(source: string, dir: string): Promise<number> {
  const prefix = analysisPrefix(source);
  if (prefix === null) return 0;
  let objects: cloud.CloudObject[];
  try {
    objects = await cloud.list(prefix);
  } catch (error) {
    diag.warn("cloud", `listing ${source}'s analysis: ${failure(error)}`);
    return 0;
  }
  const shared = readShared(dir);
  let fetched = 0;
  // Small files: several at once (each its own request).
  const one = async (object: cloud.CloudObject): Promise<void> => {
    if (!object.key.startsWith(prefix)) return;
    const name = object.key.slice(prefix.length);
    const local = join(dir, name);
    if (!isAnalysis(name)) return;
    // Another machine's keys add to this one's.
    const merge = name === WATCH_KEYS && fs.existsSync(local);
    if (fs.existsSync(local) && !merge) return;
    try {
      fs.mkdirSync(parent(local)!, { recursive: true });
    } catch {
      // The download says why.
    }
    const target = merge ? join(dir, `watch/.keys-${process.pid}-${nextFileId()}.json`) : local;
    try {
      await cloud.download(object.key, target);
      if (merge) {
        addWatchKeys(dir, keysIn(target));
        // Merged: sent back next time, with this machine's keys in it.
      } else {
        // Came from the cloud: nothing to send back.
        shared[name] = stamp(local);
      }
      fetched += 1;
    } catch (error) {
      diag.warn("cloud", `fetching ${object.key}: ${scrub(failure(error))}`);
    } finally {
      if (merge) fs.rmSync(target, { force: true });
    }
  };
  for (let index = 0; index < objects.length; index += ANALYSIS_AT_ONCE) {
    await Promise.all(objects.slice(index, index + ANALYSIS_AT_ONCE).map(one));
  }
  if (fetched > 0) writeShared(dir, shared);
  return fetched;
}
