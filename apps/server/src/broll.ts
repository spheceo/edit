// What cut-ins are made of (broll.rs): B-roll picked from the source footage
// (looked through and read, not just the timeline), slowed down smoothly,
// stills turned into footage, and 3D map views of the places a story happens,
// from Google's photorealistic 3D map drawn in the local Chrome.
//
// The files it makes are named by `fingerprint` (hash.ts, Rust's
// DefaultHasher), so those already on disk are found again.

import * as fs from "node:fs";
import * as os from "node:os";

import type { App } from "./app.ts";
import { parseTranscript } from "./captions_core.ts";
import * as diag from "./diag.ts";
import { copyFile, ioMessage } from "./files.ts";
import { debugModified, fingerprint } from "./hash.ts";
import { importPaths } from "./import.ts";
import { backgroundSlots, probe as probeFile, Semaphore } from "./media.ts";
import type { Clip, Media, Probe, Project, VideoClip } from "./model.ts";
import { canonical, fileName, fileStem, isFile, join, withExtension } from "./paths.ts";
import { clipMedia, clipOf, fps as fpsOf, freshId, mediaOf } from "./project.ts";
import * as relay from "./relay.ts";
import { compareStrings, display, fixed, round, serdeParse, toI64, trim } from "./rust.ts";
import * as seams from "./seams.ts";
import { stableStringify } from "./stable.ts";
import * as tools from "./tools.ts";
import type { Transcript } from "./transcribe.ts";
import mapPageText from "./map_page.html" with { type: "text" };

/**
 * The map page: Google's Photorealistic 3D Tiles (through the relay, which
 * holds the key) drawn by CesiumJS, graded darker with a vignette and the
 * place marked in glowing red. When the tiles are in, it posts the picture
 * back to its own address. (Bun types an .html import as a bundle; as text it's the file.)
 */
export const MAP_PAGE = mapPageText as unknown as string;

/** Identifies Edit to the services it calls. */
const USER_AGENT = "edit-video-editor/0.1 (+https://github.com/spheceo/edit)";

/** Seconds of footage a still becomes: room to hold it, push in and trim. */
const STILL_SECONDS = 30;

/** How long things take (tests shorten the waits). */
export const timing = {
  sleep: (ms: number) => Bun.sleep(ms),
  now: () => performance.now(),
  /** Optical flow gives up after this. */
  smoothLimitMs: 120_000,
  /** How long map_view waits for a moving shot's first frame and building track before answering that it's still loading. */
  mapReadyWaitMs: 180_000,
  /** How long a map page may take: a moving shot waits on tiles for every frame. */
  mapRenderLimitMs: (frames: number) => (150 + 2 * frames) * 1000,
};

type Json = unknown;

/** Runs FFmpeg to the end; its exit status and stderr. */
async function ffmpeg(args: string[], timeoutMs: number | null = null): Promise<{ ok: boolean; stderr: string; timedOut: boolean }> {
  let child: Bun.Subprocess<"ignore", "ignore", "pipe">;
  try {
    child = Bun.spawn([tools.ffmpeg(), ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  } catch (error) {
    throw new Error(`ffmpeg: ${diag.messageOf(error)}`);
  }
  let timedOut = false;
  const timer =
    timeoutMs === null
      ? null
      : setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs);
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (timer !== null) clearTimeout(timer);
  return { ok: code === 0 && !timedOut, stderr, timedOut };
}

/**
 * A still as 30 s of steady 30 fps footage (even-sized, high quality), so it
 * plays, scales, grades and exports like any clip. Made once per image.
 */
export async function stillVideo(image: string, dir: string): Promise<string> {
  let meta: fs.BigIntStats;
  try {
    meta = fs.statSync(image, { bigint: true });
  } catch (error) {
    throw new Error(`${image}: ${ioMessage(error)}`);
  }
  const stem = fileStem(image) ?? "still";
  const key = fingerprint([image, meta.size.toString(), debugModified(meta.mtimeNs)]);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new Error(`${dir}: ${ioMessage(error)}`);
  }
  const out = join(dir, `${stem}-${key}.mp4`);
  if (isFile(out)) return out;
  const partial = join(dir, `${stem}-${key}.partial.mp4`);
  const made = await ffmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-loop",
    "1",
    "-framerate",
    "30",
    "-i",
    image,
    "-t",
    String(STILL_SECONDS),
    "-vf",
    "scale='min(3840,trunc(iw/2)*2)':-2:flags=lanczos,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "12",
    "-tune",
    "stillimage",
    "-r",
    "30",
    "-an",
    "-movflags",
    "+faststart",
    partial,
  ]);
  if (!made.ok) {
    fs.rmSync(partial, { force: true });
    throw new Error(`couldn't turn ${image} into footage: ${trim(made.stderr)}`);
  }
  try {
    fs.renameSync(partial, out);
  } catch (error) {
    throw new Error(ioMessage(error));
  }
  return out;
}

/** A media file's words, transcribing it first if needed. */
export async function transcript(app: App, media: Media): Promise<Transcript> {
  if (!media.has_audio) throw new Error(`${media.name} has no sound`);
  const path = media.path;
  app.media.transcribe(path, true);
  const started = timing.now();
  for (;;) {
    const status = app.media.status(path);
    if (status.transcript === "ready") {
      let text: string;
      try {
        text = fs.readFileSync(app.media.paths(path).transcript, "utf8");
      } catch (error) {
        throw new Error(ioMessage(error));
      }
      return parseTranscript(text);
    }
    if (status.transcript === "failed") {
      throw new Error(`couldn't transcribe ${media.name}: ${status.transcript_error ?? ""}`);
    }
    if (timing.now() - started > 15 * 60 * 1000) throw new Error(`transcribing ${media.name} is taking too long`);
    await timing.sleep(2000);
  }
}

