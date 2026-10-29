// Google Drive footage, read as Repack reads it: with the team's Drive
// account, whose sign-in Edit's library holds (set on start), so Script mode
// lists a case folder, downloads its recordings and reads its PDFs as Edit
// reads its sound library.

import * as fs from "node:fs";

const API = "https://www.googleapis.com/drive/v3";
const MAX_ENTRIES = 1_000;
const VIDEO_EXT = ["mp4", "wmv", "mov", "mkv", "avi", "m4v", "webm"];
const AUDIO_EXT = ["mp3", "m4a", "wav", "aac", "ogg", "oga", "opus", "flac", "wma", "amr"];
const FIELDS = "id,name,mimeType,size,md5Checksum,shortcutDetails,trashed,videoMediaMetadata";

/** The team's Drive sign-in, an access token good for about an hour (Edit's library, set on start). */
export const hooks = { accessToken: (): Promise<string> => Promise.reject(new Error("Google Drive needs the team's sign-in.")) };

export type Link = { kind: "file"; id: string } | { kind: "folder"; id: string };

/** A drive.google.com file or folder link, as Repack accepts them. */
export function parse(given: string): Link {
  const url = given.trim();
  const rest = url.startsWith("https://") ? url.slice(8) : url.startsWith("http://") ? url.slice(7) : null;
  if (rest === null) throw new Error("Paste a Google Drive link.");
  const slash = rest.indexOf("/");
  const [host, tail] = slash < 0 ? [rest, ""] : [rest.slice(0, slash), rest.slice(slash + 1)];
  if (host !== "drive.google.com") throw new Error("Paste a drive.google.com link to a file or a folder.");
  const [path, query = ""] = tail.split("?", 2) as [string, string?];
  const after = (marker: string) => (path.includes(marker) ? (path.split(marker)[1]!.split("/")[0] ?? "") : null);
  const ok = (id: string) => id.length >= 10 && id.length <= 200 && /^[A-Za-z0-9_-]+$/.test(id);
  const folder = after("folders/");
  if (folder !== null) {
    if (!ok(folder)) throw new Error("That folder link is not complete.");
    return { kind: "folder", id: folder };
  }
  const file = after("file/d/");
  if (file !== null) {
    if (!ok(file)) throw new Error("That file link is not complete.");
    return { kind: "file", id: file };
  }
  const id = query.split("&").find((pair) => pair.startsWith("id="))?.slice(3) ?? "";
  if (ok(id)) return { kind: "file", id };
  throw new Error("Paste a Drive link to a video or to a folder of recordings.");
}

/** Whether `url` is a Drive link this reads. */
export function isDrive(url: string): boolean {
  try {
    parse(url);
    return true;
  } catch {
    return false;
  }
}

