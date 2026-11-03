// The server's export registry: a durable queue on this Mac and any
// number in the cloud (Modal's sections, `modal_exports.ts`, when it's on and
// worth it), their
// `export` events, the files it may hand out, and the Drive upload after a
// subtitled video (or whenever asked). The local rendering, mixing, the partial
// file beside the destination and its rename are the addon's (`ExportJob`).

import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { Effect } from "effect";

import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import * as capacity from "./export_capacity.ts";
import { runPromise } from "./effect/runtime.ts";
import * as jobs from "./jobs.ts";
import { ioMessage, nowMs, writeAtomic } from "./files.ts";
import { subtitleVideo } from "./drive.ts";
import { catchBugsAsync } from "./guard.ts";
import type { MacSpeed } from "./modal_exports.ts";
import type { ExportOptions, Plan, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { canonical, fileName, join, parent } from "./paths.ts";
import { duration } from "./project.ts";
import { fixed, jsonForSerde } from "./rust.ts";
import * as seams from "./seams.ts";
import type { Store } from "./store.ts";
import { BUILD } from "./version.ts";

/** How many finished exports are remembered (handed out, revealed). */
const KEEP_FINISHED = 50;

/** Where an export renders: this Mac, the Relay's worker (v2) or Modal's sections (v3). */
export type Backend = "local" | "cloud" | "modal";

/** How an export is started beyond its options (a restart passes back what it was). */
export interface StartExtra {
  backend?: Backend;
  cloudRequest?: string;
  cloudJob?: string;
  /** Upload the finished file to Drive; by default only a whole subtitled video is (`drive.wanted`). */
  drive?: boolean;
  /** Keep the local file after its verified cloud upload (default: deleted, cloud is canonical). */
  keepLocal?: boolean;
  /** A share's export (reviews.exportAndShare): a failure is the share's to try again, not the export's (retry_after_update.ts). */
  share?: boolean;
  /** Said beside it in the Exports panel ("Trying again after the update"). */
  note?: string;
  /** A channel's watermark over the whole export (channel_marks.ts): its picture's Drive id in the Watermarks folder. */
  watermark?: string;
}

/**
 * An export that failed, kept in `<home>/export-failures.json` (the panel's
 * outcomes are in memory and gone with a restart, an update's too) until the
 * project's next export succeeds: what an update tries again, once, with the
 * same settings (retry_after_update.ts).
 */
export interface ExportFailure {
  project: string;
  name: string;
  options: ExportOptions;
  output: string;
  error: string;
  at: number;
  /** The build it failed on. */
  build: string;
  drive?: boolean;
  keepLocal?: boolean;
  share?: boolean;
}

const FAILURES = "export-failures.json";

/** The exports that failed and haven't succeeded since, by project. */
export function failedExports(home: string): Record<string, ExportFailure> {
  try {
    const value = JSON.parse(fs.readFileSync(join(home, FAILURES), "utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, ExportFailure>) : {};
  } catch {
    return {};
  }
}

function noteFailure(home: string, project: string, failure: ExportFailure | null): void {
  const all = failedExports(home);
  if (failure === null) {
    if (all[project] === undefined) return;
    delete all[project];
  } else all[project] = failure;
  try {
    writeAtomic(join(home, FAILURES), JSON.stringify(all, null, 1));
  } catch (error) {
    diag.warn("export", `couldn't note the failed exports: ${diag.messageOf(error)}`);
  }
}

interface Running {
  output: string;
  /** Its entry in the jobs a restart resumes. */
  key: string;
  cancelled: boolean;
  job: { cancel(): void } | null;
  backend: Backend;
  /** Rendered elsewhere: no contention with this Mac's own work. */
  remote: boolean;
  cloudRequest: string;
  cloudJob?: string;
  /** The timeline kept for a restart (`snapshotFile`), removed when it ends. */
  snapshot: string | null;
  /** What it exports, as `timelineHash`. */
  timeline: string;
  /** The options it exports with, as JSON with sorted keys (and its watermark: `withWatermarkKey`). */
  options: string;
  /** The edit's picture clips, for the review's clip map: the watermark's own isn't one. */
  clips?: [string, number, number][];
  keepLocal: boolean;
  queued: boolean;
  share?: boolean;
  note?: string;
  /** What it waits for while queued (export_capacity.ts `noRoom`). */
  waiting?: string;
  /** Rendered on Modal and kept in the cloud there (never copied here): its key and size. */
  inCloud?: { key: string; bytes: number | null };
  cancelQueued?: () => void;
}

/** Export jobs across projects, including the recent outcomes. Local jobs
 * queue for one renderer: each renderer owns several decoder/frame buffers. */
export interface ExportActivity {
  id: string;
  name: string;
  path: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  backend: Backend;
  updated_ms: number;
  error?: string;
  /** Said beside it: "Trying again after the update". */
  note?: string;
  /** Queued: what it waits for ("waiting for the encoder (this Mac has one)", export_capacity.ts). */
  waiting?: string;
}

/**
 * A finished export, kept per project in `<home>/exports.json` (this
 * machine's files, never shared): the project's exports list, with a
 * download (on the Mac or over Tailscale) and a delete each, survives a
 * restart. A normal edit isn't uploaded anywhere; this is how it's handed out.
 */
export interface ExportRecord {
  path: string;
  name: string;
  finished_ms: number;
  /** How long it took (seconds). */
  seconds: number;
  bytes: number | null;
  /** Frames exported, and whether that was the whole edit. */
  frames: number;
  whole: boolean;
  /** The first frame exported: an opening (0) can be shared as a preview. */
  start?: number;
  format: string;
  /**
   * Frames a second this Mac rendered it at when every frame was new (a first
   * export on this Mac, H.264, no restart), and whether it was a subtitle
   * video: what `macSpeed` learns this Mac's speed from.
   */
  fresh_fps?: number;
  subtitles?: boolean;
  /** The exported timeline's fingerprint (`timelineHash`): an edit since makes the project "not exported". */
  timeline?: string;
  /** R2 key of the verified cloud copy, when the local file was deleted after upload. */
  cloudKey?: string;
}

/** The R2 key an export of `project` named `name` is archived under. */
export function exportCloudKey(project: string, name: string): string {
  return `edit/exports/${project}/${name}`;
}

/** Injectable cloud IO for `archiveExportFile` (tests stand in for R2). */
export const exportCloud = {
  enabled: (): boolean => cloud.enabled(),
  upload: (path: string, key: string): Promise<void> => cloud.uploadFile(path, key),
  head: (key: string): Promise<{ size: number } | null> => cloud.head(key),
};

/**
 * Uploads `output` to `key` and deletes the local file — only after R2 is
 * verified to hold an object of exactly the local size. Any failure keeps
 * the local file (it may be the only copy) and returns false.
 */
/** Exports being read (a share making its copies): how many readers each. */
const reading = new Map<string, number>();
/** Exports archived while being read: their local copy goes when the last reader is done. */
const archivedMeanwhile = new Set<string>();

/**
 * Marks an export as being read until `release` is called: its archive keeps
 * the local copy meanwhile. A share started the moment the Cop video's export
 * said done lost its file to the archive mid-way ("No such file or
 * directory", Oct 29).
 */
export function holdExport(path: string): () => void {
  reading.set(path, (reading.get(path) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (reading.get(path) ?? 1) - 1;
    if (left > 0) {
      reading.set(path, left);
      return;
    }
    reading.delete(path);
    // Archived while it was read: gone now, as it would have been then (the
    // kept copies filled the disk and card 1's export failed, Oct 29).
    if (archivedMeanwhile.delete(path)) fs.rmSync(path, { force: true });
  };
}

/** Whether something is reading the export at `path` now (a share making its copies). */
export function beingRead(path: string): boolean {
  return reading.has(path);
}

/**
 * Holds `path` for the scope it's in (docs/plans/2026-11-01-effect.md, round
 * 3): let go however the work ends (done, failed, interrupted), so an archive
 * waits for the reading and never waits for ever.
 */
export const holdingExport = (path: string) => Effect.acquireRelease(Effect.sync(() => holdExport(path)), (release) => Effect.sync(release));

/** `use`, with `path` held while it runs (`holdingExport`) for the code that isn't Effect yet. */
export function withExport<T>(path: string, use: () => Promise<T>): Promise<T> {
  return runPromise(Effect.scoped(holdingExport(path).pipe(Effect.andThen(Effect.tryPromise({ try: use, catch: (error) => error as Error })))));
}

/** An export with no progress for `ms` has stalled: it's started again, `tries` times at most (looked at every `everyMs`). */
export const stall = { ms: 8 * 60_000, tries: 3, everyMs: 15_000 };

/** Free space where `path` is (bytes); 0 when it can't be told. */
function freeBytes(path: string): number {
  try {
    const found = fs.statfsSync(parent(path) ?? ".");
    return Number(found.bavail) * Number(found.bsize);
  } catch {
    return 0;
  }
}

/**
 * Room enough on the disk to keep an archived export here too: the next
 * re-export copies its unchanged chunks straight out of it instead of
 * fetching it back from the cloud first (2–3 minutes for a 90-minute edit).
 */
export const KEEP_WHEN_FREE = 60e9;

export async function archiveExportFile(
  output: string,
  key: string,
  io: typeof exportCloud = exportCloud,
  room: (path: string) => number = freeBytes,
): Promise<boolean> {
  let size: number;
  try { size = fs.statSync(output).size; } catch { return false; }
  try {
    await io.upload(output, key);
    const found = await io.head(key);
    if (found === null || found.size !== size) return false;
  } catch { return false; }
  // Archived; with room to spare it stays here too.
  if (room(output) > KEEP_WHEN_FREE) return true;
  // A copy being read stays until the reading's done.
  if (reading.has(output)) {
    archivedMeanwhile.add(output);
    return true;
  }
  try { fs.rmSync(output, { force: true }); } catch { return false; }
  return !fs.existsSync(output);
}

/**
 * Puts a finished export in the cloud (`archiveExportFile`) and lists it
 * there: after the export, or after a restart cut the upload short (the
 * `archive` job). A file gone meanwhile is said, never exported again here.
 */
export async function archiveFinished(home: string, id: string, output: string, key: string, record: ExportRecord): Promise<void> {
  if (!fs.existsSync(output)) throw new Error(`${output} is gone`);
  if (await archiveExportFile(output, key)) {
    try {
      remember(home, id, record);
    } catch { /* the list keeps the local-only record */ }
    diag.info("export", `${id}: archived ${output} to ${key}${fs.existsSync(output) ? " (the local copy kept: being read, or room to spare)" : " and deleted the local copy"}`);
    // Short of room: the copies kept while there was some go too.
    if (freeBytes(output) <= KEEP_WHEN_FREE) dropKept(home, output);
  } else {
    diag.warn("export", `${id}: cloud archive of ${output} unverified; local copy kept`);
  }
}

/** The chunk folder of a project's exports (the engine's chunks::folder). */
export function chunkFolder(cache: string, project: string): string {
  return join(cache, "export-chunks", project.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/**
 * The last export's file, fetched back from the cloud when it was archived,
 * so a re-export copies the chunks that didn't change out of it: with the
 * file gone the engine reuses nothing (its manifest wants the file as it was
 * written), and every re-export since exports went to the cloud rendered the
 * whole video again: 30–40 minutes for a fix in the intro (Oct 29). Its
 * manifest gets the fetched copy's time. The path fetched, else null.
 */
export async function restorePrevious(cache: string, home: string, project: string, fetch: (key: string, dest: string) => Promise<void> = (key, dest) => cloud.download(key, dest)): Promise<string | null> {
  const manifest = join(chunkFolder(cache, project), "manifest-v1.json");
  let text: string;
  let output: string;
  let size: number;
  try {
    text = fs.readFileSync(manifest, "utf8");
    const value = JSON.parse(text) as { output?: unknown; size?: unknown };
    if (typeof value.output !== "string" || typeof value.size !== "number") return null;
    [output, size] = [value.output, value.size];
  } catch {
    return null;
  }
  if (fs.existsSync(output)) return null;
  const key = cloudKeyFor(home, output);
  if (key === null) return null;
  try {
    fs.mkdirSync(parent(output) ?? ".", { recursive: true });
    await fetch(key, output);
  } catch (error) {
    diag.warn("export", `fetching the last export back to reuse its chunks: ${diag.messageOf(error)}; it renders whole`);
    fs.rmSync(output, { force: true });
    return null;
  }
  if (!fs.existsSync(output) || fs.statSync(output).size !== size) {
    fs.rmSync(output, { force: true });
    return null;
  }
  // The time as text: nanoseconds are past what a JS number holds exactly.
  const ns = fs.statSync(output, { bigint: true }).mtimeNs.toString();
  writeAtomic(manifest, text.replace(/"modified_ns"\s*:\s*\d+/, `"modified_ns":${ns}`));
  diag.info("export", `${project}: fetched the last export back so its unchanged chunks are reused`);
  return output;
}

/** The chunks the last whole export of `project` was joined from: each one's content key, first frame in the file and length. */
export function lastChunks(cache: string, project: string): { output: string; size: number; fps: number; chunks: { key: string; at: number; frames: number }[] } | null {
  try {
    const value = JSON.parse(fs.readFileSync(join(chunkFolder(cache, project), "manifest-v1.json"), "utf8")) as Record<string, unknown>;
    if (typeof value.output !== "string" || typeof value.size !== "number" || typeof value.fps !== "number" || !Array.isArray(value.chunks)) return null;
    const chunks = (value.chunks as Record<string, unknown>[]).filter((one) => typeof one.key === "string" && typeof one.at === "number" && typeof one.frames === "number") as { key: string; at: number; frames: number }[];
    return chunks.length === value.chunks.length && chunks.length > 0 ? { output: value.output, size: value.size, fps: value.fps, chunks } : null;
  } catch {
    return null;
  }
}

/**
 * Deletes the local copies of exports archived in the cloud (verified by
 * size), but `except` and any being read: kept while the disk had room,
 * they go when it hasn't (four of them filled this Mac on Oct 29).
 */
export function dropKept(home: string, except: string): number {
  let freed = 0;
  for (const own of Object.values(readRecords(home))) {
    for (const record of own) {
      if (record.cloudKey === undefined || record.path === except || reading.has(record.path) || !fs.existsSync(record.path)) continue;
      const size = fs.statSync(record.path).size;
      if (record.bytes !== null && size !== record.bytes) continue;
      fs.rmSync(record.path, { force: true });
      freed += size;
    }
  }
  if (freed > 0) diag.info("export", `freed ${(freed / 1e9).toFixed(1)} GB: exports already in the cloud, kept here while there was room`);
  return freed;
}

/** The cloud key recorded for `path`, when its local copy was archived. */
export function cloudKeyFor(home: string, path: string): string | null {
  for (const own of Object.values(readRecords(home))) {
    const hit = own.find((record) => record.path === path);
    if (hit?.cloudKey !== undefined) return hit.cloudKey;
  }
  return null;
}

/** A project's timeline as a fingerprint: the same whatever revision or machine saved it, different after any edit. */
export function timelineHash(project: Project): string {
  return createHash("sha256").update(jsonForSerde(project)).digest("hex").slice(0, 16);
}

/** The picture clips of an export's timeline ([id, start, duration] frames): a review note's moment finds its clip by them after later edits. */
export function clipMap(project: Project): [string, number, number][] {
  return project.clips.filter((clip) => clip.type === "video").map((clip): [string, number, number] => [clip.id, clip.start, clip.duration]);
}

/** Where an export's clip map is kept, by its timeline (`timelineHash`). */
export function mapFile(home: string, timeline: string): string {
  return join(home, "export-maps", `${timeline}.json`);
}

/** How many exports a project keeps listed (the oldest drop off the list; their files stay). */
const KEEP_LISTED = 30;

/**
 * The project as an export running for it was asked for, kept while it runs
 * so an export a restart cut short carries on with that timeline, not edits
 * made since (`resumeSnapshot`).
 */
function snapshotFile(home: string, id: string): string {
  return join(home, "jobs", `export-${id}.json`);
}

/** The project an export a restart cut short was started with, if it was kept. */
export function resumeSnapshot(home: string, id: string, args: Record<string, unknown>): Project | null {
  const path = args.snapshot;
  // Only the file Edit keeps for it: jobs.json names nothing else to read.
  if (typeof path !== "string" || path !== snapshotFile(home, id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as Project;
  } catch {
    return null;
  }
}

function recordsFile(home: string): string {
  return join(home, "exports.json");
}

function readRecords(home: string): Record<string, ExportRecord[]> {
  try {
    const value = JSON.parse(fs.readFileSync(recordsFile(home), "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, ExportRecord[]>) : {};
  } catch {
    return {};
  }
}

function writeRecords(home: string, records: Record<string, ExportRecord[]>): void {
  writeAtomic(recordsFile(home), JSON.stringify(records, null, 1));
}

/** Project `id`'s exports, newest first, each saying whether its file is still there. */
export function listExports(home: string, id: string): (ExportRecord & { missing: boolean })[] {
  return [...(readRecords(home)[id] ?? [])]
    .reverse()
    .map((record) => ({ ...record, missing: !fs.existsSync(record.path) && record.cloudKey === undefined }));
}

function remember(home: string, id: string, record: ExportRecord): void {
  const records = readRecords(home);
  const own = (records[id] ?? []).filter((one) => one.path !== record.path);
  own.push(record);
  records[id] = own.slice(Math.max(own.length - KEEP_LISTED, 0));
  writeRecords(home, records);
}

/** The fewest frames a speed sample has: a short export is mostly its fixed start and finish. */
const SPEED_FRAMES = 1800;
/** The newest samples a kind's speed is the median of. */
const SPEED_SAMPLES = 5;

/**
 * This Mac's own speed for the house export, by kind: the median of its
 * newest fresh exports (`fresh_fps`), where Modal's 25-minute rule reads it
 * (`cloudBetter`). A fixed 45 frames/s had a Mac keeping an edit it took twice
 * as long over (the 16-Year-Old, 26.7 min: 22 frames/s on an M1, Nov 1).
 */
export function macSpeed(home: string): MacSpeed {
  const samples = Object.values(readRecords(home)).flat()
    .filter((record) => typeof record.fresh_fps === "number" && record.fresh_fps > 0)
    .sort((a, b) => b.finished_ms - a.finished_ms);
  const median = (subtitles: boolean): number | undefined => {
    const rates = samples.filter((record) => (record.subtitles === true) === subtitles).slice(0, SPEED_SAMPLES).map((record) => record.fresh_fps!).sort((a, b) => a - b);
    if (rates.length === 0) return undefined;
    const middle = Math.floor(rates.length / 2);
    return rates.length % 2 === 1 ? rates[middle]! : (rates[middle - 1]! + rates[middle]!) / 2;
  };
  const edit = median(false);
  const subtitles = median(true);
  return { ...(edit === undefined ? {} : { edit }), ...(subtitles === undefined ? {} : { subtitles }) };
}

/** Whether nothing of `project`'s earlier exports is kept to reuse: an export now renders every frame. */
function nothingToReuse(cache: string, project: string): boolean {
  try {
    return fs.readdirSync(chunkFolder(cache, project)).length === 0;
  } catch {
    return true;
  }
}

/** Whether `path` is one of the listed exports (of any project). */
export function listed(home: string, path: string): boolean {
  return Object.values(readRecords(home)).some((own) => own.some((record) => record.path === path));
}

/**
 * Deletes one of project `id`'s listed exports: its file and its place on
 * the list. Only a listed export's file is ever deleted.
 */
export function deleteExport(home: string, id: string, path: string): void {
  const records = readRecords(home);
  const own = records[id] ?? [];
  if (!own.some((record) => record.path === path)) throw new Error("not one of this project's exports");
  try {
    fs.rmSync(path, { force: true });
  } catch (error) {
    throw new Error(`${path}: ${ioMessage(error)}`);
  }
  records[id] = own.filter((record) => record.path !== path);
  writeRecords(home, records);
  diag.info("export", `${id}: deleted the export ${path}`);
}

/** An export's options key with its watermark (a channel's picture id), so a share follows only an export with the same one. */
export function withWatermarkKey(key: string, watermark: string | undefined): string {
  return watermark === undefined ? key : `${key}|watermark:${watermark}`;
}

/** Export options as JSON with sorted keys: two asks for the same export compare equal. */
export function optionsKey(options: ExportOptions): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, one]) => [key, sorted(one)])) : value;
  return JSON.stringify(sorted(options));
}

export class ExportRegistry implements seams.Exports {
  private jobs = new Map<string, Running>();
  /** Exports rendering on this Mac now: as many at once as it has room for (export_capacity.ts). */
  private localActive = 0;
  private localQueue: { running: Running; start: () => void }[] = [];
  /** A look again at the line when an export waits for room (memory, the CPU) rather than for one to end. */
  private recheck: ReturnType<typeof setTimeout> | null = null;
  private recent = new Map<string, ExportActivity>();
  /** Files exported since the server started, newest last: the only ones it hands out or reveals. */
  private finished: string[] = [];

  /** The data folder whose exports list this keeps (`<home>/exports.json`); none in some tests. */
  constructor(private readonly home: string | null = null) {}

  /** Whether `path` is a file this server exported, now or before a restart (and so may be downloaded or revealed). */
  exported(path: string): boolean {
    return this.finished.includes(path) || (this.home !== null && listed(this.home, path));
  }

  running(): boolean {
    return this.jobs.size > 0;
  }

  /** Project `id`'s export under way: what it writes, its timeline (`timelineHash`) and options (`optionsKey`). */
  runningFor(id: string): { output: string; timeline: string; options: string } | null {
    const running = this.jobs.get(id);
    return running === undefined || running.cancelled ? null : { output: running.output, timeline: running.timeline, options: running.options };
  }

  localRunning(): boolean {
    return this.localActive > 0;
  }

  activity(): ExportActivity[] {
    return [...this.recent.values()].map(one => ({ ...one })).sort((a, b) => b.updated_ms - a.updated_ms);
  }

  private publish(store: Store, project: Project, running: Running, state: ExportActivity["state"], progress: number, extra: Record<string, unknown> = {}): void {
    this.recent.set(project.id, { id: project.id, name: project.name, path: running.output, state, progress, backend: running.backend, updated_ms: nowMs(), ...(typeof extra.error === "string" ? { error: extra.error } : {}), ...(running.note === undefined ? {} : { note: running.note }), ...(state === "queued" && running.waiting !== undefined ? { waiting: running.waiting } : {}) });
    // Keep every active job and only the latest completed outcomes.
    const ended = [...this.recent.values()].filter(one => one.state !== "queued" && one.state !== "running").sort((a, b) => b.updated_ms - a.updated_ms);
    for (const old of ended.slice(20)) this.recent.delete(old.id);
    store.emit({ type: "export", id: project.id, state, progress, path: running.output, ...extra });
  }

  /** Starts what waits in line while this Mac has room for another (export_capacity.ts). */
  private drain(): void {
    this.localQueue = this.localQueue.filter((one) => !one.running.cancelled);
    while (this.localQueue.length > 0) {
      const why = capacity.noRoom(this.localActive);
      if (why !== null) {
        for (const one of this.localQueue) one.running.waiting = why;
        // Waiting on room rather than on an export to end: looked at again in a while.
        if (this.localActive < capacity.mostAtOnce() && this.recheck === null) {
          this.recheck = setTimeout(() => {
            this.recheck = null;
            this.drain();
          }, 20_000);
          this.recheck.unref?.();
        }
        return;
      }
      const next = this.localQueue.shift()!;
      if (this.localActive > 0) diag.info("export", `starting another export beside ${this.localActive} running (${capacity.standing()})`);
      this.localActive++;
      next.running.queued = false;
      next.start();
    }
  }

  /** An export here let go of its place: the next in line may start. */
  private releaseOne(): void {
    this.localActive = Math.max(0, this.localActive - 1);
    this.drain();
  }

  cancel(project: string): boolean {
    const running = this.jobs.get(project);
    if (running === undefined) return false;
    running.cancelled = true;
    if (running.queued) running.cancelQueued?.();
    running.job?.cancel();
    return true;
  }

  /**
   * Starts exporting `project` as `options` ask; returns the file it will
   * write (`output` with the format's extension). It renders on Modal when
   * that's on and the export suits it, else here (or the Relay's worker). A
   * whole subtitled video is then uploaded to the team's Drive unless
   * `drive` is false; any whole video export is when it's true.
   */
  async start(
    store: Store,
    library: seams.Library,
    project: Project,
    options: ExportOptions,
    output: string,
    extra: StartExtra = {},
  ): Promise<string> {
    const cloudRequest = extra.cloudRequest ?? crypto.randomUUID();
    const cloudJob = extra.cloudJob;
    const addon = native();
    const { plan, fps } = addon.exportPlan({ json: jsonForSerde(project) }, options);
    // The edit as it is, before a watermark goes over it: what this export is of (its hash and clip map).
    const edit = project;
    if (extra.watermark !== undefined) project = await seams.channelMarks.addWatermark({ library }, store.cacheDir(), project, plan, extra.watermark);
    let path = addon.withExtension(output, options.format);
    // Never into an unplugged media drive's folder (or the empty mount point it leaves behind).
    store.layout().writable(path);
    const above = parent(path);
    const folder = above === null || above === "" ? "." : above;
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    const name = fileName(path);
    if (name === null) throw new Error("export needs a file name");
    let real: string;
    try {
      real = fs.realpathSync(folder);
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    path = join(real, name);
    if (fs.existsSync(path)) {
      const existing = canonical(path);
      if (project.media.some((media) => fs.existsSync(media.path) && canonical(media.path) === existing)) {
        throw new Error("export would overwrite source footage; choose another file");
      }
    }
    let backend: Backend;
    if (extra.backend !== undefined) {
      backend = extra.backend;
    } else if ((await seams.modalExports.ready(), seams.modalExports.enabled())) {
      // Modal only when the Mac really can't (the user, Oct 31: ~$1 an export,
      // the same videos four to six times a day, the month's limit reached):
      // it's already exporting, it's busy, or it would take over 25 minutes at
      // its own measured speed (`cloudBetter`, `macSpeed`). Until Nov 1 that
      // rule was written but never asked, so every export Modal could take
      // went there. Modal can't do some (`unsuitable`): those stay here too.
      const why = seams.modalExports.unsuitable(project, options, plan);
      const busy = why === null
        ? seams.modalExports.cloudBetter(project, plan, capacity.noRoom(this.localActive) !== null || this.localQueue.length > 0, undefined, macSpeed(this.home ?? store.home))
        : null;
      if (why === null && busy !== null) {
        diag.info("export", `${project.id}: exporting on Modal: ${busy}`);
        backend = "modal";
      } else {
        diag.info("export", `${project.id}: exporting on this Mac: ${why ?? "it's free here and would finish within 25 minutes"}`);
        backend = why === null || !seams.cloudExports.enabled() ? "local" : "cloud";
      }
    } else {
      backend = seams.cloudExports.enabled() ? "cloud" : "local";
    }
    if (backend === "modal") {
      const why = seams.modalExports.unsuitable(project, options, plan);
      if (why !== null) throw new Error(`this export can't render in the cloud: ${why}`);
    }
    // Rendered here: refused up front when the disks can't hold it, never halfway (TODO, Oct 18: a 2h35m export
    // needed ~8 GB with 2.8 GB free).
    if (backend === "local") {
      const short = roomFor(exportBytes(options, plan, options.fps ?? fps), store.cacheDir(), folder);
      if (short !== null) throw new Error(short);
    }
    const whole = ["h264", "hevc", "prores"].includes(options.format) && plan.start === 0 && plan.end >= duration(project) && plan.end > 0;
    if (extra.drive === true && !whole) throw new Error("only a whole video export (MP4 or MOV) uploads to Drive");
    const remote = backend !== "local";
    if (this.jobs.has(project.id)) throw new Error("this project already has an export running");
    if ([...this.jobs.values()].some(job => job.output === path)) throw new Error("another export is writing this output path");
    let snapshot: string | null = null;
    if (this.home !== null) {
      snapshot = snapshotFile(this.home, project.id);
      try {
        fs.mkdirSync(join(this.home, "jobs"), { recursive: true });
        writeAtomic(snapshot, jsonForSerde(project));
      } catch (error) {
        throw new Error(`couldn't keep this export's timeline for a restart: ${ioMessage(error)}`);
      }
    }
    const args = {
      options, output: path, backend, cloudRequest,
      ...(cloudJob === undefined ? {} : { cloudJob }), ...(extra.drive === undefined ? {} : { drive: extra.drive }), ...(snapshot === null ? {} : { snapshot }),
    };
    const key = jobs.begin(this.home, "export", project.id, args);
    // Own the snapshot in memory too: a caller changing its draft or options
    // after enqueueing must never change the export that was accepted.
    project = structuredClone(project);
    options = structuredClone(options);
    const running: Running = { output: path, key, cancelled: false, job: null, snapshot, backend, remote, cloudRequest, cloudJob, timeline: timelineHash(edit), options: withWatermarkKey(optionsKey(options), extra.watermark), clips: clipMap(edit), keepLocal: extra.keepLocal === true, queued: !remote, ...(extra.share === true ? { share: true } : {}), ...(extra.note === undefined ? {} : { note: extra.note }) };
    this.jobs.set(project.id, running);
    let upload = false;
    try {
      upload = extra.drive ?? seams.drive.wanted(project, options, plan);
    } catch (error) {
      if (!seams.isUnavailable(error)) {
        this.jobs.delete(project.id);
        jobs.end(this.home, key);
        if (snapshot !== null) fs.rmSync(snapshot, { force: true });
        throw error;
      }
    }
    if (remote) void this.run(store, library, project, options, plan, path, running, upload);
    else {
      running.cancelQueued = () => {
        this.localQueue = this.localQueue.filter(one => one.running !== running);
        this.publish(store, project, running, "cancelled", 0);
        this.jobs.delete(project.id);
        jobs.end(this.home, running.key);
        if (snapshot !== null) fs.rmSync(snapshot, { force: true });
      };
      this.localQueue.push({ running, start: () => {
        void this.run(store, library, project, options, plan, path, running, upload, () => this.releaseOne());
      } });
      this.drain();
      if (running.queued) this.publish(store, project, running, "queued", 0);
    }
    return path;
  }

  private async run(
    store: Store,
    library: seams.Library,
    project: Project,
    options: ExportOptions,
    plan: import("./model.ts").Plan,
    output: string,
    running: Running,
    upload: boolean,
    releaseLocal?: () => void,
  ): Promise<void> {
    const id = project.id;
    const emit = (state: ExportActivity["state"], progress: number, extra: Record<string, unknown> = {}) => this.publish(store, project, running, state, progress, extra);
    emit("running", 0);
    const started = performance.now();
    // A speed sample (`fresh_fps`): rendered here from the start, every frame new, never restarted.
    let fresh = running.backend === "local" && options.format === "h264" && nothingToReuse(store.cacheDir(), id);
    let result: { ok: true } | { ok: false; error: string };
    try {
      await catchBugsAsync("the export", async () => {
        if (running.backend === "modal") {
          try {
            // Kept in the cloud where it's archived, unless Drive or the caller wants it here.
            const keep = !upload && !running.keepLocal && exportCloud.enabled() ? exportCloudKey(id, fileName(output) ?? "export.mp4") : null;
            const made = await seams.modalExports.run(this.home ?? store.home, project, options, output, () => running.cancelled, progress => emit("running", progress), keep);
            if (made.key !== null) running.inCloud = { key: made.key, bytes: made.bytes };
            return;
          } catch (error) {
            if (running.cancelled) throw error;
            // Something wrong on Modal (out of credit, down): exported here instead.
            diag.warn("export", `${project.name}: Modal couldn't export it (${diag.messageOf(error)}); exporting on this Mac`);
            running.backend = "local";
            running.remote = false;
            fresh = false;
            // In line for this Mac's renderer like any export here. It went
            // around the line (Nov 2, JJ's Mac: Modal refused Cops Surprise,
            // it exported here, and Mom Secretly's v2 started beside it, two
            // whole renders on a Mac with 0.1 GB free, until its encoder stalled).
            await new Promise<void>((resolve, reject) => {
              running.queued = true;
              running.cancelQueued = () => {
                this.localQueue = this.localQueue.filter(one => one.running !== running);
                reject(new Error("cancelled"));
              };
              this.localQueue.push({ running, start: resolve });
              this.drain();
              if (running.queued) emit("queued", 0);
            });
            releaseLocal = () => this.releaseOne();
            emit("running", 0);
          }
        }
        if (running.backend === "cloud") {
          await seams.cloudExports.run(project, options, plan, output, () => running.cancelled, progress => emit("running", progress), running.cloudRequest, {
            id: running.cloudJob,
            accepted: id => { running.cloudJob = id; jobs.patch(this.home, running.key, { cloudJob: id }); },
          });
          return;
        }
        // Fetched back to reuse its chunks; gone again after if this export writes elsewhere.
        let restored: string | null = null;
        try {
          // A stalled render (a read from the cloud that never answers: card 1's
          // export sat at 28% for seven minutes, Oct 29) is stopped and started
          // again by itself; the chunks it made are kept, so it carries on.
          for (let attempt = 1; ; attempt++) {
            let stalled = false;
            // Cloud footage: the originals, not the proxies (read from R2 for the export), signed afresh each try.
            let exported = project;
            let originals: seams.Originals | null = null;
            try {
              [exported, originals] = await seams.cloudMedia.forExport(project, plan.start, plan.end, store.cacheDir(), () => running.cancelled);
            } catch (error) {
              if (!seams.isUnavailable(error)) throw error;
            }
            try {
              let pending: string[] = [];
              try {
                pending = seams.broll.smoothingPending(exported.id);
              } catch (error) {
                if (!seams.isUnavailable(error)) throw error;
              }
              if (pending.length > 0) {
                diag.info(
                  "export",
                  `exporting current timeline snapshot; ${pending.length} optional optical-flow renders still pending`,
                );
              }
              if (running.cancelled) throw new Error("cancelled");
              if (attempt === 1) restored = this.home === null ? null : await restorePrevious(store.cacheDir(), this.home, project.id);
              let moved = performance.now();
              let last = -1;
              const job = native().ExportJob.start(
                { project: { json: jsonForSerde(exported) }, options, plan, output, cacheDir: store.cacheDir(), sounds: originals?.sounds ?? {}, excerpts: originals?.excerpts ?? [] },
                (progress) => {
                  // Any change is movement: the engine trying its chunks again reports from lower down (Nov 2:
                  // Kroger's retry rendered 11 chunks yet "nothing new for 8 minutes", and was started over).
                  if (progress !== last) {
                    last = progress;
                    moved = performance.now();
                  }
                  try {
                    emit("running", progress);
                  } catch (error) {
                    diag.warn("export", `progress: ${diag.messageOf(error)}`);
                  }
                },
              );
              running.job = job;
              if (running.cancelled) job.cancel();
              const watch = setInterval(() => {
                if (performance.now() - moved < stall.ms) return;
                stalled = true;
                job.cancel();
              }, stall.everyMs);
              try {
                await job.wait();
              } catch (error) {
                if (!stalled || running.cancelled) throw error;
              } finally {
                clearInterval(watch);
              }
              if (running.cancelled) throw new Error("cancelled");
              if (!stalled) break;
            } finally {
              originals?.release();
            }
            fresh = false;
            if (attempt >= stall.tries) throw new Error(`the export stopped moving ${stall.tries} times (nothing new for ${Math.round(stall.ms / 60_000)} minutes each)`);
            diag.warn("export", `${project.name}: nothing new for ${Math.round(stall.ms / 60_000)} minutes; starting it again (the chunks made are kept)`);
          }
        } finally {
          if (restored !== null && restored !== output) fs.rmSync(restored, { force: true });
        }
      });
      this.finished = this.finished.filter((done) => done !== output);
      this.finished.push(output);
      this.finished.splice(0, Math.max(this.finished.length - KEEP_FINISHED, 0));
      result = { ok: true };
    } catch (error) {
      result = { ok: false, error: diag.messageOf(error) };
    } finally {
      // Archiving/uploading a completed file doesn't occupy the renderer.
      releaseLocal?.();
    }
    const frames = Math.max(plan.end - plan.start, 0);
    const took = performance.now() - started;
    if (result.ok) {
      diag.info(
        "export",
        `${project.name} exported ${frames} frames in ${diag.human(took)} (${fixed(frames / Math.max(took / 1000, 1e-3), 1)} frames/s) to ${output}`,
      );
      diag.record("export", "export", took, null);
      let bytes: number | null = running.inCloud?.bytes ?? null;
      try {
        bytes = fs.statSync(output).size;
      } catch {
        // In the cloud only.
      }
      emit("done", 1, { seconds: (performance.now() - started) / 1000, bytes, drive: upload, backend: running.backend });
      if (this.home !== null) noteFailure(this.home, id, null);
      try {
        remember(this.home ?? store.home, id, {
          path: output,
          name: fileName(output) ?? output,
          finished_ms: nowMs(),
          seconds: took / 1000,
          bytes,
          frames,
          whole: plan.start === 0 && plan.end >= duration(project),
          start: plan.start,
          format: options.format,
          ...(fresh && frames >= SPEED_FRAMES
            ? { fresh_fps: Math.round((frames / (took / 1000)) * 10) / 10, subtitles: subtitleVideo(project) }
            : {}),
          timeline: running.timeline,
          ...(running.inCloud === undefined ? {} : { cloudKey: running.inCloud.key }),
        });
        fs.mkdirSync(join(this.home ?? store.home, "export-maps"), { recursive: true });
        writeAtomic(mapFile(this.home ?? store.home, running.timeline), JSON.stringify(running.clips ?? clipMap(project)));
      } catch (error) {
        diag.warn("export", `couldn't list ${output}: ${diag.messageOf(error)}`);
      }
      // Cloud is canonical: upload, verify by size, then delete the local
      // file. Skipped when Drive will read the file next, or on request.
      if (running.inCloud !== undefined) {
        diag.info("export", `${id}: rendered and kept in the cloud at ${running.inCloud.key}, never copied to this Mac`);
      } else if (!upload && !running.keepLocal && exportCloud.enabled()) {
        const key = exportCloudKey(id, fileName(output) ?? "export.mp4");
        const record: ExportRecord = {
          path: output, name: fileName(output) ?? output, finished_ms: nowMs(), seconds: took / 1000, bytes,
          frames, whole: plan.start === 0 && plan.end >= duration(project), start: plan.start, format: options.format, timeline: running.timeline, cloudKey: key,
        };
        // The export is done: its file is whole and listed. The archive is a job of its own, so a restart
        // meanwhile sends the file again instead of exporting it again (Nov 3: Kroger, 77 minutes, started
        // over from nothing by a restart during its upload).
        jobs.end(this.home, running.key);
        const archive = jobs.begin(this.home, "archive", id, { output, key, record });
        try {
          await archiveFinished(this.home ?? store.home, id, output, key, record);
        } finally {
          jobs.end(this.home, archive);
        }
      }
    } else if (running.cancelled) {
      diag.info("export", `${project.name} export cancelled`);
      emit("cancelled", 0, { error: result.error });
    } else {
      diag.record("export", "export", took, `${project.name}: ${result.error}`);
      emit("failed", 0, { error: result.error });
      // Kept for the next build to try again (retry_after_update.ts).
      if (this.home !== null) {
        noteFailure(this.home, id, {
          project: id, name: project.name, options, output, error: result.error, at: nowMs(), build: BUILD,
          ...(upload ? { drive: true } : {}), ...(running.keepLocal ? { keepLocal: true } : {}), ...(running.share === true ? { share: true } : {}),
        });
      }
    }
    this.jobs.delete(id);
    jobs.end(this.home, running.key);
    if (running.snapshot !== null) fs.rmSync(running.snapshot, { force: true });
    if (upload && result.ok) {
      try {
        seams.drive.start(store, library, project, output);
      } catch (error) {
        diag.warn("drive", `${project.name}: ${diag.messageOf(error)}`);
      }
    }
  }
}


/**
 * About how many bytes an export's file is, by the engine's own rate
 * (export.rs `video_bitrate`: pixels × fps × bits a pixel for the quality,
 * HEVC 60%, a target size as given; ProRes ~2.5 bits a pixel) and its sound.
 * Audio and stills are small: 0.
 */
export function exportBytes(options: ExportOptions, plan: Plan, fps: number): number {
  if (!["h264", "hevc", "prores"].includes(options.format)) return 0;
  const seconds = Math.max((plan.end - plan.start) / Math.max(fps, 1), 0);
  const pixels = plan.width * plan.height * fps;
  const bits = { high: 0.14, balanced: 0.08, small: 0.045 }[options.quality];
  const video =
    options.format === "prores" ? pixels * 2.5 : options.target_mb != null ? (options.target_mb * 8_000_000) / Math.max(seconds, 1) : pixels * bits * (options.format === "hevc" ? 0.6 : 1);
  const audio = plan.audio ? 256_000 : 0;
  return Math.ceil(((video + audio) / 8) * seconds);
}

const GB = 1e9;

/**
 * Why the disks can't hold an export of `bytes`, or null: its chunks go in
 * `cacheDir`, then are joined into a file in `outputDir` (both on one disk:
 * twice the room), with a margin of a tenth or a gigabyte.
 */
export function roomFor(bytes: number, cacheDir: string, outputDir: string, free: (path: string) => number = freeAt, device: (path: string) => number = deviceOf): string | null {
  if (bytes <= 0) return null;
  const margin = Math.max(bytes * 0.1, GB);
  const need = new Map<number, { path: string; bytes: number }>();
  for (const path of [cacheDir, outputDir]) {
    const disk = device(path);
    const had = need.get(disk);
    need.set(disk, { path: had?.path ?? path, bytes: (had?.bytes ?? margin) + bytes });
  }
  for (const { path, bytes: wanted } of need.values()) {
    const has = free(path);
    if (has < wanted) {
      return `not enough disk space for this export: it needs about ${(wanted / GB).toFixed(1)} GB on the disk with ${path}, and ${(has / GB).toFixed(1)} GB is free (free some space, or export a shorter span, a smaller size or a lower quality)`;
    }
  }
  return null;
}

function freeAt(path: string): number {
  try {
    const stats = fs.statfsSync(path);
    return stats.bavail * stats.bsize;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function deviceOf(path: string): number {
  try {
    return fs.statSync(path).dev;
  } catch {
    return -1;
  }
}