/**
 * What's said in a media file between `from` and `to` (its own seconds), as
 * phrases with their times and who says them, or word by word (`words`) for
 * timing something to an exact word.
 */
export async function mediaTranscript(app: App, media: Media, from: number, to: number, words: boolean): Promise<string> {
  const said = await transcript(app, media);
  const inSpan = said.words.filter((word) => word.start >= from && word.start < to);
  const nothing = () => `nothing is said in ${media.name} between ${fixed(from, 1)}s and ${fixed(to, 1)}s`;
  if (words) {
    const out = inSpan.map((word) => `${fixed(word.start, 2)}–${fixed(word.end, 2)} ${word.text}`);
    return out.length === 0 ? nothing() : out.join("\n");
  }
  let out = "";
  let phrase: { start: number; speaker: string | null; words: string; end: number } | null = null;
  const flush = () => {
    if (phrase !== null) {
      const who = phrase.speaker === null ? "" : ` (${phrase.speaker})`;
      out += `[${fixed(phrase.start, 2)}–${fixed(phrase.end, 2)}s]${who} ${phrase.words}\n`;
      phrase = null;
    }
  };
  for (const word of inSpan) {
    const voice = word.speaker ?? null;
    const speaker = voice === null ? null : (said.speakers !== undefined && Object.hasOwn(said.speakers, voice) ? said.speakers[voice]! : voice);
    const current = phrase as { start: number; speaker: string | null; words: string; end: number } | null;
    const breaks = current === null || word.start - current.end > 0.8 || current.speaker !== speaker;
    if (breaks) {
      flush();
      phrase = { start: word.start, speaker, words: word.text, end: word.end };
    } else if (current !== null) {
      current.words += ` ${word.text}`;
      current.end = word.end;
    }
  }
  flush();
  return out === "" ? nothing() : out;
}

// ---------------------------------------------------------------------------
// Smooth slow motion

/** What a smoothing render was made from: media, in point and speed (a clip's position, scale or keyframes can change meanwhile). */
function sourceOf(clip: Clip): string | null {
  return clip.type === "video" ? JSON.stringify([clip.media, clip.source_in, clip.speed]) : null;
}

/**
 * Optical flow is optional and uses one shared background slot. Serializing
 * it also prevents duplicate requests from writing the same cached file.
 */
const smoothingSlots = new Semaphore(1);

/** Clips being smoothed in the background, by project. */
const smoothing = new Map<string, Set<string>>();

/** A cloud project's new media goes up in the background (cloud_media `backfill_soon`, which does nothing for other projects). */
function backfillSoon(app: App, projectId: string): void {
  if (!relay.cloudEnabled()) return;
  try {
    seams.cloudMedia.backfillSoon(app, projectId);
  } catch (error) {
    diag.warn("cloud", `backfill ${projectId}: ${diag.messageOf(error)}`);
  }
}

/**
 * Slows a slowed clip smoothly: the stretch of its media it plays is rendered
 * at its speed with new frames made between the real ones (motion
 * interpolation, like After Effects' pixel-motion frame blending), and the
 * clip plays that at normal speed. Same timing, no stutter.
 */
export async function smoothSlowMotion(app: App, projectId: string, clipId: string): Promise<Json> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const project = live.project;
  const found = clipOf(project, clipId);
  if (found === undefined) throw new Error(`no clip ${clipId}`);
  const clip = structuredClone(found) as Clip;
  if (clip.type !== "video") throw new Error("only video clips can be slowed smoothly");
  const speed = clip.speed;
  if (speed >= 0.999) throw new Error(`${clipId} plays at ${display(speed)}×; slow it first (speed below 1, e.g. 0.5)`);
  const source = mediaOf(project, clip.media);
  if (source === undefined) throw new Error("the clip's media is missing");
  const fps = fpsOf(project);
  // Interpolation loses a few frames at the ends: render a little more than
  // the clip plays, so the result always covers it at 1×.
  const length = (clip.duration / fps + 0.25) * speed;
  const dir = join(app.store.uploadsDir(projectId), "smooth");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new Error(ioMessage(error));
  }
  const stem = fileStem(source.name) ?? "clip";
  const key = fingerprint([
    "bounded-optical-flow-v2",
    app.native.mediaKey(source.path),
    `${project.settings.width}x${project.settings.height}`,
    // Named as its cache key names it, so a move to the media drive keeps it.
    app.store.layout().keyPath(source.path),
    fixed(clip.source_in, 4),
    fixed(length, 4),
    fixed(speed, 4),
    display(fps),
  ]);
  const out = join(dir, `${stem}-${fixed(speed, 2)}x-${key}.mp4`);
  if (!isFile(out)) {
    // A few renders at a time (see `smoothingSlots`); the rest wait their turn.
    const slot = await smoothingSlots.acquire();
    try {
      const work = await backgroundSlots.acquire();
      try {
        const partial = join(dir, `${stem}-${key}.partial.mp4`);
        // Never two renders into one file: a second ask waits for the first.
        if (isFile(out)) return await swapInSmooth(app, projectId, clip, out, fps);
        // A queued request may already be obsolete. Do not spend minutes on it.
        const now = app.store.get(projectId);
        if (now === null) throw new Error("project vanished");
        const current = clipOf(now.project, clipId);
        if (current === undefined) throw new Error("clip was removed before smoothing");
        if (sourceOf(current) !== sourceOf(clip) || current.duration > clip.duration) {
          throw new Error(`${clipId} changed before smoothing started; skipped`);
        }
        const { width, height } = project.settings;
        const filter = `scale=w='min(${width},iw)':h='min(${height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setpts=PTS/${fixed(speed, 6)},minterpolate=fps=${display(fps)}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,format=yuv420p`;
        const made = await ffmpeg(
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-threads",
            "2",
            "-filter_threads",
            "1",
            "-ss",
            fixed(clip.source_in, 4),
            "-t",
            fixed(length, 4),
            "-i",
            source.path,
            "-an",
            "-vf",
            filter,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "15",
            "-threads",
            "2",
            "-movflags",
            "+faststart",
            partial,
          ],
          timing.smoothLimitMs,
        );
        if (made.timedOut) {
          fs.rmSync(partial, { force: true });
          throw new Error("optical flow exceeded 120 seconds; kept the original slowed clip");
        }
        if (!made.ok) {
          fs.rmSync(partial, { force: true });
          throw new Error(`couldn't slow it smoothly: ${trim(made.stderr)}`);
        }
        try {
          fs.renameSync(partial, out);
        } catch (error) {
          throw new Error(ioMessage(error));
        }
      } finally {
        work();
      }
    } finally {
      slot();
    }
  }
  return swapInSmooth(app, projectId, clip, out, fps);
}

