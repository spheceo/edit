// Google Drive footage, read as Repack reads it: with the team's Drive
// account, whose sign-in Edit's library holds (set on start), so Script mode
// lists a case folder, downloads its recordings and reads its PDFs as Edit
// reads its sound library.

import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { Effect, Schema } from "effect";

import * as diag from "../diag.ts";
import { inArea, runPromise } from "../effect/runtime.ts";
import * as service from "../effect/service.ts";
import * as endpoints from "../endpoints.ts";
import * as ranged from "../ranged_download.ts";

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

// ── Drive's answers (in Effect since Nov 1: docs/plans/2026-11-01-effect.md, round 2, area 2) ──
//
// Every call is `service.request` with its time, its answer read through a
// Schema, and its failures typed and given a kind: a dropped connection, a
// timeout or Drive busy (429, 5xx) is asked again by itself; a file not
// shared with the team's account is the person's to change ("later"); a
// link that isn't a recording is permanent (Replace, not Try again). The
// download resumes from the bytes already on disk at each try, and a
// connection that stops sending is abandoned after `STALL_MS`.

const SERVICE = "Google Drive";

/** Drive won't let the team's account see or download it (401, 403, 404): someone shares it, then Try again. */
export class DriveNotShared extends Schema.TaggedError<DriveNotShared>()("DriveNotShared", { message: Schema.String }) {}
/** The link isn't a recording, or its folder has none, or more than 1,000 items. */
export class NotRecordings extends Schema.TaggedError<NotRecordings>()("NotRecordings", { message: Schema.String }) {}
/** A recording came down short after every try: Try again carries on from what's here. */
export class DownloadShort extends Schema.TaggedError<DownloadShort>()("DownloadShort", { message: Schema.String }) {}
/** A recording came down whole but not as Drive holds it (its MD5 differs), even fetched again from scratch. */
export class DownloadCorrupt extends Schema.TaggedError<DownloadCorrupt>()("DownloadCorrupt", { message: Schema.String }) {}
/** Drive sent a small page (a quota, a scan warning) instead of the recording. */
export class DrivePage extends Schema.TaggedError<DrivePage>()("DrivePage", { message: Schema.String }) {}

service.kinds({ DriveNotShared: "later", NotRecordings: "permanent", DownloadShort: "temporary", DownloadCorrupt: "temporary", DrivePage: "later" });

export type DriveError = DriveNotShared | NotRecordings | DownloadShort | DownloadCorrupt | DrivePage | service.ServiceError;

/** The Promise side's switch for tests: no waits between tries. */
export const timing = { instant: false };

/** A metadata or list call may take this long. */
const CALL_MS = 60_000;
/** A download that sends nothing for this long is abandoned and tried again from where it got to (tests make it short). */
export const STALL_MS = { value: 60_000 };

const retries = (what: string) => service.temporaryRetries(what, timing.instant ? { base: 1 } : { base: "2 seconds" });

const DriveFileSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  size: Schema.optional(Schema.String),
  md5Checksum: Schema.optional(Schema.String),
  trashed: Schema.optional(Schema.Boolean),
  shortcutDetails: Schema.optional(Schema.Struct({ targetId: Schema.optional(Schema.String), targetMimeType: Schema.optional(Schema.String) })),
  videoMediaMetadata: Schema.optional(Schema.Struct({ durationMillis: Schema.optional(Schema.Union([Schema.String, Schema.Number])) })),
});
type DriveFile = typeof DriveFileSchema.Type;

const FileList = Schema.Struct({ files: Schema.optional(Schema.Array(DriveFileSchema)), nextPageToken: Schema.optional(Schema.String) });

/** Drive's own reason in an error body (`error.message`), when it gives one. */
function reasonIn(text: string): string | null {
  try {
    const reason = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    return typeof reason === "string" ? reason : null;
  } catch {
    return null;
  }
}

/** A Drive API call as JSON checked against `schema`, with the refusals that matter said plainly; temporary failures asked again. */
const getJson = <S extends Schema.Top>(token: string, url: string, schema: S) =>
  Effect.gen(function* () {
    const answer = yield* service
      .request(SERVICE, endpoints.google(url), { headers: { authorization: `Bearer ${token}` } }, CALL_MS)
      .pipe(Effect.mapError((error) => (error._tag === "ServiceUnreachable" ? new service.ServiceUnreachable({ service: SERVICE, message: `Could not reach Google Drive (${error.message}).` }) : error)));
    if (answer.status === 403 || answer.status === 404) return yield* new DriveNotShared({ message: "Drive won't share that with Repack's Drive account. Share it with that account, then try again." });
    if (answer.status !== 200) {
      const reason = reasonIn(answer.text());
      return yield* new service.ServiceRefused({
        service: SERVICE,
        status: answer.status,
        retryAfterMs: service.retryAfterOf(answer.headers),
        message: reason === null ? `Google Drive answered ${answer.status}.` : `Google Drive said: ${reason}`,
      });
    }
    return yield* service.decodeJson(SERVICE, schema, answer.text());
  }).pipe(Effect.retry(retries("asking Google Drive")));

