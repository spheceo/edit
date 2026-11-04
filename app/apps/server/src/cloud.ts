// Edit's cloud: footage originals and preview proxies on Cloudflare
// R2, project files in Convex, all through the relay (apps/relay/src/cloud.ts),
// which holds the R2 keys and Convex's service token. Edit only ever sees
// short-lived presigned URLs and the answers of `edit:` Convex functions.
//
// The Rust side ran curl subprocesses; here it's fetch, with the relay token
// only ever in a request header (never an argument, never a log line).
// Errors are thrown Errors whose text is fit to show (agents and the UI read
// it). Cloud calls carry the signed-in person's token (accounts.ts; or
// `EDIT_RELAY_TOKEN` for tests and a local relay); [`enabled`] says whether
// there's a sign-in.
//
// Keys are R2 object keys, always under `edit/` ([`validKey`]); the bucket is
// shared with Repack, and the relay refuses anything else.
//
// Big uploads are multipart: fixed-size parts (R2 wants every part but the
// last the same size), a few in flight at once, each retried with a fresh
// URL, and the upload aborted if one gives up. [`uploadStream`] takes any
// source (a Drive download piped straight through) and holds only the parts
// in flight in memory, never a temp file.

import * as fs from "node:fs";

import { Effect, Option, Predicate, Schedule, Schema } from "effect";

import * as diag from "./diag.ts";
import { inArea, runPromise } from "./effect/runtime.ts";
import * as service from "./effect/service.ts";
import { ioMessage, writeAtomic } from "./files.ts";
import { isBug } from "./guard.ts";
import { extension, join, parent } from "./paths.ts";
import * as relay from "./relay.ts";
import { byteLength, debugStr, takeChars } from "./rust.ts";
import { stableStringify } from "./stable.ts";
import { validId } from "./store.ts";

const MIB = 1024 * 1024;
/** A file's parts: 64 MiB, four in flight (≤ 320 MiB in memory). */
export const FILE_PART = 64 * MIB;
const FILE_PARALLEL = 4;
/** A stream's parts: 32 MiB, two in flight plus the one being read (≤ 96 MiB). */
export const STREAM_PART = 32 * MIB;
const STREAM_PARALLEL = 2;
/** S3's (and R2's) limit on parts per upload. */
export const MAX_PARTS = 10_000;
/** Tries per part, per single PUT and per download. */
const ATTEMPTS = 4;
/** Keys per relay delete request (the relay's limit). */
const DELETE_BATCH = 40;
/** A transfer slower than 1 KB/s for a minute is given up on (curl's --speed-limit 1024 --speed-time 60). */
const STALL_BYTES_PER_SECOND = 1024;
const STALL_WINDOW_MS = 60_000;
/** How long a download may take to answer at all (curl's --connect-timeout 30). */
const CONNECT_MS = 30_000;

/** What tests change: the waits between retries, and part sizes (so a multipart upload needn't be 64 MiB). */
export const timing = {
  sleep: (ms: number): Promise<void> => Bun.sleep(ms),
  filePart: FILE_PART,
  streamPart: STREAM_PART,
  /** A transfer is given up on after this long below STALL_BYTES_PER_SECOND. */
  stallMs: STALL_WINDOW_MS,
  /** A download may take this long to answer at all. */
  connectMs: CONNECT_MS,
  /** A file this big or more uploads resumably. */
  resumableFrom: 512 * MIB,
};

/** Whether cloud calls can work: someone is signed in (or `EDIT_RELAY_TOKEN` is set). Cloud is always on then. */
export function enabled(): boolean {
  return relay.cloudEnabled();
}

/** POSTs `body` to the relay's `/v1/cloud/<path>` and returns its JSON answer. */
export function relayJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  return relay.json<Record<string, unknown>>("POST", `/v1/cloud/${path}`, body, "cloud storage", 120);
}

const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f-\u009f\\]/u;

/**
 * A key Edit may use: under `edit/`, no empty, `.` or `..` segments, no
 * control characters or backslashes (the relay's rule, checked early).
 */
