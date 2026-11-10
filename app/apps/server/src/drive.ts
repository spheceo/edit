// Exports on the team's Google Drive. A whole export of a
// subtitled video is uploaded to the "Subtitles" folder (Repack's, where its
// own renders go); a normal edit isn't (it's downloaded from Edit; "Render"
// is only where one went before, Oct 17). Anyone with the link may view it, and the
// project keeps the link (`project.drive`) for as long as the file is on
// Drive: when the UI shows the link it asks the server, which checks the file
// still exists and clears the link when it was deleted or trashed. Edit never
// deletes a file on Drive; a re-export sends new contents to the file it made
// before (same link), or a new file when that one is gone.
//
// The sign-in is the sound library's (`Library.accessToken`), and like it
// every request goes through curl with the token on stdin.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import * as jobs from "./jobs.ts";
import { googleProto, google } from "./endpoints.ts";
import { ioMessage, nowMs } from "./files.ts";
import { catchBugsAsync } from "./guard.ts";
import { curl, encode, quote } from "./library.ts";
import type { DriveFile, ExportOptions, Plan, Project } from "./model.ts";
import { extension } from "./paths.ts";
import { duration } from "./project.ts";
import { f32, trim } from "./rust.ts";
import type { Library } from "./seams.ts";
import { stableStringify } from "./stable.ts";
import { isSubtitled, type Store } from "./store.ts";

/** "Subtitles" (My Drive / [03] Media / Repack / Subtitles): subtitled videos. */
const SUBTITLES_FOLDER = "12q4jbYhXI53BYZtTwOxzFEOJV2d1wJTk";
/** "Render": every other edit. */
const RENDER_FOLDER = "15Fp5Zq_RKwYRohpE5t_uEho8T2Q1RwwL";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
/** A link checked this recently isn't checked again. */
const CHECKED_FOR_MS = 5 * 60 * 1000;

/** How long things take (tests make the retry pauses instant). */
export const timing = {
  sleep: (ms: number) => Bun.sleep(ms),
  now: () => performance.now(),
};

/**
 * Uploads running, by project: the newest one's number, so an older upload
 * finishing late doesn't replace the newer one's link.
 */
const uploads = new Map<string, number>();
let nextUpload = 0;
/** When each file was last found on Drive. */
const checkedAt = new Map<string, number>();

/** Where a project's exports go: subtitled videos to Subtitles, the rest to Render. */
export function folder(subtitled: boolean): string {
  const [variable, fallback] = subtitled
    ? ["EDIT_SUBTITLES_FOLDER", SUBTITLES_FOLDER]
    : ["EDIT_RENDER_FOLDER", RENDER_FOLDER];
  const given = process.env[variable];
  return given !== undefined && given !== "" ? given : fallback;
}

/** Where a Drive file opens. */
export function viewUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

/** The file's name on Drive: the project's, without a " (subtitles)" ending. */
export function uploadName(project: string, ext: string): string {
  let name = trim(project);
  for (const ending of ["(subtitles)", "(Subtitles)"]) {
    if (name.endsWith(ending)) {
      name = name.slice(0, name.length - ending.length).replace(/\p{White_Space}+$/u, "");
      break;
    }
  }
  return `${name === "" ? "Edit" : name}.${ext}`;
}

/**
 * Whether a subtitled video's Repack-style subtitles are in it (no label,
 * named for their person), or it's only footage and subtitles.
 */
export function subtitleVideo(project: Project): boolean {
  // An edit (narration, voice-overs) is never one, Repack-style subtitles or
  // not: the interrogation demo (an edit with repack_subtitles) started
  // uploading its 7.7 GB export to the team's Subtitles folder.
  const edit =
    (project.script?.blocks ?? []).some((block) => block.kind === "narration") || project.clips.some((clip) => clip.name === "Voice-over");
  return (
    isSubtitled(project) ||
    (!edit && project.clips.some((clip) => clip.type === "text" && (clip.name ?? "").startsWith("Subtitle · ") && clip.style.label == null))
  );
}

/**
 * Whether an export is uploaded: a video file (MP4 or MOV) of all of a
 * subtitled video, for Repack's "Subtitles" folder. A normal edit isn't
 * uploaded (decided Oct 17): it's downloaded from Edit, on the Mac or over
 * Tailscale, from the project's exports.
 */
export function wanted(project: Project, options: ExportOptions, plan: Plan): boolean {
  const total = duration(project);
  return (
    subtitleVideo(project) &&
    (options.format === "h264" || options.format === "hevc" || options.format === "prores") &&
    plan.start === 0 &&
    plan.end >= total &&
    total > 0
  );
}

