// The scrub tier (off Modal, step 5; Sphe, Nov 2): beside each video's 1080p
// proxy, a 960×540 copy where every frame is a keyframe (all-intra H.264,
// ~6 Mbit/s, VideoToolbox), so a drag shows the frame under the playhead
// instead of the keyframe before it (a scrub showed about half the positions
// asked: docs/preview.md). The viewer decodes it only while the playhead is
// dragged; resting or playing, the 1080p proxy, so what's judged is full size.
//
// Made only for the stretches the timeline uses, in pieces of `PIECE`
// seconds of the source, on demand (the page asks for the pieces around the
// playhead as a drag starts): kept at `edit/scrub/<proxy without edit/>/<n>.mp4`
// in the cache (evicted like any copy of an R2 object). Kept on this Mac only
// (Nov 3): a Mac makes a five-minute piece in ~13 s, and fetching its 225 MB
// from South Africa takes longer and competes with footage uploads. Behind
// EDIT_EDGE_MEDIA=1 (`shared`) a piece is put in R2 too and fetched from there
// by another Mac. Until a piece is made, the proxy is the only tier there.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import { fetchKey, localPath, scratchDir, streamKey } from "./cloud_media.ts";
import { playbackPath } from "./cloud_playback.ts";
import * as diag from "./diag.ts";
import { ApiError, json, notFound } from "./http/errors.ts";
import { serveFile } from "./http/files.ts";
import { readJson, type Router } from "./http/router.ts";
import { Semaphore } from "./media.ts";
import type { Media, Project } from "./model.ts";
import { isFile, join } from "./paths.ts";
import * as tools from "./tools.ts";

/** Seconds of the source in one piece. */
export const PIECE = 300;
/** Its picture: 960×540 at most, every frame a keyframe. */
const WIDTH = 960;
const HEIGHT = 540;
const BITRATE = 6_000_000;
/** Pieces made at once (VideoToolbox's encoder is shared with exports and renders). */
const making = new Semaphore(1);
const inFlight = new Map<string, Promise<string | null>>();

/** Whether pieces go to R2 and come from it (EDIT_EDGE_MEDIA=1, as the edge cache's media); else this Mac's only. */
export function shared(): boolean {
  return process.env.EDIT_EDGE_MEDIA === "1" && cloud.enabled();
}

/** A piece's R2 key: by the proxy it's made from and its place in it. */
export function pieceKey(proxy: string, index: number): string {
  return `edit/scrub/${proxy.startsWith("edit/") ? proxy.slice("edit/".length) : proxy}/${index}.mp4`;
}

/** The pieces of each video media frames `from..to` of the timeline show (`PIECE`s of the source). */
export function piecesOf(project: Project, from: number, to: number): Map<string, Set<number>> {
  const fps = project.settings.fps > 0 ? project.settings.fps : 30;
  const out = new Map<string, Set<number>>();
  for (const clip of project.clips) {
    if (clip.type !== "video" || clip.start >= to || clip.start + clip.duration <= from) continue;
    const media = project.media.find((one) => one.id === clip.media);
    if (media === undefined || media.kind !== "video") continue;
    const at = (frame: number) => (clip.source_in ?? 0) + ((frame - clip.start) / fps) * (clip.speed ?? 1);
    const [a, b] = [at(Math.max(clip.start, from)), at(Math.min(clip.start + clip.duration, to))].sort((x, y) => x - y) as [number, number];
    const own = out.get(media.id) ?? new Set<number>();
    for (let index = Math.floor(a / PIECE); index <= Math.floor(Math.max(b - 1e-6, a) / PIECE); index++) own.add(index);
    out.set(media.id, own);
  }
  return out;
}

/** Where piece `index` of `media` is read from to make it, and what it's kept as; null for media with no proxy in the cloud. */
function sourceOf(app: App, media: Media): { input: string; proxy: string } | null {
  const proxy = streamKey(media.cloud, "proxy");
  if (proxy === null) return null;
  return { input: playbackPath(proxy, app.port), proxy };
}

/** This Mac's copy of piece `index` of `media`, when it's here. */
export function pieceFile(app: App, media: Media, index: number): string | null {
  const source = sourceOf(app, media);
  if (source === null) return null;
  const local = localPath(app.store.cacheDir(), pieceKey(source.proxy, index));
  return isFile(local) ? local : null;
}

/**
 * Piece `index` of `media` on this Mac: here, or made now from its proxy
 * (one at a time); when `shared`, R2's before it's made and put there
 * after. Null when it can't be had.
 */
