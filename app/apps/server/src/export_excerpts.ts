// Exports read cloud footage from excerpts on this Mac, never over HTTPS
// (off Modal, step 2; Sphe, Nov 2: Edit moves off Modal onto the team's Macs).
//
// An export of a cloud edit read every original through a presigned URL, one
// FFmpeg process per clip, each restart paying R2's ~0.25–0.5 s from South
// Africa: Kroger (148k frames, 414 video clips, 63 originals) took 65 minutes
// on this M1. So before it renders, every stretch of an original the timeline
// shows is cut into a local file, picture copied (never re-encoded), and the
// engine reads those with AVFoundation (crates/edit-engine/src/excerpts.rs).
//
// Stretches are cells of 30 s of the original (`CELL`), the same cells
// whatever the edit, so a re-export and another project using the same
// footage find the same ones, kept in the cache beside the other copies of R2
// objects (`cloud/excerpts/<original without edit/>/cells-30-<fps>/<n>.<ext>`,
// evicted by project like them, never while an export reads them: `pinned`).
// A cell begins on the original's frame grid (frame ⌊30·n·fps⌋), and FFmpeg's
// stream copy writes an edit list so the excerpt's time 0 is that moment
// exactly; AVFoundation and FFmpeg both honour it (render.rs's tests: B-frames,
// a cut off a keyframe, a GOP longer than a cell at 29.97 fps). A cell that
// can't be cut or reads back wrong is left out, and the engine reads that
// stretch from the URL as before; the last cell of an original reaches on
// past its end (`TO_THE_END`).
//
// Not in R2 yet (Nov 2): cutting Kroger's 239 cells took 69 s, and uploading
// them from South Africa would take longer than that and use the uplink that
// footage uploads and exports need, every project. The key is R2-shaped
// (`cellKey`) so they can be shared once uplink isn't the bottleneck.

import * as fs from "node:fs";

import { localPath, scratchDir } from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { Semaphore } from "./media.ts";
import type { Media, Project } from "./model.ts";
import type { ExportExcerpt } from "./native/index.ts";
import { extension, isFile, join } from "./paths.ts";
import * as tools from "./tools.ts";

/** Seconds of the original in one excerpt. */
export const CELL = 30;
/**
 * Where an excerpt that reaches its original's end reaches (seconds): every
 * later time, the reader holding the last picture there, as a reader of the
 * original does. Asked a hair past the last cut's end, the cloud URL was read
 * by a reader with nothing decoded yet, which failed the export (Nov 2,
 * Kroger, frame ~72,000, twice: "could not decode <url>: failed to fill
 * whole buffer").
 */
export const TO_THE_END = 1e9;
/** Seconds kept either side of what a clip shows (a frame rounded the other way). */
const PAD = 0.5;
/** Excerpts fetched or cut at once. */
const AT_ONCE = 6;
/** How often a cut in progress looks whether its export was cancelled (ms). */
const CANCEL_LOOK_MS = 250;

/** One cell of one original an export needs. */
export interface Cell {
  media: string;
  /** Its index: seconds `CELL·index` on. */
  index: number;
  /** Seconds of the original where the excerpt's time 0 is (on its frame grid). */
  from: number;
  /** Seconds of the original it reaches. */
  to: number;
  /** The first timeline frame showing it: cells are made in the order they're shown. */
  first: number;
}

/** A container that holds the original's picture as it is, or null (that footage is read from its URL). */
function containerOf(original: string): string | null {
  const ext = (extension(original) ?? "").toLowerCase();
  if (ext === "mov") return "mov";
  if (ext === "mp4" || ext === "m4v") return "mp4";
  return null;
}

/** The R2 key of `cell` of `original` (a key under `edit/`). */
export function cellKey(original: string, fps: number, index: number): string | null {
  const container = containerOf(original);
  if (container === null) return null;
  const rest = original.startsWith("edit/") ? original.slice("edit/".length) : original;
  return `edit/excerpts/${rest}/cells-${CELL}-${fps.toFixed(3)}/${index}.${container}`;
}

/** Where cell `index` of footage at `fps`, `duration` seconds long, begins and ends. */
export function cellSpan(index: number, fps: number, duration: number): { from: number; to: number } {
  const rate = fps > 0 ? fps : 30;
  const from = Math.floor(index * CELL * rate + 1e-6) / rate;
  const to = Math.min((index + 1) * CELL, duration > 0 ? duration : Number.POSITIVE_INFINITY);
  return { from, to };
}