export function validKey(key: string): boolean {
  return (
    byteLength(key) <= 1024 &&
    key.startsWith("edit/") &&
    !CONTROL_OR_BACKSLASH.test(key) &&
    key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function checkKey(key: string): void {
  if (!validKey(key)) throw new Error(`not a cloud key Edit may use: ${debugStr(key)}`);
}

/** What a presigned URL lets its holder do. */
export type Method = "GET" | "PUT" | "HEAD";

/**
 * A presigned URL for `key`. `expires` (seconds) defaults to an hour; the
 * relay caps it there, or at 6 h for a GET of footage (originals, proxies,
 * excerpts, sounds), which FFmpeg reads through one URL for a whole excerpt
 * or export.
 */
export async function presign(key: string, method: Method, expires: number | null = null, edge = false): Promise<string> {
  // Writer's script files are read for the handoff (the relay allows that too), never written.
  if (!(method !== "PUT" && key.startsWith("writer/scripts/") && validKey(`edit/${key.slice("writer/".length)}`))) checkKey(key);
  const body: Record<string, unknown> = { key, method, ...(edge ? { edge: true } : {}) };
  if (expires !== null) body.expires = Math.max(Math.floor(expires), 1);
  const answer = await relayJson("r2/url", body);
  if (typeof answer.url !== "string") throw lacking("the relay gave no URL");
  return answer.url;
}

/** An object's size and identity. */
export interface Head {
  size: number;
  etag: string | null;
  contentType: string | null;
}

/** `Value::as_u64`: a non-negative whole number, else null. */
function asU64(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** The object at `key`, or null when there isn't one. */
export function head(key: string): Promise<Head | null> {
  checkKey(key);
  return diag.timeOnAsync("cloud", "cloud: head", key, async () => parseHead(await relayJson("r2/head", { key })));
}

export function parseHead(answer: Record<string, unknown>): Head | null {
  if (answer.exists !== true) return null;
  return {
    size: asU64(answer.size) ?? 0,
    etag: typeof answer.etag === "string" ? answer.etag : null,
    contentType: typeof answer.contentType === "string" ? answer.contentType : null,
  };
}

/** One listed object. */
export interface CloudObject {
  key: string;
  size: number;
}

/** Every object whose key starts with `prefix` (which must start with `edit/`). */
export function list(prefix: string): Promise<CloudObject[]> {
  if (!prefix.startsWith("edit/")) {
    return Promise.reject(new Error(`not a cloud prefix Edit may use: ${debugStr(prefix)}`));
  }
  return diag.timeOnAsync("cloud", "cloud: list", prefix, async () => {
    const objects: CloudObject[] = [];
    let cursor: string | null = null;
    for (;;) {
      const body: Record<string, unknown> = cursor === null ? { prefix } : { prefix, cursor };
      const answer = await relayJson("r2/list", body);
      for (const object of Array.isArray(answer.objects) ? answer.objects : []) {
        const record = object as Record<string, unknown> | null;
        if (record !== null && typeof record === "object" && typeof record.key === "string") {
          objects.push({ key: record.key, size: asU64(record.size) ?? 0 });
        }
      }
      if (typeof answer.cursor === "string" && answer.cursor !== "") cursor = answer.cursor;
      else return objects;
    }
  });
}

/** Deletes `keys` (missing ones are fine). */
export async function remove(keys: string[]): Promise<void> {
  for (const key of keys) checkKey(key);
  await diag.timeOnAsync("cloud", "cloud: delete", `${keys.length} keys`, async () => {
    for (let at = 0; at < keys.length; at += DELETE_BATCH) {
      await relayJson("r2/delete", { keys: keys.slice(at, at + DELETE_BATCH) });
    }
  });
}

// ---------------------------------------------------------------------------
// Uploads

/** `progress(sent, total)` as bytes go (from every part in flight). */
export type Report = (sent: number, total: number) => void;

/** Something to upload from, read a part at a time (`Read`): a file, a download, stdin. */
export interface Source {
  /** Up to `max` bytes (any amount above zero), or null at the end. */
  read(max: number): Promise<Uint8Array | null>;
}

/** A source over bytes in memory. */
export function bytesSource(data: Uint8Array): Source {
  let at = 0;
  return {
    async read(max) {
      if (at >= data.length) return null;
      const end = Math.min(at + max, data.length);
      const out = data.subarray(at, end);
      at = end;
      return out;
    },
  };
}

/** A source over a stream's chunks (a fetch body, stdin), keeping what a read didn't take. */
export function streamSource(stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): Source {
  const iterator = (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  let left: Uint8Array | null = null;
  let done = false;
  return {
    async read(max) {
      while (left === null || left.length === 0) {
        if (done) return null;
        const next = await iterator.next();
        if (next.done === true) {
          done = true;
          return null;
        }
        left = next.value;
      }
      const out = left.subarray(0, Math.min(max, left.length));
      left = left.subarray(out.length);
      return out;
    },
  };
}

/** A source over an open file, from its start. */
function fileSource(fd: number): Source {
  let position = 0;
  return {
    async read(max) {
      const buffer = Buffer.allocUnsafe(Math.min(max, 4 * MIB));
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (read === 0) return null;
      position += read;
      return buffer.subarray(0, read);
    },
  };
}

/** Uploads the file at `path` to `key`: one PUT under 64 MiB, else multipart. `signal` stops it (a share the person cancelled). */
export async function uploadFile(path: string, key: string, progress: Report = () => {}, signal?: AbortSignal): Promise<void> {
  checkKey(key);
  if (signal?.aborted) throw new Error("the share was cancelled");
  await diag.timeOnAsync("cloud", "cloud: upload file", `${path} → ${key}`, async () => {
    let fd: number;
    let stat: fs.Stats;
    try {
      fd = fs.openSync(path, "r");
      stat = fs.fstatSync(fd);
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    try {
      const size = stat.size;
      const journal = size >= timing.resumableFrom ? journalPath(key) : null;
      if (journal !== null) {
        await resumable(fd, journal, { key, size, mtimeMs: stat.mtimeMs, part: partSize(timing.filePart, size) }, progress, signal);
        const now = fs.statSync(path);
        if (now.size !== size || now.mtimeMs !== stat.mtimeMs) throw new TransferMismatch({ message: `${path} changed while uploading` });
        return;
      }
      const sent = await upload(fileSource(fd), key, size, partSize(timing.filePart, size), FILE_PARALLEL, progress, signal);
      if (sent !== size) throw new TransferMismatch({ message: `${path} changed while uploading (${size} bytes, sent ${sent})` });
    } finally {
      fs.closeSync(fd);
    }
  });
}

// ---------------------------------------------------------------------------
// Resumable uploads: a big file's finished parts are kept in a journal, so
// after a restart only the rest go up (the 10-hour trial, Nov 4: a 58 GB
// original took 3 h to go up and began again from nothing after every
// restart). R2 keeps an upload's parts until it's completed, or for 7 days.

let journals: string | null = null;

/** Where resumable uploads keep their journals (the server's home); null (tests, the CLI): a big upload that stops begins again. Those older than R2 keeps an upload are let go. */
export function keepUploadJournalsIn(dir: string | null): void {
  journals = dir;
  if (dir === null) return;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > 7 * 86_400_000) fs.rmSync(file, { force: true });
    } catch {
      // Gone already.
    }
  }
}

/** An upload under way: which file it is, R2's upload id, and the parts R2 holds (their ETags). */
interface Journal {
  key: string;
  size: number;
  mtimeMs: number;
  part: number;
  uploadId: string;
  parts: Record<string, string>;
}

function journalPath(key: string): string | null {
  return journals === null ? null : join(journals, `${new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 32)}.json`);
}

function readJournal(file: string): Journal | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Journal;
    return typeof value.uploadId === "string" && typeof value.parts === "object" && value.parts !== null ? value : null;
  } catch {
    return null;
  }
}