/**
 * Puts a smoothed render in place of the slowed stretch it was made from,
 * unless the clip has changed since (re-trimmed, re-timed, other media): the
 * render no longer matches it then, and it must be smoothed again.
 */
async function swapInSmooth(app: App, projectId: string, rendered: Clip, out: string, fps: number): Promise<Json> {
  const changed = () => new Error(`${rendered.id} changed while smoothing; kept the current clip`);
  const before = app.store.get(projectId);
  if (before === null) throw new Error("project vanished");
  const now = clipOf(before.project, rendered.id);
  if (now === undefined) throw new Error("the clip went away");
  if (sourceOf(now) !== sourceOf(rendered) || now.duration > rendered.duration) throw changed();
  const probe = await probeFile(out);
  const [, done] = await app.store.update(projectId, "agent", (project) => {
    const clip = clipOf(project, rendered.id);
    if (clip === undefined) throw new Error("the clip went away");
    if (sourceOf(clip) !== sourceOf(rendered) || clip.duration > rendered.duration) throw changed();
    let smooth = project.media.find((media) => media.path === out)?.id;
    if (smooth === undefined) {
      smooth = freshId(project, "m");
      project.media.push({
        id: smooth,
        name: fileName(out) ?? "",
        path: out,
        kind: probe.kind,
        duration: probe.duration,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        has_audio: probe.has_audio,
      });
    }
    const video = clip as VideoClip;
    video.media = smooth;
    video.source_in = 0.0;
    video.speed = 1.0;
    return { clip: rendered.id, media: smooth, seconds: clip.duration / fps };
  });
  app.media.ensure(out, probe);
  // A cloud project's copy of it goes up in the background.
  backfillSoon(app, projectId);
  return done;
}

/**
 * The clips of a project still being smoothed in the background. Map shots
 * still rendering (and any whose render failed) come after them, by media:
 * "m7 (map view rendering)".
 */
export function smoothingPending(projectId: string): string[] {
  const pending = [...(smoothing.get(projectId) ?? [])].sort(compareStrings);
  const maps = [...(mapsPending.get(projectId)?.values() ?? [])]
    .map((map) =>
      map.error === null
        ? `${map.media} (map view rendering)`
        : `${map.media} (map view failed: ${map.error}; map_view again with the same arguments carries on from its frames)`,
    )
    .sort(compareStrings);
  return [...pending, ...maps];
}

/**
 * Smooths slowed clips without waiting: each swaps in when its render is
 * done (a few render at once). A clip already being smoothed is left to it.
 * Returns the clips started.
 */
export function smoothInBackground(app: App, projectId: string, clipIds: string[]): string[] {
  const started: string[] = [];
  for (const clipId of clipIds) {
    let clips = smoothing.get(projectId);
    if (clips === undefined) {
      clips = new Set();
      smoothing.set(projectId, clips);
    }
    if (clips.has(clipId)) continue;
    clips.add(clipId);
    started.push(clipId);
    void (async () => {
      try {
        await diag.timeAsync("agent", "smooth slow motion (background)", () => smoothSlowMotion(app, projectId, clipId));
      } catch (error) {
        diag.warn("agent", `smoothing ${clipId} in ${projectId}: ${diag.messageOf(error)}`);
      }
      const pending = smoothing.get(projectId);
      if (pending !== undefined) {
        pending.delete(clipId);
        if (pending.size === 0) smoothing.delete(projectId);
      }
    })();
  }
  return started;
}

/**
 * Waits (up to `limit`) until a project's background smoothing is done, so
 * an export renders the smooth shots. Returns false if it timed out.
 */
