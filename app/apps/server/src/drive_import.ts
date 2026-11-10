// Footage from a Google Drive link (speed-plan 3.8): a subtitled video starts
// from the folder link the team shares ("the video and its Doc"), or a file's.
// The folder's videos are downloaded to this Mac (resuming, past Drive's
// virus-scan page: script.ts `download`) and imported as local files, so their
// upload to the cloud runs beside the proxy and exports read this copy
// (cloud_media `localOriginal`) instead of fetching the original back; the
// copy goes again a few days after it was last used (cache_cleanup.ts). Docs,
// notes and pictures in the folder are left alone: only the footage matters.

import { createHash } from "node:crypto";
import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import * as jobs from "./jobs.ts";
import { importPaths, placeAtEnd, type Imported } from "./import.ts";
import { startsWith } from "./paths.ts";
import * as seams from "./seams.ts";
import { curl, driveError, encode, quote } from "./library.ts";
import { join } from "./paths.ts";
import { serdeParse } from "./rust.ts";
import * as script from "./script.ts";
import * as uploads from "./uploads.ts";

const API = "https://www.googleapis.com/drive/v3";

/** The folder id in a Drive folder link (`/drive/folders/ID`, `/drive/u/0/folders/ID`). */
export function folderId(url: string): string | null {
  if (!url.includes("drive.google.com")) return null;
  const match = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(url);
  return match === null ? null : match[1]!;
}