/**
 * The cells of each of `media` (ids) that frames `start..end` of `project`
 * show, in the order they're first shown.
 */
export function cellsOf(project: Project, start: number, end: number, media: Set<string>): Cell[] {
  const fps = project.settings.fps > 0 ? project.settings.fps : 30;
  const found = new Map<string, Cell>();
  for (const clip of project.clips) {
    if (clip.type !== "video" || !media.has(clip.media)) continue;
    const from = Math.max(clip.start, start);
    const to = Math.min(clip.start + clip.duration, end);
    if (to <= from) continue;
    const item = project.media.find((one) => one.id === clip.media);
    if (item === undefined || item.kind !== "video") continue;
    const speed = clip.speed ?? 1;
    const at = (frame: number) => (clip.source_in ?? 0) + ((frame - clip.start) / fps) * speed;
    const [a, b] = [at(from), at(to)];
    const lo = Math.max(Math.min(a, b) - PAD, 0);
    const hi = Math.min(Math.max(a, b) + PAD, item.duration > 0 ? item.duration : Number.POSITIVE_INFINITY);
    for (let index = Math.floor(lo / CELL); index <= Math.floor(hi / CELL); index++) {
      const id = `${clip.media}#${index}`;
      const known = found.get(id);
      if (known !== undefined) {
        known.first = Math.min(known.first, from);
        continue;
      }
      const span = cellSpan(index, item.fps, item.duration);
      if (span.to <= span.from) continue;
      found.set(id, { media: clip.media, index, ...span, first: from });
    }
  }
  return [...found.values()].sort((a, b) => a.first - b.first || a.media.localeCompare(b.media) || a.index - b.index);
}

/**
 * How many seconds of picture `path` holds, or why it can't be used: it must
 * read back, and not run past the cell (its copy runs on to the end of its
 * last frame, and the edit list may add one). Shorter is fine (footage that
 * ends sooner than its project says): the engine reads past its end from the
 * cloud.
 */
