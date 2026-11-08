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
//   242 pictures streamed for good.
// - A pieced proxy (proxy_pieces.ts, a video of 20 minutes or more) is no
//   file to fetch: its pieces come down or are made behind the viewer
//   (`cloud_media.prefetchProject`'s fill), and each piece here is cut into a
//   file of its own (its picture copied, time 0 the piece's start) that the
//   window reads instead of the stream where it reaches (the engine's
//   excerpts, crates/edit-engine/src/excerpts.rs).
//
// Until then a picture is the server's loopback stream; the page asks again
// every 15 s while any is. And when the cache's cleaner takes a copy handed
// out here (cache_cleanup.ts), the project's pages hear it (`native-sources`)
// and ask again, rather than a jump failing on the missing file.

import type { App } from "./app.ts";
import * as cloudMedia from "./cloud_media.ts";
import { PLAYBACK_ROUTE } from "./cloud_playback.ts";
import * as diag from "./diag.ts";
import { cut, TO_THE_END } from "./export_excerpts.ts";
import { json } from "./http/errors.ts";
import { fetchWhole } from "./local_previews.ts";
import type { Project } from "./model.ts";
import { isFile } from "./paths.ts";
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

/** Seams for tests. */
export const hooks = {
  cut: (url: string, from: number, to: number, out: string): Promise<void> => cut(url, from, to, out, new AbortController().signal),
};

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
 * here); pieces here but not cut yet are cut behind this.
 */
async function pieceExcerpts(cache: string, base: string, url: string): Promise<NativeExcerpt[]> {
  const context = cloudMedia.piecesHere(cache);
  let layout: pieces.Layout;
  try {
    layout = await pieces.layoutOf(context, base);
  } catch {
    return [];
  }
  const out: NativeExcerpt[] = [];
  for (let n = 0; n < layout.pieces; n++) {
    if (!pieces.pictureHere(context, base, n)) continue;
    const [first, end] = pieces.framesOf(layout, n);
    const from = first / layout.fps;
    const to = end / layout.fps;
    const file = cloudMedia.localPath(cache, `${base}/native/${n}.mp4`);
    if (isFile(file)) {
      out.push({ from, to: n === layout.pieces - 1 ? TO_THE_END : to, path: file });
      continue;
    }
    if (Date.now() - (cutFailed.get(file) ?? 0) < RETRY_MS || cutting.has(file) || cutsWaiting.some((one) => one.out === file)) continue;
    cutsWaiting.push({ url, from, to, out: file });
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
  const excerpts: Record<string, NativeExcerpt[]> = {};
  // Only what the timeline shows comes down (Cops Realize lists 169 own-file videos, 1.5 GB; its clips show 66, 0.7 GB).
  const shown = new Set(project.clips.flatMap((clip) => (clip.type === "video" ? [clip.media] : [])));
  for (const media of project.media) {
    if (media.kind !== "video" && media.kind !== "image") continue;
    const key = cloudMedia.streamKey(media.cloud, "proxy");
    if (key !== null) {
      const local = cloudMedia.localPath(cache, key);
      const base = pieces.baseOf(key);
      if (base === null && isFile(local)) sources[media.id] = local;
      else if (isFile(media.path)) sources[media.id] = media.path;
      else {
        const url = `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent(key)}`;
        sources[media.id] = url;
        if (!shown.has(media.id)) continue;
        if (base === null) fetchWhole(key, local);
        else {
          const here = await pieceExcerpts(cache, base, url);
          if (here.length > 0) excerpts[media.id] = here;
        }
      }
      continue;
    }
    const paths = app.media.paths(media.path);
    sources[media.id] = media.kind === "video" && isFile(paths.proxyDone) && isFile(paths.proxy) ? paths.proxy : media.path;
  }
  const files = new Set<string>([...Object.values(sources).filter((source) => !source.startsWith("http")), ...Object.values(excerpts).flatMap((list) => list.map((one) => one.path))]);
  handed.set(project.id, files);
  return json({ cache, sources, excerpts });
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
  handed.clear();
  cutsWaiting.length = 0;
  cutting.clear();
  cutFailed.clear();
}