/** Whether any upload is running (an update waits for it), or project `id`'s. */
export function uploading(id?: string): boolean {
  return id === undefined ? uploads.size > 0 : uploads.has(id);
}

export function mime(path: string): string {
  return extension(path)?.toLowerCase() === "mov" ? "video/quicktime" : "video/mp4";
}

/**
 * Uploads `path` (an export of `project`) in the background, reporting to the
 * UI as `{type: "drive", id, state: uploading | done | failed, progress, url, error}`
 * events, and on success links the project to it.
 */
export function start(store: Store, library: Library, project: Project, path: string): void {
  const id = project.id;
  const ext = (extension(path) ?? "mp4").toLowerCase();
  const name = uploadName(project.name, ext);
  // A re-export replaces the file it made before, so its link stays the same.
  const replacing = project.drive?.file_id ?? null;
  const into = folder(subtitleVideo(project));
  nextUpload += 1;
  const number = nextUpload;
  // The upload session a restart cut short, kept with its job: carried on from what Drive has (Sphe, Nov 10: an update
  // goes through at any time; the whole file was sent again, and a first upload cut after Drive had it made a second file).
  const listed = jobs.get(store.home, jobs.keyOf("drive", id));
  const saved = listed !== undefined && listed.args.path === path ? keptSession(listed.args.session) : null;
  const job = jobs.begin(store.home, "drive", id, { path, ...(saved === null ? {} : { session: saved }) });
  const keep = { saved, save: (session: Session | null) => jobs.patch(store.home, job, { session }) };
  uploads.set(id, number);
  const emit = (state: string, extra: Record<string, unknown>) => {
    // Keys sorted, as events always were.
    const event: Record<string, unknown> = { type: "drive", id, state, name, ...extra };
    store.emit(JSON.parse(stableStringify(event)) as Record<string, unknown>);
  };
  void (async () => {
    emit("uploading", { progress: 0.0 });
    const subject = `${path} (${id})`;
    let file: DriveFile | null = null;
    let failure: string | null = null;
    try {
      file = await diag.timeOnAsync("drive", "drive upload", subject, () =>
        catchBugsAsync("the Drive upload", () =>
          upload(library, path, name, into, replacing, (progress) => emit("uploading", { progress }), keep),
        ),
      );
      if (uploads.get(id) === number) {
        const made = file;
        await store.update(id, "drive", (edited) => {
          edited.drive = made;
        });
      }
    } catch (error) {
      failure = diag.messageOf(error);
    }
    if (failure === null && file !== null) {
      diag.info("drive", `uploaded ${path} to Drive`);
      checkedAt.set(file.file_id, timing.now());
      emit("done", { progress: 1.0, url: file.url });
    } else {
      emit("failed", { error: failure });
    }
    if (uploads.get(id) === number) uploads.delete(id);
    jobs.end(store.home, job);
  })();
}

/** A resumable upload session, kept with its job so a restart carries it on: for this file as it was (size, mtime). */
export interface Session {
  uri: string;
  size: number;
  mtime_ms: number;
  /** The file the session sends new contents to, or null for a new file in the folder. */
  replacing: string | null;
}

/** A session kept in a job's args, when it reads as one. */
function keptSession(value: unknown): Session | null {
  const session = value as Partial<Session> | null | undefined;
  if (typeof session?.uri !== "string" || typeof session.size !== "number" || typeof session.mtime_ms !== "number") return null;
  return { uri: session.uri, size: session.size, mtime_ms: session.mtime_ms, replacing: typeof session.replacing === "string" ? session.replacing : null };
}

/** Where an upload's session is kept: the one a restart cut short, and how a new one is noted (null: none to carry on). */
export interface Keep {
  saved: Session | null;
  save(session: Session | null): void;
}

/**
 * Drive's resumable upload: a session for the file in the folder (or for new
 * contents of `replacing`, keeping its link; a new file if that one is gone),
 * then its bytes streamed from disk, then a link anyone can view. The session
 * is kept (`keep`) as soon as Drive gives it, and asked first after a cut
 * (a restart, a dropped connection): an upload Drive finished isn't sent
 * again, nor made a second file, and one part-way carries on from what Drive has.
 */
