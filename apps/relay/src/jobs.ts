/**
 * Cloud jobs (speed-plan 7.1): work that finishes without the Mac. The first
 * is a Drive file → R2 copy, which Edit did by streaming the whole file
 * through the Mac (download and upload both on its connection, and lost when
 * the Mac slept or Edit restarted).
 *
 * `DriveToR2` is a Cloudflare Workflow: each 64 MiB part is a durable step
 * (Drive's bytes for that range, piped into an R2 multipart part, never held
 * in memory or in the Workflow's state; only the part's ETag is kept), so an
 * interruption retries the part it was on and carries on from there. Before
 * starting it looks the file up (size and checksum: its version); the job's
 * id is the file, the key and that version, so asking again for the same
 * copy finds the same job, and a changed file is a new one. When the upload
 * is complete and its size checked, the job records the original in Edit's
 * registry (Convex `edit:putMedia`, as Edit does), so any machine finds it.
 * A job that fails or is cancelled aborts its upload: nothing half-written
 * stays in R2.
 *
 * The Mac asks with /v1/cloud/jobs/drive and follows /v1/cloud/jobs/status
 * (bytes so far: R2's list of the parts uploaded).
 */

import { BadRequest, escapeXml, isObject, needKey, objectUrl, r2Fetch, unescapeXml, Upstream, xmlValue, type R2 } from "./cloud";

// The Workers runtime's modules (no @cloudflare/workers-types here).
// @ts-ignore: resolved by wrangler
import { WorkflowEntrypoint } from "cloudflare:workers";
// @ts-ignore: resolved by wrangler
import { NonRetryableError } from "cloudflare:workflows";

declare const FixedLengthStream: { new (size: number): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } };

interface WorkflowInstance {
  id: string;
  status(): Promise<{ status: string; error?: unknown; output?: unknown }>;
  terminate(): Promise<void>;
}

interface Workflow {
  create(options: { id: string; params: unknown }): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowInstance>;
}

interface Step {
  do<T>(name: string, config: Record<string, unknown>, work: () => Promise<T>): Promise<T>;
  do<T>(name: string, work: () => Promise<T>): Promise<T>;
}

export interface JobsEnv {
  /** The Workflow binding (wrangler.toml `[[workflows]]`). */
  DRIVE_TO_R2?: Workflow;
  GOOGLE_DRIVE_CLIENT_ID?: string;
  GOOGLE_DRIVE_CLIENT_SECRET?: string;
  GOOGLE_DOCS_REFRESH_TOKEN?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  CONVEX_URL?: string;
  CONVEX_SERVICE_TOKEN?: string;
}

interface DriveParams {
  file: string;
  key: string;
  name: string;
  size: number;
  version: string;
  /** Bytes per part (tests make it small); else `PART`. */
  part?: number;
}

/** Each part: big enough that a 4 GB file is ~60 steps, small enough to retry. */
export const PART = 64 * 1024 * 1024;
/** Parts copied at once. */
const AT_ONCE = 4;
const DRIVE = "https://www.googleapis.com/drive/v3";

// --- Google -----------------------------------------------------------------------

async function googleToken(env: JobsEnv): Promise<string> {
  return (await googleSignIn(env)).access_token;
}

