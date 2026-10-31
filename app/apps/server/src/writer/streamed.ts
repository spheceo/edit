// Footage that goes to the cloud without landing on this Mac (the user, Oct
// 30: "we still use the mac but we dont need to reserve the space for
// imports"). Each recording's original goes straight to Edit's originals (R2
// and the registry, as the handoff would have put it): a Drive file copied by
// the relay's cloud job or streamed through this Mac (cloud_media.driveOriginal),
// a YouTube video downloaded by yt-dlp, uploaded and deleted here. Only
// the recording's 480p piece of the preview is made here, read back from the
// cloud copy; the words are heard from the preview (transcription.recordings
// does that for a recording with no file of its own) and the speakers watched
// in it. `edit-shared.json` says what's in the cloud, so the handoff shares
// the words and never uploads the footage again.

import * as fs from "node:fs";

import type { App } from "../app.ts";
import * as cloud from "../cloud.ts";
import * as cloudMedia from "../cloud_media.ts";
import * as diag from "../diag.ts";
import { join } from "../paths.ts";
import * as youtube from "../youtube.ts";
import { title as titleOf } from "./youtube.ts";
import type { Recording } from "./drive.ts";
import { keepShared, originalKey, segment } from "./handoff.ts";

/** Whether imports stream their footage to the cloud (`EDIT_STREAM_IMPORTS=0`: downloaded here, as before). */
export function on(): boolean {
  return process.env.EDIT_STREAM_IMPORTS !== "0" && cloud.enabled();
}

/** How long a cloud original's address works for the FFmpeg that reads it (a long recording's piece takes a while). */
const READ_SECONDS = 6 * 3600;

/** Where a recording's original is in the cloud, and an address FFmpeg reads it from. */
export interface InCloud {
  source: string;
  key: string;
  name: string;
  size: number;
  url: string;
}

/** A Drive recording's original put in the cloud (unless it's there already) and noted beside the script. */
export async function drive(dir: string, recording: Recording, onBytes: (bytes: number) => void): Promise<InCloud> {
  const scratch = join(dir, "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const put = await cloudMedia.driveOriginal(recording.id, scratch, (bytes) => onBytes(bytes));
  keepShared(dir, null, put.source, put.key);
  return { source: put.source, key: put.key, name: put.name, size: put.size, url: await cloud.presign(put.key, "GET", READ_SECONDS) };
}

/**
 * A YouTube video's original put in the cloud: downloaded by yt-dlp's own
 * downloader into this script's scratch folder (by the same routes, resuming
 * a stopped try, its bytes retried piece by piece), uploaded, and deleted
 * here. It was streamed through FFmpeg (`--downloader ffmpeg` to stdout,
 * Oct 30): one connection read at about the video's own speed, which nothing
 * could resume, so a single drop anywhere in a 25-minute video stopped the
 * whole import from the start (Oct 31, Kroger: "yt-dlp stopped part-way
 * (exit 1)" at 5%, on three Macs). The file is on this Mac only while it
 * goes up.
 */
export async function fromYoutube(app: App, dir: string, url: string, onBytes: (bytes: number) => void): Promise<InCloud> {
  const id = youtube.videoId(url);
  if (id === null) throw new Error(`${url} isn't a YouTube video link.`);
  const source = `${youtube.PREFIX}${id}`;
  const record = (await cloud.query("edit:getMedia", { source })) as { originalReady?: boolean; originalKey?: string; name?: string; size?: number } | null;
  if (record?.originalReady === true && typeof record.originalKey === "string") {
    keepShared(dir, null, source, record.originalKey);
    const size = Math.max(Math.trunc(record.size ?? 0), 0);
    onBytes(size);
    return { source, key: record.originalKey, name: record.name ?? `${id}.mp4`, size, url: await cloud.presign(record.originalKey, "GET", READ_SECONDS) };
  }
  const title = await titleOf(app, url).catch(() => id);
  const name = segment(`${title} [${id}].mp4`);
  const key = record !== null && typeof record.originalKey === "string" ? record.originalKey : originalKey(source, name);
  if (record === null) await cloud.mutation("edit:putMedia", { source, name, originalKey: key, size: 0 });
  const into = join(dir, "scratch", "youtube", id);
  let size: number;
  try {
    const got = await youtube.download(app.store.home, id, into, (bytes) => onBytes(bytes));
    size = got.size;
    await cloud.uploadFile(got.path, key, (sent) => onBytes(sent));
  } catch (error) {
    // Half a video is never left as the original.
    await cloud.remove([key]).catch(() => {});
    throw error;
  } finally {
    fs.rmSync(into, { recursive: true, force: true });
  }
  await cloud.mutation("edit:putMedia", { source, originalReady: true, size });
  keepShared(dir, null, source, key);
  diag.info("writer", `YouTube ${id} downloaded and put in Edit's originals (${Math.round(size / 1e6)} MB), nothing kept on this Mac`);
  return { source, key, name, size, url: await cloud.presign(key, "GET", READ_SECONDS) };
}