export async function upload(
  library: Library,
  path: string,
  name: string,
  into: string,
  replacing: string | null,
  progress: (share: number) => void,
  keep: Keep = { saved: null, save: () => {} },
): Promise<DriveFile> {
  let size: number;
  let mtime: number;
  try {
    const stat = fs.statSync(path);
    size = stat.size;
    mtime = stat.mtimeMs;
  } catch (error) {
    throw new Error(`can't read ${path}: ${ioMessage(error)}`);
  }
  const type = mime(path);
  const session = async (replace: string | null): Promise<[number, string]> => {
    const metadata = stableStringify(replace !== null ? { name } : { name, parents: [into] });
    const config =
      [
        `Authorization: Bearer ${await library.accessToken()}`,
        "Content-Type: application/json; charset=UTF-8",
        `X-Upload-Content-Type: ${type}`,
        `X-Upload-Content-Length: ${size}`,
      ]
        .map((header) => `header = ${quote(header)}\n`)
        .join("") + `data-binary = ${quote(metadata)}\n`;
    const [url, method] =
      replace !== null
        ? [`${UPLOAD}/${encode(replace)}?uploadType=resumable&supportsAllDrives=true&fields=id`, "PATCH"]
        : [`${UPLOAD}?uploadType=resumable&supportsAllDrives=true&fields=id`, "POST"];
    const [code, answer] = await curl(config, ["--max-time", "60", "-X", method, "-D", "-", url]);
    return [code, new TextDecoder().decode(answer)];
  };
  let replaced = replacing !== null;
  // The session kept for this very file (a restart cut it short), else none yet.
  let current = keep.saved !== null && keep.saved.size === size && keep.saved.mtime_ms === mtime ? keep.saved : null;
  // A dropped connection or a busy Drive mid-upload carries on in the same
  // session from what Drive has (a few times), rather than failing the export
  // and leaving the user to upload by hand.
  let tries = 0;
  let code = 0;
  let body = "";
  for (;;) {
    tries += 1;
    let sent: [number, string] | null = null;
    let error: unknown = null;
    try {
      let from = 0;
      let address: string | null = null;
      if (current !== null) {
        const where = await ask(current.uri, size);
        if ("done" in where) {
          // Drive has it all: its answer is the upload's, and nothing is sent again.
          replaced = current.replacing !== null;
          sent = where.done;
        } else if (where.from !== null && where.from < size) {
          replaced = current.replacing !== null;
          address = current.uri;
          from = where.from;
        } else {
          current = null;
          keep.save(null);
        }
      }
      if (sent === null && address === null) {
        let [answered, answer] = await session(replaced ? replacing : null);
        if (replaced && answered === 404) {
          // Deleted on Drive since: a new file, and a new link.
          [answered, answer] = await session(null);
          replaced = false;
        }
        if (answered !== 200) throw new Fatal(driveError(answered, bodyOf(answer)));
        address = location(answer);
        if (address === null) throw new Fatal("Google Drive didn't start the upload");
        // Kept before a byte goes, so a restart from here asks this session and never starts a second file.
        current = { uri: address, size, mtime_ms: mtime, replacing: replaced ? replacing : null };
        keep.save(current);
      }
      if (sent === null && address !== null) {
        if (from > 0) diag.info("drive", `uploading ${name}: carrying on from ${from} of ${size} bytes`);
        sent = await put(address, path, type, progress, from);
      }
    } catch (thrown) {
      if (thrown instanceof Fatal) throw new Error(thrown.message);
      error = thrown;
    }
    // 308: Drive has only part of it; the next try asks the session how much.
    const retry = sent === null || sent[0] === 429 || sent[0] >= 500 || sent[0] === 0 || sent[0] === 308;
    if (!retry || tries >= 3) {
      if (sent === null) throw error;
      [code, body] = sent;
      break;
    }
    const said = sent === null ? diag.messageOf(error) : driveError(sent[0], sent[1]);
    diag.warn("drive", `uploading ${name}, try ${tries}: ${said}; trying again`);
    await timing.sleep(2000 * tries);
  }
  if (!(code >= 200 && code < 300)) throw new Error(driveError(code, body));
  let fileId: string | null = null;
  try {
    const value = JSON.parse(body) as { id?: unknown } | null;
    fileId = typeof value?.id === "string" ? value.id : null;
  } catch {
    fileId = null;
  }
  if (fileId === null) throw new Error("Google Drive didn't say what the uploaded file is");
  // A replaced file's link was shared when it was first uploaded.
  if (!replaced) {
    try {
      await share(library, fileId);
    } catch (error) {
      // The team still sees it in the folder; only the link for others fails.
      diag.warn("drive", `sharing ${name} (${fileId}) by link: ${diag.messageOf(error)}`);
    }
  }
  return { file_id: fileId, url: viewUrl(fileId), name, uploaded_ms: nowMs() };
}