export async function waitForSmoothing(projectId: string, limitMs: number): Promise<boolean> {
  const started = timing.now();
  const busy = () => (smoothing.get(projectId)?.size ?? 0) > 0 || mapsRendering(projectId);
  while (busy()) {
    if (timing.now() - started > limitMs) return false;
    await timing.sleep(500);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Map views

/** A URL's answer as text (curl -sS --max-time 30, so any status's body). */
async function fetchText(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    return await response.text();
  } catch (error) {
    throw new Error(`couldn't reach ${url.split("?")[0] ?? url}: ${diag.messageOf(error)}`);
  }
}

/**
 * Where a place is, from Google's geocoding through the relay (only Google's
 * may be shown with its tiles): lat, lon and its full address.
 */
async function geocode(place: string): Promise<[number, number, string]> {
  const url = `${relay.url()}/v1/geocode?address=${urlencode(place)}`;
  let found: Record<string, unknown>;
  try {
    found = serdeParse(await fetchText(url)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`unexpected answer from the map search: ${error.message}`);
    throw error;
  }
  const status = typeof found?.status === "string" ? found.status : null;
  if (status === "ZERO_RESULTS") throw new Error(`couldn't find "${place}" on the map; try a fuller address`);
  if (status !== "OK") {
    const said = [found?.error_message, found?.error, status].find((value) => typeof value === "string") as string | undefined;
    throw new Error(`the map search failed: ${said ?? "no answer"}`);
  }
  const first = (Array.isArray(found.results) ? found.results[0] : null) as Record<string, unknown> | null | undefined;
  const location = ((first?.geometry as Record<string, unknown> | undefined)?.location ?? null) as Record<string, unknown> | null;
  const lat = location?.lat;
  const lng = location?.lng;
  if (typeof lat !== "number") throw new Error("no latitude");
  if (typeof lng !== "number") throw new Error("no longitude");
  return [lat, lng, typeof first?.formatted_address === "string" ? first.formatted_address : place];
}

/** The outline (lon, lat ring) of the building at a point, from Google. */
async function buildingOutline(lat: number, lon: number): Promise<[number, number][] | null> {
  try {
    const url = `${relay.url()}/v1/outline?lat=${display(lat)}&lon=${display(lon)}`;
    return outlineIn(serdeParse(await fetchText(url)));
  } catch {
    return null;
  }
}

/**
 * The first building's outer ring in a destinations answer: the place
 * itself if it is a building, else the building that holds it.
 */
export function outlineIn(found: unknown): [number, number][] | null {
  const destinations = (found as { destinations?: unknown } | null)?.destinations;
  if (!Array.isArray(destinations) || destinations.length === 0) return null;
  const destination = destinations[0] as Record<string, unknown> | null;
  const containing = destination?.containingPlaces;
  const places = [destination?.primary, ...(Array.isArray(containing) ? containing : [])];
  for (const place of places as (Record<string, unknown> | null | undefined)[]) {
    if (place?.structureType !== "BUILDING") continue;
    const polygon = place.displayPolygon as Record<string, unknown> | undefined;
    const coordinates = polygon?.coordinates as unknown[] | undefined;
    let ring: unknown;
    if (polygon?.type === "Polygon") ring = Array.isArray(coordinates) ? coordinates[0] : undefined;
    else if (polygon?.type === "MultiPolygon") {
      const first = Array.isArray(coordinates) ? coordinates[0] : undefined;
      ring = Array.isArray(first) ? first[0] : undefined;
    } else continue;
    if (!Array.isArray(ring)) continue;
    const points: [number, number][] = [];
    for (const point of ring as unknown[]) {
      if (Array.isArray(point) && typeof point[0] === "number" && typeof point[1] === "number") points.push([point[0], point[1]]);
    }
    if (points.length >= 4) return points;
  }
  return null;
}

/** A place for the map search's query: unreserved bytes as they are, spaces as +, the rest %XX. */
export function urlencode(text: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(text)) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(char)) out += char;
    else if (byte === 0x20) out += "+";
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

const CHROMES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** Chrome on this machine, if any. */
export function chrome(): string | null {
  return CHROMES.find((path) => isFile(path)) ?? null;
}

/** Where this server answers (main sets it once it's listening); map pages open in Chrome against it. */
let listening: { host: string; port: number } | null = null;

/** Tells map renders where the server listens (`0.0.0.0` / `::` are reached as 127.0.0.1). */
export function setListening(host: string, port: number): void {
  listening = { host, port };
}

function pageHost(app: App): string {
  const address = listening ?? { host: "127.0.0.1", port: app.port };
  const host =
    address.host === "0.0.0.0" || address.host === "::" || address.host === ""
      ? "127.0.0.1"
      : address.host.includes(":")
        ? `[${address.host}]`
        : address.host;
  return `${host}:${address.port}`;
}

/** A number serde_json writes as an f64 ("170.0"), as `config.to_string()` named the map's files by it. */
class F64 {
  constructor(readonly value: number) {}
}

/** ryu's shortest form, as serde_json writes an f64. */
export function ryu(x: number): string {
  if (!Number.isFinite(x)) return "null";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mantissa, power] = x.toExponential().split("e") as [string, string];
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  const kk = Number(power) + 1;
  const length = digits.length;
  const k = kk - length;
  let out: string;
  if (k >= 0 && kk <= 16) out = `${digits}${"0".repeat(k)}.0`;
  else if (kk > 0 && kk <= 16) out = `${digits.slice(0, kk)}.${digits.slice(kk)}`;
  else if (kk > -5 && kk <= 0) out = `0.${"0".repeat(-kk)}${digits}`;
  else if (length === 1) out = `${digits}e${kk - 1}`;
  else out = `${digits[0]}.${digits.slice(1)}e${kk - 1}`;
  return negative ? `-${out}` : out;
}

