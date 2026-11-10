// What Edit.app's native preview decodes each picture from (its window draws
// the viewer's picture with the engine: crates/edit-window/src/preview.rs,
// docs/plans/2026-11-06-native-player.md). The engine reads files on this Mac
// with the video decoder and anything else with FFmpeg, which opens a stream
// again on every jump: a cloud preview streamed took 3–8.6 s a frame to scrub
// to (the 16-Year-Old, Nov 6), and 0.5–1.7 s on Cops Realize (Nov 8). So:
//
// - Every cloud preview that's one file comes down whole, four at a time,
//   into the copy Edit already serves from (`cloud_media.localPath`): a made
//   proxy (`edit/proxies/…`), and footage that's its own proxy (an original
//   of 256 MB or less, `cloud_media.OWN_FILE_MAX`: maps, interview cuts,
//   pictures). Until Nov 8 only made proxies did, so 147 of Cops Realize's
//   242 pictures streamed for good. They come down in playhead order (the
//   media the timeline plays first, first), and they're the one footage form
//   the window reads: asking here marks the project as the window's
//   (player.ts), so the page player's block prefetch, scrub pieces and
//   smooth-playback render stay off for it on this Mac (audit, Nov 8: the
//   same proxy bytes were kept in four forms).
// - A pieced proxy (proxy_pieces.ts, a video of 20 minutes or more) is no
//   file to fetch: its pieces come down or are made behind the viewer
//   (`cloud_media.fillPieces`, started here), and each piece here that the
//   timeline plays is cut into a file of its own (its picture copied, time 0
//   the piece's start) that the window reads instead of the stream where it
//   reaches (the engine's excerpts, crates/edit-engine/src/excerpts.rs).
//
// Playing, the window mixes the edit's sound itself (crates/edit-engine/src/player.rs),
// so each heard media's sound file is named too: a made preview's sound
// (`preview.m4a`), a cloud preview's whole copy here (its sound is in it; a
// sound file's own copy, fetched whole like a picture's), else the footage or
// the loopback stream, which FFmpeg reads.
//
// Until then a picture is the server's loopback stream; the page asks again
// every 15 s while any is. And when the cache's cleaner takes a copy handed
// out here (cache_cleanup.ts), the project's pages hear it (`native-sources`)
// and ask again, rather than a jump failing on the missing file.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloudMedia from "./cloud_media.ts";
import { PLAYBACK_ROUTE } from "./cloud_playback.ts";
import * as diag from "./diag.ts";
import { cut, TO_THE_END } from "./export_excerpts.ts";
import { json } from "./http/errors.ts";
import { fetchWhole } from "./local_previews.ts";
import type { Project } from "./model.ts";
import { isFile } from "./paths.ts";
import * as player from "./player.ts";
import * as pieces from "./proxy_pieces.ts";

/** Seconds `from..to` of a streamed source in a file here: the window reads it instead of the stream. */
export interface NativeExcerpt {
  from: number;
  to: number;
  path: string;
}

/** The local files each project's window was last told to read (`evicted` looks here). */
const handed = new Map<string, Set<string>>();

/** Piece cuts at once, and the ones waiting or failed lately (tried again after `RETRY_MS`). */
const CUTS_AT_ONCE = 2;
const RETRY_MS = 10 * 60_000;
const cutsWaiting: { url: string; from: number; to: number; out: string }[] = [];
const cutting = new Set<string>();
const cutFailed = new Map<string, number>();

/**
 * Cuts a piece into `out`, whole or not at all: into a file beside it, moved
 * into place once FFmpeg is done, so a cut Edit quits during never leaves half
 * a piece the window would read. The pieces' folder is made here: nothing
 * else makes it, and until Nov 10 nothing did, so no piece was ever cut (JJ's
 * Mac, 104 times in six hours: "Error opening output files: No such file or
 * directory") and a long video's picture came through the stream for good.
 */
async function cutWhole(url: string, from: number, to: number, out: string): Promise<void> {
  const part = out.replace(/\.mp4$/, ".part.mp4");
  try {
    fs.mkdirSync(out.slice(0, out.lastIndexOf("/")), { recursive: true });
    await cut(url, from, to, part, new AbortController().signal);
    fs.renameSync(part, out);
  } finally {
    fs.rmSync(part, { force: true });
  }
}

/** Seams for tests. */
export const hooks = { cut: cutWhole };

function cutNext(): void {
  while (cutting.size < CUTS_AT_ONCE) {
    const next = cutsWaiting.shift();
    if (next === undefined) return;
    if (cutting.has(next.out) || isFile(next.out)) continue;
    cutting.add(next.out);
    void hooks
      .cut(next.url, next.from, next.to, next.out)
      .catch((error: unknown) => {
        cutFailed.set(next.out, Date.now());
        diag.warn("preview", `a piece for the window (${next.out}) wasn't cut: ${diag.messageOf(error)}`);
      })
      .finally(() => {
        cutting.delete(next.out);
        cutNext();
      });
  }
}

/**
 * The pieces of pieced proxy `base` on this Mac as files the window reads
 * (cut from `url`, the loopback stream, which answers them from the pieces
 * here); of those the timeline plays (`played`: stretches of the video, in
 * seconds), the ones here but not cut yet are cut behind this, in its order.
 * Only those: a cut piece is a second copy of its minute of the preview (a
 * two-hour interview's, 3.6 GB), and an edit plays a part of it.
 */