/** What fails an upload at once: Drive refused to start it (not tried again). */
class Fatal extends Error {}

/**
 * Where a kept upload session is (Drive's status check: an empty PUT saying
 * only the size): done, with Drive's answer (the file); part-way, from the
 * byte Drive has up to (`from`); or `from: null`: gone (expired, a week on)
 * or not one Drive knows, so a new session starts. Throws when Drive can't
 * be asked now (offline, busy): tried again like a dropped upload.
 */
async function ask(uri: string, size: number): Promise<{ done: [number, string] } | { from: number | null }> {
  const config =
    `url = ${quote(uri)}\n` +
    `header = ${quote(`Content-Range: bytes */${size}`)}\n` +
    `data-binary = ${quote("")}\n`;
  const [code, raw] = await curl(config, ["--max-time", "60", "-X", "PUT", "-D", "-"]);
  const answer = new TextDecoder().decode(raw);
  if (code === 200 || code === 201) return { done: [code, bodyOf(answer)] };
  if (code === 308) return { from: received(answer) };
  if (code === 429 || code >= 500 || code === 0) throw new Error(driveError(code, bodyOf(answer)));
  return { from: null };
}

/** How many bytes Drive has, from a 308's `Range: bytes=0-<last>` (none: nothing yet). */
export function received(answer: string): number {
  const head = answer.split("\r\n\r\n")[0] ?? "";
  for (const line of head.split("\n")) {
    const found = /^\s*range\s*:\s*bytes=0-(\d+)\s*$/i.exec(line);
    if (found !== null) return Number(found[1]) + 1;
  }
  return 0;
}

/** Lets anyone with the link view the file. */
async function share(library: Library, fileId: string): Promise<void> {
  const config =
    `header = ${quote(`Authorization: Bearer ${await library.accessToken()}`)}\n` +
    `header = ${quote("Content-Type: application/json")}\n` +
    `data-binary = ${quote('{"type":"anyone","role":"reader"}')}\n`;
  const url = `${API}/files/${encode(fileId)}/permissions?supportsAllDrives=true`;
  const [code, body] = await curl(config, ["--max-time", "30", url]);
  if (code !== 200) throw new Error(driveError(code, new TextDecoder().decode(body)));
}

/**
 * PUTs the file to the upload session (the session's address is all the
 * sign-in it needs), from byte `from` on (curl's `-C` says where in its
 * Content-Range), calling `progress` as it goes. Returns the status and body.
 */
async function put(session: string, path: string, type: string, progress: (share: number) => void, from = 0): Promise<[number, string]> {
  const config =
    `url = ${quote(session)}\n` +
    `header = ${quote(`Content-Type: ${type}`)}\n` +
    // No waiting for a 100 Continue before the bytes.
    `header = ${quote("Expect:")}\n`;
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn(
      ["curl", "-#", "-S", "--proto", googleProto(), "--config", "-", "--connect-timeout", "30", "-w", "\n%{http_code}", ...(from > 0 ? ["-C", String(from)] : []), "--upload-file", path],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
  } catch (error) {
    throw new Error(`curl: ${diag.messageOf(error)}`);
  }
  let written = true;
  try {
    await child.stdin.write(config);
    await child.stdin.end();
  } catch {
    written = false;
  }
  const reading = new Response(child.stdout).text();
  // curl's progress bar: "######     45.2%" lines ended by carriage returns; of the whole file, carried on or not.
  // Carried on, its first line says 100% before a byte's gone: read only once it says less.
  let started = from === 0;
  let said = "";
  let line: number[] = [];
  let last = -1.0;
  const decoder = new TextDecoder();
  for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) {
    for (const byte of chunk) {
      if (byte !== 0x0d && byte !== 0x0a) {
        line.push(byte);
        continue;
      }
      const text = decoder.decode(new Uint8Array(line));
      line = [];
      const share = percent(text);
      if (share !== null && !started && share < 1.0) started = true;
      if (share !== null) {
        if (!started) continue;
        if (f32(share - last) >= f32(0.01) || (share >= 1.0 && last < 1.0)) {
          last = share;
          progress(share);
        }
      } else if (trim(text) !== "") {
        said = trim(text);
      }
    }
  }
  if (line.length > 0 && percent(decoder.decode(new Uint8Array(line))) === null) said = trim(decoder.decode(new Uint8Array(line)));
  const status = await child.exited;
  const out = await reading;
  if (!written) throw new Error("curl stdin");
  if (status !== 0) throw new Error(`couldn't upload to Google Drive: ${said}`);
  const split = out.lastIndexOf("\n");
  const [head, code] = split < 0 ? ["", out] : [out.slice(0, split), out.slice(split + 1)];
  const parsed = Number.parseInt(trim(code), 10);
  return [Number.isFinite(parsed) && /^\+?\d+$/.test(trim(code)) ? parsed : 0, head];
}

