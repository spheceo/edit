// Every script in the cloud, as Writer kept them (and still does, beside
// Edit): each script's body (script.json) and files (the preview, transcript
// pieces, sources, research) on R2 under `writer/scripts/<id>/`, and an index
// in Convex (Repack's deployment, the `writer` module) naming each script's
// current rev and files, reached through Edit's relay.
//
// Saves land on disk as always. A loop pushes what changed a few seconds
// later (the changed files, then a new body, then a commit naming the rev it
// began from) and pulls what other Macs pushed. A commit another Mac overtook
// is refused; then this Mac's version is kept as a "(conflicted copy)" and the
// cloud's taken, never an overwrite. Scripts importing or being written wait
// until they're done. Deleting a script deletes it everywhere. Footage isn't
// downloaded: a script another Mac made plays its preview from the cloud.

import * as fs from "node:fs";

import { Effect, Option, Predicate, Schema } from "effect";
import { createHash } from "node:crypto";

import type { Script } from "@edit/types/writer";

import * as diag from "../diag.ts";
import { idle, inArea, runtime } from "../effect/runtime.ts";
import * as service from "../effect/service.ts";
import { ConvexAnswer } from "../cloud.ts";
import * as archive from "./archive.ts";
import * as storage from "./storage.ts";
import { writeAtomic } from "../files.ts";
import { isFile, join, parent } from "../paths.ts";
import * as machine from "../machine.ts";
import * as relay from "../relay.ts";
import { importing } from "./imports.ts";
import * as jobs from "./jobs.ts";
import { changeShelf, hooks as lessonHooks, merge, readShelf, type Shelf } from "./lessons.ts";
import * as store from "./store.ts";

const TICK_MS = 3_000;
const PULL_EVERY_MS = 30_000;
/** A save is pushed once the script has been still this long. */
const SETTLE_MS = 2_000;
const PREFIX = "writer/scripts";
/** Files bigger than this go up in parts of PART_SIZE. */
const MULTIPART_OVER = 100_000_000;
const PART_SIZE = 64 * 1024 * 1024;
const BACKOFF_FIRST = 30_000;
const BACKOFF_MAX = 3_600_000;
const LESSONS_KEY = "writer/lessons.json";
/** Whether a script body has its cut written: any cut-in (an unbuilt script is its recordings whole). */
function builtIn(body: Uint8Array): boolean {
  try {
    const script = JSON.parse(new TextDecoder().decode(body)) as { clips?: { kind?: string }[] };
    return (script.clips ?? []).some((clip) => clip.kind === "cut-in");
  } catch {
    return false;
  }
}

/** Whether a script body is an import that never finished here (still processing, or failed before any recording came in): nothing of this Mac's to keep. */
function unfinished(body: Uint8Array): boolean {
  try {
    const script = JSON.parse(new TextDecoder().decode(body)) as { status?: string; clips?: unknown[] };
    return script.status === "processing" || (script.status === "error" && (script.clips ?? []).length === 0);
  } catch {
    return false;
  }
}

/** The library row's shape: 1 added `kind`, 2 `runFailed` (Oct 30). A script whose cloud row is older is pushed again. */
const SUMMARY_VERSION = 2;

/** What the page shows: off, syncing, synced, offline or a problem. */
export interface Status {
  enabled: boolean;
  state: string;
  pending: number;
  transfer: { script: string; name: string; up: boolean; done: number; total: number } | null;
  lastSync: number | null;
  error: string | null;
  scripts: number;
}

const status: Status = { enabled: false, state: "off", pending: 0, transfer: null, lastSync: null, error: null, scripts: 0 };
export const statusNow = (): Status => ({ ...status });

let pullNow = true;
/** Scripts whose push the cloud refused: when to try again, how long it waited last, and what it said. */
const backoff = new Map<string, { until: number; wait: number }>();
const refusals = new Map<string, string>();

/** Why the cloud refused this script's last save, while it still does. */
export const refused = (id: string): string | null => refusals.get(id) ?? null;

/** Syncs on the next tick rather than waiting for the next pull. */
export function syncSoon(): void {
  pullNow = true;
}

/** Every script waiting after a refusal is tried again on the next tick (remote support's unstick): how many were. */
export function tryAllAgain(): number {
  const waiting = backoff.size;
  backoff.clear();
  syncSoon();
  return waiting;
}

/** Tries this script again on the next tick, however long it was waiting after a refusal. */
export function tryAgain(id: string): void {
  backoff.delete(id);
  syncSoon();
}

class Problem extends Error {
  constructor(
    message: string,
    /** The connection, not the cloud: waits quietly and tries again. */
    readonly offline = false,
    /** The cloud there but failing for a moment (a 5xx, 429): this script waits a little and goes again, never kept as a refusal. */
    readonly temporary = offline,
  ) {
    super(message);
  }
}

/** A file a revision names that isn't in the cloud (deleted by a push that lost, before each push had its own keys). */
class Gone extends Problem {}

// ---- What this Mac knows of each script in the cloud ----

interface Kept {
  key: string;
  size: number;
  /** This Mac's modified time, in ms: a file whose size and time match is unchanged. */
  mtime: number;
}

interface Known {
  rev: number;
  /** The script.json this rev was, by its hash. */
  body: string;
  files: Record<string, Kept>;
  summary?: number;
}

/** `copied`: the rev a script's conflicted copy was kept for, until that rev has come down, so a pull tried again doesn't keep another. */
type Ledger = { scripts: Record<string, Known>; copied?: Record<string, number> };

const ledgerPath = (data: string) => join(data, "cloud", "ledger.json");
const deletingPath = (data: string) => join(data, "cloud", "deleted.json");

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  fs.mkdirSync(parent(path) ?? ".", { recursive: true });
  writeAtomic(path, JSON.stringify(value, null, 2));
}