export interface Recording {
  id: string;
  name: string;
  size: number;
  audio: boolean;
  /** The length Drive reports, when it knows. */
  claimedMs?: number | null;
  /** Drive's MD5 of the file (null: Drive keeps none; absent: not known, asked when a download is checked): a download is checked against it (`intact`). */
  md5?: string | null;
}

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
const walk = <T extends Recording>(token: string, folder: string, keep: (file: DriveFile, id: string, mime: string, name: string, size: number) => T | null) =>
  Effect.gen(function* () {
    const found: T[] = [];
    const seen = new Set<string>();
    const queue = [folder];
    let entries = 0;
    for (let parent = queue.pop(); parent !== undefined; parent = queue.pop()) {
      let page: string | null = null;
      do {
        const query: string = `${API}/files?q=%27${parent}%27+in+parents+and+trashed+%3D+false&fields=nextPageToken,files(${FIELDS})&pageSize=1000&includeItemsFromAllDrives=true&supportsAllDrives=true${page === null ? "" : `&pageToken=${encodeURIComponent(page)}`}`;
        const list: typeof FileList.Type = yield* getJson(token, query, FileList);
        for (const file of list.files ?? []) {
          if (++entries > MAX_ENTRIES) return yield* new NotRecordings({ message: "That folder holds more than 1,000 items." });
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
  });

/** The recordings behind a link and a title for them. A folder is one case: every video and audio file in it and its subfolders, in name order. */
export const recordingsOf = Effect.fn("drive.recordings")(function* (token: string, link: Link) {
  if (link.kind === "file") {
    const file = yield* getJson(token, `${API}/files/${link.id}?fields=${FIELDS}&supportsAllDrives=true`, DriveFileSchema);
    const [, mime] = target(file);
    const id = file.shortcutDetails?.targetId ?? link.id;
    const name = file.name ?? "Drive video";
    const audio = kind(name, mime);
    if (audio === null) return yield* new NotRecordings({ message: "That Drive file is not a video or audio recording." });
    return [stem(name), [{ id, name, size: Number(file.size ?? 0) || 0, audio, claimedMs: claimed(file), md5: file.md5Checksum ?? null }]] as [string, Recording[]];
  }
  const folder = yield* getJson(token, `${API}/files/${link.id}?fields=name&supportsAllDrives=true`, Schema.Struct({ name: Schema.optional(Schema.String) }));
  const found = yield* walk(token, link.id, (file, id, mime, name, size) => {
    const audio = kind(name, mime);
    return audio === null ? null : { id, name, size, audio, claimedMs: claimed(file), md5: file.md5Checksum ?? null };
  });
  if (found.length === 0) return yield* new NotRecordings({ message: "That folder has no video or audio recordings." });
  return [folder.name ?? "Drive folder", found] as [string, Recording[]];
});

export function recordings(token: string, link: Link): Promise<[string, Recording[]]> {
  return runPromise(recordingsOf(token, link).pipe(inArea("writer")));
}

/** The PDFs in a case's folder and its subfolders (police reports, court papers), in name order. */
export function pdfs(token: string, folder: string): Promise<Recording[]> {
  return runPromise(
    walk(token, folder, (_file, id, mime, name, size) => (mime === "application/pdf" || name.toLowerCase().endsWith(".pdf") ? { id, name, size, audio: false } : null)).pipe(inArea("writer")),
  );
}

export function stem(name: string): string {
  const at = name.lastIndexOf(".");
  return [...(at > 0 ? name.slice(0, at) : name)].slice(0, 180).join("");
}

const sizeOf = (path: string) => (fs.existsSync(path) ? fs.statSync(path).size : 0);

/**
 * One try at the rest of a recording: from the bytes already at `dest` to
 * its end. Fails when the connection drops, Drive refuses, or nothing comes
 * for `STALL_MS`; whatever came down stays, for the next try.
 */
const downloadTry = (token: string, recording: Recording, dest: string, onBytes: (bytes: number) => void) =>
  Effect.gen(function* () {
    const have = sizeOf(dest);
    // A big one in parts at once (ranged_download.ts: 70 MB/s from Drive, one connection 12-16): begun so, or begun now.
    if (recording.size >= ranged.ranged.from && (ranged.partlyDone(dest) || have === 0)) {
      return yield* Effect.tryPromise({
        try: (signal) =>
          ranged.download({
            url: endpoints.google(`${API}/files/${recording.id}?alt=media&supportsAllDrives=true`),
            size: recording.size,
            dest,
            fetch: (url, init) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } }),
            onBytes,
            signal,
          }),
        catch: (error) =>
          error instanceof ranged.Refused
            ? new DriveNotShared({ message: `Drive won't let Repack's account download ${recording.name}.` })
            : new service.ServiceUnreachable({ service: SERVICE, message: diag.messageOf(error) }),
      });
    }
    if (recording.size > 0 && have >= recording.size) return;
    let heard = Date.now();
    const pull = Effect.tryPromise({
      try: async (signal) => {
        const answer = await fetch(endpoints.google(`${API}/files/${recording.id}?alt=media&supportsAllDrives=true`), {
          headers: { authorization: `Bearer ${token}`, ...(have > 0 ? { range: `bytes=${have}-` } : {}) },
          signal,
        });
        if (answer.status === 416) return null;
        if ([401, 403, 404].includes(answer.status)) return { kind: "refused" } as const;
        if (!answer.ok || answer.body === null) {
          return { kind: "failed", error: new service.ServiceRefused({ service: SERVICE, status: answer.status, retryAfterMs: service.retryAfterOf(answer.headers), message: `Google Drive answered ${answer.status}` }) } as const;
        }
        // A server that ignores the range sends the whole file again; one that
        // answers a range from anywhere but where this file stops would put its
        // bytes in the wrong place (Nov 1: a damaged 5.3 GB copy that FFmpeg read
        // as thousands of "Invalid NAL unit size"), so the file starts over.
        const resumed = answer.status === 206;
        const from = resumed ? rangeStart(answer.headers.get("content-range")) : null;
        if (resumed && from !== have) {
          await answer.body.cancel().catch(() => {});
          fs.rmSync(dest, { force: true });
          return { kind: "failed", error: new service.ServiceUnreachable({ service: SERVICE, message: `Google Drive answered from byte ${from ?? "?"}, not ${have}: starting ${recording.name} over` }) } as const;
        }
        const out = fs.openSync(dest, resumed ? "a" : "w");
        let written = resumed ? have : 0;
        try {
          for await (const chunk of answer.body) {
            heard = Date.now();
            fs.writeSync(out, chunk);
            written += chunk.length;
            onBytes(written);
          }
        } finally {
          fs.closeSync(out);
        }
        // More than the recording holds: something was written twice. Start over.
        if (recording.size > 0 && written > recording.size) {
          fs.rmSync(dest, { force: true });
          return { kind: "failed", error: new service.ServiceUnreachable({ service: SERVICE, message: `${recording.name} came down longer than Drive's file (${written} of ${recording.size} bytes): starting it over` }) } as const;
        }
        // The answer ended before the recording did, without an error: a connection closed early, to carry on from.
        if (recording.size > 0 && written < recording.size) return { kind: "ended", written } as const;
        return null;
      },
      catch: (error) => new service.ServiceUnreachable({ service: SERVICE, message: diag.messageOf(error) }),
    });
    const stalled = Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep(Math.min(STALL_MS.value, 5000));
        if (Date.now() - heard >= STALL_MS.value) {
          return yield* new service.ServiceTimedOut({ service: SERVICE, afterMs: STALL_MS.value, message: `nothing came from Google Drive for ${Math.round(STALL_MS.value / 1000)} s` });
        }
      }
    });
    const said = yield* Effect.raceFirst(pull, stalled);
    if (said === null) return;
    if (said.kind === "refused") return yield* new DriveNotShared({ message: `Drive won't let Repack's account download ${recording.name}.` });
    if (said.kind === "failed") return yield* said.error;
    return yield* new service.ServiceUnreachable({ service: SERVICE, message: `the connection closed at ${said.written} of ${recording.size} bytes` });
  });

