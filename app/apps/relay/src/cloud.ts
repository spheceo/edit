/**
 * Edit's cloud: footage and previews on Cloudflare R2, project files in Convex.
 * The relay holds the R2 keys and Convex's service token; Edit only ever gets
 * short-lived presigned URLs and the answers of `edit:` Convex functions.
 *
 * Every route is POST JSON and needs a signed-in person's token with the
 * route's permission (auth.ts). R2 keys must sit under `edit/` (the bucket
 * is shared with Repack).
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
import { allow, budgetKey, burstKey, type AuthEnv, type Caller, type Permission } from "./auth";
import { EDIT_CALLS, grantedTo, isAdmin, LISTABLE, maxExpires, mayWork, PROJECT_WRITES, projectOfKey, shapeOf, UNAVAILABLE, WRITABLE } from "./authz";
import { cancelJob, driveJob, googleSignIn, jobStatus, proxyJob, type JobsEnv } from "./jobs";
import { exportRoute, type ModalEnv } from "./exports";

export interface CloudEnv extends JobsEnv, ModalEnv {
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
  /** The models /v1/cloud/ai/chat may ask for (comma-separated; default the watcher's). */
  AI_MODELS?: string;
  /** What the AI Gateway may cost a day (USD, its own usage.cost): per person, and across everyone. */
  DAILY_AI_USD_PER_IP?: string;
  DAILY_AI_USD_TOTAL?: string;
  /** Held for each AI call while it runs (USD), settled at its real cost. */
  AI_RESERVE_USD?: string;
  /** The day's budgets (index.ts's TranscriptionBudget) and the burst limiter. */
  BUDGET?: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  BURST?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** "1": a project's first commit carries who started it (`actor`, from the token); Repack's `edit:commitProject` keeps it as `createdBy`. */
  STAMP_CREATOR?: string;
}

const HOUR = 3600;
const DEFAULT_EXPIRES: Record<string, number> = { GET: HOUR, PUT: HOUR, HEAD: HOUR };
/** Subrequests per invocation are limited (50 on the free plan). */
const MAX_DELETE = 40;
const MAX_PART_URLS = 1000;
const MAX_BODY = 8 * 1024 * 1024;
const CONVEX_KINDS = new Set(["query", "mutation", "action"]);
/** A watch window's request: a few minutes of 360p video, base64 (Edit caps the clip at 15 MiB). */
const MAX_AI_BODY = 32 * 1024 * 1024;
const AI_GATEWAY = "https://ai-gateway.vercel.sh/v1/chat/completions";
/** The longest answer a call may ask for (Flash: ~$0.08 of output; a watch window's answer is a few thousand). */
const MAX_AI_TOKENS = 32768;
/** Repack's reviews (always as Edit) and Writer's scripts, read only (the handoff). */
const REVIEWS_PATH = /^reviews:[A-Za-z_][A-Za-z0-9_]*$/;
const WRITER_READS = new Set(["writer:listScripts", "writer:getScript"]);
/** The reviews functions Edit calls, each as its kind (the audit, Oct 23: any reviews:* went through with the service token). */
const REVIEW_CALLS = new Map<string, string>([
  ["reviews:changes", "query"], ["reviews:get", "query"], ["reviews:open", "query"],
  ["reviews:publish", "mutation"], ["reviews:claim", "mutation"], ["reviews:release", "mutation"], ["reviews:resolve", "mutation"],
  ["reviews:reply", "mutation"], ["reviews:approve", "mutation"], ["reviews:note", "mutation"], ["reviews:deleteNote", "mutation"], ["reviews:setMeta", "mutation"],
  // Fixing on the one computer chosen on accounts' Fixing page (accounts/docs/fixing.md).
  ["reviews:checkIn", "mutation"], ["reviews:takeFix", "mutation"], ["reviews:fixProgress", "mutation"], ["reviews:check", "mutation"],
]);
const callable = (path: string, kind: string) =>
  EDIT_CALLS.get(path) === kind || (REVIEWS_PATH.test(path) && REVIEW_CALLS.get(path) === kind) || (WRITER_READS.has(path) && kind === "query");

/** Each cloud route's permission: `use` for all of them (accounts' contract v2); null for a route that isn't one. */
function permissionOf(route: string): Permission | null {
  if (route === "ai/chat" || route === "google/token" || route === "convex" || route.startsWith("r2/") || route.startsWith("jobs/")) return "use";
  return null;
}

