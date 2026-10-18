/**
 * Edit's cloud: footage and previews on Cloudflare R2, project files in Convex.
 * The relay holds the R2 keys and Convex's service token; Edit only ever gets
 * short-lived presigned URLs and the answers of `edit:` Convex functions.
 *
 * Every route is POST JSON and needs `authorization: Bearer <CLOUD_TOKEN>`
 * (no IP fallback: without the secret every request is refused). R2 keys
 * must sit under `edit/` (the bucket is shared with Repack).
 *
 *   /v1/cloud/r2/url                {key, method: GET|PUT|HEAD, expires?} → {url}
 *   /v1/cloud/r2/multipart/create   {key, contentType?}                    → {uploadId}
 *   /v1/cloud/r2/multipart/urls     {key, uploadId, parts: [n…]}          → {urls: {n: url}}
 *   /v1/cloud/r2/multipart/complete {key, uploadId, parts: [{partNumber, etag}]} → {ok, size?, etag?}
 *   /v1/cloud/r2/multipart/abort    {key, uploadId}                        → {ok}
 *   /v1/cloud/r2/head               {key}                                  → {exists, size?, etag?}
 *   /v1/cloud/r2/delete             {keys: [...]}  (at most 40)            → {ok, deleted}
 *   /v1/cloud/r2/list               {prefix, cursor?}  (a page of ≤1000)   → {objects: [{key, size}], cursor?}
 *   /v1/cloud/convex                {kind: query|mutation|action, path: "edit:…", args?}
 *                                   → Convex's answer ({status: "success", value} | {status: "error", errorMessage})
 *   /v1/cloud/jobs/drive            {file, key}  → {id, status}: Drive file → R2 in the cloud (jobs.ts)
 *   /v1/cloud/jobs/status           {id}         → {id, status, bytes?, total?, output?, error?}
 *   /v1/cloud/jobs/cancel           {id}         → {ok}
 *   /v1/cloud/google/token          {}           → {access_token, expires_in}: the team's Google sign-in
 *                                   (Drive and Docs: the sound library, script imports, Drive links and uploads)
 *   /v1/cloud/ai/chat               an AI Gateway chat completion, passed through with the relay's
 *                                   AI_GATEWAY_API_KEY (the footage watcher); the gateway's answer as it is
 */
import { cancelJob, driveJob, googleSignIn, jobStatus, type JobsEnv } from "./jobs";

export interface CloudEnv extends JobsEnv {
  /** Edit's bearer token for /v1/cloud/* (EDIT_RELAY_TOKEN on the app side). */
  CLOUD_TOKEN?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  /** The Convex deployment (https://….convex.cloud), shared with Repack. */
  CONVEX_URL?: string;
  /** Passed as `args.token` to every `edit:` function, which checks it. */
  CONVEX_SERVICE_TOKEN?: string;
  /** Vercel's AI Gateway, for the footage watcher (/v1/cloud/ai/chat). */
  AI_GATEWAY_API_KEY?: string;
}

const HOUR = 3600;
const MAX_EXPIRES = 7 * 24 * HOUR; // SigV4's limit
const DEFAULT_EXPIRES: Record<string, number> = { GET: 6 * HOUR, PUT: HOUR, HEAD: HOUR };
/** Subrequests per invocation are limited (50 on the free plan). */
const MAX_DELETE = 40;
const MAX_PART_URLS = 1000;
const MAX_BODY = 8 * 1024 * 1024;
const CONVEX_KINDS = new Set(["query", "mutation", "action"]);
/** A watch window's request: a few minutes of 360p video, base64 (Edit caps the clip at 15 MiB). */
const MAX_AI_BODY = 32 * 1024 * 1024;
const AI_GATEWAY = "https://ai-gateway.vercel.sh/v1/chat/completions";
/** Only Edit's module: the relay must not reach Repack's other functions. */
const CONVEX_PATH = /^edit:[A-Za-z_][A-Za-z0-9_]*$/;

