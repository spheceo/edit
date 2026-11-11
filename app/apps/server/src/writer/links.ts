// A link in the producer's message to a built script (Sphe, Nov 11: "we are
// building a script and the agent has already put it together, we want to now,
// afterwards, add the YouTube link to the script and have the agent add it
// there"). Each video linked is downloaded whole (../links.ts, as Edit mode
// does: YouTube, a Drive file, any page with a video, no length limit),
// joined after the script's footage as a recording of its own (as a
// compilation's reused case is, reuse.ts), heard whole by Scribe at once (no
// free first hearing: it's one piece, wanted now) and its voices named. Then
// Claude revises the script on the message, told which video is new, so the
// footage goes where and how the producer asked. The job is one, so the
// chat says each step as it goes and the script is never edited twice at once.

import * as fs from "node:fs";

import type { Focus, Part, Word } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as editCloud from "../cloud.ts";
import * as diag from "../diag.ts";
import { bytesSaid, fetchLink, linkOf, type Link } from "../links.ts";
import { isFile, join, parent } from "../paths.ts";
import { footageFile } from "../script.ts";
import { keepShared, originalKey, sha256Of } from "./handoff.ts";
import * as chat from "./chat.ts";
import * as hearing from "./hearing.ts";
import { checkStopped, type Job, type Outcome } from "./jobs.ts";
import * as media from "./media.ts";
import { caseNames } from "./names.ts";
import { nameNewVoices } from "./reuse.ts";
import { reviseWith } from "./scripting.ts";
import * as storage from "./storage.ts";
import * as store from "./store.ts";
import { keepPeaks, readPeaks } from "./tidy.ts";
import { onClock } from "./transcription.ts";
import { THIS_MACHINE } from "../machine.ts";

const URL_IN_TEXT = /https?:\/\/[^\s<>"'\]]+/gu;

/** The video links in a message, each once: what a revision brings in before it's made. Docs and folders aren't videos; Writer's own links (a script, a review) aren't either. */
export function videoLinks(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(URL_IN_TEXT) ?? []) {
    let link: Link;
    try {
      link = linkOf(raw);
    } catch {
      continue;
    }
    const host = new URL(link.url).hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".ts.net") || host === "127.0.0.1" || host.endsWith("spheceo.com") || host.endsWith("trello.com")) continue;
    if (!out.includes(link.url)) out.push(link.url);
  }
  return out;
}

/** A recording's title from the file it came down as: "Bodycam 4 [abc].mp4" is "Bodycam 4". */
const titleOf = (name: string): string => name.replace(/\.[A-Za-z0-9]{2,4}$/u, "").replace(/\s*\[[^\]]+\]$/u, "").trim() || "Linked video";

/**
 * Brings the videos `urls` names into the script, then revises it on
 * `request`. A video already brought in (a restart after it was added) isn't
 * added again; one that can't be had is said in the answer, and the rest go on.
 */
export async function bringLinks(app: App, data: string, id: string, urls: string[], request: string, focus: Focus, job: Job): Promise<Outcome> {
  const dir = store.scriptDir(data, id);
  chat.asked(dir, request, job.resumed);
  const failed: string[] = [];
  const added: string[] = [];
  for (const [step, url] of urls.entries()) {
    checkStopped(job);
    const which = urls.length > 1 ? ` ${step + 1} of ${urls.length}` : "";
    try {
      const title = await addOne(app, dir, url, which, job);
      if (title !== null) added.push(title);
    } catch (error) {
      if (job.signal.aborted) throw error;
      diag.warn("writer", `${id}: ${url} couldn't be brought in: ${diag.messageOf(error)}`);
      failed.push(`${url} couldn't be brought in (${diag.messageOf(error)})`);
    }
  }
  const script = store.read(dir);
  const parts = script.parts ?? [];
  const unit = script.compilation ? "Video" : "Recording";
  const named = urls.flatMap((url) => {
    const at = parts.findIndex((part) => part.url === url && part.reuse === undefined);
    return at < 0 ? [] : [`${unit} ${at + 1} ("${parts[at]!.title}") is the footage from ${url}`];
  });
  const told = named.length === 0 ? request : `${request}\n\n(The footage linked here is in the script now, its words heard: ${named.join("; ")}. Use it as asked.)`;
  // What couldn't come in is said first, in its own line: the revision goes on with the rest.
  if (failed.length > 0) chat.add(dir, "editor", `${failed.join(". ")}.`, null, true);
  return await reviseWith(data, id, told, request, focus, false, { ...job, resumed: true });
}