/**
 * Streams one recording to `dest`, picking up from the bytes already there.
 * A connection that drops, stalls or that Drive refuses for a moment is
 * resumed, up to four more times. `onBytes` gets the bytes written so far.
 */
export const downloading = Effect.fn("drive.download")(function* (token: string, recording: Recording, dest: string, onBytes: (bytes: number) => void = () => {}) {
  let problem = "";
  yield* downloadTry(token, recording, dest, onBytes).pipe(
    Effect.tapError((error) => Effect.sync(() => (problem = error.message))),
    Effect.retry(service.temporaryRetries(`downloading ${recording.name} from Google Drive`, timing.instant ? { base: 1, times: 4 } : { base: "2 seconds", times: 4 })),
    // Out of tries on a temporary failure: what came down is said below, and kept for Try again.
    Effect.catchIf(service.isTemporary, () => Effect.void),
  );
  const size = sizeOf(dest);
  // In parts, the file reaches its size before every part is in: the parts noted say it isn't done.
  if (recording.size > 0 && (size < recording.size || ranged.partlyDone(dest))) {
    return yield* new DownloadShort({
      message: `${recording.name} came down short (${Math.floor(size / 1_000_000)} of ${Math.floor(recording.size / 1_000_000)} MB).${problem === "" ? "" : ` Last problem: ${problem}.`}`,
    });
  }
  // Drive answers some refusals with a small page instead of media.
  if (size < 4096) {
    const head = fs.readFileSync(dest).subarray(0, 1).toString();
    if (head === "{" || head === "<") return yield* new DrivePage({ message: `Drive sent a page instead of ${recording.name}.` });
  }
  // Whole, but is it Drive's file? Checked against Drive's MD5; one that isn't is fetched again from scratch, once.
  if (yield* intactNow(token, recording, dest)) return;
  diag.warn("writer", `${recording.name} came down damaged (its MD5 isn't Drive's): fetching it again from the start`);
  fs.rmSync(dest, { force: true });
  yield* downloadTry(token, recording, dest, onBytes).pipe(Effect.retry(service.temporaryRetries(`downloading ${recording.name} again from Google Drive`, timing.instant ? { base: 1, times: 4 } : { base: "2 seconds", times: 4 })));
  if (!(yield* intactNow(token, recording, dest))) {
    fs.rmSync(dest, { force: true });
    return yield* new DownloadCorrupt({ message: `${recording.name} came down damaged twice (it isn't the file Drive holds). Try again later.` });
  }
});