const loadLedger = (data: string): Ledger => readJson<Ledger>(ledgerPath(data), { scripts: {} });

/** Footage cleared from this Mac once the cloud held it, or left there by a pull, by script: still the script's files in the cloud. */
const storagePath = (data: string) => join(data, "cloud", "storage.json");
export const purgedNames = (data: string, id: string): string[] => readJson<Record<string, string[]>>(storagePath(data), {})[id] ?? [];

export function leftInCloud(data: string, id: string, names: string[]): void {
  if (names.length === 0) return;
  const map = readJson<Record<string, string[]>>(storagePath(data), {});
  map[id] = [...new Set([...(map[id] ?? []), ...names])];
  writeJson(storagePath(data), map);
}

/** A file back on this Mac (a restore): no longer only in the cloud. */
export function forgetPurged(data: string, id: string, name: string): void {
  const map = readJson<Record<string, string[]>>(storagePath(data), {});
  if (!(map[id] ?? []).includes(name)) return;
  map[id] = map[id]!.filter((other) => other !== name);
  writeJson(storagePath(data), map);
}
const deleting = (data: string): string[] => readJson<string[]>(deletingPath(data), []);
/** Scripts deleted on this Mac whose delete hasn't reached the cloud yet: lists of the cloud's scripts leave them out (Home showed one until the next sync). */
export const beingDeleted = (data: string): Set<string> => new Set(deleting(data));

/** A script deleted on this Mac: deleted from the cloud, and so from every other Mac, by the next round. */
export function deleted(data: string, id: string): void {
  const list = deleting(data);
  if (!list.includes(id)) writeJson(deletingPath(data), [...list, id]);
  syncSoon();
}

/** The cloud's rev of this script, as this Mac last saw it; null if it never reached the cloud. */
export const revOf = (data: string, id: string): number | null => loadLedger(data).scripts[id]?.rev ?? null;

/** A script file's key and size in the cloud, as this Mac last synced it. */
export const fileKey = (data: string, id: string, name: string): Kept | null => loadLedger(data).scripts[id]?.files[name] ?? null;

/** Told of each script a sync has just put in the cloud (storage.ts leaves its footage there at once). */
const pushedHooks: ((id: string) => void)[] = [];
export function onPushed(hook: (id: string) => void): void {
  pushedHooks.push(hook);
}

/**
 * Writer's own record of what each script is in the cloud, taken once when
 * its scripts were brought in, so nothing goes up again: the copies were made
 * now, so a file whose size the record agrees with takes its time from here.
 */
export function adoptLedger(data: string, writerFolder: string): void {
  // What Writer cleared from this Mac or left in the cloud (still those scripts' files there), and which archives it freed or restored here.
  for (const name of ["storage.json", "archive-local.json"]) {
    if (!isFile(join(data, "cloud", name)) && isFile(join(writerFolder, "cloud", name))) {
      fs.mkdirSync(join(data, "cloud"), { recursive: true });
      fs.copyFileSync(join(writerFolder, "cloud", name), join(data, "cloud", name));
    }
  }
  if (isFile(ledgerPath(data))) return;
  const theirs = readJson<Ledger | null>(join(writerFolder, "cloud", "ledger.json"), null);
  if (theirs === null) return;
  for (const [id, known] of Object.entries(theirs.scripts)) {
    const dir = store.scriptDir(data, id);
    for (const [name, kept] of Object.entries(known.files)) {
      const path = inside(dir, name);
      if (path !== null && isFile(path) && fs.statSync(path).size === kept.size) kept.mtime = mtime(path);
    }
  }
  writeJson(ledgerPath(data), theirs);
  diag.info("writer", `took Writer's cloud record of ${Object.keys(theirs.scripts).length} scripts`);
}

// ---- The relay ----

/** Reads that Edit's relay answered before Script mode's own routes (Writer's script reads, for the handoff). */
const READS = new Set(["writer:listScripts", "writer:getScript"]);

async function call(route: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return await relay.json<Record<string, unknown>>("POST", `/v1/cloud/writer/${route}`, body, "Script mode's cloud", 120);
  } catch (error) {
    const message = diag.messageOf(error);
    // A relay from before the merge: reads go the way Edit read Writer's scripts; saves wait for the new relay.
    if (/needs deploying|\b404\b|not found/i.test(message)) {
      const read = (route === "convex" && READS.has(String(body.path))) || (route === "r2/url" && body.method !== "PUT" && String(body.key).startsWith(`${PREFIX}/`));
      if (read) return relay.json<Record<string, unknown>>("POST", `/v1/cloud/${route}`, body, "Script mode's cloud", 120);
      throw new Problem("Edit's relay doesn't serve Script mode's cloud yet (it needs the update with Writer's cloud).");
    }
    throw new Problem(message, message.startsWith(relay.UNREACHABLE), service.isTemporary(error));
  }
}

/** A `writer:`, `reviews:` or `edit:` function's value; its refusal's code and data. */
export async function convex(kind: string, path: string, args: Record<string, unknown>): Promise<{ ok: true; value: unknown } | { ok: false; code: string; data: Record<string, unknown> }> {
  const read = Schema.decodeUnknownOption(ConvexAnswer)(await call("convex", { kind, path, args }));
  // Not Convex's answer at all: said, never read as an empty value.
  if (Option.isNone(read)) throw new Problem(`The cloud's answer to ${path} wasn't Convex's.`);
  const answer = read.value;
  if (answer.status === "success") return { ok: true, value: answer.value ?? null };
  const data = (Predicate.isObject(answer.errorData) ? answer.errorData : {}) as Record<string, unknown>;
  const code = typeof data.code === "string" ? data.code : "";
  if (code === "") throw new Problem(`The cloud refused ${path}: ${String(data.message ?? answer.errorMessage ?? "unknown error").split("Uncaught ConvexError: ").pop()!.trim()}`);
  return { ok: false, code, data };
}