/** A fresh access token for the team's Google sign-in (Drive and Docs), and how long it lasts (seconds). */
export async function googleSignIn(env: JobsEnv): Promise<{ access_token: string; expires_in: number }> {
  if (!env.GOOGLE_DRIVE_CLIENT_ID || !env.GOOGLE_DRIVE_CLIENT_SECRET || !env.GOOGLE_DOCS_REFRESH_TOKEN) {
    throw new Upstream("Google Drive is not configured on the relay yet.");
  }
  const answer = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_DRIVE_CLIENT_ID,
      client_secret: env.GOOGLE_DRIVE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_DOCS_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const value = (await answer.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (!answer.ok || typeof value?.access_token !== "string") throw new Upstream(`Google sign-in failed (${answer.status}).`);
  const expires = typeof value.expires_in === "number" && value.expires_in > 0 ? Math.floor(value.expires_in) : 3600;
  return { access_token: value.access_token, expires_in: expires };
}

/** A Drive file id (the characters Drive uses). */
export function validFileId(file: unknown): file is string {
  return typeof file === "string" && /^[A-Za-z0-9_-]{10,200}$/.test(file);
}

/** The file's name, size and version (its checksum, else its size and modification time). */
export async function driveMeta(file: string, token: string): Promise<{ name: string; size: number; version: string }> {
  const answer = await fetch(`${DRIVE}/files/${file}?fields=name,size,md5Checksum,modifiedTime,mimeType&supportsAllDrives=true`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (answer.status === 404) throw new BadRequest("That Drive file isn't there, or this account can't see it.");
  if (!answer.ok) throw new Upstream(`Google Drive ${answer.status}: ${(await answer.text()).slice(0, 200)}`);
  const meta = (await answer.json()) as { name?: string; size?: string; md5Checksum?: string; modifiedTime?: string };
  const size = Number(meta.size);
  if (!Number.isSafeInteger(size) || size <= 0) throw new BadRequest("That Drive file has no bytes to copy (a Google Doc?).");
  return { name: meta.name ?? file, size, version: meta.md5Checksum ?? `${size}-${meta.modifiedTime ?? ""}` };
}

// --- R2 multipart ---------------------------------------------------------------------

async function createUpload(r2: R2, key: string): Promise<string> {
  const answer = await r2Fetch(r2, "POST", key, { uploads: "" });
  const id = xmlValue(await answer.text(), "UploadId");
  if (!id) throw new Upstream("R2 gave no upload id.");
  return id;
}

/** The uploads under way for `key` (S3 ListMultipartUploads). */
async function uploadsFor(r2: R2, key: string): Promise<string[]> {
  const text = await (await r2Fetch(r2, "GET", "", { uploads: "", prefix: key })).text();
  return [...text.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)]
    .filter(([, item]) => unescapeXml(xmlValue(item, "Key") ?? "") === key)
    .map(([, item]) => unescapeXml(xmlValue(item, "UploadId") ?? ""))
    .filter((id) => id !== "");
}

/** Bytes in the parts uploaded so far (S3 ListParts). */
async function bytesUploaded(r2: R2, key: string, upload: string): Promise<number> {
  const text = await (await r2Fetch(r2, "GET", key, { uploadId: upload }, { allow404: true })).text();
  return [...text.matchAll(/<Size>(\d+)<\/Size>/g)].reduce((sum, [, size]) => sum + Number(size), 0);
}

async function abortUploads(r2: R2, key: string): Promise<void> {
  for (const upload of await uploadsFor(r2, key)) await r2Fetch(r2, "DELETE", key, { uploadId: upload }, { allow404: true });
}

/** Copies Drive bytes [from, from + length) into part `number`; its ETag. */
async function copyPart(env: JobsEnv, r2: R2, params: DriveParams, upload: string, number: number): Promise<string> {
  const part = params.part ?? PART;
  const from = (number - 1) * part;
  const length = Math.min(part, params.size - from);
  const token = await googleToken(env);
  const source = await fetch(`${DRIVE}/files/${params.file}?alt=media&supportsAllDrives=true`, {
    headers: { authorization: `Bearer ${token}`, range: `bytes=${from}-${from + length - 1}` },
  });
  if (source.status !== 206 && !(source.status === 200 && from === 0 && length === params.size)) {
    await source.body?.cancel();
    throw new Error(`Google Drive answered ${source.status} for part ${number}`);
  }
  if (source.body === null) throw new Error(`Google Drive sent nothing for part ${number}`);
  // A known length, so R2 gets a Content-Length and the bytes stream through.
  const { readable, writable } = new FixedLengthStream(length);
  const piped = source.body.pipeTo(writable);
  const url = await objectUrl(r2, "PUT", params.key, { partNumber: String(number), uploadId: upload }, 3600);
  const [answer] = await Promise.all([fetch(url, { method: "PUT", body: readable }), piped]);
  if (!answer.ok) throw new Error(`R2 ${answer.status} for part ${number}: ${(await answer.text()).slice(0, 200)}`);
  const etag = answer.headers.get("etag");
  if (!etag) throw new Error(`R2 gave part ${number} no ETag`);
  return etag;
}

async function completeUpload(r2: R2, key: string, upload: string, etags: string[]): Promise<number> {
  const xml = `<CompleteMultipartUpload>${etags.map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
  const answer = await r2Fetch(r2, "POST", key, { uploadId: upload }, { body: xml, headers: { "content-type": "application/xml" } });
  const text = await answer.text();
  if (text.includes("<Error>")) throw new Error(`R2: ${xmlValue(text, "Code") ?? "Error"}: ${xmlValue(text, "Message") ?? text.slice(0, 300)}`);
  const head = await r2Fetch(r2, "HEAD", key, {}, { allow404: true });
  return head.status === 200 ? Number(head.headers.get("content-length")) : 0;
}

async function existingSize(r2: R2, key: string): Promise<number | null> {
  const head = await r2Fetch(r2, "HEAD", key, {}, { allow404: true });
  return head.status === 200 ? Number(head.headers.get("content-length")) : null;
}

// --- Convex: the registry, as Edit writes it --------------------------------------------

async function register(env: JobsEnv, params: DriveParams, size: number): Promise<void> {
  // A test copy (edit/test/…) never names a Drive file's original.
  if (!env.CONVEX_URL || !env.CONVEX_SERVICE_TOKEN || params.key.startsWith("edit/test/")) return;
  const answer = await fetch(`${env.CONVEX_URL.replace(/\/+$/, "")}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: "edit:putMedia",
      args: { source: `drive:${params.file}`, name: params.name, originalKey: params.key, size, originalReady: true, token: env.CONVEX_SERVICE_TOKEN },
      format: "json",
    }),
  });
  const value = (await answer.json().catch(() => null)) as { status?: string; errorMessage?: string } | null;
  if (value?.status !== "success") throw new Error(`Convex: ${value?.errorMessage ?? answer.status}`);
}