export async function cloud(request: Request, url: URL, env: CloudEnv & AuthEnv): Promise<Response> {
  if (url.pathname.startsWith("/v1/cloud/exports/")) return exportRoute(request, url, env);
  const permission = permissionOf(url.pathname.slice("/v1/cloud/".length));
  if (permission === null) return json(404, { error: "not found" });
  const found = await allow(request, env, permission, url.pathname.slice("/v1/".length));
  if (found instanceof Response) return found;
  if (request.method !== "POST") return json(405, { error: `POST JSON to ${url.pathname}` });
  if (url.pathname === "/v1/cloud/ai/chat") return aiChat(request, env, found);
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
  if (route === "convex") return convex(body, env, found);
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
      if (route === "jobs/drive") {
        await mayTouch({ found, env }, "write", needKey(body.key));
        const started = await driveJob(body, env, r2);
        if (found.kind === "person" && typeof started.id === "string") await jobOwner(env, started.id, found.sub);
        return json(200, started);
      }
      if (route === "jobs/cancel") {
        // A Drive copy two projects share is one job: only who started it (or an admin) stops it, and its upload.
        const owner = typeof body.id === "string" ? await jobOwner(env, body.id) : null;
        if (owner !== null && !(found.kind === "person" && (found.sub === owner || found.admin))) throw new Forbidden("Only who started this copy, or an admin, can cancel it.");
      }
      if (route === "jobs/proxy") { await mayTouch({ found, env }, "write", needKey(body.manifest)); return json(200, await proxyJob(body, env, r2)); }
      if (route === "jobs/status") return json(200, await jobStatus(body, env, r2));
      if (route === "jobs/cancel") return json(200, await cancelJob(body, env, r2));
    } catch (error) {
      if (error instanceof BadRequest) return json(400, { error: error.message });
      if (error instanceof Forbidden) return json(403, { error: error.message });
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
    return await handler(body, r2, { found, env });
  } catch (error) {
    if (error instanceof BadRequest) return json(400, { error: error.message });
    if (error instanceof Forbidden) return json(403, { error: error.message });
    if (error instanceof Upstream) return json(502, { error: error.message });
    throw error;
  }
}

/** `Bearer <CLOUD_TOKEN>` (now only Modal's worker token, passed as CLOUD_TOKEN), compared in constant time; refused when unset. */
/** A chat completion through the AI Gateway with the relay's key; the body and the answer pass through untouched. */
/** The models Edit's watcher, cameras, names and seats ask the gateway for. */
const AI_MODELS = ["google/gemini-3.8-flash"];

/**
 * The AI Gateway, for Edit's own model calls (the audit, Oct 23: any model, any
 * body, no limit): only the allowed models, no streaming, a burst limit per
 * person, and a daily budget per person and in all, counted from the gateway's
 * own usage.cost after each answer.
 */