/** A presigned address for `key` (good for an hour). */
export async function presign(key: string, method: "GET" | "PUT" | "HEAD"): Promise<string> {
  const answer = await call("r2/url", { key, method });
  if (typeof answer.url !== "string") throw new Problem("The cloud gave no address for a file.");
  return answer.url;
}

async function remove(keys: string[]): Promise<void> {
  for (let at = 0; at < keys.length; at += 40) await call("r2/delete", { keys: keys.slice(at, at + 40) }).catch(() => undefined);
}

/**
 * Deletes `keys` (Script mode's own, under `writer/`) and everything under
 * `prefix`: the files a deleted review link named, and any it left beside
 * them. Says how many it deleted; one the relay refused (deleting needs
 * script work) is left to Repack's cleanup, which the review's delete queued.
 */
export async function removeUnder(prefix: string, keys: string[]): Promise<number> {
  if (!prefix.startsWith("writer/") || !prefix.endsWith("/")) throw new Error(`not a prefix Script mode deletes under: ${prefix}`);
  const found = new Set(keys.filter((key) => key.startsWith("writer/")));
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const answer = await call("r2/list", cursor === undefined ? { prefix } : { prefix, cursor });
    for (const object of Array.isArray(answer.objects) ? (answer.objects as { key?: unknown }[]) : []) if (typeof object.key === "string" && object.key.startsWith(prefix)) found.add(object.key);
    cursor = typeof answer.cursor === "string" && answer.cursor !== "" ? answer.cursor : undefined;
    if (cursor === undefined) break;
  }
  let deleted = 0;
  const all = [...found];
  for (let at = 0; at < all.length; at += 40) {
    const batch = all.slice(at, at + 40);
    const answer = await call("r2/delete", { keys: batch }).catch((error: unknown) => {
      diag.info("writer", `deleting ${batch.length} review files under ${prefix}: ${diag.messageOf(error)}; Repack's cleanup deletes them`);
      return null;
    });
    if (answer !== null) deleted += batch.length;
  }
  return deleted;
}

const transferProblem = (error: unknown, name: string): Problem => new Problem(`${name} didn't get through (${diag.messageOf(error)}).`, true);

/** Uploads a file, its progress shown as it goes: in parts past MULTIPART_OVER. */
async function upload(script: string, name: string, path: string, key: string): Promise<number> {
  const size = fs.statSync(path).size;
  const shown = (done: number) => (status.transfer = { script, name, up: true, done, total: size });
  if (size <= MULTIPART_OVER) {
    const answer = await fetch(await presign(key, "PUT"), { method: "PUT", body: Bun.file(path), headers: { "content-length": String(size) }, signal: AbortSignal.timeout(600_000) }).catch((error: unknown) => {
      throw transferProblem(error, name);
    });
    if (!answer.ok) throw new Problem(`The cloud refused ${name} (${answer.status}).`);
    shown(size);
    return size;
  }
  const created = await call("r2/multipart/create", { key });
  const uploadId = String(created.uploadId ?? "");
  if (uploadId === "") throw new Problem("The cloud gave no upload id.");
  const count = Math.ceil(size / PART_SIZE);
  const parts: { partNumber: number; etag: string }[] = [];
  try {
    for (let first = 1; first <= count; first += 100) {
      const numbers = Array.from({ length: Math.min(100, count - first + 1) }, (_, k) => first + k);
      const urls = (await call("r2/multipart/urls", { key, uploadId, parts: numbers })).urls as Record<string, string>;
      for (const number of numbers) {
        const from = (number - 1) * PART_SIZE;
        const chunk = Bun.file(path).slice(from, Math.min(from + PART_SIZE, size));
        const answer = await fetch(urls[String(number)]!, { method: "PUT", body: chunk, signal: AbortSignal.timeout(600_000) }).catch((error: unknown) => {
          throw transferProblem(error, name);
        });
        if (!answer.ok) throw new Problem(`The cloud refused ${name} (${answer.status}).`);
        parts.push({ partNumber: number, etag: answer.headers.get("etag") ?? "" });
        shown(Math.min(number * PART_SIZE, size));
      }
    }
    await call("r2/multipart/complete", { key, uploadId, parts });
  } catch (error) {
    await call("r2/multipart/abort", { key, uploadId }).catch(() => undefined);
    throw error;
  }
  return size;
}

async function uploadBytes(key: string, bytes: Uint8Array | string): Promise<void> {
  const answer = await fetch(await presign(key, "PUT"), { method: "PUT", body: bytes, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(60_000) }).catch((error: unknown) => {
    throw transferProblem(error, "script.json");
  });
  if (!answer.ok) throw new Problem(`The cloud refused script.json (${answer.status}).`);
}

/** What's at a key, or null when nothing is. */
async function fetchBytes(key: string): Promise<Uint8Array | null> {
  const answer = await fetch(await presign(key, "GET"), { signal: AbortSignal.timeout(60_000) }).catch((error: unknown) => {
    throw transferProblem(error, key.split("/").pop() ?? "file");
  });
  if (answer.status === 404) return null;
  if (!answer.ok) throw new Problem(`The cloud refused ${key.split("/").pop()} (${answer.status}).`);
  return new Uint8Array(await answer.arrayBuffer());
}