function r2Of(env: JobsEnv): R2 {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET) throw new NonRetryableError("Cloud storage is not configured on the relay.");
  return { host: `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, bucket: env.R2_BUCKET, accessKeyId: env.R2_ACCESS_KEY_ID, secret: env.R2_SECRET_ACCESS_KEY };
}

// --- The Workflow -------------------------------------------------------------------

export class DriveToR2 extends WorkflowEntrypoint<JobsEnv, DriveParams> {
  async run(event: { payload: DriveParams }, step: Step): Promise<{ key: string; size: number; name: string }> {
    const params = event.payload;
    const env = (this as unknown as { env: JobsEnv }).env;
    const r2 = r2Of(env);
    const retries = { retries: { limit: 6, delay: "15 seconds", backoff: "exponential" }, timeout: "30 minutes" };
    let ownedUpload: string | null = null;
    try {
      const unchanged = await step.do("check the file", retries, async () => {
        const meta = await driveMeta(params.file, await googleToken(env));
        return meta.version === params.version;
      });
      if (!unchanged) throw new NonRetryableError("The Drive file changed since the copy was asked for; ask again.");
      const there = await step.do("look for a finished copy", retries, () => existingSize(r2, params.key));
      if (there === params.size) {
        await step.do("register", retries, () => register(env, params, params.size));
        return { key: params.key, size: params.size, name: params.name };
      }
      const upload = await step.do("start the upload", retries, () => createUpload(r2, params.key));
      ownedUpload = upload;
      const parts = Math.ceil(params.size / (params.part ?? PART));
      const etags: string[] = new Array(parts);
      for (let first = 1; first <= parts; first += AT_ONCE) {
        const batch = Array.from({ length: Math.min(AT_ONCE, parts - first + 1) }, (_, index) => first + index);
        await Promise.all(
          batch.map(async (number) => {
            etags[number - 1] = await step.do(`part ${number} of ${parts}`, retries, () => copyPart(env, r2, params, upload, number));
          }),
        );
      }
      const stillSame = await step.do("verify the source version", retries, async () => {
        const meta = await driveMeta(params.file, await googleToken(env));
        return meta.version === params.version && meta.size === params.size;
      });
      if (!stillSame) throw new NonRetryableError("The Drive file changed during its copy; ask again.");
      const size = await step.do("finish the upload", retries, () => completeUpload(r2, params.key, upload, etags));
      if (size !== params.size) throw new NonRetryableError(`R2 has ${size} bytes, not the file's ${params.size}`);
      await step.do("register", retries, () => register(env, params, size));
      return { key: params.key, size, name: params.name };
    } catch (error) {
      // Nothing half-written stays in R2.
      await step.do("abort", async () => {
        // Another project may be copying the same file. Never sweep its
        // upload while cleaning up this attempt's failure.
        if (ownedUpload !== null) await r2Fetch(r2, "DELETE", params.key, { uploadId: ownedUpload }, { allow404: true });
        return true;
      });
      throw error;
    }
  }
}

