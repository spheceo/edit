// A link pasted in a chat, brought in whole (Sphe, Nov 11: "you should be able
// to paste a link along with your prompt, the agent pulls that link, downloads
// it and reports the progress to you and adds it according to how you want.
// Could be YouTube, drive, actual footage… anything and we shouldn't have a
// limit to the duration"). One road for both modes: `fetchLink` downloads a
// YouTube video, a Drive file or the video on any page yt-dlp reads (a post, a
// news player, a direct link to a file) into Edit's footage folder, where the
// script import keeps its own, so a video fetched once is never fetched again.
// Edit mode's `import_link` then brings it in as a dropped file is (uploads.ts,
// the cloud in cloud mode) and has Scribe hear all of it at once: it's one
// piece the person asked for, not hours to cut down, so no free first hearing
// (first_hearing.ts) comes before. Script mode's is writer/links.ts.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { importPaths } from "./import.ts";
import { registerTool, text } from "./mcp/registry.ts";
import { fileName, join } from "./paths.ts";
import * as progress from "./progress.ts";
import { download as driveDownload, driveFileId } from "./script.ts";
import * as seams from "./seams.ts";
import { stableStringify } from "./stable.ts";
import * as uploads from "./uploads.ts";
import * as youtube from "./youtube.ts";

export type Progress = (bytes: number, total: number | null, name: string) => void;

/** What a link is: a YouTube video, a Drive file, or any other page with a video on it. */
export type Link = { kind: "youtube"; id: string; url: string } | { kind: "drive"; id: string; url: string } | { kind: "page"; url: string };

/** A pasted link, read: trailing punctuation off, https only, a Drive folder or Doc refused with what to give instead. */
export function linkOf(raw: string): Link {
  const url = raw.trim().replace(/^<|>$/gu, "").replace(/[.,;:!?)\]]+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${url.slice(0, 200)} isn't a link`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Give an http or https link.");
  const video = youtube.videoId(url);
  if (video !== null) return { kind: "youtube", id: video, url: `https://www.youtube.com/watch?v=${video}` };
  const drive = driveFileId(url);
  if (drive !== null) return { kind: "drive", id: drive, url };
  const host = parsed.hostname.toLowerCase();
  if (host === "drive.google.com" && parsed.pathname.includes("/folders/")) throw new Error("That's a Drive folder: give the link of the one video in it.");
  if (host === "docs.google.com") throw new Error("That's a Google Doc, not a video: give the link of the video itself.");
  return { kind: "page", url };
}

/** A link's name until its download says better. */
function nameOf(link: Link): string {
  if (link.kind === "youtube") return `YouTube video ${link.id}`;
  if (link.kind === "drive") return `Drive file ${link.id}`;
  return new URL(link.url).hostname.replace(/^www\./u, "");
}

/**
 * Downloads `link` whole into Edit's footage folder (`store.driveDir()`, as
 * the script import does: the same video is the same file), with no length or
 * size limit, calling `progress(bytes, total, name)` as it goes. A finished
 * download is reused; a stopped one resumes where it can.
 */
export async function fetchLink(app: App, link: Link, progress: Progress): Promise<{ path: string; name: string }> {
  const root = app.store.driveDir();
  return await diag.timeOnAsync("links", "links: download", link.url, async () => {
    if (link.kind === "youtube") {
      const got = await youtube.download(app.store.home, link.id, join(root, "youtube", link.id), progress);
      return { path: got.path, name: got.name };
    }
    if (link.kind === "drive") {
      const path = await driveDownload(join(root, link.id), link.id, progress);
      return { path, name: fileName(path) ?? `${link.id}.mp4` };
    }
    const got = await youtube.downloadLink(app.store.home, link.url, join(root, "links", Bun.hash(link.url).toString(16)), progress);
    return { path: got.path, name: got.name };
  });
}

/** "1.2 of 3.4 GB, 35%"; "1.2 GB" with no total known. */
export function bytesSaid(bytes: number, total: number | null): string {
  const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
  if (total === null || total <= 0) return size(bytes);
  return `${size(bytes)} of ${size(total)}, ${Math.min(99, Math.floor((bytes / total) * 100))}%`;
}