const FLOAT = /^[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|inf|infinity|nan)$/i;

/** What curl's progress bar says, as a share (0–1, an f32 as Rust kept it). */
export function percent(line: string): number | null {
  const text = trim(line);
  if (!text.endsWith("%")) return null;
  const words = text.slice(0, -1).split(/\p{White_Space}+/u).filter((word) => word !== "");
  const lastWord = words[words.length - 1];
  if (lastWord === undefined) return null;
  const number = lastWord.replace(/^#+/, "");
  if (!FLOAT.test(number)) return null;
  const value = f32(Number(/inf/i.test(number) ? (number.startsWith("-") ? -Infinity : Infinity) : number));
  if (!(value >= 0.0 && value <= 100.0)) return null;
  return f32(value / 100.0);
}

/** The `Location` header of a response printed headers first (`-D -`). */
export function location(answer: string): string | null {
  const head = answer.split("\r\n\r\n")[0] ?? "";
  let url: string | null = null;
  for (const line of head.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (trim(line.slice(0, colon)).toLowerCase() === "location") {
      url = trim(line.slice(colon + 1));
      break;
    }
  }
  // Only ever Google's upload address: the bytes go nowhere else (straight to Google even when the session was
  // started through the relay's gateway: the address is the session's own grant, and holds no sign-in).
  return url !== null && (url.startsWith("https://www.googleapis.com/upload/") || url.startsWith(google("https://www.googleapis.com/"))) ? url : null;
}

/** The body of a response printed headers first. */
export function bodyOf(answer: string): string {
  const at = answer.lastIndexOf("\r\n\r\n");
  return at < 0 ? answer : answer.slice(at + 4);
}

function driveError(code: number, body: string): string {
  let message = "request failed";
  try {
    const value = JSON.parse(body) as { error?: { message?: unknown } } | null;
    if (typeof value?.error?.message === "string") message = value.error.message;
  } catch {
    message = "request failed";
  }
  switch (code) {
    case 401:
    case 403:
      return `Google Drive refused the upload (${code}): ${message}`;
    case 404:
      return "Google Drive can't find the Subtitles folder.";
    default:
      return `Google Drive answered ${code}: ${message}`;
  }
}

/**
 * Whether the file is still on Drive (not deleted or in the trash). An error
 * means it couldn't be told (offline, no sign-in): keep the link.
 */
async function exists(library: Library, fileId: string): Promise<boolean> {
  const config = `header = ${quote(`Authorization: Bearer ${await library.accessToken()}`)}\n`;
  const url = `${API}/files/${encode(fileId)}?fields=trashed&supportsAllDrives=true`;
  const [code, body] = await curl(config, ["--max-time", "20", url]);
  return answerExists(code, new TextDecoder().decode(body));
}

export function answerExists(code: number, body: string): boolean {
  if (code === 404) return false;
  if (code === 200) {
    try {
      const value = JSON.parse(body) as { trashed?: unknown } | null;
      return !(typeof value?.trashed === "boolean" ? value.trashed : false);
    } catch {
      return true;
    }
  }
  throw new Error(driveError(code, body));
}

/**
 * The project's Drive link, after checking (at most every few minutes) that
 * the file is still there; a link to a deleted or trashed file is cleared.
 */
export async function checked(store: Store, library: Library, id: string): Promise<DriveFile | null> {
  const live = store.get(id);
  if (live === null) throw new Error("no such project");
  const file = live.project.drive;
  if (file === undefined || file === null) return null;
  const at = checkedAt.get(file.file_id);
  if (at !== undefined && timing.now() - at < CHECKED_FOR_MS) return file;
  let there: boolean;
  try {
    there = await exists(library, file.file_id);
  } catch (error) {
    diag.warn("drive", `checking ${file.name} (${id}) on Drive: ${diag.messageOf(error)}`);
    return file;
  }
  if (there) {
    checkedAt.set(file.file_id, timing.now());
    return file;
  }
  diag.info("drive", `${file.name} is gone from Drive; unlinking it from ${id}`);
  await store.update(id, "drive", (project) => {
    if (project.drive?.file_id === file.file_id) delete project.drive;
  });
  return null;
}

/** Forgets what was checked and what's uploading (tests). */
export function forget(): void {
  checkedAt.clear();
  uploads.clear();
}