async function lengthOf(path: string, seconds: number): Promise<number | string> {
  let text = "";
  try {
    text = new TextDecoder().decode(await tools.run([tools.ffprobe(), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { timeoutMs: 60_000 }));
  } catch (error) {
    return `it can't be read back (${diag.messageOf(error)})`;
  }
  const got = Number(text.trim());
  if (!Number.isFinite(got) || got <= 0) return "it can't be read back";
  if (got > seconds + 1.5) return `it runs ${got.toFixed(1)} s, not ${seconds.toFixed(1)} s`;
  return got;
}

/** Cuts seconds `from..to` of `url`'s picture into `out`, copied; `signal` ends FFmpeg. */
async function cut(url: string, from: number, to: number, out: string, signal: AbortSignal): Promise<void> {
  await tools.run(
    [
      tools.ffmpeg(),
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-ss",
      from.toFixed(6),
      "-protocol_whitelist",
      tools.protocols(url),
      ...tools.urlArgs(url),
      "-i",
      url,
      "-t",
      (to - from).toFixed(6),
      "-map",
      "0:v:0",
      "-c:v",
      "copy",
      "-an",
      "-sn",
      "-dn",
      out,
    ],
    { timeoutMs: 20 * 60_000, signal },
  );
}

/** Excerpts an export is reading (path → how many): the cache's cleaner leaves them (cache_cleanup.ts). */
const reading = new Map<string, number>();

/** Whether an export is reading `path` now. */
export function pinned(path: string): boolean {
  return (reading.get(path) ?? 0) > 0;
}

/** Holds `paths` against the cleaner until the returned function is called (once the export is done with them). */
export function pin(paths: string[]): () => void {
  for (const path of paths) reading.set(path, (reading.get(path) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const path of paths) {
      const left = (reading.get(path) ?? 1) - 1;
      if (left > 0) reading.set(path, left);
      else reading.delete(path);
    }
  };
}

/** One cell as a local file and the seconds it holds: this Mac's copy, or cut now from `url`. Null when it can't be had. */
async function cellFile(cache: string, key: string, url: string, cell: Cell, signal: AbortSignal): Promise<{ path: string; seconds: number; how: "here" | "cut" } | null> {
  const local = localPath(cache, key);
  const wanted = cell.to - cell.from;
  if (isFile(local)) {
    // Touched: the cleaner keeps what's used longest.
    const now = new Date();
    try {
      fs.utimesSync(local, now, now);
    } catch {
      // Read-only: kept as it is.
    }
    const seconds = await lengthOf(local, wanted);
    if (typeof seconds === "number") return { path: local, seconds, how: "here" };
    diag.warn("export", `the excerpt ${key} here won't do (${seconds}); cut again`);
    fs.rmSync(local, { force: true });
  }
  const scratch = join(scratchDir(cache), `cell-${process.pid}-${crypto.randomUUID().slice(0, 8)}.${extension(key) ?? "mp4"}`);
  try {
    await cut(url, cell.from, cell.to, scratch, signal);
    const seconds = await lengthOf(scratch, wanted);
    if (typeof seconds === "string") {
      diag.warn("export", `an excerpt of ${key} came out wrong (${seconds}); that stretch is read from the cloud`);
      return null;
    }
    fs.mkdirSync(local.slice(0, local.lastIndexOf("/")), { recursive: true });
    fs.renameSync(scratch, local);
    return { path: local, seconds, how: "cut" };
  } catch (error) {
    if (signal.aborted) return null;
    diag.warn("export", `cutting an excerpt of ${key}: ${diag.scrub(diag.messageOf(error))}; that stretch is read from the cloud`);
    return null;
  } finally {
    fs.rmSync(scratch, { force: true });
  }
}

/**
 * Local excerpts of the cloud originals frames `start..end` of `project`
 * show: `urls` are the media read from the cloud (media id → presigned URL
 * of its original, `originals` → its key). Cells in timeline order,
 * `AT_ONCE` at a time; `cancelled` stops it between cells.
 */
export async function prepare(
  project: Project,
  start: number,
  end: number,
  cache: string,
  urls: Map<string, string>,
  originals: Map<string, string>,
  cancelled: () => boolean = () => false,
): Promise<ExportExcerpt[]> {
  const cells = cellsOf(project, start, end, new Set(urls.keys()));
  if (cells.length === 0) return [];
  const began = performance.now();
  const slots = new Semaphore(AT_ONCE);
  const counts = { here: 0, cut: 0, failed: 0 };
  // A cancel ends the cuts under way, not just the ones not started.
  const stop = new AbortController();
  const watch = setInterval(() => {
    if (cancelled()) stop.abort();
  }, CANCEL_LOOK_MS);
  const media = new Map<string, Media>(project.media.map((item) => [item.id, item]));
  let made: (ExportExcerpt | null)[];
  try {
    made = await Promise.all(
      cells.map(async (cell): Promise<ExportExcerpt | null> => {
        const url = urls.get(cell.media);
        const original = originals.get(cell.media);
        const item = media.get(cell.media);
        if (url === undefined || original === undefined || item === undefined) return null;
        const key = cellKey(original, item.fps, cell.index);
        if (key === null) return null;
        const release = await slots.acquire();
        try {
          if (cancelled() || stop.signal.aborted) return null;
          const file = await cellFile(cache, key, url, cell, stop.signal);
          if (file === null) {
            counts.failed += 1;
            return null;
          }
          // Up to the next cell's start (a stream copy runs to its last frame's end), and on for good from the original's last.
          const last = item.duration <= 0 || cell.to >= item.duration - 0.5;
          // Short anywhere but at the end: a cut that stopped part-way (it would show its last picture for the rest).
          if (!last && file.seconds < cell.to - cell.from - 0.5) {
            diag.warn("export", `the excerpt ${key} holds ${file.seconds.toFixed(1)} s of ${(cell.to - cell.from).toFixed(1)}; that stretch is read from the cloud`);
            fs.rmSync(file.path, { force: true });
            counts.failed += 1;
            return null;
          }
          counts[file.how] += 1;
          return { object: url.split("?")[0] ?? url, from: cell.from, to: last ? TO_THE_END : cell.to, path: file.path };
        } finally {
          release();
        }
      }),
    );
  } finally {
    clearInterval(watch);
  }
  if (stop.signal.aborted || cancelled()) throw new Error("cancelled");
  const excerpts = made.filter((one): one is ExportExcerpt => one !== null);
  diag.info(
    "export",
    `${project.id}: ${excerpts.length} of ${cells.length} excerpts of ${urls.size} cloud originals ready in ${diag.human(performance.now() - began)} (${counts.here} here, ${counts.cut} cut now${counts.failed > 0 ? `, ${counts.failed} read from the cloud instead` : ""})`,
  );
  return excerpts;
}