/** A folder's videos (id, name), by name. */
export async function videosIn(app: App, folder: string): Promise<{ id: string; name: string }[]> {
  const files: { id: string; name: string; mimeType: string }[] = [];
  let page = "";
  for (;;) {
    const query = `'${folder}' in parents and trashed = false`;
    let url = `${API}/files?q=${encode(query)}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=nextPageToken,files(id,name,mimeType)`;
    if (page !== "") url += `&pageToken=${encode(page)}`;
    const config = `header = ${quote(`Authorization: Bearer ${await app.library.accessToken()}`)}\n`;
    const [code, body] = await curl(config, ["--max-time", "60", url]);
    const text = new TextDecoder().decode(body);
    if (code !== 200) throw new Error(driveError(code, text));
    const value = serdeParse(text) as { files?: unknown; nextPageToken?: unknown } | null;
    if (Array.isArray(value?.files)) files.push(...(value.files as typeof files));
    if (typeof value?.nextPageToken === "string") page = value.nextPageToken;
    else break;
  }
  return files
    .filter((file) => typeof file.mimeType === "string" && file.mimeType.startsWith("video/"))
    .map((file) => ({ id: file.id, name: file.name }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The import's job key: one per project and link. */
function part(url: string): string {
  return createHash("sha256").update(url.trim()).digest("hex").slice(0, 16);
}

export function importKey(id: string, url: string): string {
  return jobs.keyOf("footage", id, part(url));
}

/** Imports going now, by job key: the same link pasted again into the same project waits for the one going. */
const going = new Map<string, Promise<Imported>>();

/** Drive links importing now. */
export const importing = (): boolean => going.size > 0;

/**
 * Imports the footage a Drive link names (a folder's videos, or one file) into
 * project `id`, placed one after another when `place`. Throws when the link
 * is neither, or the folder has no video.
 *
 * A job in jobs.json from the start (kind `footage`; Sphe, Nov 10: an update
 * goes through at any time, and what it cuts carries on), so a restart
 * meanwhile carries it on by itself: its downloads resume from what they kept,
 * and the footage is placed once (`resumeImport`). It was a counter inside
 * the request, and the person had to paste the link again. What fails while
 * Edit restarts itself isn't written (jobs.freeze), so the job stays as it was.
 */
export function importDrive(app: App, id: string, url: string, place: boolean, origin: string): Promise<Imported> {
  const key = importKey(id, url);
  const already = going.get(key);
  if (already !== undefined) return already;
  jobs.begin(app.store.home, "footage", id, { url, place, origin }, part(url), "downloading");
  return run(app, key, id, url, place, origin, false);
}

/**
 * A Drive import a restart cut short, carried on in the background: from its
 * downloads (they resume), or, when its footage was already added, only the
 * noting of what was added. Footage a cut import already put on the timeline
 * isn't put there again.
 */
export function resumeImport(app: App, job: jobs.Job): void {
  const { url, place, origin, media, paths, whole } = job.args as { url?: unknown; place?: unknown; origin?: unknown; media?: unknown; paths?: unknown; whole?: unknown };
  if (typeof url !== "string") throw new jobs.Gone("no link kept");
  if (going.has(job.key)) return;
  const from = typeof origin === "string" ? origin : "";
  if (job.step === "added" && Array.isArray(media) && Array.isArray(paths)) {
    finish(app, job.key, job.project, media as string[], paths as string[], whole === true, true);
    return;
  }
  void run(app, job.key, job.project, url, place !== false, from, true).catch((error: unknown) =>
    diag.warn("drive", `${job.project}: the Drive footage a restart cut off didn't come in: ${diag.messageOf(error)}`),
  );
}

function run(app: App, key: string, id: string, url: string, place: boolean, origin: string, resumed: boolean): Promise<Imported> {
  // Failed, it ends (the person is told); cut by Edit restarting itself, the table is frozen and it stays for the next run.
  const work = importDriveNow(app, key, id, url, place, origin, resumed).catch((error: unknown) => {
    jobs.end(app.store.home, key);
    throw error;
  });
  going.set(key, work);
  const done = () => {
    if (going.get(key) === work) going.delete(key);
  };
  work.then(done, done);
  return work;
}

async function importDriveNow(app: App, key: string, id: string, url: string, place: boolean, origin: string, resumed: boolean): Promise<Imported> {
  const home = app.store.home;
  const folder = folderId(url);
  const file = folder === null ? script.driveFileId(url) : null;
  if (folder === null && file === null) throw new Error("that isn't a Google Drive folder or file link");
  const files = folder !== null ? await videosIn(app, folder) : [{ id: file!, name: file! }];
  if (files.length === 0) throw new Error("there's no video in that Drive folder");
  const paths: string[] = [];
  for (const one of files) {
    const dir = join(app.store.uploadsDir(id), "drive", one.id);
    const path = await diag.timeOnAsync("drive", "drive: download footage", one.name, () => script.download(dir, one.id, () => {}));
    paths.push(path);
  }
  jobs.step(home, key, "importing", { paths });
  // Carried on after a restart: what the cut import put on the timeline stays where it is, and only the rest is
  // placed (a media item is added once per file either way: import.ts addMedia). Into a timeline still empty, all of it as at first.
  const before = app.store.get(id)?.project ?? null;
  const placeAll = place && (!resumed || before === null || before.clips.length === 0);
  let imported = await importPaths(app, id, paths, placeAll, origin);
  if (place && !placeAll) {
    const [live] = await app.store.update(id, origin, (project) => {
      for (const media of imported[1]) {
        if (!project.clips.some((clip) => "media" in clip && clip.media === media)) placeAtEnd(project, media);
      }
    });
    imported = [live.rev, imported[1], imported[2]];
  }
  const whole = imported[2].length === 0;
  jobs.step(home, key, "added", { media: imported[1], paths, whole });
  finish(app, key, id, imported[1], paths, whole, resumed);
  return imported;
}

/**
 * What the person added, noted for the agent's context (uploads.ts), and the
 * staging copies let go once their uploads are verified; then the job ends.
 * Carried on (`again`), what was already noted isn't noted twice.
 */
function finish(app: App, key: string, id: string, added: string[], paths: string[], whole: boolean, again: boolean): void {
  const project = app.store.get(id)?.project ?? null;
  try {
    const dir = app.store.uploadsDir(id);
    const noted = again ? new Set(uploads.list(dir).map((one) => one.media)) : new Set<string | null>();
    for (const mediaId of added) {
      if (noted.has(mediaId)) continue;
      uploads.remember(dir, { at: Date.now(), name: project?.media.find((one) => one.id === mediaId)?.name ?? mediaId, media: mediaId, file: null });
    }
  } catch (error) {
    diag.warn("upload", `noting what was added: ${diag.messageOf(error)}`);
  }
  // Upload-once: Edit's downloaded staging copies go once their uploads are
  // verified in the cloud (the import's background upload). A failed or
  // pending upload keeps its copy — it may be the only one.
  if (whole) {
    const root = app.store.uploadsDir(id);
    for (const path of paths) {
      void seams.cloudMedia.uploaded(path).then((ok) => { if (ok) removeStagedCopy(path, root); });
    }
  }
  jobs.end(app.store.home, key);
}

/** Deletes a Drive staging copy under `root` (Edit's own copy only). Whether it went. */
export function removeStagedCopy(path: string, root: string): boolean {
  if (!startsWith(path, `${root}/`)) return false;
  try { fs.rmSync(path, { force: true }); return !fs.existsSync(path); } catch { return false; }
}