async function aiChat(request: Request, env: CloudEnv, found: Caller): Promise<Response> {
  if (!env.AI_GATEWAY_API_KEY) return json(503, { error: { message: "The AI Gateway is not configured on the relay yet." } });
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!(length > 0)) return json(411, { error: { message: "Send the request's length." } });
  if (length > MAX_AI_BODY) return json(413, { error: { message: "Request too large." } });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!isObject(parsed)) throw new Error("not an object");
    body = parsed;
  } catch {
    return json(400, { error: { message: "Send a JSON chat request." } });
  }
  const allowed = (env.AI_MODELS ?? "").split(",").map((one) => one.trim()).filter(Boolean);
  if (typeof body.model !== "string" || !(allowed.length > 0 ? allowed : AI_MODELS).includes(body.model)) {
    return json(403, { error: { message: `Only ${(allowed.length > 0 ? allowed : AI_MODELS).join(", ")} can be asked through Edit's relay.` } });
  }
  if (body.stream === true) return json(400, { error: { message: "Streaming isn't supported here." } });
  // An answer's length is bounded, so one call's cost is (about the hold below).
  if (!(typeof body.max_tokens === "number" && body.max_tokens > 0 && body.max_tokens <= MAX_AI_TOKENS)) body.max_tokens = MAX_AI_TOKENS;
  if (env.BURST !== undefined && !(await env.BURST.limit({ key: `ai:${burstKey(request, found)}` })).success) {
    return json(429, { error: { message: "Too many model calls at once; try again in a minute." } });
  }
  const client = await budgetKey(request, found);
  const budget = env.BUDGET === undefined ? null : env.BUDGET.get(env.BUDGET.idFromName(new Date().toISOString().slice(0, 10)));
  const reserve = Number(env.AI_RESERVE_USD ?? 0.1);
  const ask = (phase: "check" | "spend", cost = 0) =>
    budget!.fetch(new Request("https://budget/ai", { method: "POST", body: JSON.stringify({ client, phase, cost, reserve, perIp: Number(env.DAILY_AI_USD_PER_IP ?? 5), total: Number(env.DAILY_AI_USD_TOTAL ?? 25) }) }));
  if (budget !== null) {
    const checked = await ask("check");
    if (!checked.ok) return new Response(checked.body, { status: checked.status, headers: { "content-type": "application/json" } });
  }
  let answer: Response;
  try {
    answer = await fetch(AI_GATEWAY, {
      method: "POST",
      headers: { authorization: `Bearer ${env.AI_GATEWAY_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Nothing was spent: the call's hold is given back.
    if (budget !== null) await ask("spend", 0).catch(() => undefined);
    return json(502, { error: { message: "Couldn't reach the AI Gateway." } });
  }
  const text = await answer.text();
  if (budget !== null) {
    let cost = 0;
    try {
      const usage = (JSON.parse(text) as { usage?: { cost?: unknown } }).usage;
      cost = typeof usage?.cost === "number" && Number.isFinite(usage.cost) && usage.cost > 0 ? usage.cost : 0;
    } catch {
      cost = 0;
    }
    // Settled at its real cost (its hold given back when it cost nothing).
    await ask("spend", cost).catch(() => undefined);
  }
  return new Response(text, { status: answer.status, headers: { "content-type": answer.headers.get("content-type") ?? "application/json" } });
}

export async function cloudAuthorized(request: Request, env: CloudEnv): Promise<boolean> {
  if (!env.CLOUD_TOKEN) return false;
  const sent = request.headers.get("authorization") ?? "";
  const [a, b] = await Promise.all([sha256(sent), sha256(`Bearer ${env.CLOUD_TOKEN}`)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/** A Writer script's key Edit may read (`writer/scripts/…`), with the same rules as `validKey`. */
export function writerReadable(key: unknown): key is string {
  return typeof key === "string" && key.startsWith("writer/scripts/") && validKey(`edit/${key.slice("writer/".length)}`);
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
/** Not this person's to do (403). */
export class Forbidden extends Error {}
export class Upstream extends Error {}

/** Who started cloud job `id` (with `sub`: keeps them as its starter unless it has one). Null when nobody's kept. */
async function jobOwner(env: CloudEnv, id: string, sub?: string): Promise<string | null> {
  if (env.BUDGET === undefined) return null;
  const owners = env.BUDGET.get(env.BUDGET.idFromName("owners"));
  const answer = await owners.fetch(new Request("https://budget/owner", { method: "POST", body: JSON.stringify(sub === undefined ? { id, phase: "get" } : { id, sub, phase: "set" }) }));
  if (sub !== undefined || !answer.ok) return null;
  const found = (await answer.json()) as { sub?: unknown };
  return typeof found.sub === "string" ? found.sub : null;
}

/** Who's asking, for the key rules (authz.ts). */
interface Access {
  found: Caller;
  env: CloudEnv;
}

/**
 * Whether the caller may read or write `key`: writes only where Edit writes
 * (an admin anywhere under edit/), and a project's own keys only within its kind.
 */
async function mayTouch(access: Access, op: "read" | "write", key: string): Promise<void> {
  if (op === "write" && !isAdmin(access.found) && !WRITABLE.some((prefix) => key.startsWith(prefix))) throw new Forbidden("Edit doesn't write there.");
  const project = projectOfKey(key);
  if (project !== null) await mayOpen(access, project);
}

/** Refuses a project outside the caller's kinds (a project not in the cloud yet is anyone's to start). */
async function mayOpen(access: Access, projectId: string): Promise<Record<string, unknown> | null> {
  const given = grantedTo(access.found);
  if (given === null) return null;
  const row = await projectRow(access.env, projectId);
  if (row !== null && !mayWork(shapeOf(row.summary), given)) throw new Forbidden(UNAVAILABLE);
  return row;
}

const R2_ROUTES: Record<string, (body: Record<string, unknown>, r2: R2, access: Access) => Promise<Response>> = {
  async url(body, r2, access) {
    const method = body.method === undefined ? "GET" : body.method;
    if (method !== "GET" && method !== "PUT" && method !== "HEAD") throw new BadRequest("method must be GET, PUT or HEAD.");
    // Writer's scripts (bodies and their files) are read for the handoff, never written.
    const key = method !== "PUT" && writerReadable(body.key) ? body.key : needKey(body.key);
    if (!key.startsWith("writer/")) await mayTouch(access, method === "PUT" ? "write" : "read", key);
    let expires = DEFAULT_EXPIRES[method];
    if (body.expires !== undefined) {
      if (typeof body.expires !== "number" || !Number.isInteger(body.expires) || body.expires <= 0) throw new BadRequest("expires must be a whole number of seconds.");
      expires = body.expires;
    }
    expires = Math.min(expires, maxExpires(method, key));
    return json(200, { url: await objectUrl(r2, method, key, {}, expires), expires });
  },

  async "multipart/create"(body, r2, access) {
    const key = needKey(body.key);
    await mayTouch(access, "write", key);
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

  async "multipart/urls"(body, r2, access) {
    const key = needKey(body.key);
    await mayTouch(access, "write", key);
    const uploadId = needUploadId(body.uploadId);
    if (!Array.isArray(body.parts) || body.parts.length === 0 || body.parts.length > MAX_PART_URLS) throw new BadRequest(`parts must list 1 to ${MAX_PART_URLS} part numbers.`);
    const urls: Record<string, string> = {};
    for (const part of body.parts) {
      urls[String(needPartNumber(part))] = await objectUrl(r2, "PUT", key, { partNumber: String(part), uploadId }, DEFAULT_EXPIRES.PUT);
    }
    return json(200, { urls });
  },

  async "multipart/complete"(body, r2, access) {
    const key = needKey(body.key);
    await mayTouch(access, "write", key);
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

  async "multipart/abort"(body, r2, access) {
    const key = needKey(body.key);
    await mayTouch(access, "write", key);
    await r2Fetch(r2, "DELETE", key, { uploadId: needUploadId(body.uploadId) }, { allow404: true });
    return json(200, { ok: true });
  },

  async head(body, r2, access) {
    const key = needKey(body.key);
    await mayTouch(access, "read", key);
    const answer = await r2Fetch(r2, "HEAD", key, {}, { allow404: true });
    if (answer.status === 404) return json(200, { exists: false });
    return json(200, { exists: true, size: Number(answer.headers.get("content-length")), etag: answer.headers.get("etag") ?? undefined, contentType: answer.headers.get("content-type") ?? undefined });
  },

  async delete(body, r2, access) {
    if (!Array.isArray(body.keys) || body.keys.length > MAX_DELETE) throw new BadRequest(`keys must list at most ${MAX_DELETE} keys.`);
    const keys = body.keys.map(needKey);
    // Footage is shared by every project using it: only an admin deletes from the cloud.
    if (!isAdmin(access.found)) throw new Forbidden("Only an admin can delete from Edit's cloud.");
    await Promise.all(keys.map((key) => r2Fetch(r2, "DELETE", key, {}, { allow404: true })));
    return json(200, { ok: true, deleted: keys.length });
  },

  async list(body, r2, access) {
    if (!validPrefix(body.prefix)) throw new BadRequest("prefix must start with edit/.");
    if (!isAdmin(access.found) && !body.prefix.startsWith(LISTABLE)) throw new Forbidden(`Only ${LISTABLE} can be listed.`);
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

/**
 * Calls an `edit:` function (or a `reviews:` one, as Edit, or one of
 * Writer's script reads) with the service token added to its args.
 */
/**
 * Who started a project, for `edit:commitProject` (Convex keeps it on the
 * row it creates and never changes it): always the verified token's person,
 * never what the caller sent. Null for no person.
 */
export function actorOf(found: Caller): Record<string, string> | null {
  if (found.kind !== "person") return null;
  const actor: Record<string, string> = { sub: found.sub, name: found.name ?? found.email?.split("@")[0] ?? "" };
  if (found.email !== undefined) actor.email = found.email;
  if (found.picture !== undefined) actor.picture = found.picture;
  return actor;
}

async function convex(body: Record<string, unknown>, env: CloudEnv, found: Caller): Promise<Response> {
  const kind = body.kind;
  if (typeof kind !== "string" || !CONVEX_KINDS.has(kind)) return json(400, { error: "kind must be query, mutation or action." });
  if (typeof body.path !== "string" || !callable(body.path, kind)) {
    return json(403, { error: "Only the edit: and reviews: functions Edit calls, and Writer's script reads, can be called." });
  }
  if (body.args !== undefined && !isObject(body.args)) return json(400, { error: "args must be an object." });
  if (!env.CONVEX_URL || !env.CONVEX_SERVICE_TOKEN) return json(503, { error: "Convex is not configured on the relay yet." });
  // A project outside the caller's kinds isn't changed, and only who started it (or an admin) deletes it.
  if (PROJECT_WRITES.has(body.path)) {
    const args = (body.args ?? {}) as Record<string, unknown>;
    if (typeof args.projectId !== "string") return json(400, { error: "args.projectId must be a string." });
    const given = grantedTo(found);
    let row: Record<string, unknown> | null;
    try {
      row = given === null && (body.path !== "edit:deleteProject" || isAdmin(found)) ? null : await projectRow(env, args.projectId);
    } catch (error) {
      return json(502, { error: error instanceof Error ? error.message : String(error) });
    }
    if (row !== null && !mayWork(shapeOf(row.summary), given)) return json(403, { error: UNAVAILABLE });
    if (body.path === "edit:commitProject" && !mayWork(shapeOf(args.summary), given)) return json(403, { error: UNAVAILABLE });
    if (body.path === "edit:deleteProject" && row !== null && !isAdmin(found) && creatorOf(row) !== (found.kind === "person" ? found.sub : null)) {
      return json(403, { error: "Only who started this project, or an admin, can delete it." });
    }
  }
  // A review is always Edit's from here, whatever the caller says.
  if (REVIEWS_PATH.test(body.path)) body.args = { ...(body.args as object | undefined), app: "edit" };
  // Who started a project comes from the token, never the caller.
  if (body.path === "edit:commitProject") {
    const { actor: _sent, ...args } = (body.args ?? {}) as Record<string, unknown>;
    const actor = env.STAMP_CREATOR === "1" ? actorOf(found) : null;
    body.args = actor === null ? args : { ...args, actor };
  }
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
  if (isObject(parsed) && parsed.status === "success") {
    // Reads leave out what isn't the caller's kind of video.
    const given = grantedTo(found);
    let value = parsed.value ?? null;
    if (given !== null && body.path === "edit:listProjects" && Array.isArray(value)) value = value.filter((card) => mayWork(shapeOf(isObject(card) ? card.summary : null), given));
    if (given !== null && body.path === "edit:getProject" && isObject(value) && !mayWork(shapeOf(value.summary), given)) return json(403, { error: UNAVAILABLE });
    return json(200, { status: "success", value });
  }
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

/** Who started a project, as its Convex card says (`createdBy.sub`); null for an older one. */
function creatorOf(row: Record<string, unknown>): string | null {
  const by = row.createdBy;
  return isObject(by) && typeof by.sub === "string" ? by.sub : null;
}

/** A project's Convex card (`edit:getProject`, with its summary), or null when it isn't in the cloud. */
async function projectRow(env: CloudEnv, projectId: string): Promise<Record<string, unknown> | null> {
  if (!env.CONVEX_URL || !env.CONVEX_SERVICE_TOKEN) throw new Upstream("Convex is not configured on the relay yet.");
  let parsed: unknown;
  try {
    const answer = await fetch(`${env.CONVEX_URL.replace(/\/+$/, "")}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "edit:getProject", args: { projectId, token: env.CONVEX_SERVICE_TOKEN }, format: "json" }),
    });
    parsed = await answer.json();
  } catch (error) {
    throw new Upstream(`Convex: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed) || parsed.status !== "success") throw new Upstream("Convex couldn't say whose project that is.");
  return isObject(parsed.value) ? parsed.value : null;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