/** The resumable uploads under way or stopped on this Mac: their key, size and how much of it is up. */
export function uploadJournals(): { key: string; size: number; up: number; parts: number }[] {
  if (journals === null) return [];
  let names: string[];
  try {
    names = fs.readdirSync(journals);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const saved = readJournal(join(journals!, name));
    if (saved === null) return [];
    const done = Object.keys(saved.parts).length;
    return [{ key: saved.key, size: saved.size, up: Math.min(saved.size, done * saved.part), parts: done }];
  });
}

/** Lets go of a resumable upload of `key` begun here (the object got there another way): its parts in R2 and its journal. */
export function forgetUpload(key: string): void {
  const file = journalPath(key);
  if (file === null) return;
  const saved = readJournal(file);
  if (saved !== null) abortUpload(saved.key, saved.uploadId);
  fs.rmSync(file, { force: true });
}

function abortUpload(key: string, uploadId: string): void {
  void relayJson("r2/multipart/abort", { key, uploadId }).catch((error: unknown) => diag.warn("cloud", `couldn't abort the upload of ${key}: ${diag.messageOf(error)}`));
}

/**
 * Uploads open file `fd` (`file`: its key, size, time and part size) to its
 * key, picking up the upload `journal` holds when it's this file's. One that
 * fails is kept to resume on the next try, unless it was cancelled; one R2
 * no longer has is begun again, once.
 */
async function resumable(fd: number, journal: string, file: Omit<Journal, "uploadId" | "parts">, report: Report, signal?: AbortSignal): Promise<void> {
  let saved = readJournal(journal);
  if (saved !== null && (saved.key !== file.key || saved.size !== file.size || saved.mtimeMs !== file.mtimeMs || saved.part !== file.part)) {
    abortUpload(saved.key, saved.uploadId);
    saved = null;
  }
  for (;;) {
    const resumed = saved !== null;
    let state: Journal;
    if (saved !== null) {
      state = saved;
      diag.info("cloud", `resuming the upload of ${file.key}: ${Object.keys(state.parts).length} of ${Math.ceil(file.size / file.part)} parts are up`);
    } else {
      const created = await relayJson("r2/multipart/create", { key: file.key, contentType: contentType(file.key) });
      if (typeof created.uploadId !== "string") throw lacking("the relay gave no upload id");
      state = { ...file, uploadId: created.uploadId, parts: {} };
      fs.mkdirSync(parent(journal)!, { recursive: true });
      writeAtomic(journal, JSON.stringify(state));
    }
    try {
      await sendParts(fd, journal, state, report, signal);
      fs.rmSync(journal, { force: true });
      return;
    } catch (error) {
      if (signal?.aborted || error instanceof TransferMismatch) {
        abortUpload(state.key, state.uploadId);
        fs.rmSync(journal, { force: true });
        throw error;
      }
      // A refusal of one picked up (R2 let it go): begun again; anything temporary stays kept for the next try.
      if (resumed && !service.isTemporary(error)) {
        diag.warn("cloud", `the upload of ${file.key} couldn't be picked up (${diag.messageOf(error)}); beginning it again`);
        fs.rmSync(journal, { force: true });
        saved = null;
        continue;
      }
      throw error;
    }
  }
}

/** Sends the parts R2 doesn't hold yet, `FILE_PARALLEL` at once, each noted in the journal as it's up; then completes the upload. */
async function sendParts(fd: number, journal: string, state: Journal, report: Report, signal?: AbortSignal): Promise<void> {
  const count = Math.max(1, Math.ceil(state.size / state.part));
  if (count > MAX_PARTS) throw new Error(`${state.key} needs more than ${MAX_PARTS} parts`);
  const lengthOf = (n: number) => Math.min(state.part, state.size - (n - 1) * state.part);
  const progress = new Progress(state.size, report);
  const missing: number[] = [];
  let up = 0;
  for (let n = 1; n <= count; n++) {
    if (state.parts[n] !== undefined) up += lengthOf(n);
    else missing.push(n);
  }
  if (up > 0) progress.add(up);
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (failure === null && next < missing.length) {
      if (signal?.aborted) throw new Error("the share was cancelled");
      const n = missing[next++]!;
      const data = Buffer.allocUnsafe(lengthOf(n));
      for (let got = 0; got < data.length; ) {
        const read = await new Promise<number>((resolve, reject) => fs.read(fd, data, got, data.length - got, (n - 1) * state.part + got, (error, bytes) => (error ? reject(error) : resolve(bytes))));
        if (read === 0) throw new TransferMismatch({ message: `${state.key}'s file ended before ${state.size} bytes` });
        got += read;
      }
      state.parts[n] = await putPart(state.key, state.uploadId, n, data, progress, signal);
      writeAtomic(journal, JSON.stringify(state));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FILE_PARALLEL, Math.max(missing.length, 1)) }, () =>
      worker().catch((error: unknown) => {
        failure ??= error;
      }),
    ),
  );
  if (failure !== null) throw failure;
  const parts = Object.entries(state.parts)
    .map(([n, etag]) => ({ partNumber: Number(n), etag }))
    .sort((a, b) => a.partNumber - b.partNumber);
  const done = await relayJson("r2/multipart/complete", { key: state.key, uploadId: state.uploadId, parts });
  const stored = asU64(done.size);
  if (stored !== null && stored !== state.size) throw new TransferMismatch({ message: `${state.key} came out ${stored} bytes in the cloud, not ${state.size}` });
}

/**
 * Uploads everything `source` gives to `key`, without a temp file: parts of
 * 32 MiB, two in flight (≤ 96 MiB in memory); one PUT if it all fits in the
 * first part. `sizeHint` is the expected size (for progress and part size; 0
 * total when unknown). Returns the bytes uploaded.
 */
export function uploadStream(source: Source, key: string, sizeHint: number | null, progress: Report = () => {}): Promise<number> {
  checkKey(key);
  return diag.timeOnAsync("cloud", "cloud: upload stream", key, () =>
    upload(source, key, sizeHint, partSize(timing.streamPart, sizeHint), STREAM_PARALLEL, progress),
  );
}

