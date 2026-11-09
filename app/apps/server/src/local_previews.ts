// Cloud previews read from their whole copy on this Mac (Nov 6, JJ's four
// reviews on Sphe's Mac): their footage was imported on Mathias's, so every
// frame the agent looked at was read in blocks through this server's loopback
// stream from R2, behind the Mac's other cloud traffic. Pictures took 1–3
// minutes a look (a contact sheet 3 min 32 s, a render_frame 3 min 06 s, a
// plan's review frames 3 min 31 s) and ~90% of the turns' tool time; the
// compositing took under half a second. A preview is small (a 7-minute one
// ~26 MB, a whole project's ~0.5–1 GB), so the whole file is fetched once,
// into the copy Edit already serves from (`cloud_media.localPath`), and
// frames read it with the Mac's video decoder.
//
// Fetched when a turn starts on a project (and when the native preview asks),
// a few at a time; until a file is here its frames stream as before. The
// renders take the project with those paths swapped for the files here
// (`localized`), never the saved project: its paths are the cloud's, the same
// on every Mac.

import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { objectOf } from "./export_excerpts.ts";
import type { Media, Project } from "./model.ts";
import { isFile } from "./paths.ts";
import * as pieces from "./proxy_pieces.ts";

/** Whole previews fetched at once. */
const AT_ONCE = 4;
const waiting: { key: string; local: string }[] = [];
const fetching = new Set<string>();
/** When a fetch last failed, so it isn't asked again on every frame (again after `RETRY_MS`). */
const failed = new Map<string, number>();
const RETRY_MS = 10 * 60_000;

/** Seams for tests. */
export const hooks = {
  fetch: (key: string, local: string): Promise<void> => cloudMedia.fetchKey(key, local),
};

function fetchNext(): void {
  while (fetching.size < AT_ONCE) {
    const next = waiting.shift();
    if (next === undefined) return;
    if (fetching.has(next.local) || isFile(next.local)) continue;
    fetching.add(next.local);
    const started = performance.now();
    void hooks
      .fetch(next.key, next.local)
      .then(() => diag.info("preview", `${next.key}: whole preview here in ${diag.human(performance.now() - started)}`))
      .catch((error: unknown) => {
        failed.set(next.local, Date.now());
        diag.warn("preview", `${next.key}: whole preview not fetched: ${diag.messageOf(error)}`);
      })
      .finally(() => {
        fetching.delete(next.local);
        fetchNext();
      });
  }
}

/** Queues `key`'s whole preview into `local`, once. */
export function fetchWhole(key: string, local: string): void {
  if (Date.now() - (failed.get(local) ?? 0) < RETRY_MS || fetching.has(local) || waiting.some((one) => one.local === local) || isFile(local)) return;
  waiting.push({ key, local });
  fetchNext();
}

/**
 * A cloud media's preview key, when its whole file can be kept here: a made
 * proxy, or footage that's its own proxy (256 MB at most); not a pieced
 * proxy, which is no file (proxy_pieces.ts).
 */
function previewKey(media: Media): string | null {
  if (media.kind !== "video") return null;
  const key = cloudMedia.streamKey(media.cloud, "proxy");
  return key !== null && pieces.baseOf(key) === null ? key : null;
}

/** Queues every cloud preview `project` reads that isn't here yet. */
export function fetchAll(cache: string, project: Project): void {
  for (const media of project.media) {
    const key = previewKey(media);
    if (key !== null && !isFile(media.path)) fetchWhole(key, cloudMedia.localPath(cache, key));
  }
}

/**
 * `project` with each cloud preview it streams read from its whole file here
 * instead, or null when none is here (the rest are fetched behind it). Only a
 * path that streams that very preview is swapped, so what's drawn is the same.
 */
export function localized(cache: string, project: Project): Project | null {
  let out: Project | null = null;
  project.media.forEach((media, index) => {
    const key = previewKey(media);
    if (key === null || isFile(media.path) || objectOf(media.path) !== `cloud:${key}`) return;
    const local = cloudMedia.localPath(cache, key);
    if (!isFile(local)) {
      fetchWhole(key, local);
      return;
    }
    out ??= { ...project, media: [...project.media] };
    out.media[index] = { ...media, path: local };
  });
  return out;
}

/** The file a media's frames and sound are read from: its whole preview here, else its path. */
export function pathOf(cache: string, media: Media): string {
  const key = previewKey(media);
  if (key === null || isFile(media.path) || objectOf(media.path) !== `cloud:${key}`) return media.path;
  const local = cloudMedia.localPath(cache, key);
  return isFile(local) ? local : media.path;
}

/** For tests. */
export function reset(): void {
  waiting.length = 0;
  fetching.clear();
  failed.clear();
}