/** A Drive API call as JSON, with the refusals that matter said plainly. */
async function getJson(token: string, url: string): Promise<Record<string, unknown>> {
  let answer: Response;
  try {
    answer = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new Error(`Could not reach Google Drive (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (answer.status === 403 || answer.status === 404) throw new Error("Drive won't share that with Repack's Drive account. Share it with that account, then try again.");
  const text = await answer.text();
  if (!answer.ok) {
    let reason: unknown = null;
    try {
      reason = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    } catch {
      reason = null;
    }
    throw new Error(typeof reason === "string" ? `Google Drive said: ${reason}` : `Google Drive answered ${answer.status}.`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("Google Drive answered with something Edit can't read.");
  }
}

export interface Recording {
  id: string;
  name: string;
  size: number;
  audio: boolean;
  /** The length Drive reports, when it knows. */
  claimedMs?: number | null;
}

type DriveFile = { id?: string; name?: string; mimeType?: string; size?: string; md5Checksum?: string; shortcutDetails?: { targetId?: string; targetMimeType?: string }; videoMediaMetadata?: { durationMillis?: string | number } };

function claimed(file: DriveFile): number | null {
  const given = Number(file.videoMediaMetadata?.durationMillis);
  return Number.isFinite(given) && given >= 0 ? given : null;
}

/** Whether a file is a recording: false for video, true for sound alone, null for neither. */
function kind(name: string, mime: string): boolean | null {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (mime.startsWith("video/") || VIDEO_EXT.includes(ext)) return false;
  if (mime.startsWith("audio/") || AUDIO_EXT.includes(ext)) return true;
  return null;
}

/** A shortcut's target, or the file itself. */
const target = (file: DriveFile): [string, string] => (file.shortcutDetails?.targetId ? [file.shortcutDetails.targetId, file.shortcutDetails.targetMimeType ?? ""] : [file.id ?? "", file.mimeType ?? ""]);

/** Every file in a folder and its subfolders that `keep` takes, each once however often it was added, in name order. */
async function walk<T extends Recording>(token: string, folder: string, keep: (file: DriveFile, id: string, mime: string, name: string, size: number) => T | null): Promise<T[]> {
  const found: T[] = [];
  const seen = new Set<string>();
  const queue = [folder];
  let entries = 0;
  for (let parent = queue.pop(); parent !== undefined; parent = queue.pop()) {
    let page: string | null = null;
    do {
      const query = `${API}/files?q=%27${parent}%27+in+parents+and+trashed+%3D+false&fields=nextPageToken,files(${FIELDS})&pageSize=1000&includeItemsFromAllDrives=true&supportsAllDrives=true${page === null ? "" : `&pageToken=${encodeURIComponent(page)}`}`;
      const list = (await getJson(token, query)) as { files?: DriveFile[]; nextPageToken?: string };
      for (const file of list.files ?? []) {
        if (++entries > MAX_ENTRIES) throw new Error("That folder holds more than 1,000 items.");
        const [id, mime] = target(file);
        if (id === "") continue;
        if (mime === "application/vnd.google-apps.folder") {
          queue.push(id);
          continue;
        }
        const size = Number(file.size ?? 0) || 0;
        const kept = keep(file, id, mime, file.name ?? "", size);
        // The same recording added twice plays once.
        if (kept === null || seen.has(`${file.md5Checksum ?? id}:${size}`)) continue;
        seen.add(`${file.md5Checksum ?? id}:${size}`);
        found.push(kept);
      }
      page = list.nextPageToken ?? null;
    } while (page !== null);
  }
  return found.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The recordings behind a link and a title for them. A folder is one case: every video and audio file in it and its subfolders, in name order. */
export async function recordings(token: string, link: Link): Promise<[string, Recording[]]> {
  if (link.kind === "file") {
    const file = (await getJson(token, `${API}/files/${link.id}?fields=${FIELDS}&supportsAllDrives=true`)) as DriveFile;
    const [, mime] = target(file);
    const id = file.shortcutDetails?.targetId ?? link.id;
    const name = file.name ?? "Drive video";
    const audio = kind(name, mime);
    if (audio === null) throw new Error("That Drive file is not a video or audio recording.");
    return [stem(name), [{ id, name, size: Number(file.size ?? 0) || 0, audio, claimedMs: claimed(file) }]];
  }
  const folder = (await getJson(token, `${API}/files/${link.id}?fields=name&supportsAllDrives=true`)) as { name?: string };
  const found = await walk(token, link.id, (file, id, mime, name, size) => {
    const audio = kind(name, mime);
    return audio === null ? null : { id, name, size, audio, claimedMs: claimed(file) };
  });
  if (found.length === 0) throw new Error("That folder has no video or audio recordings.");
  return [folder.name ?? "Drive folder", found];
}

/** The PDFs in a case's folder and its subfolders (police reports, court papers), in name order. */
export function pdfs(token: string, folder: string): Promise<Recording[]> {
  return walk(token, folder, (_file, id, mime, name, size) => (mime === "application/pdf" || name.toLowerCase().endsWith(".pdf") ? { id, name, size, audio: false } : null));
}

export function stem(name: string): string {
  const at = name.lastIndexOf(".");
  return [...(at > 0 ? name.slice(0, at) : name)].slice(0, 180).join("");
}

/**
 * Streams one recording to `dest`, picking up from the bytes already there.
 * A connection that drops is resumed, up to four times. `onBytes` gets the
 * bytes written so far.
 */
export async function download(token: string, recording: Recording, dest: string, onBytes: (bytes: number) => void = () => {}, signal?: AbortSignal): Promise<void> {
  const url = `${API}/files/${recording.id}?alt=media&supportsAllDrives=true`;
  let problem = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    if (signal?.aborted) throw new Error("Stopped.");
    if (attempt > 0) await Bun.sleep(2_000 * attempt);
    const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    if (recording.size > 0 && have >= recording.size) break;
    let answer: Response;
    try {
      answer = await fetch(url, { headers: { authorization: `Bearer ${token}`, ...(have > 0 ? { range: `bytes=${have}-` } : {}) }, ...(signal ? { signal } : {}) });
    } catch (error) {
      if (signal?.aborted) throw error;
      problem = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (answer.status === 416) break;
    if ([401, 403, 404].includes(answer.status)) throw new Error(`Drive won't let Repack's account download ${recording.name}.`);
    if (!answer.ok || answer.body === null) {
      problem = `Google Drive answered ${answer.status}`;
      continue;
    }
    // A server that ignores the range sends the whole file again.
    const resumed = answer.status === 206;
    const out = fs.openSync(dest, resumed ? "a" : "w");
    let written = resumed ? have : 0;
    let finished = true;
    try {
      for await (const chunk of answer.body) {
        fs.writeSync(out, chunk);
        written += chunk.length;
        onBytes(written);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      problem = error instanceof Error ? error.message : String(error);
      finished = false;
    } finally {
      fs.closeSync(out);
    }
    if (finished) break;
  }
  const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  if (recording.size > 0 && size < recording.size) {
    throw new Error(`${recording.name} came down short (${Math.floor(size / 1_000_000)} of ${Math.floor(recording.size / 1_000_000)} MB).${problem === "" ? "" : ` Last problem: ${problem}.`}`);
  }
  // Drive answers some refusals with a small page instead of media.
  if (size < 4096) {
    const head = fs.readFileSync(dest).subarray(0, 1).toString();
    if (head === "{" || head === "<") throw new Error(`Drive sent a page instead of ${recording.name}.`);
  }
}

/** A Drive recording's page, which plays it from a moment with `t`. */
export const fileLink = (id: string): string => `https://drive.google.com/file/d/${id}/view`;