/** `base`, or bigger (whole MiB) when the size would need over 10,000 parts. */
export function partSize(base: number, size: number | null): number {
  const needed = Math.ceil(Math.ceil((size ?? 0) / MAX_PARTS) / MIB) * MIB;
  return Math.max(base, needed);
}

/**
 * Progress over parts in flight: never goes backwards (a retried part's bytes
 * count again only once they pass what was already reported).
 */
export class Progress {
  private sent = 0;
  private reported = 0;

  constructor(
    readonly total: number,
    private readonly report: Report,
  ) {}

  add(bytes: number): void {
    this.sent += bytes;
    if (this.reported < this.sent) {
      this.reported = this.sent;
      this.report(this.sent, this.total);
    }
  }

  takeBack(bytes: number): void {
    this.sent -= bytes;
  }
}

/** Reads up to `size` bytes (fewer only at the end of the source). */
export async function readPart(source: Source, size: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < size) {
      const chunk = await source.read(size - length);
      if (chunk === null) break;
      if (chunk.length === 0) continue;
      chunks.push(chunk);
      length += chunk.length;
    }
  } catch (error) {
    if (isBug(error)) throw error;
    throw new Error(`reading the upload: ${diag.messageOf(error)}`);
  }
  if (chunks.length === 1) return Uint8Array.from(chunks[0]!);
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** mime_guess's `first_or_octet_stream` for the extensions Edit stores. */
const CONTENT_TYPES: Record<string, string> = {
  "3gp": "video/3gpp",
  aac: "audio/aac",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  avi: "video/x-msvideo",
  bin: "application/octet-stream",
  bmp: "image/bmp",
  caf: "audio/x-caf",
  flac: "audio/flac",
  gif: "image/gif",
  heic: "image/heic",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  m2ts: "video/vnd.dlna.mpeg-tts",
  m4a: "audio/m4a",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  mts: "video/vnd.dlna.mpeg-tts",
  mxf: "application/mxf",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
  ts: "video/vnd.dlna.mpeg-tts",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  wma: "audio/x-ms-wma",
};

export function contentType(key: string): string {
  const ext = extension(key)?.toLowerCase();
  return (ext === undefined ? undefined : CONTENT_TYPES[ext]) ?? "application/octet-stream";
}

async function upload(
  source: Source,
  key: string,
  total: number | null,
  part: number,
  parallel: number,
  report: Report,
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) throw new Error("the share was cancelled");
  const progress = new Progress(total ?? 0, report);
  const kind = contentType(key);
  const first = await readPart(source, part);
  if (first.length < part) {
    // It all fits in one request.
    await retry(`upload of ${key}`, async () => {
      const url = await presign(key, "PUT");
      await put(url, first, kind, progress, signal);
    });
    const size = first.length;
    report(size, total ?? size);
    return size;
  }
  if (signal?.aborted) throw new Error("the share was cancelled");
  const created = await relayJson("r2/multipart/create", { key, contentType: kind });
  if (typeof created.uploadId !== "string") throw lacking("the relay gave no upload id");
  const uploadId = created.uploadId;
  try {
    const size = await multipart(source, key, uploadId, first, part, parallel, progress, signal);
    report(size, total ?? size);
    return size;
  } catch (error) {
    try {
      await relayJson("r2/multipart/abort", { key, uploadId });
    } catch (abort) {
      diag.warn("cloud", `couldn't abort the upload of ${key}: ${diag.messageOf(abort)}`);
    }
    throw error;
  }
}

/**
 * Sends the parts (the first already read) through `parallel` workers and
 * completes the upload; the total size. A part is read only once a worker is
 * free for it, so at most `parallel` parts are in flight plus the one read.
 */
async function multipart(
  source: Source,
  key: string,
  uploadId: string,
  first: Uint8Array,
  part: number,
  parallel: number,
  progress: Progress,
  signal?: AbortSignal,
): Promise<number> {
  let failed = false;
  let error: unknown = null;
  const fail = (why: unknown) => {
    failed = true;
    error ??= why;
  };
  const etags: [number, string][] = [];
  const inFlight = new Set<Promise<void>>();
  let size = 0;
  let number = 1;
  let data = first;
  for (;;) {
    if (signal?.aborted) {
      fail(new Error("the share was cancelled"));
      break;
    }
    const length = data.length;
    size += length;
    while (inFlight.size >= Math.max(parallel, 1)) await Promise.race(inFlight);
    if (!failed) {
      const sending = number;
      const bytes = data;
      const job: Promise<void> = putPart(key, uploadId, sending, bytes, progress, signal)
        .then((etag) => {
          etags.push([sending, etag]);
        }, fail)
        .finally(() => inFlight.delete(job));
      inFlight.add(job);
    }
    if (length < part || failed) break;
    let next: Uint8Array;
    try {
      next = await readPart(source, part);
    } catch (why) {
      fail(why);
      break;
    }
    if (next.length === 0) break;
    data = next;
    number += 1;
    if (number > MAX_PARTS) {
      fail(new Error(`${key} needs more than ${MAX_PARTS} parts`));
      break;
    }
  }
  await Promise.all(inFlight);
  if (error !== null) throw error;
  etags.sort((a, b) => a[0] - b[0]);
  const parts = etags.map(([partNumber, etag]) => ({ partNumber, etag }));
  const done = await relayJson("r2/multipart/complete", { key, uploadId, parts });
  const stored = asU64(done.size);
  if (stored !== null && stored !== size) throw new TransferMismatch({ message: `${key} came out ${stored} bytes in the cloud, not ${size}` });
  return size;
}