/** How long the words may take to come once they've started (Scribe by link hears a long file in minutes; ten hours is its most). */
export const timing = { poll: 2000, wordsMs: 3 * 60 * 60_000, sleep: (ms: number) => Bun.sleep(ms) };

/**
 * Edit mode: `url` downloaded, brought into project `id` as a dropped file is
 * (converted when it must be, the cloud in cloud mode, listed with the
 * uploads), then heard whole by Scribe with the case's names. Says each stage
 * in `progress` (kind "link") for `wait` and get_edit_context.
 */
export async function bringIn(app: App, id: string, raw: string, part: string): Promise<Record<string, unknown>> {
  const link = linkOf(raw);
  let name = nameOf(link);
  progress.begin("link", id, part);
  let ok = false;
  try {
    progress.stage("link", id, part, "download", `downloading ${name}`);
    const got = await fetchLink(app, link, (bytes, total, called) => {
      if (called.trim() !== "") name = called.trim();
      progress.stage("link", id, part, "download", `downloading “${name}”: ${bytesSaid(bytes, total)}`, bytes, total ?? 0);
    });
    name = got.name;
    progress.stage("link", id, part, "import", `bringing “${name}” into the project${cloud.enabled() ? " and the cloud" : ""}`);
    const dir = app.store.uploadsDir(id);
    const how = await uploads.plan(got.path, join(dir, "converted"));
    if ("file" in how) throw new Error(`${link.url} gave ${name}, which isn't a video, a sound or a picture`);
    const [, added, errors] = await importPaths(app, id, [how.media], false, "link");
    const media = added[0];
    if (media === undefined) throw new Error(errors[0] ?? `${name} didn't import`);
    uploads.remember(dir, { at: Date.now(), name, media, file: null, ...(how.from === undefined ? {} : { from: how.from }) });
    const item = app.store.get(id)?.project.media.find((one) => one.id === media);
    if (item === undefined) throw new Error(`${name} didn't import`);
    // Cloud mode: footage edited from its proxy needs no copy here once its original is up (as a dropped file's);
    // converted, the download isn't kept beside the copy Edit reads.
    if (item.cloud !== undefined && item.cloud !== null && item.path !== how.media) seams.cloudMedia.removeWhenUploaded(how.media);
    if (how.from !== undefined) fs.rmSync(got.path, { force: true });
    const words = item.has_audio === true && item.kind !== "image" ? await hear(app, id, part, item.path, name) : "none: it has no sound";
    ok = true;
    return {
      media,
      name,
      kind: item.kind,
      duration: item.duration,
      url: link.url,
      words,
      next: "It isn't on the timeline yet. Put it where the person asked, as they asked (find what they described in its words: find_in_footage, media_transcript), and tell them where it went.",
    };
  } finally {
    progress.end("link", id, part, ok);
  }
}

/** Scribe hears all of `path` now (with the case's names), the link waiting until the words are in. */
async function hear(app: App, id: string, part: string, path: string, name: string): Promise<string> {
  progress.stage("link", id, part, "words", `being transcribed (“${name}”)`);
  const project = app.store.get(id)?.project;
  const names = project === undefined ? [] : seams.research.knownNames(app, project);
  let status = app.media.transcribe(path, true, names, false, false, true);
  const until = Date.now() + timing.wordsMs;
  while (status.transcript === "working" && Date.now() < until) {
    await timing.sleep(timing.poll);
    status = app.media.status(path);
  }
  if (status.transcript === "ready") return "ready";
  if (status.transcript === "working") return "still being heard: media_transcript will have them";
  return `failed: ${status.transcript_error ?? status.error ?? "the transcription stopped"}`;
}

registerTool("import_link", async ({ app, args, projectId }) => {
  if (typeof args.url !== "string" || args.url.trim() === "") throw new Error("url is required");
  const part = `link:${Bun.hash(args.url.trim()).toString(16)}`;
  return text(stableStringify(await bringIn(app, projectId, args.url, part), 2));
});