/** Downloads a file beside its place, then moves it in whole. */
async function download(script: string, name: string, key: string, size: number, path: string): Promise<void> {
  // A body that stops arriving must not wedge the sync forever: 60 s
  // without a chunk aborts it (a total deadline would kill slow big files).
  const stall = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(new Error("no data for a minute")), 60_000);
    timer.unref?.();
  };
  arm();
  const answer = await fetch(await presign(key, "GET"), { signal: stall.signal }).catch((error: unknown) => {
    clearTimeout(timer);
    throw transferProblem(error, name);
  });
  if (answer.status === 404) {
    clearTimeout(timer);
    throw new Gone(`${name} isn't in the cloud.`);
  }
  if (!answer.ok || answer.body === null) {
    clearTimeout(timer);
    throw new Problem(`The cloud refused ${name} (${answer.status}).`);
  }
  fs.mkdirSync(parent(path) ?? ".", { recursive: true });
  const partial = `${path}.partial`;
  const out = fs.openSync(partial, "w");
  let done = 0;
  try {
    for await (const chunk of answer.body) {
      arm();
      fs.writeSync(out, chunk);
      done += chunk.length;
      status.transfer = { script, name, up: false, done, total: size };
    }
  } catch (error) {
    throw new Problem(`${name} stopped coming down (${diag.messageOf(error)}).`, true);
  } finally {
    clearTimeout(timer);
    fs.closeSync(out);
  }
  fs.renameSync(partial, path);
}

/** Puts bytes at a key Script mode may write (its own, or Edit's shared prefixes). */
export async function putBytes(key: string, bytes: Uint8Array | string, contentType = "application/json"): Promise<void> {
  const answer = await fetch(await presign(key, "PUT"), { method: "PUT", body: bytes, headers: { "content-type": contentType }, signal: AbortSignal.timeout(60_000) }).catch((error: unknown) => {
    throw transferProblem(error, key.split("/").pop() ?? "file");
  });
  if (!answer.ok) throw new Problem(`The cloud refused ${key.split("/").pop()} (${answer.status}).`);
}

/** Uploads a file to a key, its progress shown under `script` as the sync's is. */
export const putFile = (script: string, key: string, path: string): Promise<number> => upload(script, path.split("/").pop() ?? "file", path, key);

/** The size of what's at a key, or null when nothing is there. */
export async function head(key: string): Promise<number | null> {
  const answer = await call("r2/head", { key });
  return answer.exists === true ? Number(answer.size ?? 0) : null;
}

/** What's at a key, or null when nothing is. */
export const getBytes = (key: string): Promise<Uint8Array | null> => fetchBytes(key);

/**
 * A script's file (by its path in the folder) on this Mac, brought down from
 * the cloud first when it was cleared from here or made on another Mac.
 */
export async function fetchFile(data: string, id: string, name: string): Promise<string> {
  const path = inside(store.scriptDir(data, id), name);
  if (path === null) throw new Error(`${name} isn't a script's file.`);
  if (isFile(path)) return path;
  const kept = fileKey(data, id, name);
  if (kept === null || kept.key === "") throw new Error(`This script's ${name} isn't on this Mac or in the cloud.`);
  await download(id, name, kept.key, kept.size, path);
  // Its time as kept here now, so the next push sees it unchanged.
  const ledger = loadLedger(data);
  const known = ledger.scripts[id]?.files[name];
  if (known !== undefined) {
    known.mtime = mtime(path);
    writeJson(ledgerPath(data), ledger);
  }
  forgetPurged(data, id, name);
  return path;
}

/** The script's preview on this Mac, brought down from the cloud first when it was cleared from here or made on another Mac. */
export const fetchPreview = (data: string, id: string): Promise<string> => fetchFile(data, id, "proxy.mp4");

/**
 * A script's preview that's only in the cloud (another Mac made it), played
 * from there a range at a time; null when the cloud has none.
 */
export async function stream(request: Request, data: string, id: string): Promise<Response | null> {
  const kept = fileKey(data, id, "proxy.mp4");
  if (kept === null) return null;
  const range = request.headers.get("range");
  const answer = await fetch(await presign(kept.key, "GET"), { headers: range ? { range } : {} });
  const headers = new Headers({ "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "no-store" });
  for (const name of ["content-length", "content-range", "etag"]) {
    const value = answer.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(answer.body, { status: answer.status, headers });
}

// ---- The loop ----

/** Who this Mac is, as commits name it. */
const holder = (): string => machine.name().slice(0, 120);

/**
 * The sync, one fiber for as long as Edit runs (round 3): a round every
 * TICK_MS, pulling every PULL_EVERY_MS or when asked (`syncSoon`); a round
 * never overlaps the last, and a round that throws, or a bug in one, is said
 * and the next round goes on (a loop that died silently was 81aa84cb's).
 * Offline and errors are said once each, when they change.
 */
const syncing = (data: string) =>
  Effect.gen(function* () {
    let lastPull = 0;
    for (;;) {
      yield* idle(TICK_MS);
      if (!relay.cloudEnabled()) {
        Object.assign(status, { enabled: false, state: "off", error: null, transfer: null });
        continue;
      }
      status.enabled = true;
      const pull = pullNow || Date.now() - lastPull >= PULL_EVERY_MS;
      const was = status.state;
      const ran = yield* Effect.tryPromise(() => tick(data, pull)).pipe(Effect.result);
      if (ran._tag === "Success") {
        if (was === "offline" || was === "error") yield* Effect.logInfo("the cloud: back in sync");
        Object.assign(status, { pending: ran.success, state: ran.success > 0 ? "syncing" : "synced", error: null, transfer: null, lastSync: Date.now() });
      } else {
        const cause = ran.failure.cause;
        const problem = cause instanceof Problem ? cause : new Problem(diag.messageOf(cause));
        if (status.error !== problem.message) yield* (problem.offline ? Effect.logWarning : Effect.logError)(`the cloud: ${problem.offline ? "offline" : "sync stopped"}: ${problem.message}`);
        Object.assign(status, { state: problem.offline ? "offline" : "error", error: problem.message, transfer: null });
      }
      if (pull) {
        lastPull = Date.now();
        pullNow = false;
      }
    }
  }).pipe(inArea("writer"));

/** Starts syncing in the background, for as long as Edit runs. */
export function start(data: string): void {
  lessonHooks.changed = syncSoon;
  runtime.runFork(syncing(data));
}

/** A script Edit is working on now: importing or being written. */
const busy = (id: string): boolean => importing(id) || jobs.running(id);

const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function mtime(path: string): number {
  try {
    return Math.floor(fs.statSync(path).mtimeMs);
  } catch {
    return 0;
  }
}

/** A file's place inside a script's folder, refusing anything that would leave it. */
function inside(dir: string, name: string): string | null {
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\"))) return null;
  return join(dir, ...parts);
}

/**
 * Every file of a script but its body, by its path inside the folder. A
 * joined case's recordings, and any original in Edit's originals
 * (`edit-shared.json`), are left out (the preview is what another Mac
 * plays), as is a build's state and a commentary's clip footage (each Mac's own).
 */
function localFiles(dir: string, script: Script): Record<string, Kept> {
  const shared = new Set(readJson<{ file?: unknown }[]>(join(dir, "edit-shared.json"), []).flatMap((entry) => (typeof entry?.file === "string" ? [entry.file] : [])));
  const found: Record<string, Kept> = {};
  const stack = [dir];
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.name.startsWith(".") || entry.name.endsWith(".tmp") || entry.name.endsWith(".partial")) continue;
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      const relative = path.slice(dir.length + 1);
      if (relative === "script.json" || relative === "build.json" || relative.startsWith("footage/")) continue;
      const recording = (relative.startsWith("drive/") || relative.startsWith("compilation/")) && !relative.endsWith(".json");
      if (recording && path !== script.originalPath) continue;
      // In Edit's originals now (the handoff's edit-shared.json): found there, not kept twice.
      if (shared.has(relative)) continue;
      found[relative] = { key: "", size: fs.statSync(path).size, mtime: mtime(path) };
    }
  }
  return found;
}