/** One part, retried with a fresh URL; its ETag. */
function putPart(key: string, uploadId: string, number: number, data: Uint8Array, progress: Progress, signal?: AbortSignal): Promise<string> {
  return retry(`part ${number} of ${key}`, async () => {
    const answer = await relayJson("r2/multipart/urls", { key, uploadId, parts: [number] });
    const urls = answer.urls as Record<string, unknown> | undefined;
    const url = urls !== undefined && urls !== null && typeof urls === "object" ? urls[String(number)] : undefined;
    if (typeof url !== "string") throw lacking("the relay gave no part URL");
    const etag = await put(url, data, null, progress, signal);
    if (etag === null) throw new service.AnswerInvalid({ service: "R2", message: "R2 gave no ETag for the part" });
    return etag;
  });
}

/**
 * Runs `attempt` up to ATTEMPTS times, waiting 2, 4, 8 s between, but asks
 * again only after a temporary failure (effect/service.ts `kindOf`: R2 or
 * the relay unreachable, a stall, a 5xx or 429, a connection closed early).
 * A refusal (a 403, a 400), an answer missing what it should hold, or a bug
 * is said at once: the old loop asked again after anything but a bug, so a
 * refused upload took four tries and 14 s to say so. The waits go through
 * `timing.sleep`, which tests make instant.
 */
export function retry<T>(what: string, attempt: () => Promise<T>): Promise<T> {
  let tries = 0;
  const once = Effect.tryPromise({ try: () => ((tries += 1), attempt()), catch: (error) => error as Error });
  return runPromise(
    once.pipe(
      Effect.retry(
        Schedule.recurs(ATTEMPTS - 1).pipe(
          Schedule.setInputType<Error>(),
          Schedule.while(({ input }) => !isBug(input) && !diag.messageOf(input).includes("was cancelled") && service.isTemporary(input)),
          Schedule.tap(({ input }) =>
            Effect.logWarning(`${what} failed (try ${tries}): ${diag.messageOf(input)}`).pipe(Effect.andThen(Effect.promise(() => timing.sleep((1 << tries) * 1000)))),
          ),
        ),
      ),
      inArea("cloud"),
    ),
  );
}

/** R2 couldn't be reached, or a transfer stalled (said as a timeout). */
function unreached(message: string, stalled: boolean): service.ServiceUnreachable | service.ServiceTimedOut {
  return stalled ? new service.ServiceTimedOut({ service: "R2", afterMs: timing.stallMs, message }) : new service.ServiceUnreachable({ service: "R2", message });
}

/** The relay's answer lacked what it always holds. */
const lacking = (message: string) => new service.AnswerInvalid({ service: "Edit's relay", message });

/** A file changed under an upload, or R2 stored a different size: uploading it again can fix it. */
export class TransferMismatch extends Schema.TaggedError<TransferMismatch>()("TransferMismatch", { message: Schema.String }) {}

service.kinds({ TransferMismatch: "temporary" });

/**
 * Gives up on a transfer that moves less than 1 KB/s for a minute (curl's
 * --speed-limit 1024 --speed-time 60): `moved` counts bytes, `signal` aborts.
 */
export class Stall {
  private readonly controller = new AbortController();
  private moved_ = 0;
  private timer: ReturnType<typeof setInterval>;
  private connect: ReturnType<typeof setTimeout> | null = null;
  reason: string | null = null;

  constructor(connectMs: number | null = null) {
    const window = timing.stallMs;
    this.timer = setInterval(() => {
      if (this.moved_ < STALL_BYTES_PER_SECOND * (window / 1000)) {
        this.abort(`Operation too slow. Less than ${STALL_BYTES_PER_SECOND} bytes/sec transferred the last ${window / 1000} seconds`);
      }
      this.moved_ = 0;
    }, window);
    unref(this.timer);
    if (connectMs !== null) {
      this.connect = setTimeout(() => this.abort(`Connection timed out after ${connectMs} milliseconds`), connectMs);
      unref(this.connect);
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The answer has started: the connect timeout no longer applies. */
  connected(): void {
    if (this.connect !== null) clearTimeout(this.connect);
    this.connect = null;
  }

  moved(bytes: number): void {
    this.moved_ += bytes;
  }

  private abort(reason: string): void {
    this.reason ??= reason;
    this.controller.abort(new Error(reason));
  }

  stop(): void {
    clearInterval(this.timer);
    if (this.connect !== null) clearTimeout(this.connect);
  }

  /** Why the transfer failed: the stall's reason when it gave up, else `error`'s message. */
  why(error: unknown): string {
    return this.reason ?? diag.messageOf(error);
  }
}

function unref(timer: unknown): void {
  (timer as { unref?: () => void }).unref?.();
}

/**
 * PUTs `data` to a presigned URL with an exact Content-Length (S3 wants it,
 * never chunked), a MiB at a time as the request takes it (that's the
 * progress); the ETag R2 answered with.
 */
async function put(url: string, data: Uint8Array, kind: string | null, progress: Progress, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) throw new Error("the share was cancelled");
  let written = 0;
  const stall = new Stall();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (signal?.aborted) throw new Error("the share was cancelled");
        if (written >= data.length) {
          controller.close();
          return;
        }
        const end = Math.min(written + MIB, data.length);
        const chunk = data.subarray(written, end);
        controller.enqueue(chunk);
        written = end;
        stall.moved(chunk.length);
        progress.add(chunk.length);
      },
    },
    { highWaterMark: 0 },
  );
  const headers: Record<string, string> = { "content-length": String(data.length) };
  if (kind !== null) headers["content-type"] = kind;
  const stop = signal === undefined ? stall.signal : AbortSignal.any([stall.signal, signal]);
  try {
    let response: Response;
    try {
      response = await fetch(url, { method: "PUT", body, headers, signal: stop, duplex: "half" } as RequestInit);
    } catch (error) {
      if (signal?.aborted || diag.messageOf(error).includes("was cancelled")) throw new Error("the share was cancelled");
      throw unreached(`could not reach R2: ${diag.scrub(stall.why(error))}`, stall.reason !== null);
    }
    const text = await response.text().catch(() => "");
    if (response.status !== 200) {
      throw new service.ServiceRefused({ service: "R2", status: response.status, retryAfterMs: service.retryAfterOf(response.headers), message: `R2 refused the upload (${response.status}): ${r2Message(text)}` });
    }
    const etag = (response.headers.get("etag") ?? "").trim();
    return etag === "" ? null : etag;
  } catch (error) {
    progress.takeBack(written);
    throw error;
  } finally {
    stall.stop();
  }
}