/** "bytes 100-199/1000" → 100; null when it doesn't say. */
export function rangeStart(header: string | null): number | null {
  const found = /^bytes (\d+)-\d+\/(?:\d+|\*)$/u.exec(header?.trim() ?? "");
  return found ? Number(found[1]) : null;
}

/** The MD5 of a file, read through once. */
export function md5Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("md5");
    fs.createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Where a file proven to be Drive's notes its size and MD5, so it's read through once, not at every import. */
const proofOf = (dest: string) => `${dest}.verified`;

/**
 * Whether `dest` is exactly the recording Drive holds: its size, and its MD5
 * when Drive has one (asked of Drive when the recording doesn't carry it: a
 * manifest from before Nov 1). Size alone let a damaged copy of the right
 * length be used at every retry.
 */
const intactNow = (token: string, recording: Recording, dest: string) =>
  Effect.gen(function* () {
    if (!fs.existsSync(dest)) return false;
    const size = fs.statSync(dest).size;
    if (recording.size > 0 ? size !== recording.size : size === 0) return false;
    // null: Drive has none. Absent: not known yet (a manifest from before Nov 1), so asked.
    const md5 = recording.md5 !== undefined ? recording.md5 : (yield* getJson(token, `${API}/files/${recording.id}?fields=md5Checksum&supportsAllDrives=true`, Schema.Struct({ md5Checksum: Schema.optional(Schema.String) })).pipe(
      Effect.map((file) => file.md5Checksum ?? null),
      Effect.orElseSucceed(() => null),
    ));
    // Drive keeps no MD5 for some files: the size is all there is to go on.
    if (md5 === null) return true;
    const proof = proofOf(dest);
    if (fs.existsSync(proof) && fs.readFileSync(proof, "utf8") === `${size} ${md5}`) return true;
    const found = yield* Effect.promise(() => md5Of(dest));
    if (found !== md5) return false;
    fs.writeFileSync(proof, `${size} ${md5}`);
    return true;
  });

/** `intactNow` for code that isn't Effect yet. */
export function intact(token: string, recording: Recording, dest: string): Promise<boolean> {
  return runPromise(intactNow(token, recording, dest).pipe(inArea("writer")));
}

/** `downloading` for code that isn't Effect yet; a stop (`signal`) abandons the request, keeping what came down. */
export function download(token: string, recording: Recording, dest: string, onBytes: (bytes: number) => void = () => {}, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Stopped."));
  return runPromise(downloading(token, recording, dest, onBytes).pipe(inArea("writer")), signal ? { signal } : undefined).catch((error: unknown) => {
    if (signal?.aborted) throw new Error("Stopped.");
    throw error;
  });
}

/** A Drive recording's page, which plays it from a moment with `t`. */
export const fileLink = (id: string): string => `https://drive.google.com/file/d/${id}/view`;