export function makePiece(app: App, media: Media, index: number): Promise<string | null> {
  const source = sourceOf(app, media);
  if (source === null) return Promise.resolve(null);
  const key = pieceKey(source.proxy, index);
  const local = localPath(app.store.cacheDir(), key);
  if (isFile(local)) return Promise.resolve(local);
  const running = inFlight.get(key);
  if (running !== undefined) return running;
  const work = (async (): Promise<string | null> => {
    try {
      if (shared() && (await cloud.head(key).catch(() => null)) !== null) {
        await fetchKey(key, local);
        if (isFile(local)) return local;
      }
    } catch (error) {
      diag.warn("scrub", `fetching ${key}: ${diag.messageOf(error)}`);
    }
    const release = await making.acquire();
    // Never beside a local export: it has the encoder (export_capacity.ts).
    for (let waited = 0; waited < 3600 && (app.exports.localRunning?.() ?? false); waited += 5) await Bun.sleep(5000);
    const scratch = join(scratchDir(app.store.cacheDir()), `scrub-${process.pid}-${crypto.randomUUID().slice(0, 8)}.mp4`);
    try {
      const began = performance.now();
      const seconds = Math.min(PIECE, Math.max(media.duration - index * PIECE, 0.1));
      await tools.run([
        tools.ffmpeg(), "-v", "error", "-nostdin", "-y",
        "-ss", String(index * PIECE), "-protocol_whitelist", tools.protocols(source.input), ...tools.urlArgs(source.input), "-i", source.input,
        "-t", seconds.toFixed(3), "-map", "0:v:0", "-an", "-sn", "-dn",
        "-vf", `scale=w=${WIDTH}:h=${HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        "-c:v", "h264_videotoolbox", "-b:v", String(BITRATE), "-g", "1", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", scratch,
      ], { timeoutMs: 20 * 60_000 });
      fs.mkdirSync(local.slice(0, local.lastIndexOf("/")), { recursive: true });
      fs.renameSync(scratch, local);
      diag.info("scrub", `${media.name}: piece ${index} (${Math.round(seconds)} s) made in ${diag.human(performance.now() - began)}`);
      if (shared()) void cloud.uploadFile(local, key).catch((error: unknown) => diag.warn("scrub", `sharing ${key}: ${diag.messageOf(error)}`));
      return local;
    } catch (error) {
      diag.warn("scrub", `${media.name}: piece ${index}: ${diag.messageOf(error)}`);
      return null;
    } finally {
      fs.rmSync(scratch, { force: true });
      release();
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

export function routes(router: Router<App>): void {
  router
    // Which pieces of the timeline's footage are here, by media: [index…].
    .get("/api/projects/{id}/scrub", ({ app, params }) => {
      const live = app.store.get(params.id ?? "");
      if (live === null) throw notFound("no such project");
      const ready: Record<string, number[]> = {};
      for (const [media, pieces] of piecesOf(live.project, 0, Number.MAX_SAFE_INTEGER)) {
        const found = live.project.media.find((one) => one.id === media);
        if (found === undefined) continue;
        const here = [...pieces].filter((index) => pieceFile(app, found, index) !== null);
        if (here.length > 0) ready[media] = here;
      }
      return json({ seconds: PIECE, ready });
    })
    // Make the pieces frames `from..to` of the timeline show (the page, as a drag starts there).
    .post("/api/projects/{id}/scrub", async (context) => {
      const { app, params } = context;
      const live = app.store.get(params.id ?? "");
      if (live === null) throw notFound("no such project");
      const body = (await readJson(context)) as { from?: unknown; to?: unknown };
      const from = typeof body.from === "number" ? Math.max(0, Math.floor(body.from)) : 0;
      const to = typeof body.to === "number" ? Math.floor(body.to) : from + 30 * (live.project.settings.fps || 30);
      if (!(to > from)) throw new ApiError(400, "from must come before to");
      let asked = 0;
      for (const [media, pieces] of piecesOf(live.project, from, to)) {
        const found = live.project.media.find((one) => one.id === media);
        if (found === undefined) continue;
        for (const index of pieces) {
          if (pieceFile(app, found, index) !== null) continue;
          asked++;
          void makePiece(app, found, index);
        }
      }
      return json({ asked });
    })
    .get("/api/projects/{id}/scrub/{media}/{piece}", ({ app, params, request }) => {
      const media = app.store.get(params.id ?? "")?.project.media.find((one) => one.id === params.media);
      const index = Number(params.piece);
      if (media === undefined || !Number.isInteger(index) || index < 0) throw notFound("no such piece");
      const file = pieceFile(app, media, index);
      if (file === null) throw notFound("that piece isn't made yet");
      const response = serveFile(request, file);
      response.headers.set("cache-control", "private, max-age=31536000, immutable");
      return response;
    });
}