/** The `<Message>` of an S3 error body, else its start. */
export function r2Message(body: string): string {
  const between = (tag: string): string | null => {
    const open = `<${tag}>`;
    const start = body.indexOf(open);
    if (start < 0) return null;
    const rest = body.slice(start + open.length);
    const end = rest.indexOf(`</${tag}>`);
    return end < 0 ? null : rest.slice(0, end);
  };
  const code = between("Code");
  const message = between("Message");
  if (code !== null && message !== null) return `${code}: ${message}`;
  return takeChars(body.trim(), 300);
}

// ---------------------------------------------------------------------------
// Downloads

/**
 * Downloads `key` to `dest`, through `dest.partial` (a later call carries on
 * from it while the object is unchanged: `dest.partial.etag` says which
 * version it holds). `progress(received, total)`.
 */
/** Whether `key` is in the cloud: a lookup that may well find nothing (a shared transcript nobody made yet), never a failure. */
export async function has(key: string): Promise<boolean> {
  checkKey(key);
  return (await head(key)) !== null;
}

export function download(key: string, dest: string, progress: Report = () => {}): Promise<void> {
  checkKey(key);
  return diag.timeOnAsync("cloud", "cloud: download", key, async () => {
    const object = await head(key);
    if (object === null) throw new Error(`${key} isn't in the cloud`);
    const dir = parent(dest);
    try {
      if (dir !== null && dir !== "") fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    const partial = partialPath(dest);
    const version = `${partial}.etag`;
    const etag = object.etag ?? "";
    let held: string | null = null;
    try {
      held = fs.readFileSync(version, "utf8");
    } catch {
      held = null;
    }
    try {
      if (held !== etag) {
        // Bytes of another version (or of unknown origin): start over.
        fs.rmSync(partial, { force: true });
        fs.writeFileSync(version, etag);
      }
      // An empty body writes no file.
      if (object.size === 0) fs.writeFileSync(partial, "");
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    await retry(`download of ${key}`, () => fetchRest(key, object, partial, progress));
    const got = sizeOf(partial);
    if (got !== object.size) {
      fs.rmSync(partial, { force: true });
      throw new TransferMismatch({ message: `${key}: got ${got} bytes of ${object.size}` });
    }
    try {
      fs.renameSync(partial, dest);
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    fs.rmSync(version, { force: true });
    progress(object.size, object.size);
  });
}

export function partialPath(dest: string): string {
  return `${dest}.partial`;
}

function sizeOf(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

function exists(path: string): boolean {
  try {
    fs.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * An ETag without its weak mark: R2 gzips a small JSON on the way (an
 * analysis file) and answers `W/"…"` for the same object, which read as
 * "changed while downloading" on every try, so no machine ever fetched
 * another's transcripts and paid to transcribe them again.
 */
export function strongEtag(etag: string): string {
  const trimmed = etag.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
}

/** One try at getting the rest of `object` into `partial`. */
async function fetchRest(key: string, object: Head, partial: string, progress: Report): Promise<void> {
  let have = sizeOf(partial);
  if (have > object.size) {
    fs.rmSync(partial, { force: true });
    have = 0;
  }
  if (have === object.size && exists(partial)) return;
  const url = await presign(key, "GET", 3600);
  const headers: Record<string, string> = {};
  if (have > 0) {
    headers.range = `bytes=${have}-`;
    // S3 sends the whole (changed) object instead; R2 ignores If-Range, so
    // the ETag it answers with is checked below too.
    if (object.etag !== null) headers["if-range"] = object.etag;
  }
  const stall = new Stall(timing.connectMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: stall.signal });
    } catch (error) {
      throw unreached(`downloading ${key} (000): ${diag.scrub(stall.why(error))}`, stall.reason !== null);
    }
    stall.connected();
    const code = String(response.status);
    const etag = (response.headers.get("etag") ?? "").trim();
    if (object.etag !== null && etag !== "" && strongEtag(etag) !== strongEtag(object.etag)) {
      await response.body?.cancel().catch(() => {});
      fs.rmSync(partial, { force: true });
      throw new TransferMismatch({ message: `${key} changed while downloading; download it again` });
    }
    if (response.status >= 400) {
      await response.body?.cancel().catch(() => {});
      // 416: nothing past what we have; start again from nothing, on the next try.
      if (code === "416") {
        fs.rmSync(partial, { force: true });
        throw new TransferMismatch({ message: `downloading ${key} (416): The requested range was past the object; starting again` });
      }
      throw new service.ServiceRefused({ service: "R2", status: response.status, retryAfterMs: service.retryAfterOf(response.headers), message: `downloading ${key} (${code}): The requested URL returned error: ${code}` });
    }
    if (have > 0 && response.status !== 206) {
      // The server ignored the range: start again from nothing.
      await response.body?.cancel().catch(() => {});
      fs.rmSync(partial, { force: true });
      // Started again from nothing on the next try (the partial file is gone).
      throw new TransferMismatch({ message: `downloading ${key} (${code}): HTTP server doesn't seem to support byte ranges. Cannot resume.` });
    }
    const fd = fs.openSync(partial, have > 0 ? "a" : "w");
    let reported = 0;
    try {
      if (response.body !== null) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          fs.writeSync(fd, chunk);
          stall.moved(chunk.length);
          const now = performance.now();
          if (now - reported >= 250) {
            reported = now;
            progress(sizeOf(partial), object.size);
          }
        }
      }
    } catch (error) {
      if (isBug(error)) throw error;
      throw unreached(`downloading ${key} (${code}): ${diag.scrub(stall.why(error))}`, stall.reason !== null);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    stall.stop();
  }
}

// ---------------------------------------------------------------------------
// Convex

export type ConvexKind = "unreachable" | "relay" | "function";

/**
 * Why a Convex call failed: the relay couldn't be reached (offline), the
 * relay refused it (a bad token, a bad request), or the function threw; then
 * `code` is its `errorData.code` (Edit's functions use `conflict`, `locked`,
 * `missing_body` and `invalid`) and `data` the whole `errorData`. Its
 * message is what Rust's Display said.
 */
export class ConvexFailure extends Error {
  /** Its tag, for `kindOf` (effect/service.ts). */
  readonly _tag = "ConvexFailure";
  constructor(
    readonly kind: ConvexKind,
    /** The function's own message (unprefixed); the relay's text otherwise. */
    readonly said: string,
    readonly code: string | null = null,
    readonly data: unknown = null,
    /** The relay's status, when it refused. */
    readonly status: number | null = null,
    /** The relay is pausing the database while it moves: offline for minutes, not asked again by the call. */
    readonly paused = false,
  ) {
    super(kind === "function" ? `Convex: ${said}` : said);
  }

  static unreachable(message: string, paused = false): ConvexFailure {
    return new ConvexFailure("unreachable", message, null, null, null, paused);
  }

  static relay(message: string, status: number | null = null): ConvexFailure {
    return new ConvexFailure("relay", message, null, null, status);
  }

  static function(message: string, code: string | null, data: unknown): ConvexFailure {
    return new ConvexFailure("function", message, code, data);
  }
}

/**
 * Calls a Convex function in Edit's `edit` module through the relay (which
 * adds the service token). `kind` is "query", "mutation" or "action"; `path`
 * like "edit:getProject"; the function's value, or its error.
 */
export function convex(kind: string, path: string, args: unknown): Promise<unknown> {
  return convexCall(kind, path, args, 120);
}

// ── Convex as an Effect (docs/plans/2026-11-01-effect.md, round 2, area 3) ──
//
// A call's failures are `ConvexFailure`s, as before, now with kinds
// (effect/service.ts): the relay unreachable or slow is temporary, a
// conflict or a lock someone holds is the sync's to settle ("later"), any
// other refusal or function error is permanent. A query, which changes
// nothing, is asked again after a temporary failure; a mutation is not (its
// answer may have been lost after it landed: the sync loops look before they
// save again, 8f67a6cf).

service.kinds({
  ConvexFailure: (error) => {
    const failure = error as ConvexFailure;
    if (failure.kind === "unreachable") return failure.paused ? "later" : "temporary";
    if (failure.kind === "relay") return failure.status === null ? "permanent" : service.kindOfStatus(failure.status);
    return failure.code === "conflict" || failure.code === "locked" ? "later" : "permanent";
  },
});

/** Convex's answer: a value, or its error with `errorData` (a ConvexError's code and message). */
export const ConvexAnswer = Schema.Union([
  Schema.Struct({ status: Schema.Literal("success"), value: Schema.optional(Schema.Unknown) }),
  Schema.Struct({ status: Schema.Literal("error"), errorMessage: Schema.optional(Schema.String), errorData: Schema.optional(Schema.Unknown) }),
]);

/** How long a query waits before it's asked again after a temporary failure (tests make it short). */
export const convexRetry = { baseMs: 500 };

/** A relay failure as the Convex call says it. */
function asConvexFailure(error: service.ServiceError): ConvexFailure {
  switch (error._tag) {
    case "ServiceUnreachable":
    case "ServiceTimedOut":
      return ConvexFailure.unreachable(error.message);
    case "ServiceRefused":
      // The relay pausing the database while it moves reads as offline: work waits here and is saved after.
      return error.message.includes("cloud is moving to its new home") ? ConvexFailure.unreachable(error.message, true) : ConvexFailure.relay(error.message, error.status);
    case "AnswerInvalid":
      return ConvexFailure.relay(error.message);
  }
}

/** One Convex function call through the relay; `timeoutMs` for each request. */
export const convexEffect = Effect.fn("cloud.convex")(function* (kind: string, path: string, args: unknown, timeoutMs: number) {
  if (kind !== "query" && kind !== "mutation" && kind !== "action") return yield* Effect.fail(ConvexFailure.relay(`not a Convex function kind: ${kind}`));
  if (typeof args !== "object" || args === null || Array.isArray(args)) return yield* Effect.fail(ConvexFailure.relay("Convex args must be an object"));
  const asked = relay.askJson("POST", "/v1/cloud/convex", { kind, path, args }, "cloud storage", timeoutMs).pipe(Effect.mapError(asConvexFailure));
  const answer = yield* kind === "query" ? asked.pipe(Effect.retry(service.temporaryRetries(`Convex ${path}`, { times: 2, base: convexRetry.baseMs }))) : asked;
  return yield* Effect.try({ try: () => convexValue(answer), catch: (error) => (error instanceof ConvexFailure ? error : ConvexFailure.relay(diag.messageOf(error))) });
});

/** [`convex`] with the failure kept apart ([`ConvexFailure`]) and a timeout in seconds. */
export async function convexCall(kind: string, path: string, args: unknown, timeout: number): Promise<unknown> {
  return diag.timeOnAsync("cloud", `cloud: convex ${kind}`, path, () => runPromise(convexEffect(kind, path, args, timeout * 1000).pipe(inArea("cloud"))));
}

/** A Convex query (see [`convex`]). */
export function query(path: string, args: unknown): Promise<unknown> {
  return convex("query", path, args);
}

/** A Convex mutation (see [`convex`]). */
export function mutation(path: string, args: unknown): Promise<unknown> {
  return convex("mutation", path, args);
}

/**
 * Convex's `{status: "success", value}` / `{status: "error", errorMessage,
 * errorData}`. A ConvexError's own message (`errorData.message`) is
 * preferred: `errorMessage` wraps it in Convex's "Uncaught ConvexError: …".
 */
export function convexValue(answer: unknown): unknown {
  const read = Schema.decodeUnknownOption(ConvexAnswer)(answer);
  if (Option.isNone(read)) throw ConvexFailure.relay(`unexpected answer from Convex: ${takeChars(stableStringify(answer), 300)}`);
  const said = read.value;
  if (said.status === "success") return said.value === undefined ? null : said.value;
  const data = said.errorData === undefined ? null : said.errorData;
  const dataFields = Predicate.isObject(data) && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  const message = (dataFields !== null && typeof dataFields.message === "string" ? dataFields.message : null) ?? said.errorMessage ?? "unknown error";
  const code = dataFields !== null && typeof dataFields.code === "string" ? dataFields.code : null;
  throw ConvexFailure.function(message, code, data);
}

// ---------------------------------------------------------------------------
// `edit cloud …`

export const CLI_HELP = `edit cloud — Edit's cloud storage and Convex, through the relay

  edit cloud url KEY [GET|PUT|HEAD] [--expires SECS]   a presigned URL
  edit cloud put FILE KEY                              upload a file
  edit cloud put - KEY [--size BYTES]                  upload stdin (no temp file)
  edit cloud get KEY FILE                              download (resumes)
  edit cloud head KEY | ls PREFIX | rm KEY…
  edit cloud convex query|mutation|action edit:NAME ['{"args":1}']

Keys start with edit/. Needs EDIT_RELAY_TOKEN (the relay's CLOUD_TOKEN);
EDIT_RELAY_URL picks another relay (e.g. http://localhost:8787 for wrangler dev).
`;

/** Where `runCli` writes (the terminal, or a test's buffers). */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  stdin(): ReadableStream<Uint8Array>;
}

const TERMINAL: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  stdin: () => Bun.stdin.stream(),
};

