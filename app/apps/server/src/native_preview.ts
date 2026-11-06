// What Edit.app's native preview decodes each picture from (its window draws
// the viewer's picture with the engine: crates/edit-window/src/preview.rs,
// docs/plans/2026-11-06-native-player.md). The engine reads files on this Mac
// with the video decoder and anything else with FFmpeg, which opens a stream
// again on every jump: a cloud preview streamed took 3–8.6 s a frame to scrub
// to (the 16-Year-Old, Nov 6). So a cloud preview not here yet is streamed
// while its whole file comes down behind it, two at a time, into the copy
// Edit already serves from (`cloud_media.localPath`: the page's sound reads
// it too); the page asks again until nothing is streamed.

import type { App } from "./app.ts";
import * as cloudMedia from "./cloud_media.ts";
import { PLAYBACK_ROUTE } from "./cloud_playback.ts";
import { json } from "./http/errors.ts";
import { fetchWhole } from "./local_previews.ts";
import type { Project } from "./model.ts";
import { isFile } from "./paths.ts";

/**
 * Each picture media's file for the native preview: its made preview, else
 * its footage; a cloud one's whole preview here, else its footage when that's
 * here, else this server's loopback stream of the preview (and the whole file
 * fetched behind it). With the media cache, where waveforms' levels are.
 */
export function nativeSources(app: App, project: Project): Response {
  const cache = app.store.cacheDir();
  const sources: Record<string, string> = {};
  for (const media of project.media) {
    if (media.kind !== "video" && media.kind !== "image") continue;
    const key = cloudMedia.streamKey(media.cloud, "proxy");
    if (key !== null) {
      const local = cloudMedia.localPath(cache, key);
      const whole = key.startsWith("edit/proxies/");
      if (whole && isFile(local)) sources[media.id] = local;
      else if (isFile(media.path)) sources[media.id] = media.path;
      else {
        sources[media.id] = `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent(key)}`;
        if (whole) fetchWhole(key, local);
      }
      continue;
    }
    const paths = app.media.paths(media.path);
    sources[media.id] = media.kind === "video" && isFile(paths.proxyDone) && isFile(paths.proxy) ? paths.proxy : media.path;
  }
  return json({ cache, sources });
}