export async function cloud(request: Request, url: URL, env: CloudEnv): Promise<Response> {
  if (!(await cloudAuthorized(request, env))) return json(401, { error: "This relay needs Edit's cloud token." });
  if (request.method !== "POST") return json(405, { error: `POST JSON to ${url.pathname}` });
  if (url.pathname === "/v1/cloud/ai/chat") return aiChat(request, env);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return json(413, { error: "Request too large." });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!isObject(parsed)) throw new Error("not an object");
    body = parsed;
  } catch {
    return json(400, { error: "Send a JSON object." });
  }
  const route = url.pathname.slice("/v1/cloud/".length);
  if (route === "convex") return convex(body, env);
  if (route === "google/token") {
    try {
      return json(200, await googleSignIn(env));
    } catch (error) {
      if (error instanceof Upstream) return json(502, { error: error.message });
      throw error;
    }
  }
  if (route.startsWith("jobs/")) {
    const r2 = r2Config(env);
    if (!r2) return json(503, { error: "Cloud storage is not configured on the relay yet." });
    try {
      if (route === "jobs/drive") return json(200, await driveJob(body, env, r2));
      if (route === "jobs/status") return json(200, await jobStatus(body, env, r2));
      if (route === "jobs/cancel") return json(200, await cancelJob(body, env, r2));
    } catch (error) {
      if (error instanceof BadRequest) return json(400, { error: error.message });
      if (error instanceof Upstream) return json(502, { error: error.message });
      throw error;
    }
    return json(404, { error: "not found" });
  }
  const handler = route.startsWith("r2/") && Object.hasOwn(R2_ROUTES, route.slice(3)) ? R2_ROUTES[route.slice(3)] : undefined;
  if (!handler) return json(404, { error: "not found" });
  const r2 = r2Config(env);
  if (!r2) return json(503, { error: "Cloud storage is not configured on the relay yet." });
  try {
    return await handler(body, r2);
  } catch (error) {
    if (error instanceof BadRequest) return json(400, { error: error.message });
    if (error instanceof Upstream) return json(502, { error: error.message });
    throw error;
  }
}

/** `Bearer <CLOUD_TOKEN>`, compared in constant time; refused when unset. */
/** A chat completion through the AI Gateway with the relay's key; the body and the answer pass through untouched. */
async function aiChat(request: Request, env: CloudEnv): Promise<Response> {
  if (!env.AI_GATEWAY_API_KEY) return json(503, { error: { message: "The AI Gateway is not configured on the relay yet." } });
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!(length > 0)) return json(411, { error: { message: "Send the request's length." } });
  if (length > MAX_AI_BODY) return json(413, { error: { message: "Request too large." } });
  let answer: Response;
  try {
    answer = await fetch(AI_GATEWAY, {
      method: "POST",
      headers: { authorization: `Bearer ${env.AI_GATEWAY_API_KEY}`, "content-type": "application/json" },
      body: request.body,
    });
  } catch {
    return json(502, { error: { message: "Couldn't reach the AI Gateway." } });
  }
  return new Response(answer.body, { status: answer.status, headers: { "content-type": answer.headers.get("content-type") ?? "application/json" } });
}