const sameFiles = (known: Record<string, Kept>, here: Record<string, Kept>): boolean =>
  Object.keys(known).length === Object.keys(here).length && Object.entries(here).every(([name, file]) => known[name]?.size === file.size && known[name]?.mtime === file.mtime);

/** Whether this Mac has changed a script since it last synced it. */
const changedHere = (dir: string, known: Known | undefined): boolean => known === undefined || known.body !== hash(fs.readFileSync(join(dir, "script.json")));

/** This Mac's version of a script the cloud overtook, kept beside it under a new id. */
function keepCopy(data: string, dir: string, label: string): void {
  const id = crypto.randomUUID();
  const copy = store.scriptDir(data, id);
  fs.cpSync(dir, copy, { recursive: true });
  const script = store.read(copy);
  script.id = id;
  script.title = `${script.title} (${label})`;
  script.updatedAt = Date.now();
  store.write(copy, script);
  store.libraryChanged();
}

/** One round: deletions, then what came from other Macs, then what changed here. Answers how many scripts still wait. */
async function tick(data: string, pull: boolean): Promise<number> {
  const ledger = loadLedger(data);
  const save = () => writeJson(ledgerPath(data), ledger);
  let waiting = 0;
  for (const id of deleting(data)) {
    let answer: Awaited<ReturnType<typeof convex>>;
    try {
      answer = await convex("mutation", "writer:deleteScript", { scriptId: id, holder: holder() });
    } catch (error) {
      // Offline, everything waits; refused, this delete waits and the rest of the round goes on.
      if (error instanceof Problem && error.offline) throw error;
      waiting++;
      continue;
    }
    if (!answer.ok) continue;
    const keys = (((answer.value as { keys?: unknown } | null)?.keys ?? []) as unknown[]).filter((key): key is string => typeof key === "string");
    await remove(keys);
    delete ledger.scripts[id];
    save();
    writeJson(deletingPath(data), deleting(data).filter((other) => other !== id));
  }
  const gone = deleting(data);
  if (pull) {
    const listed = await convex("query", "writer:listScripts", {});
    if (!listed.ok) throw new Problem(`The cloud refused to list scripts (${listed.code}).`);
    const rows = (Array.isArray(listed.value) ? listed.value : []) as Record<string, unknown>[];
    status.scripts = rows.filter((row) => row.deletedAt == null).length;
    // Archived from Repack's page, or asked back: archive.ts acts on it.
    archive.keepStates(data, rows);
    for (const row of rows) {
      if (gone.includes(String(row.scriptId))) continue;
      try {
        await pullOne(data, ledger, row);
      } catch (error) {
        if (error instanceof Problem && error.offline) throw error;
        diag.warn("writer", `the cloud: ${String(row.title ?? row.scriptId)} didn't come down: ${diag.messageOf(error)}`);
        waiting++;
      }
      save();
    }
  }
  // What changed here, found first so the count of what's left can be shown.
  const changed: [string, string, Script, Uint8Array, Known | undefined, Record<string, Kept>][] = [];
  for (const id of store.ids(data).sort()) {
    const until = backoff.get(id)?.until ?? 0;
    if (busy(id) || until > Date.now() || archive.archived(data, id)) continue;
    const dir = store.scriptDir(data, id);
    let body: Uint8Array;
    let script: Script;
    try {
      body = fs.readFileSync(join(dir, "script.json"));
      script = JSON.parse(new TextDecoder().decode(body)) as Script;
    } catch {
      continue;
    }
    if (script.status === "processing" || Date.now() - script.updatedAt < SETTLE_MS) {
      waiting++;
      continue;
    }
    const known = ledger.scripts[id];
    const files = localFiles(dir, script);
    // Footage cleared from this Mac once the cloud held it, or left there by a pull: still the script's file in the cloud, so an edit never drops it.
    for (const name of purgedNames(data, id)) {
      const kept = known?.files[name];
      if (kept !== undefined && !(name in files)) files[name] = kept;
    }
    if (known !== undefined && known.body === hash(body) && sameFiles(known.files, files) && (known.summary ?? 0) >= SUMMARY_VERSION) continue;
    changed.push([id, dir, script, body, known, files]);
  }
  let left = changed.length;
  let refusal: Problem | null = null;
  for (const [id, dir, script, body, known, files] of changed) {
    Object.assign(status, { state: "syncing", pending: left + waiting });
    try {
      const pushed = await push(id, dir, script, body, known, files);
      if (pushed === "overtaken") {
        // Another Mac saved it first: theirs comes down, then this waits a
        // little longer each time, so a newer copy that can't come down (its
        // body not in the cloud) isn't asked for every few seconds (Oct 30:
        // Predator Tutor, 167 times in 20 minutes).
        const wait = Math.min((backoff.get(id)?.wait ?? BACKOFF_FIRST / 4) * 2, BACKOFF_MAX);
        backoff.set(id, { until: Date.now() + wait, wait });
        waiting++;
        syncSoon();
      } else {
        backoff.delete(id);
        refusals.delete(id);
        ledger.scripts[id] = pushed;
        save();
        for (const hook of pushedHooks) hook(id);
      }
    } catch (error) {
      const problem = error instanceof Problem ? error : new Problem(diag.messageOf(error));
      if (problem.offline) throw problem;
      // The cloud failing for a moment (a 5xx, 429): this one waits its first backoff and goes again, not kept as a refusal.
      if (problem.temporary) {
        backoff.set(id, { until: Date.now() + BACKOFF_FIRST / 2, wait: BACKOFF_FIRST / 2 });
        diag.warn("writer", `${jobs.named(id, script.title)}: the cloud failed for a moment (${problem.message}); trying again soon`);
        waiting++;
        left--;
        continue;
      }
      // Refused: this one waits, longer each time, and the rest go on.
      const wait = Math.min((backoff.get(id)?.wait ?? BACKOFF_FIRST / 2) * 2, BACKOFF_MAX);
      backoff.set(id, { until: Date.now() + wait, wait });
      refusals.set(id, problem.message);
      diag.warn("writer", `${jobs.named(id, script.title)}: couldn't save to the cloud (${problem.message}); trying again in ${Math.round(wait / 1000)} s`);
      waiting++;
      refusal ??= new Problem(`${script.title} couldn't be saved to the cloud: ${problem.message}`);
    }
    left--;
  }
  if (pull) await syncLessons(data);
  if (refusal !== null) throw refusal;
  return waiting;
}

