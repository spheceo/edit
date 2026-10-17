// Bringing files into a project (server.rs import_paths and friends): probed,
// sent to the cloud in cloud mode (the original goes to R2 and footage is
// edited from its proxy), added as media once per path, optionally laid at
// the end of the timeline, and then their previews, loudness analysis and, for
// footage in a project with no script, the transcript and the watcher.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import * as media from "./media.ts";
import type { Clip, ClipColor, Media, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { canonical, expandHome, fileName, join } from "./paths.ts";
import { duration, fps, freshId, mediaOf } from "./project.ts";
import { cloudEnabled } from "./relay.ts";
import * as seams from "./seams.ts";

export { expandHome } from "./paths.ts";
export type { Made } from "./seams.ts";

/** How import hands a file to the cloud (`cloud_media.importLocal`); a seam until WP3 lands, replaceable in tests. */
export const hooks = {
  importLocal: (cache: string, path: string, probe: media.Probe, name: string): Promise<seams.Made> =>
    seams.cloudMedia.importLocal(cache, path, probe, name),
};

/** What an import did: the project's rev after it, the media ids added (or found), and what couldn't come in. */
export type Imported = [rev: number, added: string[], errors: string[]];

export async function importPaths(
  app: App,
  id: string,
  paths: string[],
  place: boolean,
  origin: string,
): Promise<Imported> {
  const probed: [string, media.Probe][] = [];
  const errors: string[] = [];
  const names = new Map<string, string>();
  for (const given of paths) {
    let path: string;
    try {
      path = fs.realpathSync(given);
    } catch {
      errors.push(`${given} is not a supported local media file`);
      continue;
    }
    const file = isFile(path);
    if (file && media.isMediaPath(path)) {
      // Footage or sound: as it is.
    } else if (file && media.isImagePath(path) && process.platform === "darwin") {
      // Photos stay images on macOS.
    } else if (file && media.isImagePath(path)) {
      // A still becomes 30 s of footage (it then plays, scales and exports like any clip).
      const name = fileName(path);
      let dir: string;
      try {
        dir = join(app.store.uploadsDir(id), "stills");
      } catch (error) {
        errors.push(diag.messageOf(error));
        continue;
      }
      try {
        const video = await seams.broll.stillVideo(path, dir);
        if (name !== null) names.set(video, name);
        path = video;
      } catch (error) {
        errors.push(diag.messageOf(error));
        continue;
      }
    } else {
      errors.push(`${path} is not a supported local media file`);
      continue;
    }
    try {
      probed.push([path, await media.probe(path)]);
    } catch (error) {
      errors.push(diag.messageOf(error));
    }
  }
  const nameOf = (path: string) => names.get(path) ?? fileName(path) ?? path;
  const items: seams.Made[] = [];
  for (const [path, probe] of probed) {
    const name = nameOf(path);
    if (!cloudEnabled()) {
      items.push({ path, name, probe, cloud: null });
      continue;
    }
    // Cloud mode: the original goes to R2 and footage is edited from its
    // proxy (`cloud_media`); the file on disk is left as it is.
    try {
      items.push(
        await diag.timeOnAsync("cloud", "cloud: import", path, () =>
          hooks.importLocal(app.store.cacheDir(), path, probe, name),
        ),
      );
    } catch (error) {
      errors.push(`${name} couldn't go to the cloud: ${diag.messageOf(error)}`);
    }
  }
  return addMedia(app, id, items, errors, place, origin);
}

/** Adds already-made media (a cloud excerpt's proxy and where it is on R2). */
export function importMade(app: App, id: string, items: seams.Made[], place: boolean, origin: string): Promise<Imported> {
  return addMedia(app, id, items, [], place, origin);
}

/**
 * Files Edit makes itself (a bundled sound, a house graphic) as media of a
 * project being edited in memory (a plan, saved once with everything else):
 * probed (and sent to the cloud in cloud mode, like any import), added unless
 * the project has them already. Returns each one's media id, and the new ones
 * to hand to `houseMediaSaved` once the project is saved.
 */
export async function houseMedia(app: App, project: Project, paths: string[]): Promise<[string[], seams.Made[]]> {
  const ids: string[] = [];
  const made: seams.Made[] = [];
  for (const path of paths) {
    const existing = project.media.find((item) => item.path === path);
    if (existing !== undefined) {
      ids.push(existing.id);
      continue;
    }
    const probe = await media.probe(path);
    const name = fileName(path) ?? path;
    const item = cloudEnabled()
      ? await hooks.importLocal(app.store.cacheDir(), path, probe, name)
      : { path, name, probe, cloud: null };
    const mediaId = freshId(project, "m");
    project.media.push(mediaFrom(mediaId, item));
    ids.push(mediaId);
    made.push(item);
  }
  return [ids, made];
}

/** After a project with `houseMedia` in it is saved: their previews and analysis. */
export function houseMediaSaved(app: App, made: seams.Made[]): void {
  for (const { path, probe } of made) {
    if (probe.has_audio) native().loudnessWarm(path);
    app.media.ensure(path, probe);
  }
}

function mediaFrom(id: string, item: seams.Made): Media {
  const out: Media = {
    id,
    name: item.name,
    path: item.path,
    kind: item.probe.kind,
    duration: item.probe.duration,
    width: item.probe.width,
    height: item.probe.height,
    fps: item.probe.fps,
    has_audio: item.probe.has_audio,
  };
  if (item.cloud !== null) out.cloud = item.cloud;
  return out;
}

async function addMedia(
  app: App,
  id: string,
  items: seams.Made[],
  errors: string[],
  place: boolean,
  origin: string,
): Promise<Imported> {
  const [live, added] = await app.store.update(id, origin, (project) => {
    const added: string[] = [];
    for (const item of items) {
      const existing = project.media.find((other) => other.path === item.path);
      let mediaId: string;
      if (existing !== undefined) {
        mediaId = existing.id;
      } else {
        mediaId = freshId(project, "m");
        project.media.push(mediaFrom(mediaId, item));
      }
      if (place) placeAtEnd(project, mediaId);
      added.push(mediaId);
    }
    return added;
  });
  // Footage brought into a project with no script is a subtitled video in
  // the making: its transcript is the first thing it needs, so the
  // transcriber starts now instead of when the watcher first asks for it.
  // (A script's import transcribes its own footage; voice-overs have theirs.)
  const transcribe = (live.project.script === undefined || live.project.script === null) && origin !== "voice" && origin !== "script";
  const transcribing: string[] = [];
  for (const { path, probe } of items) {
    if (transcribe && probe.kind === "video" && probe.has_audio) {
      app.media.transcribe(path, true);
      transcribing.push(path);
    }
    // Its loudness analysis, so the first measure_audio / set_loudness is instant.
    if (probe.has_audio) native().loudnessWarm(path);
    app.media.ensure(path, probe);
  }
  if (transcribing.length > 0) {
    // Then the watcher, in the background, once the words are in: asking for
    // the subtitles later finds its answers cached.
    void (async () => {
      const started = Date.now();
      while (Date.now() - started < 3600 * 1000) {
        if (!transcribing.some((path) => app.media.status(path).transcript === "working")) break;
        await Bun.sleep(3000);
      }
      try {
        seams.watch.watchInBackground(app, id);
      } catch (error) {
        diag.warn("watch", `${id}: ${diag.messageOf(error)}`);
      }
    })();
  }
  return [live.rev, added, errors];
}

const COLORS: ClipColor[] = ["blue", "purple", "cyan", "green", "orange", "pink"];

/** Appends a media item after the last clip, linking picture and sound. */
export function placeAtEnd(project: Project, mediaId: string): void {
  const item = mediaOf(project, mediaId);
  if (item === undefined) return;
  const start = duration(project);
  const length = Math.max(Math.floor(item.duration * fps(project)), 1);
  const color = COLORS[Math.floor(project.clips.length / 2) % COLORS.length] ?? "blue";
  const videoTrack = project.tracks.find((track) => track.kind === "video")?.id;
  const audioTrack = project.tracks.find((track) => track.kind === "audio")?.id;
  const link = item.kind === "video" && item.has_audio ? freshId(project, "l") : undefined;
  if (item.kind !== "audio" && videoTrack !== undefined) {
    const clip: Clip = {
      id: freshId(project, "c"),
      track: videoTrack,
      start,
      duration: length,
      color,
      fade_in: 0,
      fade_out: 0,
      type: "video",
      media: item.id,
      source_in: 0,
      speed: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      opacity: 1,
    };
    if (link !== undefined) clip.link = link;
    project.clips.push(clip);
  }
  if (item.has_audio && audioTrack !== undefined) {
    const clip: Clip = {
      id: freshId(project, "c"),
      track: audioTrack,
      start,
      duration: length,
      color: item.kind === "audio" ? "green" : color,
      fade_in: 0,
      fade_out: 0,
      type: "audio",
      media: item.id,
      source_in: 0,
      speed: 1,
      volume_db: 0,
    };
    if (link !== undefined) clip.link = link;
    project.clips.push(clip);
  }
}

function isFile(path: string): boolean {
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A path as typed (`~/…` is the user's home), made absolute and real where it exists. */
export function realPath(path: string): string {
  return canonical(expandHome(path));
}
