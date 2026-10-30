// Footage that goes to the cloud without landing on this Mac (the user, Oct
// 30: "we still use the mac but we dont need to reserve the space for
// imports"). Each recording's original goes straight to Edit's originals (R2
// and the registry, as the handoff would have put it): a Drive file copied by
// the relay's cloud job or streamed through this Mac (cloud_media.driveOriginal),
// a YouTube video streamed from yt-dlp through FFmpeg into the upload. Only
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
import { ffmpeg } from "../tools.ts";
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
 * A YouTube video's original put in the cloud, streamed: yt-dlp writes the
 * video and its sound merged to its output, FFmpeg copies them into an MP4
 * that can be written as it goes, and that goes into the upload. A run that
 * fails part-way is deleted from the cloud and asked again by the next route
 * (straight, the proxy, the sign-in), as a download would be.
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
  const size = await youtube.streamWith(app.store.home, id, async (stdout, exited, route) => {
    // The video and its sound as yt-dlp merges them, copied into an MP4 written as it goes.
    const remux = Bun.spawn([ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1"], { stdin: stdout, stdout: "pipe", stderr: "pipe" });
    try {
      const sent = await cloud.uploadStream(cloud.streamSource(remux.stdout), key, null, (bytes) => onBytes(bytes));
      const [fetched, copied, said] = await Promise.all([exited, remux.exited, new Response(remux.stderr).text()]);
      // yt-dlp stopping part-way still ends its output: what went up is only part of the video.
      if (fetched !== 0) throw new Error(`yt-dlp stopped part-way (exit ${fetched})`);
      if (copied !== 0) throw new Error(`the copy into an MP4 failed: ${said.trim().split("\n").pop() ?? copied}`);
      if (sent === 0) throw new Error("nothing came down");
      return sent;
    } catch (error) {
      remux.kill();
      // Half a video is never left as the original.
      await cloud.remove([key]).catch(() => {});
      throw new Error(`${route}: ${diag.messageOf(error)}`);
    }
  });
  await cloud.mutation("edit:putMedia", { source, originalReady: true, size });
  keepShared(dir, null, source, key);
  diag.info("writer", `YouTube ${id} streamed to Edit's originals (${Math.round(size / 1e6)} MB), nothing kept on this Mac`);
  return { source, key, name, size, url: await cloud.presign(key, "GET", READ_SECONDS) };
}