/** `serde_json::Value::to_string` of a `json!` value: keys sorted, F64s as f64s. */
export function rustJson(value: unknown): string {
  if (value instanceof F64) return ryu(value.value);
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(rustJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as object).sort(compareStrings);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${rustJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A map picture and what the page measured, or what went wrong. */
type MapShot = { ok: [Uint8Array, Json] } | { error: string };

/** A one-shot answer (tokio's oneshot): set once, waited on once. */
class Once<T> {
  private value: { set: true; value: T } | { set: false } = { set: false };
  private waiters: ((value: T) => void)[] = [];

  send(value: T): void {
    if (this.value.set) return;
    this.value = { set: true, value };
    for (const waiter of this.waiters.splice(0)) waiter(value);
  }

  get done(): boolean {
    return this.value.set;
  }

  wait(): Promise<T> {
    if (this.value.set) return Promise.resolve(this.value.value);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/** Map pages waiting to be opened, who is waiting for their picture, and where a moving shot's frames go. */
interface MapJob {
  page: string;
  done: Once<MapShot> | null;
  /** A moving shot's first frame is in and where the building is in every frame is known: what the page measured so far. */
  ready: Once<Json> | null;
  frames: string;
}

const mapJobs = new Map<string, MapJob>();

/** `GET /api/maps/{token}` */
export function mapPage(token: string): Response {
  const job = mapJobs.get(token);
  if (job === undefined) return new Response(null, { status: 404 });
  return new Response(job.page, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/** `POST /api/maps/{token}/frame/{index}`: one frame of a moving shot (image/jpeg). */
export function mapFrame(token: string, index: number, body: Uint8Array): number {
  const dir = mapJobs.get(token)?.frames;
  if (dir === undefined) return 404;
  // Whole frames only: an attempt cut short is resumed from what's there.
  const partial = join(dir, `frame-${String(index).padStart(5, "0")}.partial`);
  const frame = join(dir, frameName(index));
  try {
    fs.writeFileSync(partial, body);
    fs.renameSync(partial, frame);
    return 204;
  } catch {
    return 500;
  }
}

export function frameName(index: number): string {
  return `frame-${String(index).padStart(5, "0")}.jpg`;
}

/** The frames of a moving shot already in `dir` (whole JPEGs), from an attempt that was cut short. */
export function framesHad(dir: string, count: number): number[] {
  const out: number[] = [];
  for (let index = 0; index < count; index++) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(join(dir, frameName(index)));
    } catch {
      continue;
    }
    const n = bytes.length;
    if (n >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9) out.push(index);
  }
  return out;
}

function parseOr(text: string | Uint8Array): Json {
  try {
    return serdeParse(typeof text === "string" ? text : new TextDecoder().decode(text));
  } catch {
    return null;
  }
}

/**
 * `POST /api/maps/{token}`: the picture (image/png) with what the page measured
 * (`x-map-info`, JSON); for a moving shot, once its frames are in, just what it
 * measured (application/json); or what went wrong (text).
 */
export function mapShot(token: string, headers: Headers, body: Uint8Array): number {
  if (headers.get("x-map-phase") === "ready") {
    const job = mapJobs.get(token);
    const ready = job?.ready ?? null;
    if (job === undefined || ready === null) return 404;
    job.ready = null;
    ready.send(parseOr(body));
    return 204;
  }
  const job = mapJobs.get(token);
  const waiting = job?.done ?? null;
  if (job === undefined || waiting === null) return 404;
  job.done = null;
  const kind = headers.get("content-type") ?? "";
  const infoHeader = headers.get("x-map-info");
  const info = infoHeader === null ? null : parseOr(infoHeader);
  if (kind.startsWith("image/png")) waiting.send({ ok: [body, info] });
  else if (kind.startsWith("application/json")) waiting.send({ ok: [new Uint8Array(), parseOr(body)] });
  else waiting.send({ error: new TextDecoder().decode(body) });
  return 204;
}

let tokens = 0;

/**
 * Opens the map page in headless Chrome and waits for its picture (or, for a
 * moving shot, its frames in `frames`).
 */
async function renderMap(
  app: App,
  config: Record<string, unknown>,
  width: number,
  height: number,
  frames: string,
  ready: Once<Json> | null,
): Promise<[Uint8Array, Json]> {
  const browser = chrome();
  if (browser === null) throw new Error("map views need Google Chrome (or Chromium) installed");
  const text = rustJson(config);
  const token = fingerprint([text, `${performance.now()}-${tokens++}`, String(process.pid)]);
  const done = new Once<MapShot>();
  const page = MAP_PAGE.replaceAll("__CONFIG__", () => text.replaceAll("</", "<\\/"));
  mapJobs.set(token, { page, done, ready, frames });
  const profile = join(os.tmpdir(), `edit-map-${token}`);
  let answer: MapShot;
  let child: Bun.Subprocess | null = null;
  try {
    child = Bun.spawn(
      [
        browser,
        "--headless=new",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--mute-audio",
        // Room for the page at full size: headless windows lose some height
        // to the browser's own frame.
        `--window-size=${width + 64},${height + 200}`,
        `--user-data-dir=${profile}`,
        ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
        `http://${pageHost(app)}/api/maps/${token}`,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
  } catch (error) {
    answer = { error: `chrome: ${diag.messageOf(error)}` };
  }
  if (child !== null) {
    // A moving shot waits on tiles for every frame.
    const count = typeof config.frames === "number" ? config.frames : 0;
    const waitMs = timing.mapRenderLimitMs(count);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
    });
    const got = await Promise.race([done.wait(), late]);
    if (timer !== null) clearTimeout(timer);
    child.kill();
    if (got === null) answer = { error: "the map took too long to load" };
    else if ("error" in got) answer = { error: `the map didn't render: ${got.error}` };
    else answer = got;
  }
  mapJobs.delete(token);
  fs.rmSync(profile, { recursive: true, force: true });
  if ("error" in answer!) throw new Error(answer.error);
  return answer!.ok;
}

/** How long an export waits for map shots still rendering. */
export const MAP_EXPORT_WAIT = 600_000;

/** A moving map shot being made in the background, by its key. */
interface MapRender {
  /** What the page measured once the first frame was in (or why it failed first). */
  ready: Once<{ ok: Json } | { error: string }>;
  /** Projects whose stand-in becomes the footage when it's done. */
  projects: Set<string>;
  /** Why it failed, once it has. */
  failed: string | null;
}

const mapRenders = new Map<string, MapRender>();

/** A map shot's stand-in in a project: its media, and why its render failed (null while it's still being made). */
interface MapPending {
  media: string;
  error: string | null;
}

/** Map stand-ins by project, by the stand-in's path. */
const mapsPending = new Map<string, Map<string, MapPending>>();

/** Whether any of a project's map shots is still being made. */
function mapsRendering(projectId: string): boolean {
  return [...(mapsPending.get(projectId)?.values() ?? [])].some((map) => map.error === null);
}

/** Whether a media file is a moving map shot's first frame standing in for it. */
export function isMapStandIn(path: string): boolean {
  const name = fileName(path);
  return name !== null && name.startsWith("map-") && name.endsWith("-first.jpg");
}

/**
 * Waits (up to `limit`) for a project's map shots still being made, so an
 * export has the footage rather than its stand-in. An error says why it
 * can't: one still rendering after `limit`, or a stand-in on the timeline
 * whose render failed or was cut short (Edit closed): never exported as a
 * still by mistake.
 */
export async function waitForMaps(app: App, projectId: string, limitMs: number): Promise<void> {
  const started = timing.now();
  while (mapsRendering(projectId)) {
    if (timing.now() - started > limitMs) {
      throw new Error(
        "a map view is still rendering; export again in a minute (get_project's smoothing lists it until it's done)",
      );
    }
    await timing.sleep(500);
  }
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const project = live.project;
  const used = new Set(project.clips.map(clipMedia).filter((id): id is string => id !== null));
  const pending = mapsPending.get(projectId);
  const stuck = project.media
    .filter((media) => used.has(media.id) && isMapStandIn(media.path))
    .map((media) => {
      const error = [...(pending?.values() ?? [])].find((map) => map.media === media.id)?.error ?? null;
      return error !== null ? `${media.id} (its render failed: ${error})` : `${media.id} (its render was cut short)`;
    });
  if (stuck.length > 0) {
    throw new Error(
      `the map view ${stuck.join(", ")} is still only its first frame; call map_view again with the same arguments (it carries on from the frames it has), then export`,
    );
  }
}

/** One map render (a headless Chrome with the 3D map) at a time: each takes a gigabyte or so. */
const mapSlot = new Semaphore(1);

const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const clamp = (x: number, low: number, high: number) => Math.min(Math.max(x, low), high);

/**
 * A tilted 3D view of `place` (or `lat`/`lon`) from Google's photorealistic
 * map, the building there in red, as footage in the project: by default a
 * moving shot (the camera circling the building and closing in), or a still.
 * Returns the media and where the building is. The same view again reuses the
 * footage (each new one is a billed map session).
 *
 * A moving shot answers as soon as its first frame is in and the building's
 * place in every frame is known: its media is that first frame, standing in
 * while the rest renders in the background, and becomes the footage when
 * it's done (exports wait for it). A render cut short keeps its frames, and
 * the same call again carries on from them.
 */
export async function mapView(app: App, projectId: string, given: Json): Promise<Json> {
  const args = (typeof given === "object" && given !== null ? given : {}) as Record<string, unknown>;
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const project: Project = live.project;
  const place = typeof args.place === "string" ? args.place : null;
  const lat0 = num(args.lat);
  const lon0 = num(args.lon);
  const range = clamp(num(args.range) ?? 170.0, 60.0, 3000.0);
  const pitch = clamp(num(args.pitch) ?? 55.0, 0.0, 80.0);
  const heading = num(args.heading) ?? -25.0;
  const mark = bool(args.highlight) ?? true;
  const still = bool(args.still) ?? false;
  const seconds = clamp(num(args.seconds) ?? 6.0, 1.0, 20.0);
  const highlightAfter = clamp(num(args.highlight_after) ?? 0.0, 0.0, seconds);
  const highlightFade = clamp(num(args.highlight_fade) ?? 0.0, 0.0, seconds);
  const orbit = clamp(num(args.orbit) ?? 15.0, -90.0, 90.0);
  const push = clamp(num(args.push) ?? 0.12, 0.0, 0.6);
  const { width, height } = project.settings;
  const fps = Math.max(project.settings.fps, 1);
  const frames = still ? 0 : Math.max(toI64(round(seconds * fps)), 0);
  let lat: number;
  let lon: number;
  let found: string;
  if (lat0 !== null && lon0 !== null) {
    [lat, lon] = [lat0, lon0];
    found = place ?? `${fixed(lat, 5)}, ${fixed(lon, 5)}`;
  } else if (place !== null) {
    [lat, lon, found] = await geocode(place);
  } else {
    throw new Error("give a place (an address or name) or lat and lon");
  }
  const ring = mark ? await buildingOutline(lat, lon) : null;
  const config: Record<string, unknown> = {
    lat: new F64(lat),
    lon: new F64(lon),
    range: new F64(range),
    heading: new F64(heading),
    // The page wants the camera's angle below the horizon.
    pitch: new F64(90.0 - pitch),
    highlight: mark,
    ring: ring === null ? null : ring.map(([x, y]) => [new F64(x), new F64(y)]),
    highlight_after: new F64(highlightAfter),
    highlight_fade: new F64(highlightFade),
    fps,
    width,
    height,
    relay: relay.url(),
  };
  if (frames > 0) {
    config.frames = frames;
    config.orbit = new F64(orbit);
    config.push = new F64(push);
  }
  const dir = join(app.store.uploadsDir(projectId), "maps");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new Error(ioMessage(error));
  }
  // A capture-page change (including its baked-in grade) must not reuse
  // footage made with the previous look.
  const key = fingerprint([rustJson(config), "google-3d", MAP_PAGE]);
  const out = join(dir, `map-${key}.${frames > 0 ? "mp4" : "png"}`);
  // What the page measured is kept beside the footage, for reuse.
  const measured = withExtension(out, "json");
  let info: Json;
  let media: string;
  let rendering = false;
  if (isFile(out)) {
    let kept: Json = null;
    try {
      kept = serdeParse(fs.readFileSync(measured, "utf8"));
    } catch {
      kept = null;
    }
    info = kept;
    if (frames > 0) {
      // A stand-in still in the project (its swap never happened) becomes
      // the footage, so clips placed on it play the shot.
      const first = join(dir, `map-${key}-first.jpg`);
      if (isFile(first)) await swapInMap(app, projectId, first, out);
    }
    media = await importOne(app, projectId, out);
  } else if (frames === 0) {
    const shots = join(dir, `map-${key}.frames`);
    try {
      fs.mkdirSync(shots, { recursive: true });
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    let made: [Uint8Array, Json];
    try {
      made = await renderMap(app, config, width, height, shots, null);
    } finally {
      fs.rmSync(shots, { recursive: true, force: true });
    }
    const [picture, measuredInfo] = made;
    try {
      fs.writeFileSync(out, picture);
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    try {
      fs.writeFileSync(measured, stableStringify(measuredInfo));
    } catch {
      // Only for reuse.
    }
    info = measuredInfo;
    media = await importOne(app, projectId, out);
  } else {
    const job: MapShotJob = { key, config, width, height, fps, frames, dir };
    [info, media, rendering] = await movingMap(app, projectId, job);
  }
  const record = (typeof info === "object" && info !== null ? info : {}) as Record<string, unknown>;
  // The building's box in timeline coordinates (pixels from the frame's centre, y down).
  const placeBox = (bounds: unknown): Record<string, number> | null => {
    if (!Array.isArray(bounds)) return null;
    const [left, top, right, bottom] = [0, 1, 2, 3].map((i) => num(bounds[i])) as (number | null)[];
    if (left == null || top == null || right == null || bottom == null) return null;
    const [halfW, halfH] = [width / 2.0, height / 2.0];
    return {
      x: round((left + right) / 2.0 - halfW),
      top: round(top - halfH),
      bottom: round(bottom - halfH),
      left: round(left - halfW),
      right: round(right - halfW),
    };
  };
  const track: Record<string, number>[] = [];
  if (Array.isArray(record.track)) {
    // Every half second, and the last frame.
    const step = Math.max(Math.floor(fps / 2), 1);
    const last = Math.max(record.track.length - 1, 0);
    (record.track as unknown[]).forEach((bounds, frame) => {
      if (frame % step !== 0 && frame !== last) return;
      const at = placeBox(bounds);
      if (at !== null) track.push({ ...at, frame });
    });
  }
  const building = track[0] ?? placeBox(record.building);
  let note =
    frames > 0
      ? "A moving shot (frames/fps seconds): the camera circles the building and closes in at a constant speed by itself, so place it as a video clip at scale 1 from source_in 0 with no scale keyframes. `building` is where the marked building sits on the first frame and `building_track` where it is every half second (frame = frames into the footage), in timeline transform coordinates: keyframe a label's x and y at those frames (ease linear) to keep it pinned. The marker can reveal after a date title using `highlight_after` and `highlight_fade` in source seconds; tracking remains available throughout."
      : "30 s of footage of the still: place it as a video clip (it fills the frame) and push in slowly with scale keyframes. `building` is where the marked building sits in the frame (timeline transform coordinates at scale 1; a push-in to s moves a point p to p*s).";
  if (rendering) {
    note +=
      " It's still rendering in the background: place it now (the media is its first frame until the footage is done, then the same media id is the moving shot by itself; get_edit_context lists it under smoothing until then, and exports wait for it).";
  }
  return {
    media,
    place: found,
    lat,
    lon,
    frames,
    fps,
    building_outlined: ring !== null,
    building,
    building_track: track,
    rendering,
    note,
  };
}

/** Adds one file to the project's media (or finds it there). */
async function importOne(app: App, projectId: string, path: string): Promise<string> {
  const [, added, errors] = await importPaths(app, projectId, [path], false, "agent");
  const first = added[0];
  if (first === undefined) throw new Error(errors.join("; "));
  return first;
}

/** A moving map shot to make. */
interface MapShotJob {
  key: string;
  config: Record<string, unknown>;
  width: number;
  height: number;
  fps: number;
  frames: number;
  dir: string;
}

const jobOut = (job: MapShotJob) => join(job.dir, `map-${job.key}.mp4`);
/** Its first frame, which stands in for it until it's done. */
const jobFirst = (job: MapShotJob) => join(job.dir, `map-${job.key}-first.jpg`);
const jobShots = (job: MapShotJob) => join(job.dir, `map-${job.key}.frames`);

/**
 * Starts (or joins) the moving shot's render and waits for its first frame
 * and building track: the first frame goes in as the shot's media for now.
 * Returns what the page measured, the media, and whether it's still rendering.
 */
async function movingMap(app: App, projectId: string, job: MapShotJob): Promise<[Json, string, boolean]> {
  let render = mapRenders.get(job.key);
  if (render === undefined) {
    const made: MapRender = { ready: new Once(), projects: new Set(), failed: null };
    render = made;
    mapRenders.set(job.key, made);
    void (async () => {
      try {
        await diag.timeAsync("agent", "map_view render (background)", () => renderMoving(app, job, made));
      } catch {
        // Logged by the timing; the stand-ins hear of it.
      }
      mapRenders.delete(job.key);
    })();
  }
  render.projects.add(projectId);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timing.mapReadyWaitMs);
  });
  const ready = await Promise.race([render.ready.wait(), late]);
  if (timer !== null) clearTimeout(timer);
  if (ready === null) {
    throw new Error(
      "the map is still loading its first frame; call map_view again with the same arguments in a minute (the render carries on)",
    );
  }
  if ("error" in ready) throw new Error(ready.error);
  const info = ready.ok;
  const out = jobOut(job);
  const first = jobFirst(job);
  const media = await importOne(app, projectId, first);
  {
    // Read with the render's failure, so one that failed meanwhile is never
    // left looking as if it were still rendering.
    let maps = mapsPending.get(projectId);
    if (maps === undefined) {
      maps = new Map();
      mapsPending.set(projectId, maps);
    }
    maps.set(first, { media, error: render.failed });
  }
  // It may have finished meanwhile (its own swap found no stand-in yet).
  if (isFile(out)) await swapInMap(app, projectId, first, out);
  return [info, media, !isFile(out)];
}

/**
 * Makes a moving shot: the page's frames (resuming from those already
 * there), then the footage; the projects waiting on it get it in place of
 * its first frame. A failure keeps the frames for the next attempt.
 */
async function renderMoving(app: App, job: MapShotJob, render: MapRender): Promise<void> {
  let failure: string | null = null;
  try {
    const release = await mapSlot.acquire();
    try {
      const shots = jobShots(job);
      try {
        fs.mkdirSync(shots, { recursive: true });
      } catch (error) {
        throw new Error(ioMessage(error));
      }
      const config = { ...job.config, have: framesHad(shots, job.frames) };
      const early = new Once<Json>();
      const page = renderMap(app, config, job.width, job.height, shots, early);
      // Whichever comes first: the first frame and track, or the whole page.
      const first = await Promise.race([
        early.wait().then((measured) => ({ measured }) as const),
        page.then(
          (done) => ({ done }) as const,
          (error: unknown) => ({ failed: error }) as const,
        ),
      ]);
      const firstFrame = jobFirst(job);
      const standIn = (measured: Json) => {
        if (!isFile(firstFrame)) {
          try {
            copyFile(join(shots, frameName(0)), firstFrame);
          } catch (error) {
            throw new Error(`the map's first frame: ${ioMessage(error)}`);
          }
        }
        render.ready.send({ ok: measured });
      };
      const measuredEarly = "measured" in first ? first.measured : undefined;
      if (measuredEarly !== undefined) standIn(measuredEarly);
      let done: [Uint8Array, Json];
      if ("done" in first) done = first.done;
      else if ("failed" in first) throw first.failed;
      else done = await page;
      let info = done[1];
      // The track was measured up front; the final answer may not repeat it.
      if (measuredEarly !== undefined && typeof info === "object" && info !== null && !Array.isArray(info)) {
        const fields = info as Record<string, unknown>;
        const track = (measuredEarly as Record<string, unknown> | null)?.track;
        if (!("track" in fields) && track !== undefined) info = { ...fields, track };
      }
      if (measuredEarly === undefined) standIn(info);
      await framesVideo(shots, job.fps, jobOut(job));
      try {
        fs.writeFileSync(withExtension(jobOut(job), "json"), stableStringify(info));
      } catch {
        // Only for reuse.
      }
      fs.rmSync(shots, { recursive: true, force: true });
    } finally {
      release();
    }
  } catch (error) {
    failure = diag.messageOf(error);
  }
  const projects = [...render.projects];
  const first = jobFirst(job);
  if (failure === null) {
    for (const project of projects) await swapInMap(app, project, first, jobOut(job));
    return;
  }
  if (!render.ready.done) render.ready.send({ error: failure });
  render.failed = failure;
  for (const project of projects) {
    const map = mapsPending.get(project)?.get(first);
    if (map !== undefined) map.error = failure;
  }
  throw new Error(failure);
}

/**
 * The finished footage in place of its first frame: the stand-in media
 * becomes the moving shot (same id), so every clip using it plays it.
 */
export async function swapInMap(app: App, projectId: string, first: string, out: string): Promise<void> {
  let failure: string | null = null;
  try {
    await swapMedia(app, projectId, first, out);
  } catch (error) {
    failure = diag.messageOf(error);
  }
  const maps = mapsPending.get(projectId);
  if (failure === null) {
    if (maps !== undefined) {
      maps.delete(first);
      if (maps.size === 0) mapsPending.delete(projectId);
    }
    return;
  }
  diag.warn("agent", `map footage ${out} into ${projectId}: ${failure}`);
  // Exports refuse the stand-in and say so, rather than wait on it.
  const map = maps?.get(first);
  if (map !== undefined) map.error = failure;
}

async function swapMedia(app: App, projectId: string, first: string, out: string): Promise<void> {
  const probe = await probeFile(out);
  // As import keeps them.
  const standIn = canonical(first);
  const outPath = canonical(out);
  const live = app.store.get(projectId);
  if (live === null || !live.project.media.some((media) => media.path === standIn)) return;
  const [, replaced] = await app.store.update(projectId, "agent", (project) => replaceMediaPath(project, standIn, outPath, probe));
  if (replaced) {
    app.media.ensure(outPath, probe);
    // The footage (never the stand-in) goes up for a cloud project.
    backfillSoon(app, projectId);
  }
}

/** Points the media at `from` to the file at `to` instead (as `probe` read it). Returns whether there was any. */
export function replaceMediaPath(project: Project, from: string, to: string, probe: Probe): boolean {
  const name = fileName(to) ?? to;
  let replaced = false;
  for (const media of project.media) {
    if (media.path !== from) continue;
    media.path = to;
    media.name = name;
    media.kind = probe.kind;
    media.duration = probe.duration;
    media.width = probe.width;
    media.height = probe.height;
    media.fps = probe.fps;
    media.has_audio = probe.has_audio;
    // Another file now: whatever the stand-in had in the cloud isn't it.
    delete media.cloud;
    replaced = true;
  }
  return replaced;
}

/** A moving map shot's frames (`frame-00000.jpg`…) as footage at `fps`. */
async function framesVideo(frames: string, fps: number, out: string): Promise<void> {
  const partial = withExtension(out, "partial.mp4");
  const made = await ffmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-framerate",
    String(fps),
    "-i",
    join(frames, "frame-%05d.jpg"),
    "-vf",
    "format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "14",
    "-an",
    "-movflags",
    "+faststart",
    partial,
  ]);
  if (!made.ok) {
    fs.rmSync(partial, { force: true });
    throw new Error(`couldn't make the map footage: ${trim(made.stderr)}`);
  }
  try {
    fs.renameSync(partial, out);
  } catch (error) {
    throw new Error(ioMessage(error));
  }
}

/** For tests: the state of map stand-ins and smoothing. */
export const state = { mapsPending, smoothing, mapRenders, mapJobs };

/** Stringifies a map_view answer as the tool answers it (`to_string_pretty`, keys sorted). */
export function pretty(value: Json): string {
  return stableStringify(value, 2);
}