export async function cloudAuthorized(request: Request, env: CloudEnv): Promise<boolean> {
  if (!env.CLOUD_TOKEN) return false;
  const sent = request.headers.get("authorization") ?? "";
  const [a, b] = await Promise.all([sha256(sent), sha256(`Bearer ${env.CLOUD_TOKEN}`)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/** A key Edit may touch: under `edit/`, no empty, `.` or `..` segments, no control characters. */
export function validKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length > 1024 || !key.startsWith("edit/")) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(key)) return false;
  return key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** A listing prefix: `edit/` itself or a key-like prefix under it (may end in `/`). */
export function validPrefix(prefix: unknown): prefix is string {
  if (typeof prefix !== "string") return false;
  if (prefix === "edit/") return true;
  return validKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
}

// --- R2 (S3 API, SigV4) -------------------------------------------------------

export interface R2 { host: string; bucket: string; accessKeyId: string; secret: string }

export function r2Config(env: CloudEnv): R2 | null {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET) return null;
  return { host: `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, bucket: env.R2_BUCKET, accessKeyId: env.R2_ACCESS_KEY_ID, secret: env.R2_SECRET_ACCESS_KEY };
}

export class BadRequest extends Error {}
export class Upstream extends Error {}

const R2_ROUTES: Record<string, (body: Record<string, unknown>, r2: R2) => Promise<Response>> = {
  async url(body, r2) {
    const key = needKey(body.key);
    const method = body.method === undefined ? "GET" : body.method;
    if (method !== "GET" && method !== "PUT" && method !== "HEAD") throw new BadRequest("method must be GET, PUT or HEAD.");
    let expires = DEFAULT_EXPIRES[method];
    if (body.expires !== undefined) {
      if (typeof body.expires !== "number" || !Number.isInteger(body.expires) || body.expires <= 0) throw new BadRequest("expires must be a whole number of seconds.");
      expires = Math.min(body.expires, MAX_EXPIRES);
    }
    return json(200, { url: await objectUrl(r2, method, key, {}, expires), expires });
  },

  async "multipart/create"(body, r2) {
    const key = needKey(body.key);
    const headers: Record<string, string> = {};
    if (body.contentType !== undefined) {
      if (typeof body.contentType !== "string" || !/^[\w.+-]+\/[\w.+-]+(; ?[\w.+-]+=[\w.+-]+)*$/.test(body.contentType) || body.contentType.length > 200) throw new BadRequest("Invalid contentType.");
      headers["content-type"] = body.contentType;
    }
    const answer = await r2Fetch(r2, "POST", key, { uploads: "" }, { headers });
    const uploadId = xmlValue(await answer.text(), "UploadId");
    if (!uploadId) throw new Upstream("R2 gave no upload id.");
    return json(200, { uploadId });
  },

  async "multipart/urls"(body, r2) {
    const key = needKey(body.key);
    const uploadId = needUploadId(body.uploadId);
    if (!Array.isArray(body.parts) || body.parts.length === 0 || body.parts.length > MAX_PART_URLS) throw new BadRequest(`parts must list 1 to ${MAX_PART_URLS} part numbers.`);
    const urls: Record<string, string> = {};
    for (const part of body.parts) {
      urls[String(needPartNumber(part))] = await objectUrl(r2, "PUT", key, { partNumber: String(part), uploadId }, DEFAULT_EXPIRES.PUT);
    }
    return json(200, { urls });
  },

  async "multipart/complete"(body, r2) {
    const key = needKey(body.key);
    const uploadId = needUploadId(body.uploadId);
    if (!Array.isArray(body.parts) || body.parts.length === 0 || body.parts.length > 10000) throw new BadRequest("parts must list the uploaded parts.");
    const parts = body.parts.map((part: unknown) => {
      if (!isObject(part) || typeof part.etag !== "string" || !part.etag || part.etag.length > 200) throw new BadRequest("Each part needs partNumber and etag.");
      return { number: needPartNumber(part.partNumber), etag: part.etag };
    }).sort((a, b) => a.number - b.number);
    const xml = `<CompleteMultipartUpload>${parts.map((part) => `<Part><PartNumber>${part.number}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
    const answer = await r2Fetch(r2, "POST", key, { uploadId }, { body: xml, headers: { "content-type": "application/xml" } });
    const text = await answer.text();
    // S3 can answer 200 and still fail, with an <Error> body.
    if (text.includes("<Error>")) throw new Upstream(`R2: ${xmlValue(text, "Code") ?? "Error"}: ${xmlValue(text, "Message") ?? text.slice(0, 300)}`);
    const head = await r2Fetch(r2, "HEAD", key, {}, { allow404: true });
    const size = head.status === 200 ? Number(head.headers.get("content-length")) : undefined;
    return json(200, { ok: true, size, etag: unescapeXml(xmlValue(text, "ETag") ?? head.headers.get("etag") ?? "") || undefined });
  },

  async "multipart/abort"(body, r2) {
    const key = needKey(body.key);
    await r2Fetch(r2, "DELETE", key, { uploadId: needUploadId(body.uploadId) }, { allow404: true });
    return json(200, { ok: true });
  },

  async head(body, r2) {
    const answer = await r2Fetch(r2, "HEAD", needKey(body.key), {}, { allow404: true });
    if (answer.status === 404) return json(200, { exists: false });
    return json(200, { exists: true, size: Number(answer.headers.get("content-length")), etag: answer.headers.get("etag") ?? undefined, contentType: answer.headers.get("content-type") ?? undefined });
  },

  async delete(body, r2) {
    if (!Array.isArray(body.keys) || body.keys.length > MAX_DELETE) throw new BadRequest(`keys must list at most ${MAX_DELETE} keys.`);
    const keys = body.keys.map(needKey);
    await Promise.all(keys.map((key) => r2Fetch(r2, "DELETE", key, {}, { allow404: true })));
    return json(200, { ok: true, deleted: keys.length });
  },

  async list(body, r2) {
    if (!validPrefix(body.prefix)) throw new BadRequest("prefix must start with edit/.");
    const query: Record<string, string> = { "list-type": "2", prefix: body.prefix, "max-keys": "1000" };
    if (body.cursor !== undefined) {
      if (typeof body.cursor !== "string" || !body.cursor || body.cursor.length > 2048) throw new BadRequest("Invalid cursor.");
      query["continuation-token"] = body.cursor;
    }
    const text = await (await r2Fetch(r2, "GET", "", query)).text();
    const objects = [...text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, item]) => ({
      key: unescapeXml(xmlValue(item, "Key") ?? ""),
      size: Number(xmlValue(item, "Size") ?? 0),
    })).filter((object) => object.key.startsWith("edit/"));
    const truncated = xmlValue(text, "IsTruncated") === "true";
    const cursor = truncated ? unescapeXml(xmlValue(text, "NextContinuationToken") ?? "") || undefined : undefined;
    return json(200, { objects, cursor });
  },
};

export function needKey(key: unknown): string {
  if (!validKey(key)) throw new BadRequest("key must be a path under edit/ (no empty, . or .. segments).");
  return key;
}

function needUploadId(id: unknown): string {
  if (typeof id !== "string" || !id || id.length > 1024 || /[\u0000-\u001f\u007f]/.test(id)) throw new BadRequest("Invalid uploadId.");
  return id;
}

function needPartNumber(part: unknown): number {
  if (typeof part !== "number" || !Number.isInteger(part) || part < 1 || part > 10000) throw new BadRequest("Part numbers run from 1 to 10000.");
  return part;
}

/** A presigned URL for `key` in the bucket (path-style; `key` "" is the bucket). */
export function objectUrl(r2: R2, method: string, key: string, query: Record<string, string>, expires: number) {
  const path = `/${encodePath(r2.bucket)}${key ? `/${encodePath(key)}` : ""}`;
  return presign({ method, url: `https://${r2.host}${path}`, query, accessKeyId: r2.accessKeyId, secret: r2.secret, region: "auto", expires });
}

/** One S3 call from the relay itself, through a minute-long presigned URL. */
export async function r2Fetch(r2: R2, method: string, key: string, query: Record<string, string>, options: { body?: string; headers?: Record<string, string>; allow404?: boolean } = {}) {
  const answer = await fetch(await objectUrl(r2, method, key, query, 60), { method, body: options.body, headers: options.headers });
  if (answer.ok || (options.allow404 && answer.status === 404)) return answer;
  const text = method === "HEAD" ? "" : await answer.text();
  throw new Upstream(`R2 ${answer.status}: ${xmlValue(text, "Code") ?? ""} ${xmlValue(text, "Message") ?? text.slice(0, 300)}`.trim());
}

export interface PresignInput {
  method: string;
  /** Scheme, host and canonical (already encoded) path. */
  url: string;
  query?: Record<string, string>;
  accessKeyId: string;
  secret: string;
  region: string;
  service?: string;
  expires: number;
  date?: Date;
}

/** AWS SigV4 query-string signing (host header only, unsigned payload). */
export async function presign(input: PresignInput): Promise<string> {
  const target = new URL(input.url);
  const service = input.service ?? "s3";
  const stamp = (input.date ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = stamp.slice(0, 8);
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const params: Record<string, string> = {
    ...input.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(input.expires),
    "X-Amz-SignedHeaders": "host",
  };
  const query = Object.entries(params)
    .map(([key, value]) => [rfc3986(key), rfc3986(value)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonical = [input.method, target.pathname, query, `host:${target.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, hex(await sha256(canonical))].join("\n");
  let signing: ArrayBuffer = new TextEncoder().encode(`AWS4${input.secret}`).buffer as ArrayBuffer;
  for (const part of [day, input.region, service, "aws4_request"]) signing = await hmac(signing, part);
  const signature = hex(new Uint8Array(await hmac(signing, toSign)));
  return `${target.origin}${target.pathname}?${query}&X-Amz-Signature=${signature}`;
}

const rfc3986 = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = (path: string) => path.split("/").map(rfc3986).join("/");

async function hmac(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(data));
}

async function sha256(text: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export function xmlValue(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];
}

export const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
export const unescapeXml = (text: string) => text
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&amp;/g, "&");

// --- Convex ---------------------------------------------------------------------

/** Calls an `edit:` function with the service token added to its args. */
async function convex(body: Record<string, unknown>, env: CloudEnv): Promise<Response> {
  const kind = body.kind;
  if (typeof kind !== "string" || !CONVEX_KINDS.has(kind)) return json(400, { error: "kind must be query, mutation or action." });
  if (typeof body.path !== "string" || !CONVEX_PATH.test(body.path)) return json(403, { error: "Only edit: functions can be called." });
  if (body.args !== undefined && !isObject(body.args)) return json(400, { error: "args must be an object." });
  if (!env.CONVEX_URL || !env.CONVEX_SERVICE_TOKEN) return json(503, { error: "Convex is not configured on the relay yet." });
  let answer: Response;
  try {
    answer = await fetch(`${env.CONVEX_URL.replace(/\/+$/, "")}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: body.path, args: { ...(body.args as object | undefined), token: env.CONVEX_SERVICE_TOKEN }, format: "json" }),
    });
  } catch (error) {
    return json(502, { error: `Convex: ${error instanceof Error ? error.message : String(error)}` });
  }
  const text = await answer.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  // Convex answered (the function ran, or isn't there): its own shape, as 200
  // ({status: "success", value} | {status: "error", errorMessage, errorData}).
  if (isObject(parsed) && parsed.status === "success") return json(200, { status: "success", value: parsed.value ?? null });
  if (isObject(parsed) && parsed.status === "error") {
    return json(200, { status: "error", errorMessage: String(parsed.errorMessage ?? "unknown error").trim(), errorData: parsed.errorData });
  }
  // Anything else (a request Convex refused as {code, message}, a gateway
  // error) comes back as a relay error with Convex's status.
  const message = isObject(parsed) && parsed.code
    ? `${parsed.code}: ${parsed.message ?? ""}`
    : text.slice(0, 500) || `HTTP ${answer.status}`;
  return json(answer.ok ? 502 : answer.status, { error: `Convex: ${message}` });
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