// --- Routes -------------------------------------------------------------------------

async function jobId(file: string, key: string, version: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${key}\n${version}`)));
  const hex = Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `drive-${file}-${hex}`.slice(0, 100);
}

function workflow(env: JobsEnv): Workflow {
  if (!env.DRIVE_TO_R2) throw new Upstream("Cloud jobs are not configured on the relay yet.");
  return env.DRIVE_TO_R2;
}

async function instance(env: JobsEnv, id: string): Promise<WorkflowInstance | null> {
  try {
    return await workflow(env).get(id);
  } catch {
    return null;
  }
}

/** Starts copying Drive file `file` to R2 `key` (or finds the job already doing it). */
export async function driveJob(body: Record<string, unknown>, env: JobsEnv, r2: R2): Promise<Record<string, unknown>> {
  if (!validFileId(body.file)) throw new BadRequest("file must be a Drive file id.");
  const key = needKey(body.key);
  const meta = await driveMeta(body.file, await googleToken(env));
  const base = await jobId(body.file, key, meta.version);
  const params: DriveParams = { file: body.file, key, name: meta.name, size: meta.size, version: meta.version };
  // Ids are unique for good, so a copy started again is `<id>-r<n>`: the
  // latest attempt answers, unless it failed, was cancelled, or its copy was
  // deleted since.
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = attempt === 0 ? base : `${base.slice(0, 95)}-r${attempt}`;
    const found = await instance(env, id);
    if (found === null) {
      try {
        await workflow(env).create({ id, params });
      } catch (error) {
        // Two projects can discover a missing original together. Creating
        // the same durable id is a join, not a failed cloud copy or a reason
        // to stream a second original through the Mac.
        if (await instance(env, id) === null) throw error;
      }
      return { id, status: "queued", total: meta.size, name: meta.name };
    }
    const status = await found.status();
    const gone = status.status === "complete" && (await existingSize(r2, key)) !== meta.size;
    if (!gone && status.status !== "errored" && status.status !== "terminated") return { id, status: status.status, total: meta.size, name: meta.name };
  }
  throw new Upstream("That copy failed too many times; look at the relay's log.");
}

function needJobId(id: unknown): string {
  if (typeof id !== "string" || !/^drive-[A-Za-z0-9_-]{10,200}$/.test(id) || id.length > 100) throw new BadRequest("id must be a job id.");
  return id;
}

/** Where job `id` is: its status, the bytes copied so far, and its result or error. */
export async function jobStatus(body: Record<string, unknown>, env: JobsEnv, r2: R2): Promise<Record<string, unknown>> {
  const id = needJobId(body.id);
  const found = await instance(env, id);
  if (found === null) return { id, status: "unknown" };
  const status = await found.status();
  const out: Record<string, unknown> = { id, status: status.status };
  if (status.status === "complete" && isObject(status.output)) {
    out.output = status.output;
    out.bytes = status.output.size;
  } else if (status.status === "errored" || status.status === "terminated") {
    const error = status.error;
    out.error = isObject(error) ? String(error.message ?? error.name ?? "failed") : String(error ?? status.status);
  } else if (typeof body.key === "string") {
    // Progress: the parts in R2 so far.
    const key = needKey(body.key);
    const [upload] = await uploadsFor(r2, key);
    out.bytes = upload === undefined ? 0 : await bytesUploaded(r2, key, upload);
  }
  return out;
}

export async function cancelJob(body: Record<string, unknown>, env: JobsEnv, r2: R2): Promise<Record<string, unknown>> {
  const id = needJobId(body.id);
  const found = await instance(env, id);
  if (found !== null) {
    const status = await found.status();
    if (status.status !== "complete" && status.status !== "errored" && status.status !== "terminated") await found.terminate();
  }
  if (typeof body.key === "string") await abortUploads(r2, needKey(body.key));
  return { ok: true };
}