/** One video joined onto the script's footage, heard and saved; its title, or null when the script had it already. */
async function addOne(app: App, dir: string, url: string, which: string, job: Job): Promise<string | null> {
  const script = store.read(dir);
  if (script.commentary) throw new Error("a commentary script takes its videos as sources");
  if ((script.parts ?? []).some((part) => part.url === url && part.reuse === undefined)) return null;
  // Joining onto the preview needs the file itself: back from the cloud if it was left there.
  const base = store.proxyPath(dir);
  if (!isFile(base)) await storage.bringBack(app, store.dataDir(app.store.home), script.id, job, true);
  if (!isFile(base)) throw new Error(`the preview isn't on ${THIS_MACHINE} or in the cloud: restore the footage first`);
  const link = linkOf(url);
  job.stage(`Downloading the linked video${which}`);
  const got = await fetchLink(app, link, (bytes, total, name) => job.stage(`Downloading “${titleOf(name)}”${which} · ${bytesSaid(bytes, total)}`));
  checkStopped(job);
  const title = titleOf(got.name);
  // Kept out of the cloud (a dot folder) until the footage is joined.
  const folder = join(dir, ".link");
  fs.mkdirSync(folder, { recursive: true });
  try {
    const found = await media.streams(got.path).catch(() => {
      throw new Error(`${title} couldn't be read as video or sound`);
    });
    const held = await media.playableMs(got.path, found.durationMs);
    const segment = join(folder, "segment.mp4");
    await media.joinLike([{ path: got.path, streams: { ...found, durationMs: held } }], segment, base, (percent) => job.stage(`Preparing “${title}” · ${percent}%`), job.signal);
    const joined = join(folder, "footage.mp4");
    job.stage(`Adding “${title}” to the footage`);
    await media.append(base, [segment], joined, (percent) => job.stage(`Adding “${title}” to the footage · ${percent}%`), job.signal);
    const lengthMs = (await media.streams(segment)).durationMs;
    // Heard whole by Scribe now, from the download itself (full quality), kept as the recording's own hearing.
    // Its place among the recordings: after Video 1 when the script had one recording and no parts yet.
    const index = Math.max((script.parts ?? []).length, 1);
    const key = `part-${String(index + 1).padStart(2, "0")}`;
    const work = join(dir, "transcript", key);
    const keyterms = await caseNames(dir, script).catch(() => []);
    job.stage(`Transcribing “${title}”`);
    const heard = found.audio ? await hearing.hear(got.path, null, work, keyterms, job.signal) : null;
    checkStopped(job);
    const startMs = script.durationMs;
    const words: Word[] = heard === null ? [] : onClock(heard, startMs, lengthMs, null).map((word) => ({ ...word, id: `w-${crypto.randomUUID()}` }));
    // Shared with Edit so Start the edit finds it on any Mac: a link Edit can fetch itself names it; any other is put in Edit's originals.
    const part: Part = { title, startMs, durationMs: lengthMs, audio: !found.video, url, ...(await shareOriginal(dir, url, got.path, got.name)) };
    // The sound, extended: each 20 ms of the new footage after the old.
    const resized = (values: ArrayLike<number>, length: number) => Array.from({ length }, (_, at) => values[at] ?? 0);
    const peaks = resized(readPeaks(dir) ?? (await media.peaks(base, job.signal).catch(() => new Float32Array())), Math.floor(script.durationMs / 20));
    peaks.push(...resized(await media.peaks(segment, job.signal).catch(() => new Float32Array()), Math.floor(lengthMs / 20)));
    // Into the script as it is now: only the footage, its words and sound are this job's to write.
    const now = store.read(dir);
    if (now.durationMs !== script.durationMs || (now.parts ?? []).length !== (script.parts ?? []).length || now.words.length !== script.words.length || now.revision !== script.revision) {
      throw new Error("the script changed while the video was coming in, so it wasn't added: ask again");
    }
    if ((now.parts ?? []).length === 0) now.parts = [{ title: now.title, startMs: 0, durationMs: now.durationMs, audio: !(await media.streams(base)).video, ...(now.sourceUrl ? { url: now.sourceUrl } : {}) }];
    if ((now.parts ?? []).length === 1) {
      // Its one recording heard as the whole file is kept under the name the first of several has, so it isn't heard again.
      const whole = join(dir, "transcript", "whole");
      const first = join(dir, "transcript", "part-01");
      if (fs.existsSync(whole) && !fs.existsSync(first)) fs.cpSync(whole, first, { recursive: true });
    }
    now.words.push(...words);
    now.parts = [...(now.parts ?? []), part];
    now.durationMs = Math.max((await media.streams(joined)).durationMs, startMs + lengthMs);
    now.originalPath = base;
    now.overview = media.overview(peaks, 800);
    // Heard exactly already: the exact pass doesn't hear it again.
    if (heard !== null) {
      if ((now.exact ?? []).length === 0) now.exactKeyterms = [...keyterms];
      now.exact = [...(now.exact ?? []), [startMs, startMs + lengthMs]];
    }
    if (words.length > 0) {
      job.stage(`Reading who speaks in “${title}”`);
      await nameNewVoices(now, dir, words.length, String(index + 1), job.signal);
    }
    checkStopped(job);
    if (store.read(dir).revision !== now.revision) throw new Error("the script changed while the video was being heard: ask again (the download and its words are kept)");
    fs.renameSync(joined, base);
    keepPeaks(dir, peaks);
    now.revision++;
    now.updatedAt = Date.now();
    store.write(dir, now);
    diag.info("writer", `${now.id}: brought in ${url} as Video ${index + 1} (${title}, ${Math.round(lengthMs / 1000)} s, ${words.length} words)`);
    // With the cloud on, the download isn't kept here: the script plays its preview, Edit fetches the link
    // (or its original, shared above) when the edit starts, and hours of footage never sit on this disk.
    if (editCloud.enabled()) fs.rmSync(parent(got.path) ?? got.path, { recursive: true, force: true });
    return title;
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/** Where Edit finds a linked recording: nothing more for a link it fetches itself (YouTube, Drive, a post); else its original in Edit's originals, by its content. */
async function shareOriginal(dir: string, url: string, path: string, name: string): Promise<Pick<Part, "mediaSource" | "originalKey">> {
  if (footageFile(url) !== null || !editCloud.enabled()) return {};
  const source = `sha256:${await sha256Of(path)}`;
  const size = fs.statSync(path).size;
  let record = (await editCloud.query("edit:getMedia", { source })) as Record<string, unknown> | null;
  const key = typeof record?.originalKey === "string" ? record.originalKey : originalKey(source, name);
  if (record?.originalReady !== true) {
    if (record === null) await editCloud.mutation("edit:putMedia", { source, name, originalKey: key, size });
    await editCloud.uploadFile(path, key);
    record = (await editCloud.mutation("edit:putMedia", { source, originalReady: true, size })) as Record<string, unknown> | null;
  }
  keepShared(dir, null, source, key);
  return { mediaSource: source, originalKey: key };
}