/** One round with a pull, for tests. */
export const syncOnceForTests = (data: string): Promise<number> => tick(data, true);

/** Merges the kept lessons both ways: this Mac's and the cloud's, each lesson by its id, and one forgotten anywhere gone everywhere. */
async function syncLessons(data: string): Promise<void> {
  const remote = await fetchBytes(LESSONS_KEY);
  let theirs: Shelf | null = null;
  try {
    theirs = remote === null ? null : (JSON.parse(new TextDecoder().decode(remote)) as Shelf);
  } catch {
    theirs = null;
  }
  const here = readShelf(data);
  const merged = merge(here, { lessons: theirs?.lessons ?? [], forgotten: theirs?.forgotten ?? [] });
  if (JSON.stringify(merged) !== JSON.stringify(here)) changeShelf(data, (shelf) => Object.assign(shelf, merged));
  if (theirs === null || JSON.stringify(merged) !== JSON.stringify({ lessons: theirs.lessons ?? [], forgotten: theirs.forgotten ?? [] })) {
    try {
      await uploadBytes(LESSONS_KEY, JSON.stringify(merged, null, 2));
    } catch (error) {
      // Only someone who may teach writes the shared lessons: the rest keep the merge here.
      if (!/can't|403/.test(diag.messageOf(error))) throw error;
    }
  }
}

/** A pulled body with the cloud's `createdBy` in it, when the cloud has one and the body says otherwise. */
export function withCreator(body: Uint8Array, createdBy: unknown): Uint8Array {
  if (typeof createdBy !== "object" || createdBy === null || typeof (createdBy as { sub?: unknown }).sub !== "string") return body;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  } catch {
    return body;
  }
  const mine = value.createdBy as { sub?: unknown } | undefined;
  if (mine?.sub === (createdBy as { sub: string }).sub && JSON.stringify(mine) === JSON.stringify(createdBy)) return body;
  value.createdBy = createdBy;
  return new TextEncoder().encode(JSON.stringify(value, null, 2));
}

// ── Which copy wins (docs/plans/2026-11-01-effect.md, round 3) ──
//
// The rules a pull follows were fixed five times in three days (02c455de,
// 352e9d0a, 83e97e64, 0385252c and the body that went missing), each one a
// case nobody had thought of. They're one pure function now, `decidePull`,
// so its promises are tested over every case at once (test/writer/merge.test.ts):
// work changed here is never lost, a built script is never replaced by an
// unbuilt one, at most one conflicted copy is kept per revision, an older or
// equal revision is never taken, and a script deleted elsewhere after it
// changed here is kept as a restored copy.

/** What a pull knows before it acts: the cloud's row, this Mac's ledger and body, and (once fetched) the cloud's body. */
export interface PullSeen {
  /** Deleted on another Mac. */
  readonly deleted: boolean;
  /** The rev this Mac last synced, or null when it never did. */
  readonly knownRev: number | null;
  /** The cloud's rev. */
  readonly rev: number;
  /** This Mac's body, or null when there's none. `same`: it's the cloud's body; `changed`: it changed here since the last sync. */
  readonly here: { readonly same: boolean; readonly changed: boolean; readonly built: boolean; readonly unfinished: boolean } | null;
  /** The cloud's body: not fetched yet (undefined), missing from the cloud (null), or what it is. */
  readonly theirs: { readonly built: boolean } | null | undefined;
  /** The rev a conflicted copy was already kept for. */
  readonly copiedRev: number | null;
}

