// The server's export registry: a durable queue on this Mac, its
// `export` events, the files it may hand out, and the Drive upload after a
// subtitled video (or whenever asked). The local rendering, mixing, the partial
// file beside the destination and its rename are the addon's (`ExportJob`).

import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { Effect } from "effect";

import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import * as capacity from "./export_capacity.ts";
import { shownProgress } from "./export_prep.ts";
import { runPromise } from "./effect/runtime.ts";
import * as jobs from "./jobs.ts";
import { ioMessage, nowMs, writeAtomic } from "./files.ts";
import { subtitleVideo } from "./drive.ts";
import { catchBugsAsync } from "./guard.ts";
import type { ExportOptions, Plan, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { canonical, fileName, homePath, isFile, join, parent } from "./paths.ts";
import { duration } from "./project.ts";
import { fixed, jsonForSerde } from "./rust.ts";
import * as seams from "./seams.ts";
import type { Store } from "./store.ts";
import { BUILD } from "./version.ts";

/** How many finished exports are remembered (handed out, revealed). */
const KEEP_FINISHED = 50;

/** How an export is started beyond its options (a restart passes back what it was). */
export interface StartExtra {
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
  /** A share's export: its file goes over the review's latest version rather than adding one (reviews.share's `replace`), kept so a restart shares it the same way. */
  replace?: boolean;
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
  cancelQueued?: () => void;
  /** Made ahead, before anyone asked (export_ahead.ts): nobody waits on it, nothing lists it, and any export asked for stops it. */
  ahead?: boolean;
  /** Settled once it has ended, however it ended. */
  ended?: Promise<void>;
}

/** Export jobs across projects, including the recent outcomes. Local jobs
 * queue for one renderer: each renderer owns several decoder/frame buffers. */
export interface ExportActivity {
  id: string;
  name: string;
  path: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  updated_ms: number;
  error?: string;
  /** Said beside it: "Trying again after the update". */
  note?: string;
  /** Queued: what it waits for ("waiting for the encoder (this Mac has one)", export_capacity.ts). */
  waiting?: string;
  /** Running, before frames are encoding: "cutting the footage, 12 of 225". Absent once the encoder reports, so the line goes back to the percent. */
  phase?: string;
  /** The file is still on this Mac. Set only once the export is done, and checked again each time the queue is read: the archive deletes it after upload. */
  onDisk?: boolean;
  /** Where that file is, with home as `~` (`~/Movies/Edit/Name.mp4`). Set only while `onDisk`. */
  saved?: string;
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
   * video: this Mac's own speed for the house export.
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
 * Room enough on the disk to keep every archived export here too: the next
 * re-export copies its unchanged chunks straight out of it instead of
 * fetching it back from the cloud first (2–3 minutes for a 90-minute edit).
 */
export const KEEP_WHEN_FREE = 60e9;

/**
 * Below that, each project's newest export still stays while the disk keeps
 * this much free: at 60 GB, a Mac with a 256 GB disk (Sphe's M1, 26 GB free)
 * fetched the last export back from R2 before every re-export (Sphe, Nov 3:
 * "keep newest per project"). The older copies go first (`dropKept`).
 */
export const KEEP_NEWEST_FREE = 20e9;

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
  // Archived; while the disk keeps its room it stays here too: it's the project's newest.
  if (room(output) > KEEP_NEWEST_FREE) return true;
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
  // Short of room: the older copies kept while there was some go first, so this one may stay.
  dropKept(home, output);
  if (await archiveExportFile(output, key)) {
    try {
      remember(home, id, record);
    } catch { /* the list keeps the local-only record */ }
    diag.info("export", `${id}: archived ${output} to ${key}${fs.existsSync(output) ? " (the local copy kept: being read, or the newest with room for it)" : " and deleted the local copy"}`);
  } else {
    diag.warn("export", `${id}: cloud archive of ${output} unverified; local copy kept`);
  }
}

/** Where project `id`'s export made ahead goes (export_ahead.ts), with what it was made of beside it (`.json`). */
export function aheadFile(cache: string, id: string): string {
  return join(cache, "ahead", `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.mp4`);
}

/** An export of `id` asked for and made into `output`: its export made ahead (copied from, or older) is spent, and goes. */
export function aheadSpent(cache: string, id: string, output: string): void {
  const file = aheadFile(cache, id);
  if (file === output) return;
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.json`, { force: true });
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
 * Deletes local copies of exports archived in the cloud (verified by size),
 * never `except` or one being read, as the disk `except` is on runs short
 * (four of them filled this Mac on Oct 29): with `KEEP_WHEN_FREE` or less
 * free, every one but each project's newest; with under `KEEP_NEWEST_FREE`
 * still, the newest of other projects on that disk too, the oldest first,
 * until there's room again. Bytes freed.
 */
export function dropKept(home: string, except: string, free: (path: string) => number = freeBytes): number {
  if (free(except) > KEEP_WHEN_FREE) return 0;
  const records = Object.values(readRecords(home));
  const newest = new Set(records.map((own) => own.reduce<ExportRecord | null>((best, one) => (best === null || one.finished_ms >= best.finished_ms ? one : best), null)?.path).filter((path) => path !== undefined));
  const droppable = (record: ExportRecord): number | null => {
    if (record.cloudKey === undefined || record.path === except || reading.has(record.path) || !fs.existsSync(record.path)) return null;
    const size = fs.statSync(record.path).size;
    return record.bytes !== null && size !== record.bytes ? null : size;
  };
  let freed = 0;
  for (const record of records.flat()) {
    if (newest.has(record.path)) continue;
    const size = droppable(record);
    if (size === null) continue;
    fs.rmSync(record.path, { force: true });
    freed += size;
  }
  const disk = (path: string): number => { try { return fs.statSync(path).dev; } catch { return -1; } };
  const here = disk(parent(except) ?? ".");
  const others = records.flat().filter((record) => newest.has(record.path) && disk(record.path) === here).sort((a, b) => a.finished_ms - b.finished_ms);
  for (const record of others) {
    if (free(except) >= KEEP_NEWEST_FREE) break;
    const size = droppable(record);
    if (size === null) continue;
    fs.rmSync(record.path, { force: true });
    freed += size;
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
  /** Of those, the places smooth playback's render holds (`takeTurn`): not exports, so nothing waits on them as on one. */
  private lent = 0;
  /** Of those, the places exports made ahead hold (`startAhead`): not exports either, and they give theirs up to anything that wants it. */
  private aheadActive = 0;
  /** Smooth playback's renders waiting for a place: served before the exports in line (Sphe, Nov 3: "cut the line"). */
  private ahead: ((release: () => void) => void)[] = [];
  private localQueue: { running: Running; start: () => void; notify: () => void }[] = [];
  /** A look again at the line when an export waits for room (memory, the CPU) rather than for one to end. */
  private recheck: ReturnType<typeof setTimeout> | null = null;
  private recent = new Map<string, ExportActivity>();
  /** How an export was started, kept after it fails or is cancelled so it can be run again. Gone when it succeeds, or when the outcome leaves the recent list. */
  private held = new Map<string, { options: ExportOptions; output: string; extra: StartExtra }>();
  /** Files exported since the server started, newest last: the only ones it hands out or reveals. */
  private finished: string[] = [];

  /** The data folder whose exports list this keeps (`<home>/exports.json`); none in some tests. */
  constructor(private readonly home: string | null = null) {}

  /** Whether `path` is a file this server exported, now or before a restart (and so may be downloaded or revealed). */
  exported(path: string): boolean {
    return this.finished.includes(path) || (this.home !== null && listed(this.home, path));
  }

  /** Whether an export someone asked for is under way (one made ahead isn't). */
  running(): boolean {
    return [...this.jobs.values()].some((job) => job.ahead !== true);
  }

  /** Project `id`'s export under way: what it writes, its timeline (`timelineHash`) and options (`optionsKey`). One made ahead isn't one to follow. */
  runningFor(id: string): { output: string; timeline: string; options: string } | null {
    const running = this.jobs.get(id);
    return running === undefined || running.cancelled || running.ahead === true ? null : { output: running.output, timeline: running.timeline, options: running.options };
  }

  /** Whether an export is rendering here (smooth playback's render isn't one, nor one made ahead). */
  localRunning(): boolean {
    return this.localActive - this.lent - this.aheadActive > 0;
  }

  /** The project whose export is being made ahead, if one is. */
  aheadFor(): string | null {
    for (const [id, job] of this.jobs) if (job.ahead === true && !job.cancelled) return id;
    return null;
  }

  /** Stops exports made ahead (all, or `project`'s), for something someone wants; resolves once they've let go. */
  async stopAhead(project?: string): Promise<void> {
    const ended: Promise<void>[] = [];
    for (const [id, job] of this.jobs) {
      if (job.ahead !== true || (project !== undefined && id !== project)) continue;
      job.cancelled = true;
      job.job?.cancel();
      if (job.ended !== undefined) ended.push(job.ended);
    }
    await Promise.all(ended);
  }

  /**
   * Starts making `project`'s export ahead into `output` (export_ahead.ts), when
   * nothing else wants this Mac's encoder: no export rendering or waiting, none
   * for this project, and room for it now. False when it didn't start.
   */
  startAhead(store: Store, library: seams.Library, project: Project, options: ExportOptions, output: string, watermark?: string): boolean {
    if (this.jobs.size > 0 || this.localQueue.length > 0 || this.ahead.length > 0) return false;
    if (capacity.noRoom(this.localActive) !== null) return false;
    const addon = native();
    const { plan, fps } = addon.exportPlan({ json: jsonForSerde(project) }, options);
    if (plan.end <= plan.start) return false;
    const folder = parent(output) ?? ".";
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch {
      return false;
    }
    if (roomFor(exportBytes(options, plan, options.fps ?? fps), store.cacheDir(), folder) !== null) return false;
    const edit = structuredClone(project);
    let finish!: () => void;
    const running: Running = {
      output, key: "", cancelled: false, job: null, snapshot: null, timeline: timelineHash(edit),
      options: withWatermarkKey(optionsKey(options), watermark), keepLocal: true, queued: false, ahead: true,
      ended: new Promise<void>((resolve) => { finish = resolve; }),
    };
    this.jobs.set(project.id, running);
    this.localActive++;
    this.aheadActive++;
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      this.aheadActive = Math.max(0, this.aheadActive - 1);
      this.releaseOne();
    };
    void (async () => {
      let marked = edit;
      if (watermark !== undefined) marked = await seams.channelMarks.addWatermark({ library }, store.cacheDir(), edit, plan, watermark);
      await this.run(store, library, marked, structuredClone(options), plan, output, running, false, release);
    })()
      .catch((error: unknown) => {
        diag.warn("export", `${project.name}: making its export ahead: ${diag.messageOf(error)}`);
        if (this.jobs.get(project.id) === running) this.jobs.delete(project.id);
      })
      .finally(() => {
        release();
        finish();
      });
    return true;
  }

  /**
   * A place for smooth playback's render, as an export has: now when the Mac
   * has room (`release` given back at once), else `ready` is called with it
   * once there is, before the exports waiting in line. With three exports
   * queued, the edit open on this Mac got no smooth playback for hours; now it
   * waits only for the export rendering, and on a Max or an Ultra it renders
   * beside them. `cancel` drops a wait.
   */
  takeTurn(ready: (release: () => void) => void): { release: (() => void) | null; cancel: () => void } {
    if (this.ahead.length === 0 && capacity.noRoom(this.localActive) === null) return { release: this.lend(), cancel: () => {} };
    // Someone is watching: an export made ahead gives its place up (it carries on later from its chunks).
    if (this.aheadActive > 0) void this.stopAhead();
    this.ahead.push(ready);
    this.drain();
    return { release: null, cancel: () => { this.ahead = this.ahead.filter((one) => one !== ready); } };
  }

  /** Takes a place for smooth playback; its release gives it back (once). */
  private lend(): () => void {
    this.localActive++;
    this.lent++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.lent = Math.max(0, this.lent - 1);
      this.releaseOne();
    };
  }

  activity(): ExportActivity[] {
    return [...this.recent.values()].map((one) => this.withPlace(one)).sort((a, b) => b.updated_ms - a.updated_ms);
  }

  /** A finished export says whether its file is still on this Mac, and where. Checked on each read, not stored: the archive may delete it after this was marked done. */
  private withPlace(job: ExportActivity): ExportActivity {
    if (job.state !== "done" || job.path === "") return { ...job };
    if (!isFile(job.path)) return { ...job, onDisk: false };
    return { ...job, onDisk: true, saved: homePath(job.path) };
  }

  private publish(store: Store, project: Project, running: Running, state: ExportActivity["state"], progress: number, extra: Record<string, unknown> = {}): void {
    const phase = typeof extra.phase === "string" && extra.phase !== "" ? extra.phase : undefined;
    const waiting = state === "queued" && typeof running.waiting === "string" && running.waiting !== "" ? running.waiting : undefined;
    const rest = { ...extra };
    delete rest.phase;
    this.recent.set(project.id, { id: project.id, name: project.name, path: running.output, state, progress, updated_ms: nowMs(), ...(typeof extra.error === "string" ? { error: extra.error } : {}), ...(running.note === undefined ? {} : { note: running.note }), ...(waiting !== undefined ? { waiting } : {}), ...(phase !== undefined ? { phase } : {}) });
    // Keep every active job and only the latest completed outcomes.
    const ended = [...this.recent.values()].filter(one => one.state !== "queued" && one.state !== "running").sort((a, b) => b.updated_ms - a.updated_ms);
    for (const old of ended.slice(20)) {
      this.recent.delete(old.id);
      this.held.delete(old.id);
    }
    // `waiting` rides the event too: the share chip reads it, and a queued publish used to leave it off.
    store.emit({ type: "export", id: project.id, state, progress, path: running.output, ...rest, ...(phase !== undefined ? { phase } : {}), ...(waiting !== undefined ? { waiting } : {}) });
  }

  /** Starts what waits in line while this Mac has room for another (export_capacity.ts). */
  private drain(): void {
    this.localQueue = this.localQueue.filter((one) => !one.running.cancelled);
    while (this.ahead.length > 0 || this.localQueue.length > 0) {
      const room = capacity.noRoom(this.localActive);
      if (room !== null && this.aheadActive > 0) {
        // An export made ahead holds the place something asked for wants: it gives it up, and its release drains again.
        void this.stopAhead();
        return;
      }
      if (room !== null) {
        // Only smooth playback's render holds the Mac: it's that they wait for.
        const why = this.lent > 0 && this.localActive === this.lent ? "waiting for smooth playback's render to finish" : room;
        // Said again as it changes (memory freed, the CPU less busy), not only when it was queued.
        for (const one of this.localQueue) {
          if (one.running.waiting === why) continue;
          one.running.waiting = why;
          one.notify();
        }
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
      const turn = this.ahead.shift();
      if (turn !== undefined) {
        turn(this.lend());
        continue;
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

  /** How `id`'s export was started, when that export failed or was cancelled and can be run again. */
  replay(id: string): { options: ExportOptions; output: string; extra: StartExtra } | null {
    const outcome = this.recent.get(id);
    const held = this.held.get(id);
    if (held === undefined || outcome === undefined || (outcome.state !== "failed" && outcome.state !== "cancelled")) return null;
    return { options: structuredClone(held.options), output: held.output, extra: { ...held.extra } };
  }

  /**
   * Starts exporting `project` as `options` ask; returns the file it will
   * write (`output` with the format's extension), rendered on this Mac. A
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
    // This project's export made ahead stops first (it writes the same chunk folder); what it made is reused.
    await this.stopAhead(project.id);
    const addon = native();
    const { plan, fps } = addon.exportPlan({ json: jsonForSerde(project) }, options);
    // The edit as it is, before a watermark goes over it: what this export is of (its hash and clip map).
    const edit = project;
    if (extra.watermark !== undefined) project = await seams.channelMarks.addWatermark({ library }, store.cacheDir(), project, plan, extra.watermark);
    let path = addon.withExtension(output, options.format);
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
    // Rendered here: refused up front when the disks can't hold it, never halfway (TODO, Oct 18: a 2h35m export
    // needed ~8 GB with 2.8 GB free).
    const short = roomFor(exportBytes(options, plan, options.fps ?? fps), store.cacheDir(), folder);
    if (short !== null) throw new Error(short);
    const whole = ["h264", "hevc", "prores"].includes(options.format) && plan.start === 0 && plan.end >= duration(project) && plan.end > 0;
    if (extra.drive === true && !whole) throw new Error("only a whole video export (MP4 or MOV) uploads to Drive");
    const already = this.jobs.get(project.id);
    if (already !== undefined) throw new Error(`this project already has an export running (into ${already.output.split("/").pop()}): wait for it (wait {for: ["export"]}) or cancel it`);
    if ([...this.jobs.values()].some(job => job.output === path)) throw new Error("another export is writing this output path");
    let snapshot: string | null = null;
    if (this.home !== null) {
      snapshot = snapshotFile(this.home, project.id);
      try {
        fs.mkdirSync(join(this.home, "jobs"), { recursive: true });
        // The edit, not the watermark over it: a restart puts that on again
        // (`watermark` below), so the export carried on is of the same edit,
        // with the same keys, and the share that asked for it follows it.
        writeAtomic(snapshot, jsonForSerde(edit));
      } catch (error) {
        throw new Error(`couldn't keep this export's timeline for a restart: ${ioMessage(error)}`);
      }
    }
    // Everything it was started with, so a restart carries it on as it was:
    // a share's export once came back without its share, and its next Share
    // exported the edit again (the audit, Nov 3).
    const args = {
      options, output: path,
      ...(extra.drive === undefined ? {} : { drive: extra.drive }), ...(snapshot === null ? {} : { snapshot }),
      ...(extra.keepLocal === true ? { keepLocal: true } : {}), ...(extra.share === true ? { share: true } : {}),
      ...(extra.note === undefined ? {} : { note: extra.note }), ...(extra.watermark === undefined ? {} : { watermark: extra.watermark }),
      ...(extra.replace === true ? { replace: true } : {}),
    };
    const key = jobs.begin(this.home, "export", project.id, args);
    // Own the snapshot in memory too: a caller changing its draft or options
    // after enqueueing must never change the export that was accepted.
    project = structuredClone(project);
    options = structuredClone(options);
    const running: Running = { output: path, key, cancelled: false, job: null, snapshot, timeline: timelineHash(edit), options: withWatermarkKey(optionsKey(options), extra.watermark), clips: clipMap(edit), keepLocal: extra.keepLocal === true, queued: true, ...(extra.share === true ? { share: true } : {}), ...(extra.note === undefined ? {} : { note: extra.note }) };
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
    running.cancelQueued = () => {
      this.localQueue = this.localQueue.filter(one => one.running !== running);
      this.publish(store, project, running, "cancelled", 0);
      this.jobs.delete(project.id);
      jobs.end(this.home, running.key);
      if (snapshot !== null) fs.rmSync(snapshot, { force: true });
    };
    this.held.set(project.id, {
      options,
      output: path,
      extra: {
        ...(extra.drive === undefined ? {} : { drive: extra.drive }),
        ...(extra.keepLocal === true ? { keepLocal: true } : {}),
        ...(extra.share === true ? { share: true } : {}),
        ...(extra.note === undefined ? {} : { note: extra.note }),
        ...(extra.watermark === undefined ? {} : { watermark: extra.watermark }),
        ...(extra.replace === true ? { replace: true } : {}),
      },
    });
    this.localQueue.push({ running, start: () => {
      void this.run(store, library, project, options, plan, path, running, upload, () => this.releaseOne()).catch((error: unknown) => {
        // Whatever went wrong after the render, the project is free to export again.
        diag.error("export", `${project.name}: ${diag.messageOf(error)}`);
        if (this.jobs.get(project.id) === running) this.jobs.delete(project.id);
        jobs.end(this.home, running.key);
      });
    }, notify: () => {
      if (running.queued && !running.cancelled) this.publish(store, project, running, "queued", 0);
    } });
    this.drain();
    if (running.queued) this.publish(store, project, running, "queued", 0);
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
    const quiet = running.ahead === true;
    // One made ahead says nothing to the page: nobody asked for it.
    const emit = (state: ExportActivity["state"], progress: number, extra: Record<string, unknown> = {}) => {
      if (!quiet) this.publish(store, project, running, state, progress, extra);
    };
    // Cutting excerpts, copying sound, and fetching the last export fill the first slice of the bar.
    // "preparing the footage" alone does not count: a local export, and a stills fetch, stay on the 0–1 bar.
    let prepared = false;
    let prepRatio = 0;
    const tell = (phase: string, ratio: number) => {
      prepared = true;
      prepRatio = Math.max(prepRatio, ratio);
      emit("running", shownProgress(prepRatio, null), { phase });
    };
    const onPrep = (phase: string, ratio: number) => {
      if (phase === "preparing the footage") {
        emit("running", shownProgress(prepared ? prepRatio : null, null), { phase });
        return;
      }
      // The last export's download, when there is one, takes the rest of the prep slice.
      tell(phase, ratio * 0.85);
    };
    emit("running", 0, { phase: "preparing the footage" });
    const started = performance.now();
    // A speed sample (`fresh_fps`): rendered here from the start, every frame new, never restarted.
    let fresh = !quiet && options.format === "h264" && nothingToReuse(store.cacheDir(), id);
    let result: { ok: true } | { ok: false; error: string };
    try {
      await catchBugsAsync("the export", async () => {
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
              [exported, originals] = await seams.cloudMedia.forExport(project, plan.start, plan.end, store.cacheDir(), () => running.cancelled, onPrep);
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
              if (attempt === 1) {
                let fetched = -1;
                restored = this.home === null ? null : await restorePrevious(store.cacheDir(), this.home, project.id, (key, dest) => cloud.download(key, dest, (got, size) => {
                  const ratio = size > 0 ? Math.min(1, Math.max(0, got / size)) : 0;
                  const pct = Math.round(ratio * 100);
                  if (pct === fetched) return;
                  fetched = pct;
                  tell(`fetching the last export, ${pct}%`, 0.85 + 0.15 * ratio);
                }));
              }
              // Prep is over. The encode fills from there to 1; leaving the ratio at the footage's 0.85 would end the bar at 97%.
              if (prepared) {
                prepRatio = 1;
                emit("running", shownProgress(1, null), { phase: "starting the export" });
              } else emit("running", 0, { phase: "starting the export" });
              let moved = performance.now();
              let last = -1;
              const job = native().ExportJob.start(
                { project: { json: jsonForSerde(exported) }, options, plan, output, cacheDir: store.cacheDir(), sounds: originals?.sounds ?? {}, excerpts: originals?.excerpts ?? [], ...(quiet ? { background: true } : {}) },
                (progress) => {
                  // Any change is movement: the engine trying its chunks again reports from lower down (Nov 2:
                  // Kroger's retry rendered 11 chunks yet "nothing new for 8 minutes", and was started over).
                  if (progress !== last) {
                    last = progress;
                    moved = performance.now();
                  }
                  try {
                    // No phase: the line goes back to the percent, and a stale "cutting the footage" doesn't stick.
                    emit("running", shownProgress(prepared ? 1 : null, progress));
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
      if (!quiet) {
        this.finished = this.finished.filter((done) => done !== output);
        this.finished.push(output);
        this.finished.splice(0, Math.max(this.finished.length - KEEP_FINISHED, 0));
      }
      result = { ok: true };
    } catch (error) {
      result = { ok: false, error: diag.messageOf(error) };
    } finally {
      // Archiving/uploading a completed file doesn't occupy the renderer.
      releaseLocal?.();
    }
    const frames = Math.max(plan.end - plan.start, 0);
    const took = performance.now() - started;
    if (quiet) {
      // Made ahead: its chunks wait in the project's chunk folder (its manifest names this file) for the export someone asks for.
      if (result.ok) {
        diag.info("export", `${project.name}: made its export ahead, ${frames} frames in ${diag.human(took)}, for the next export or share to reuse`);
        try {
          writeAtomic(`${output}.json`, JSON.stringify({ timeline: running.timeline, options: running.options, made_ms: nowMs() }));
        } catch (error) {
          diag.warn("export", `${project.name}: noting its export made ahead: ${diag.messageOf(error)}`);
        }
      } else if (!running.cancelled) {
        diag.warn("export", `${project.name}: making its export ahead: ${result.error}`);
      }
      if (this.jobs.get(id) === running) this.jobs.delete(id);
      return;
    }
    // Asked for and made: one made ahead of this project's is spent (this export's manifest is the one now).
    if (result.ok) aheadSpent(store.cacheDir(), id, output);
    if (result.ok) {
      diag.info(
        "export",
        `${project.name} exported ${frames} frames in ${diag.human(took)} (${fixed(frames / Math.max(took / 1000, 1e-3), 1)} frames/s) to ${output}`,
      );
      diag.record("export", "export", took, null);
      let bytes: number | null = null;
      try {
        bytes = fs.statSync(output).size;
      } catch {
        // Gone already.
      }
      emit("done", 1, { seconds: (performance.now() - started) / 1000, bytes, drive: upload });
      this.held.delete(id);
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
        });
        fs.mkdirSync(join(this.home ?? store.home, "export-maps"), { recursive: true });
        writeAtomic(mapFile(this.home ?? store.home, running.timeline), JSON.stringify(running.clips ?? clipMap(project)));
      } catch (error) {
        diag.warn("export", `couldn't list ${output}: ${diag.messageOf(error)}`);
      }
      // Cloud is canonical: upload, verify by size, then delete the local
      // file. Skipped when Drive will read the file next, or on request.
      if (!upload && !running.keepLocal && exportCloud.enabled()) {
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
        } catch (error) {
          // The export itself is done; a failed archive must never leave the project "exporting" until a restart.
          diag.warn("export", `${id}: archiving ${output}: ${diag.messageOf(error)}`);
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