async function pieceExcerpts(cache: string, base: string, url: string, played: [number, number][]): Promise<NativeExcerpt[]> {
  const context = cloudMedia.piecesHere(cache);
  let layout: pieces.Layout;
  try {
    layout = await pieces.layoutOf(context, base);
  } catch {
    return [];
  }
  const wanted: number[] = [];
  for (const [from, to] of played) {
    for (let n = pieces.pieceAt(layout, from); n <= pieces.pieceAt(layout, to); n++) if (!wanted.includes(n)) wanted.push(n);
  }
  const out: NativeExcerpt[] = [];
  const file = (n: number) => cloudMedia.localPath(cache, `${base}/native/${n}.mp4`);
  const span = (n: number): [number, number] => {
    const [first, end] = pieces.framesOf(layout, n);
    return [first / layout.fps, end / layout.fps];
  };
  // Every piece cut already is read from its file, played now or not.
  for (let n = 0; n < layout.pieces; n++) {
    if (!isFile(file(n))) continue;
    const [from, to] = span(n);
    out.push({ from, to: n === layout.pieces - 1 ? TO_THE_END : to, path: file(n) });
  }
  for (const n of wanted) {
    const path = file(n);
    if (isFile(path) || !pieces.pictureHere(context, base, n)) continue;
    if (Date.now() - (cutFailed.get(path) ?? 0) < RETRY_MS || cutting.has(path) || cutsWaiting.some((one) => one.out === path)) continue;
    const [from, to] = span(n);
    cutsWaiting.push({ url, from, to, out: path });
  }
  cutNext();
  return out;
}

/**
 * Each picture media's file for the native preview: its made preview, else
 * its footage; a cloud one's whole preview here, else its footage when that's
 * here, else this server's loopback stream of the preview (and the whole file
 * fetched behind it, or a pieced one's pieces here as excerpts). With the
 * media cache, where waveforms' levels are.
 */
export async function nativeSources(app: App, project: Project): Promise<Response> {
  const cache = app.store.cacheDir();
  const sources: Record<string, string> = {};
  const sounds: Record<string, string> = {};
  const excerpts: Record<string, NativeExcerpt[]> = {};
  player.markNative(project.id);
  cloudMedia.stopPrefetch(project.id);
  // A pieced proxy's pieces the timeline plays come down behind the viewer, in its order (one fill a project).
  cloudMedia.fillPieces(app, project.id);
  // Only what the timeline shows comes down (Cops Realize lists 169 own-file videos, 1.5 GB; its clips show 66, 0.7 GB),
  // in playhead order: the media first played first.
  const shown = new Set(project.clips.flatMap((clip) => (clip.type === "video" ? [clip.media] : [])));
  const heard = new Set(project.clips.flatMap((clip) => (clip.type === "audio" ? [clip.media] : [])));
  const firstUse = new Map<string, number>();
  // The stretches of each video the timeline shows (seconds of it), in the timeline's order.
  const fps = project.settings.fps > 0 ? project.settings.fps : 30;
  const played = new Map<string, [number, number][]>();
  for (const clip of [...project.clips].sort((a, b) => a.start - b.start)) {
    if (clip.type !== "video" && clip.type !== "audio") continue;
    firstUse.set(clip.media, Math.min(firstUse.get(clip.media) ?? Infinity, clip.start));
    if (clip.type !== "video") continue;
    const from = clip.source_in ?? 0;
    const stretches = played.get(clip.media) ?? [];
    stretches.push([from, from + (clip.duration / fps) * (clip.speed ?? 1)]);
    played.set(clip.media, stretches);
  }
  const inPlayheadOrder = [...project.media].sort((a, b) => (firstUse.get(a.id) ?? Infinity) - (firstUse.get(b.id) ?? Infinity));
  for (const media of inPlayheadOrder) {
    const sound = media.kind === "audio" || (media.kind === "video" && media.has_audio);
    if (media.kind !== "video" && media.kind !== "image" && !sound) continue;
    const key = cloudMedia.streamKey(media.cloud, "proxy");
    if (key !== null) {
      const local = cloudMedia.localPath(cache, key);
      const base = pieces.baseOf(key);
      let source: string;
      if (base === null && isFile(local)) source = local;
      else if (isFile(media.path)) source = media.path;
      else {
        const url = `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent(key)}`;
        source = url;
        if (shown.has(media.id) || heard.has(media.id)) {
          if (base === null) fetchWhole(key, local);
          else if (shown.has(media.id)) {
            const here = await pieceExcerpts(cache, base, url, played.get(media.id) ?? []);
            if (here.length > 0) excerpts[media.id] = here;
          }
        }
      }
      if (media.kind !== "audio") sources[media.id] = source;
      if (sound) sounds[media.id] = source;
      continue;
    }
    const paths = app.media.paths(media.path);
    const made = isFile(paths.proxyDone);
    if (media.kind !== "audio") sources[media.id] = media.kind === "video" && made && isFile(paths.proxy) ? paths.proxy : media.path;
    if (sound) sounds[media.id] = made && isFile(paths.audio) ? paths.audio : media.path;
  }
  const files = new Set<string>([...Object.values(sources), ...Object.values(sounds)].filter((source) => !source.startsWith("http")).concat(Object.values(excerpts).flatMap((list) => list.map((one) => one.path))));
  handed.set(project.id, files);
  return json({ cache, sources, sounds, excerpts });
}

/**
 * The cache's cleaner took `path` (a file or a folder): each project whose
 * window was told to read something there hears it (`native-sources`), and
 * its page asks for its sources again.
 */
export function evicted(app: App, path: string): void {
  for (const [id, files] of handed) {
    if ([...files].some((file) => file === path || file.startsWith(`${path}/`))) {
      handed.delete(id);
      app.store.emit({ type: "native-sources", id });
    }
  }
}

/** For tests. */
export function reset(): void {
  player.reset();
  handed.clear();
  cutsWaiting.length = 0;
  cutting.clear();
  cutFailed.clear();
}
