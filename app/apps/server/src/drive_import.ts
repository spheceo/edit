// Footage from a Google Drive link (speed-plan 3.8): a subtitled video starts
// from the folder link the team shares ("the video and its Doc"), or a file's.
// The folder's videos are downloaded to this Mac (resuming, past Drive's
// virus-scan page: script.ts `download`) and imported as local files, so their
// upload to the cloud runs beside the proxy and exports read this copy
// (cloud_media `localOriginal`) instead of fetching the original back; the
// copy goes again a few days after it was last used (cache_cleanup.ts). Docs,
// notes and pictures in the folder are left alone: only the footage matters.

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { importPaths, type Imported } from "./import.ts";
import { curl, driveError, encode, quote } from "./library.ts";
import { join } from "./paths.ts";
import { serdeParse } from "./rust.ts";
import * as script from "./script.ts";

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

/**
 * Imports the footage a Drive link names (a folder's videos, or one file) into
 * project `id`, placed one after another when `place`. Throws when the link
 * is neither, or the folder has no video.
 */
export async function importDrive(app: App, id: string, url: string, place: boolean, origin: string): Promise<Imported> {
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
  return importPaths(app, id, paths, place, origin);
}