export type PullDecision =
  | { readonly do: "delete"; readonly keepCopy: boolean }
  | { readonly do: "skip" }
  | { readonly do: "fetch" }
  | { readonly do: "keep-ours"; readonly why: "theirs-missing" | "ours-built" }
  | { readonly do: "fail"; readonly why: "theirs-missing" }
  | { readonly do: "take"; readonly keepCopy: boolean; readonly why: "plain" | "ours-unfinished" | "copy-kept-already" | "conflict" };

/** What a pull does with what it knows. */
export function decidePull(seen: PullSeen): PullDecision {
  if (seen.deleted) return { do: "delete", keepCopy: seen.here !== null && seen.here.changed };
  if (seen.knownRev !== null && seen.knownRev >= seen.rev) return { do: "skip" };
  if (seen.theirs === undefined) return { do: "fetch" };
  if (seen.theirs === null) return seen.here !== null ? { do: "keep-ours", why: "theirs-missing" } : { do: "fail", why: "theirs-missing" };
  const here = seen.here;
  if (here === null || here.same || !here.changed) return { do: "take", keepCopy: false, why: "plain" };
  if (here.built && !seen.theirs.built) return { do: "keep-ours", why: "ours-built" };
  if (here.unfinished) return { do: "take", keepCopy: false, why: "ours-unfinished" };
  if (seen.copiedRev === seen.rev) return { do: "take", keepCopy: false, why: "copy-kept-already" };
  return { do: "take", keepCopy: true, why: "conflict" };
}