/**
 * `edit cloud …`: try the cloud by hand (EDIT_RELAY_URL / EDIT_RELAY_TOKEN).
 * A failure is thrown with the text `edit: <text>` shows (the CLI exits 2).
 */
export async function runCli(args: string[], io: CliIo = TERMINAL): Promise<void> {
  const arg = (index: number) => args[index];
  const flag = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const need = (index: number, what: string): string => {
    const value = arg(index);
    if (value === undefined) throw new Error(`give ${what}\n\n${CLI_HELP}`);
    return value;
  };
  if (!enabled()) throw new Error("`edit cloud` needs EDIT_RELAY_TOKEN (a local relay's token): against the team's relay, use the running Edit (it's signed in)");
  const show: Report = (sent, total) => {
    const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
    io.err(total > 0 ? `\r${mb(sent)} / ${mb(total)} MB   ` : `\r${mb(sent)} MB   `);
  };
  let result: unknown;
  switch (arg(0)) {
    case "url": {
      const given = arg(2) ?? "GET";
      if (given !== "GET" && given !== "PUT" && given !== "HEAD") throw new Error(`unknown method ${given}`);
      const seconds = flag("--expires");
      let expires: number | null = null;
      if (seconds !== undefined) {
        if (!/^\+?\d+$/.test(seconds)) throw new Error("--expires takes seconds");
        expires = Number(seconds);
      }
      result = await presign(need(1, "a key"), given, expires);
      break;
    }
    case "put": {
      const source = need(1, "a file (or - for stdin)");
      const key = need(2, "a key");
      const given = flag("--size");
      let size: number | null = null;
      if (given !== undefined) {
        if (!/^\+?\d+$/.test(given)) throw new Error("--size takes bytes");
        size = Number(given);
      }
      try {
        if (source === "-") {
          const sent = await uploadStream(streamSource(io.stdin()), key, size, show);
          result = { key, size: sent };
        } else {
          await uploadFile(source, key, show);
          result = { key };
        }
      } finally {
        io.err("\n");
      }
      break;
    }
    case "get": {
      const key = need(1, "a key");
      const dest = need(2, "a destination file");
      try {
        await download(key, dest, show);
      } finally {
        io.err("\n");
      }
      result = { saved: dest };
      break;
    }
    case "head": {
      const found = await head(need(1, "a key"));
      result = found === null ? null : { size: found.size, etag: found.etag, contentType: found.contentType };
      break;
    }
    case "ls":
      result = (await list(need(1, "a prefix"))).map((object) => ({ key: object.key, size: object.size }));
      break;
    case "rm": {
      const keys = args.slice(1);
      await remove(keys);
      result = { deleted: keys.length };
      break;
    }
    case "convex": {
      const kind = need(1, "query, mutation or action");
      const path = need(2, "a path (edit:…)");
      let given: unknown = {};
      const text = arg(3);
      if (text !== undefined) {
        try {
          given = JSON.parse(text);
        } catch (error) {
          throw new Error(`args: ${diag.messageOf(error)}`);
        }
      }
      result = kind === "query" ? await query(path, given) : kind === "mutation" ? await mutation(path, given) : await convex(kind, path, given);
      break;
    }
    default:
      io.out(CLI_HELP);
      return;
  }
  io.out(`${stableStringify(result, 2)}\n`);
}

/**
 * `edit cloud backfill <project id> [--port N]`: asks
 * the running Edit to put every media of a cloud project that isn't in the
 * cloud yet there now, and prints its answer. The exit code: 0, or 1 when
 * Edit refused; not reaching Edit is thrown (`edit: …`, exit 2).
 */
export async function backfillCli(id: string | undefined, port: number, io: Pick<CliIo, "out" | "err"> = TERMINAL): Promise<number> {
  if (id === undefined || !validId(id)) throw new Error("usage: edit cloud backfill <project id> [--port N]");
  io.err(`backfilling ${id} through the Edit on port ${port} (big files take a while)…\n`);
  let response: Response;
  let body: string;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/projects/${id}/cloud/backfill`, { method: "POST" });
    body = await response.text();
  } catch (error) {
    throw new Error(`couldn't reach Edit on port ${port} (is it running?): ${diag.messageOf(error)}`);
  }
  io.out(`${body}\n`);
  return response.status >= 200 && response.status < 300 ? 0 : 1;
}
