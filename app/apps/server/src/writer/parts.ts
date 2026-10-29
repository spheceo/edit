// Where a joined script's recordings live: a Drive case folder's listing and
// what the producer chose from it (`drive/manifest.json`), or a
// compilation's videos (`compilation/videos.json`), each recording's own
// file beside them, and the link and registry name each came from. Kept
// beside the downloads so a retry neither lists the folder again nor asks
// again.

import * as fs from "node:fs";

import type { Script } from "@edit/types/writer";

import { writeAtomic } from "../files.ts";
import { isFile, join } from "../paths.ts";
import { videoId } from "../youtube.ts";
import { fileLink, parse as driveLink, type Recording } from "./drive.ts";

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** A Drive case's recordings as first listed, and what the producer chose. */
export interface Manifest {
  recordings: Recording[];
  chosen?: string[] | null;
  skipped: string[];
}

export const manifestPath = (dir: string): string => join(dir, "drive", "manifest.json");

export function readManifest(dir: string): Manifest | null {
  const found = readJson<Manifest>(manifestPath(dir));
  return found === null ? null : { ...found, skipped: found.skipped ?? [] };
}

export function writeManifest(dir: string, manifest: Manifest): void {
  fs.mkdirSync(join(dir, "drive"), { recursive: true });
  writeAtomic(manifestPath(dir), JSON.stringify(manifest, null, 2));
}

/** The recordings to import, with their place in the first listing, which names their files on disk and so never changes. */
export const wanted = (manifest: Manifest): [number, Recording][] =>
  manifest.recordings.flatMap((recording, index): [number, Recording][] => ((manifest.chosen == null || manifest.chosen.includes(recording.id)) && !manifest.skipped.includes(recording.id) ? [[index, recording]] : []));

/** A recording's file in its folder: its place in the listing and its own extension. */
export function driveFile(folder: string, index: number, recording: Recording): string {
  const ext = recording.name.includes(".") ? recording.name.split(".").pop()!.toLowerCase() : "";
  return join(folder, `${String(index).padStart(2, "0")}.${ext.length > 0 && ext.length <= 5 && /^[a-z0-9]+$/.test(ext) ? ext : "mp4"}`);
}

/** A compilation's videos, one case each, as the producer listed them. */
export interface Videos {
  videos: { url: string; title: string }[];
  skipped: string[];
}

export function readVideos(dir: string): Videos | null {
  const found = readJson<Videos>(join(dir, "compilation", "videos.json"));
  return found === null ? null : { ...found, skipped: found.skipped ?? [] };
}

export function writeVideos(dir: string, videos: Videos): void {
  fs.mkdirSync(join(dir, "compilation"), { recursive: true });
  writeAtomic(join(dir, "compilation", "videos.json"), JSON.stringify(videos, null, 2));
}

const keptVideos = (videos: Videos): [number, Videos["videos"][number]][] => videos.videos.flatMap((video, index): [number, typeof video][] => (videos.skipped.includes(String(index)) ? [] : [[index, video]]));

/** Where each recording's own file belongs on this Mac, in the order of the script's parts (a reused case's footage, joined later, has none). */
export function partTargets(dir: string, script: Script): (string | null)[] {
  let files: string[];
  if (script.sourceKind === "compilation") {
    const videos = readVideos(dir);
    if (videos === null) return [];
    files = keptVideos(videos).map(([index]) => join(dir, "compilation", `${String(index).padStart(2, "0")}.mp4`));
  } else if (script.sourceKind === "drive") {
    const manifest = readManifest(dir);
    if (manifest === null) return [];
    files = wanted(manifest).map(([index, recording]) => driveFile(join(dir, "drive"), index, recording));
  } else return [];
  return (script.parts ?? []).map((part, index) => (part.reuse ? null : (files[index] ?? null)));
}

/** Each recording's own file, where it is kept on this Mac. */
export const partFiles = (dir: string, script: Script): (string | null)[] => partTargets(dir, script).map((file) => (file !== null && isFile(file) ? file : null));

/**
 * Where each of the script's recordings comes from, as Edit's footage
 * registry names it (`drive:<file id>`, `youtube:<video id>`), with its file
 * name. Null for a file from disk or a reused case.
 */
export function partSources(dir: string, script: Script): ([string, string] | null)[] {
  const ofLink = (url: string, title: string): [string, string] | null => {
    try {
      const link = driveLink(url);
      if (link.kind === "file") return [`drive:${link.id}`, `${title}.mp4`];
    } catch {
      // Not a Drive file.
    }
    // Named as Edit names its downloads: "<title> [<id>].mp4", the title without Writer's "(channel, link)".
    const at = title.lastIndexOf(" (");
    const name = at >= 0 && title.slice(at).includes("http") ? title.slice(0, at) : title;
    const id = videoId(url);
    return id === null ? null : [`youtube:${id}`, `${[...name].slice(0, 120).join("").trim()} [${id}].mp4`];
  };
  const parts = script.parts ?? [];
  let listed: ([string, string] | null)[];
  if (script.sourceKind === "drive") {
    const manifest = readManifest(dir);
    listed = manifest === null ? [ofLink(script.sourceUrl, script.title)] : wanted(manifest).map(([, recording]) => [`drive:${recording.id}`, recording.name]);
  } else if (script.sourceKind === "compilation") {
    const videos = readVideos(dir);
    listed = videos === null ? [] : keptVideos(videos).map(([, video]) => ofLink(video.url, video.title));
  } else if (script.sourceKind === "youtube") listed = [ofLink(script.sourceUrl, script.title)];
  else listed = [null];
  parts.forEach((part, index) => {
    if (part.mediaSource && part.originalKey && index < listed.length) listed[index] = [part.mediaSource, part.originalKey.split("/").pop() ?? "case.mp4"];
  });
  if (parts.length <= 1) return [listed[0] ?? null];
  return parts.map((part, index) => (part.reuse ? null : (listed[index] ?? null)));
}

/** The links of a joined script's recordings, in play order; null when they no longer line up with its parts. */
export function partLinks(dir: string, script: Script): string[] | null {
  let links: string[];
  if (script.sourceKind === "compilation") {
    const videos = readVideos(dir);
    if (videos === null) return null;
    links = keptVideos(videos).map(([, video]) => video.url);
  } else if (script.sourceKind === "drive") {
    const manifest = readManifest(dir);
    if (manifest === null) return null;
    links = wanted(manifest).map(([, recording]) => fileLink(recording.id));
  } else return null;
  return links.length === (script.parts ?? []).length ? links : null;
}