/** Brings one script from the cloud when it's newer than this Mac's, as `decidePull` says. */
async function pullOne(data: string, ledger: Ledger, row: Record<string, unknown>): Promise<void> {
  const id = String(row.scriptId ?? "");
  if (!store.idOk(id) || busy(id) || deleting(data).includes(id)) return;
  const rev = Number(row.rev ?? 0);
  const dir = store.scriptDir(data, id);
  const known = ledger.scripts[id];
  const title = String(row.title ?? "");
  const bodyPath = join(dir, "script.json");
  const ours = isFile(bodyPath) ? fs.readFileSync(bodyPath) : null;
  const seen = (theirs: Uint8Array | null | undefined): PullSeen => ({
    deleted: row.deletedAt != null,
    knownRev: known === undefined ? null : known.rev,
    rev,
    here: ours === null ? (fs.existsSync(dir) && row.deletedAt != null ? { same: false, changed: changedHere(dir, known), built: false, unfinished: false } : null) : { same: theirs != null && hash(ours) === hash(theirs), changed: changedHere(dir, known), built: builtIn(ours), unfinished: unfinished(ours) },
    theirs: theirs === undefined ? undefined : theirs === null ? null : { built: builtIn(theirs) },
    copiedRev: ledger.copied?.[id] ?? null,
  });
  let decision = decidePull(seen(undefined));
  if (decision.do === "delete") {
    // Deleted on another Mac: gone here too. Changed here since, it's kept as a copy under a new id.
    if (fs.existsSync(dir)) {
      if (decision.keepCopy) {
        keepCopy(data, dir, "restored copy");
        diag.info("writer", `${jobs.named(id, title)}: deleted on another Mac after it changed here, so this Mac's version is kept as a restored copy`);
      } else diag.info("writer", `${jobs.named(id, title)}: deleted on another Mac, so here too`);
      fs.rmSync(dir, { recursive: true, force: true });
      store.libraryChanged();
    }
    delete ledger.scripts[id];
    return;
  }
  if (decision.do === "skip") return;
  const body = await fetchBytes(String(row.bodyKey ?? ""));
  decision = decidePull(seen(body));
  if (decision.do === "fail") throw new Problem("Its body isn't in the cloud.");
  if (decision.do === "keep-ours") {
    // theirs-missing: the newest revision lost its body (two Macs once pushed the same body under one key, and the
    // loser's clean-up deleted it): no Mac can take it, so a Mac holding the script saves its copy as the next revision
    // rather than asking for the missing one for ever. ours-built: a built script is never replaced by an unbuilt copy
    // of it (Oct 31, M's CORRUPT Cops: his build came back unbuilt from another Mac's older copy, the build only in a
    // "conflicted copy", so Start the edit stayed greyed out).
    diag.warn(
      "writer",
      decision.why === "theirs-missing"
        ? `${jobs.named(id, title)}: rev ${rev}'s body isn't in the cloud, so this Mac's copy is saved as the next revision`
        : `${jobs.named(id, title)}: rev ${rev} from another Mac isn't built and this Mac's is, so this Mac's is saved as the next revision`,
    );
    ledger.scripts[id] = { rev, body: "", files: known?.files ?? {}, summary: 0 };
    syncSoon();
    return;
  }
  if (body === null || decision.do !== "take") return;
  const atStart = ours === null ? null : hash(ours);
  // An import that never finished here (or Writer's copy of one, brought in by Edit) has nothing to keep: theirs
  // replaces it (Oct 31, M's Mac: four stale imports became conflicted copies that showed as stopped imports). A copy
  // is kept once per rev: a pull that failed after keeping one and was tried again kept another every minute (Oct 31,
  // Predator Tutor: 294 copies from Mathias's Mac, rev 7 naming a file no longer in the cloud).
  if (decision.why === "ours-unfinished") diag.warn("writer", `${jobs.named(id, title)}: this Mac's copy is an import that never finished, so rev ${rev} replaces it`);
  if (decision.keepCopy) {
    keepCopy(data, dir, "conflicted copy");
    ledger.copied = { ...ledger.copied, [id]: rev };
    writeJson(ledgerPath(data), ledger);
  }
  fs.mkdirSync(dir, { recursive: true });
  const files: Record<string, Kept> = {};
  const left: string[] = [];
  for (const file of (Array.isArray(row.files) ? row.files : []) as Record<string, unknown>[]) {
    const [name, key, size] = [String(file.name ?? ""), String(file.key ?? ""), Number(file.size ?? 0)];
    const path = inside(dir, name);
    if (name === "" || key === "" || path === null) continue;
    // A small JSON file (the chat, versions, research) can change and keep its size, so on a newer script it's always fetched again.
    const smallJson = name.endsWith(".json") && size < 2_000_000;
    const present = !smallJson && isFile(path) && fs.statSync(path).size === size;
    // Footage isn't downloaded: the page plays it from the cloud (`stream`), so a first sync brings the scripts at once.
    // Nor are a transcription's pieces, needed only to finish one cut short (a new Mac fetched thousands, Oct 30).
    if ((storage.isFootage(name) || /(^|\/)pieces\//u.test(name)) && !present) {
      if (isFile(path)) fs.rmSync(path);
      files[name] = { key, size, mtime: known?.files[name]?.mtime ?? 0 };
      left.push(name);
      continue;
    }
    if (row.archived != null && storage.isFootage(name)) continue;
    if (!present) {
      try {
        await download(id, name, key, size, path);
      } catch (error) {
        if (!(error instanceof Gone)) throw error;
        // Left out rather than asked for for ever: a copy here goes up again with the next push, healing the cloud's.
        diag.warn("writer", `${jobs.named(id, title)}: rev ${rev}'s ${name} isn't in the cloud, so it's left out${isFile(path) ? " and this Mac's goes up again" : ""}`);
        continue;
      }
    }
    files[name] = { key, size, mtime: mtime(path) };
  }
  leftInCloud(data, id, left);
  // Saved here while the files came down: that version is kept as a copy, not lost.
  if ((isFile(bodyPath) ? hash(fs.readFileSync(bodyPath)) : null) !== atStart) {
    diag.warn("writer", `${jobs.named(id, title)}: changed here while rev ${rev} came down; this Mac's version is kept as a copy`);
    keepCopy(data, dir, "conflicted copy");
  }
  // Who started it, as the cloud recorded it from their verified sign-in, wins over the body's.
  const given = withCreator(body, row.createdBy);
  writeAtomic(bodyPath, Buffer.from(given));
  diag.info("writer", `${jobs.named(id, title)}: rev ${rev} came from ${String(row.updatedBy ?? "another Mac")}`);
  // Taken as current whichever version of Edit saved it: a row from a Mac on
  // an older Edit (no runFailed) pushed again here was overtaken there, round
  // and round, while the team's Macs were on mixed versions (Oct 30).
  const summary = row.summary as { kind?: unknown } | undefined;
  ledger.scripts[id] = { rev, body: hash(given), files, summary: typeof summary?.kind === "string" ? SUMMARY_VERSION : 0 };
  if (ledger.copied !== undefined) delete ledger.copied[id];
  store.libraryChanged();
}

/** Sends a script's changed files and its body, then commits them. */
async function push(id: string, dir: string, script: Script, body: Uint8Array, known: Known | undefined, files: Record<string, Kept>): Promise<Known | "overtaken"> {
  const base = known?.rev ?? 0;
  const kept: Record<string, Kept> = {};
  const began = Date.now();
  let [sent, sentBytes] = [0, 0];
  // Each push's files go under keys no committed revision uses, so a push that loses to another Mac's never overwrites the winner's files.
  const pushId = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const uploaded: string[] = [];
  for (const [name, local] of Object.entries(files)) {
    const previous = known?.files[name];
    if (previous !== undefined && previous.size === local.size && previous.mtime === local.mtime) {
      kept[name] = previous;
      continue;
    }
    const path = inside(dir, name);
    if (path === null) continue;
    const key = `${PREFIX}/${id}/files/r${base + 1}-${pushId}/${name}`;
    try {
      const size = await upload(id, name, path, key);
      sent++;
      sentBytes += size;
      uploaded.push(key);
      kept[name] = { key, size, mtime: local.mtime };
    } catch (error) {
      if (error instanceof Problem && error.offline) throw error;
      // A file that vanished while it went up (a temp piece) is left out.
      if (!fs.existsSync(path)) continue;
      await remove(uploaded);
      throw error;
    }
  }
  const digest = hash(body);
  // Unique to this push, as its files are: two Macs pushing the same body on the same revision named it alike, and the loser's
  // clean-up deleted the winner's body (Oct 30, Predator Tutor's rev 5: "Its body isn't in the cloud" on every Mac).
  const bodyKey = `${PREFIX}/${id}/body/${base + 1}-${digest.slice(0, 12)}-${pushId}.json`;
  await uploadBytes(bodyKey, body);
  const answer = await convex("mutation", "writer:commitScript", {
    scriptId: id,
    baseRev: base,
    title: script.title,
    bodyKey,
    bodySize: body.length,
    files: Object.entries(kept).map(([name, file]) => ({ name, key: file.key, size: file.size })),
    summary: store.summary(script, dir),
    holder: holder(),
  });
  if (answer.ok) {
    const value = (answer.value ?? {}) as { stale?: unknown; rev?: unknown };
    await remove((Array.isArray(value.stale) ? value.stale : []).filter((key): key is string => typeof key === "string"));
    const rev = typeof value.rev === "number" ? value.rev : base + 1;
    diag.info("writer", `${jobs.named(id, script.title)}: saved to the cloud as rev ${rev}${sent > 0 ? ` with ${sent} ${sent === 1 ? "file" : "files"} (${Math.round(sentBytes / 1e6)} MB)` : ""} in ${Math.round((Date.now() - began) / 1000)} s`);
    return { rev, body: digest, files: kept, summary: SUMMARY_VERSION };
  }
  await remove([...uploaded, bodyKey]);
  if (answer.code === "conflict") {
    diag.warn("writer", `${jobs.named(id, script.title)}: another Mac saved it first (rev ${base} is behind); taking theirs and keeping this Mac's as a copy`);
    return "overtaken";
  }
  throw new Problem(`The cloud refused ${script.title}: ${String(answer.data.message ?? answer.code)}`);
}
