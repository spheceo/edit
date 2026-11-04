/**
 * Script mode's cloud (Writer's, merged into Edit on Oct 29 2026), as Writer's
 * relay kept it: every script's body and files on R2 under `writer/`, and its
 * index in Convex (Repack's deployment, the `writer` module). The rules are
 * Writer's, read from the Edit sign-in: a script is seen only by who writes
 * its kind (`scripts.*`) or edits its style (`edit.*`, the handoff), as
 * Script mode and Edit's script list already hide the rest on the Mac (Nov 4,
 * Sphe: "if we've given someone X permissions, their account literally cannot
 * access anything else"; reading had been open to anyone who may use Edit).
 * Writing needs script work of the script's own kind, the shared lessons
 * `review.lessons`, and reviews `review.share` (Edit's manifest lists them,
 * ids unchanged).
 *
 *   /v1/cloud/writer/r2/url | multipart/create | multipart/urls | multipart/complete | multipart/abort | head | delete | list
 *   /v1/cloud/writer/convex   {kind, path: "writer:…" | "reviews:…" | "edit:getMedia|putMedia", args?}
 *
 * A script's reviews stay Writer's on the review site (`app` is forced to
 * "writer"), and the footage registry is Edit's own (`edit:getMedia`,
 * `edit:putMedia`, and keys under `edit/originals/` and `edit/analysis/`:
 * presigned URLs, multipart and head, never delete or list). Problem reports
 * under `writer/reports/` are put by anyone, read only by an admin.
 */
import { forbiddenOf, withCaller, type Caller } from "./auth";
import { BadRequest, convexPaused, escapeXml, isObject, objectUrl, r2Config, r2Fetch, Upstream, unescapeXml, xmlValue, type CloudEnv, type R2 } from "./cloud";

const HOUR = 3600;
const MAX_DELETE = 40;
const MAX_PART_URLS = 1000;
const MAX_BODY = 8 * 1024 * 1024;
const CONVEX_KINDS = new Set(["query", "mutation", "action"]);

/**
 * The functions Script mode calls, and what each needs beyond `use`: `script`
 * = the work the script is (its kind, from its summary), `any` = some kind of
 * script work, `admin`, or a capability id. Nothing else is reachable.
 */
export const WRITER_FUNCTIONS: Record<string, string> = {
  "writer:listScripts": "read",
  "writer:getScript": "read",
  "writer:commitScript": "script",
  "writer:deleteScript": "script",
  "writer:clearRestore": "any",
  "reviews:open": "read",
  "reviews:changes": "read",
  "reviews:get": "read",
  "reviews:checkIn": "read",
  "reviews:publish": "review.share",
  "reviews:approve": "review.share",
  "reviews:unapprove": "review.share",
  "reviews:claim": "review.share",
  "reviews:release": "review.share",
  "reviews:resolve": "review.share",
  "reviews:reply": "review.share",
  "reviews:note": "review.share",
  "reviews:deleteNote": "review.share",
  "reviews:takeFix": "review.share",
  "reviews:declineFix": "review.share",
  "reviews:fixProgress": "review.share",
  "reviews:check": "review.share",
  "reviews:setMeta": "review.share",
  "reviews:compress": "review.share",
  "reviews:remove": "review.share",
  "edit:getMedia": "read",
  "edit:putMedia": "any",
};

export const REPORTS = "writer/reports/";
/** The shared lessons every commentary build reads: only someone who may teach writes them. */
export const LESSONS_KEY = "writer/lessons.json";
/** Edit's prefixes Script mode may read and write, for the footage and transcripts it shares with Edit mode. */
const SHARED_PREFIXES = ["edit/originals/", "edit/analysis/"];

/** What the caller was granted: an admin, or their capabilities. */
export type Grants = { admin: boolean; perms: Set<string> };

export function grantsOf(found: Caller): Grants {
  if (found.kind !== "person") return { admin: false, perms: new Set() };
  return { admin: found.admin, perms: new Set(found.perms) };
}

const has = (grants: Grants, id: string) => grants.admin || grants.perms.has(id);
const anyWork = (grants: Grants) => grants.admin || [...grants.perms].some((perm) => perm.startsWith("scripts."));

/** The work a script is, from its summary, as Script mode's can.ts reads it. */
export function workOf(summary: unknown): string | null {
  if (!isObject(summary)) return null;
  if (summary.sourceKind === "commentary") return "scripts.commentary";
  const kind = typeof summary.kind === "string" ? summary.kind : "interrogation";
  if (summary.compilation === true) return kind === "courtroom" ? "scripts.courtroom-compilation" : kind === "foia" ? "scripts.foia-compilation" : "scripts.interrogation-compilation";
  return ["interrogation", "foia", "courtroom"].includes(kind) ? `scripts.${kind}` : null;
}

const refuse = (what: string) => json(403, { error: `Your account can't ${what}. Ask an admin at accounts.spheceo.com.` });

export const SCRIPT_UNAVAILABLE = "This script isn't available to your account: an admin can give you its kind of script at accounts.spheceo.com.";

/** The work a script is, exactly as Script mode's can.ts reads it (no kind, or one it doesn't know: an interrogation). */
export function scriptWork(summary: unknown): string {
  const given = isObject(summary) ? summary : {};
  if (given.sourceKind === "commentary") return "scripts.commentary";
  const kind = typeof given.kind === "string" ? given.kind : "interrogation";
  if (given.compilation === true) return kind === "courtroom" ? "scripts.courtroom-compilation" : kind === "foia" ? "scripts.foia-compilation" : "scripts.interrogation-compilation";
  return kind === "foia" ? "scripts.foia" : kind === "courtroom" ? "scripts.courtroom" : "scripts.interrogation";
}

/** The Edit style a script is made into, as Edit's script list reads it (writer_handoff.ts); null before Writer gives it a kind. */
export function scriptEditStyle(summary: unknown): string | null {
  const given = isObject(summary) ? summary : {};
  if (given.sourceKind === "commentary") return "commentary";
  if (typeof given.kind !== "string" || given.kind === "") return null;
  return given.kind === "commentary" ? "commentary" : given.kind === "courtroom" ? "courtroom" : given.kind === "foia" ? "bodycam" : "interrogation";
}

const editsAny = (grants: Grants) => [...grants.perms].some((perm) => perm.startsWith("edit."));

/**
 * Whether the caller may see a script with this summary: who writes its kind,
 * or who edits its style (Edit's list offers it to them to start the edit).
 * `undefined`: a script the cloud doesn't list yet (its first upload), seen by
 * anyone who writes or edits at all.
 */
export function mayReadScript(summary: unknown, found: Caller): boolean {
  const grants = grantsOf(found);
  if (found.kind !== "person") return false;
  if (grants.admin) return true;
  if (summary === undefined) return anyWork(grants) || editsAny(grants);
  if (grants.perms.has(scriptWork(summary))) return true;
  const style = scriptEditStyle(summary);
  return style === null ? editsAny(grants) : grants.perms.has(`edit.${style}`);
}

/** Whether the caller may change a script with this summary (`undefined`: not in the cloud yet, anyone who writes scripts). */
export function mayWriteScript(summary: unknown, grants: Grants): boolean {
  if (grants.admin) return true;
  return summary === undefined ? anyWork(grants) : grants.perms.has(scriptWork(summary));
}

/** The script a key belongs to: its body and files, or its review's. Null for Script mode's shared keys (the lessons, reports). */
export function scriptOfKey(key: string): string | null {
  return /^writer\/(?:scripts|reviews)\/([^/]+)\//.exec(key)?.[1] ?? null;
}

/** Scripts' summaries as the cloud last said, briefly: Script mode presigns a script's files many times a minute. */
const scriptRows = new Map<string, { summary: unknown; at: number }>();
const SCRIPT_ROW_MS = 30_000;

/** A script's summary in the cloud (`undefined`: no such script yet), or null when the cloud couldn't say (refused, never guessed). */
export async function scriptSummary(env: CloudEnv, scriptId: string): Promise<{ summary: unknown } | null> {
  const id = `${env.CONVEX_URL ?? ""}\n${scriptId}`;
  const kept = scriptRows.get(id);
  if (kept !== undefined && Date.now() - kept.at < SCRIPT_ROW_MS) return { summary: kept.summary };
  if (!env.CONVEX_URL || !env.CONVEX_SERVICE_TOKEN) return null;
  const row = await convexValue(env, "query", "writer:getScript", { scriptId });
  if (row === undefined) return null;
  const summary = row === null || (isObject(row) && row.deletedAt !== undefined && row.deletedAt !== null) ? undefined : isObject(row) ? (row.summary ?? {}) : undefined;
  if (scriptRows.size > 5000) scriptRows.clear();
  scriptRows.set(id, { summary, at: Date.now() });
  return { summary };
}

/** Tests: forget the summaries kept. */
export function forgetScripts(): void {
  scriptRows.clear();
}

/** Why the caller may not read (or write) the script `key` belongs to, as a response; null when they may. */
export async function scriptKeyRefused(env: CloudEnv, found: Caller, key: string, write: boolean): Promise<Response | null> {
  const scriptId = scriptOfKey(key);
  if (scriptId === null) return null;
  const grants = grantsOf(found);
  if (grants.admin) return null;
  const known = await scriptSummary(env, scriptId);
  if (known === null) return json(502, { error: "Convex couldn't say whose script that is; Edit asks again." });
  const allowed = write ? mayWriteScript(known.summary, grants) : mayReadScript(known.summary, found);
  return allowed ? null : json(403, { error: SCRIPT_UNAVAILABLE });
}

function wellFormed(key: string): boolean {
  if (key.length > 1024 || /[\u0000-\u001f\u007f\\]/.test(key)) return false;
  return key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** A key Script mode may delete: under `writer/`, well formed. */
export const writerKey = (key: unknown): key is string => typeof key === "string" && key.startsWith("writer/") && wellFormed(key);

/** A key Script mode may read or write: its own, or Edit's shared footage and transcripts. */
export const sharedKey = (key: unknown): key is string => typeof key === "string" && (key.startsWith("writer/") || SHARED_PREFIXES.some((prefix) => key.startsWith(prefix))) && wellFormed(key);

/** A listing prefix: `writer/` itself or a key-like prefix under it. */
export const writerPrefix = (prefix: unknown): prefix is string => typeof prefix === "string" && (prefix === "writer/" || writerKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix));

function needKey(key: unknown): string {
  if (!writerKey(key)) throw new BadRequest("key must be a path under writer/ (no empty, . or .. segments).");
  return key;
}

function needSharedKey(key: unknown): string {
  if (!sharedKey(key)) throw new BadRequest("key must be a path under writer/, edit/originals/ or edit/analysis/ (no empty, . or .. segments).");
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

export async function writerCloud(request: Request, url: URL, env: CloudEnv, found: Caller): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: `POST JSON to ${url.pathname}` });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return json(413, { error: "Request too large." });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!isObject(parsed)) throw new Error("not an object");
    body = parsed;
  } catch {
    return json(400, { error: "Send a JSON object." });
  }
  const grants = grantsOf(found);
  const route = url.pathname.slice("/v1/cloud/writer/".length);
  if (route === "convex") return convex(body, env, found, grants);
  const handler = route.startsWith("r2/") && Object.hasOwn(R2_ROUTES, route.slice(3)) ? R2_ROUTES[route.slice(3)] : undefined;
  if (!handler) return json(404, { error: "not found" });
  // Reading is everyone's; writing needs script work, and the lessons the teaching capability.
  const writes = route === "r2/delete" || route.startsWith("r2/multipart/") || (route === "r2/url" && body.method === "PUT");
  const touched = route === "r2/delete" ? (Array.isArray(body.keys) ? body.keys : []) : route === "r2/list" ? [] : [body.key];
  const reports = touched.some((key) => typeof key === "string" && key.startsWith(REPORTS));
  const listsReports = route === "r2/list" && typeof body.prefix === "string" && (body.prefix === "writer/" || body.prefix.startsWith(REPORTS.slice(0, -1)));
  if ((reports || listsReports) && !grants.admin) {
    // A report is put in one request; reading, listing or deleting them is an admin's.
    if (!(route === "r2/url" && body.method === "PUT" && touched.length === 1)) return refuse("read the team's problem reports");
  } else if (writes) {
    if (touched.includes(LESSONS_KEY) && !has(grants, "review.lessons")) return refuse("change the shared lessons");
    if (!anyWork(grants)) return refuse("write scripts");
  }
  // A script's own files (its body, its review's): only for who may see it, and written only by who writes its kind.
  if (route === "r2/list" && !grants.admin) {
    const prefix = typeof body.prefix === "string" ? body.prefix : "";
    if (scriptOfKey(prefix) === null) return refuse("list Script mode's files");
    touched.push(prefix);
  }
  for (const key of new Set(touched.filter((one): one is string => typeof one === "string"))) {
    const refused = await scriptKeyRefused(env, found, key, writes);
    if (refused !== null) return refused;
  }
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

const R2_ROUTES: Record<string, (body: Record<string, unknown>, r2: R2) => Promise<Response>> = {
  async url(body, r2) {
    const key = needSharedKey(body.key);
    const method = body.method === undefined ? "GET" : body.method;
    if (method !== "GET" && method !== "PUT" && method !== "HEAD") throw new BadRequest("method must be GET, PUT or HEAD.");
    let expires = HOUR;
    if (body.expires !== undefined) {
      if (typeof body.expires !== "number" || !Number.isInteger(body.expires) || body.expires <= 0) throw new BadRequest("expires must be a whole number of seconds.");
      expires = Math.min(body.expires, HOUR);
    }
    return json(200, { url: await objectUrl(r2, method, key, {}, expires), expires });
  },

  async "multipart/create"(body, r2) {
    const key = needSharedKey(body.key);
    const headers: Record<string, string> = {};
    if (body.contentType !== undefined) {
      if (typeof body.contentType !== "string" || !/^[\w.+-]+\/[\w.+-]+(; ?[\w.+-]+=[\w.+-]+)*$/.test(body.contentType) || body.contentType.length > 200) throw new BadRequest("Invalid contentType.");
      headers["content-type"] = body.contentType;
    }
    const uploadId = xmlValue(await (await r2Fetch(r2, "POST", key, { uploads: "" }, { headers })).text(), "UploadId");
    if (!uploadId) throw new Upstream("R2 gave no upload id.");
    return json(200, { uploadId });
  },

  async "multipart/urls"(body, r2) {
    const key = needSharedKey(body.key);
    const uploadId = needUploadId(body.uploadId);
    if (!Array.isArray(body.parts) || body.parts.length === 0 || body.parts.length > MAX_PART_URLS) throw new BadRequest(`parts must list 1 to ${MAX_PART_URLS} part numbers.`);
    const urls: Record<string, string> = {};
    for (const part of body.parts) urls[String(needPartNumber(part))] = await objectUrl(r2, "PUT", key, { partNumber: String(part), uploadId }, HOUR);
    return json(200, { urls });
  },

  async "multipart/complete"(body, r2) {
    const key = needSharedKey(body.key);
    const uploadId = needUploadId(body.uploadId);
    if (!Array.isArray(body.parts) || body.parts.length === 0 || body.parts.length > 10000) throw new BadRequest("parts must list the uploaded parts.");
    const parts = body.parts
      .map((part: unknown) => {
        if (!isObject(part) || typeof part.etag !== "string" || !part.etag || part.etag.length > 200) throw new BadRequest("Each part needs partNumber and etag.");
        return { number: needPartNumber(part.partNumber), etag: part.etag };
      })
      .sort((a, b) => a.number - b.number);
    const xml = `<CompleteMultipartUpload>${parts.map((part) => `<Part><PartNumber>${part.number}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
    const text = await (await r2Fetch(r2, "POST", key, { uploadId }, { body: xml, headers: { "content-type": "application/xml" } })).text();
    // S3 can answer 200 and still fail, with an <Error> body.
    if (text.includes("<Error>")) throw new Upstream(`R2: ${xmlValue(text, "Code") ?? "Error"}: ${xmlValue(text, "Message") ?? text.slice(0, 300)}`);
    const head = await r2Fetch(r2, "HEAD", key, {}, { allow404: true });
    const size = head.status === 200 ? Number(head.headers.get("content-length")) : undefined;
    return json(200, { ok: true, size, etag: unescapeXml(xmlValue(text, "ETag") ?? head.headers.get("etag") ?? "") || undefined });
  },

  async "multipart/abort"(body, r2) {
    await r2Fetch(r2, "DELETE", needSharedKey(body.key), { uploadId: needUploadId(body.uploadId) }, { allow404: true });
    return json(200, { ok: true });
  },

  async head(body, r2) {
    const answer = await r2Fetch(r2, "HEAD", needSharedKey(body.key), {}, { allow404: true });
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
    if (!writerPrefix(body.prefix)) throw new BadRequest("prefix must start with writer/.");
    const query: Record<string, string> = { "list-type": "2", prefix: body.prefix, "max-keys": "1000" };
    if (body.cursor !== undefined) {
      if (typeof body.cursor !== "string" || !body.cursor || body.cursor.length > 2048) throw new BadRequest("Invalid cursor.");
      query["continuation-token"] = body.cursor;
    }
    const text = await (await r2Fetch(r2, "GET", "", query)).text();
    const objects = [...text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)]
      .map(([, item]) => ({ key: unescapeXml(xmlValue(item!, "Key") ?? ""), size: Number(xmlValue(item!, "Size") ?? 0) }))
      .filter((object) => object.key.startsWith("writer/"));
    const cursor = xmlValue(text, "IsTruncated") === "true" ? unescapeXml(xmlValue(text, "NextContinuationToken") ?? "") || undefined : undefined;
    return json(200, { objects, cursor });
  },
};

/** Who started a script, from the verified sign-in: what commitScript records on its first commit. */
function actorOf(found: Caller): Record<string, string> | null {
  if (found.kind !== "person") return null;
  const actor: Record<string, string> = { sub: found.sub, name: found.name ?? found.email?.split("@")[0] ?? "", email: found.email ?? "" };
  if (found.picture) actor.picture = found.picture;
  return actor;
}

/** Calls a `writer:` function (or a `reviews:` one, as Writer, or Edit's footage registry) with the service token added to its args. */
async function convex(body: Record<string, unknown>, env: CloudEnv, found: Caller, grants: Grants): Promise<Response> {
  const kind = body.kind;
  if (typeof kind !== "string" || !CONVEX_KINDS.has(kind)) return json(400, { error: "kind must be query, mutation or action." });
  if (typeof body.path !== "string" || !Object.hasOwn(WRITER_FUNCTIONS, body.path)) return json(403, { error: "That function isn't one Script mode calls." });
  if (body.args !== undefined && !isObject(body.args)) return json(400, { error: "args must be an object." });
  if (!env.CONVEX_URL || !env.CONVEX_SERVICE_TOKEN) return json(503, { error: "Convex is not configured on the relay yet." });
  const paused = convexPaused(env);
  if (paused !== null) return paused;
  const needs = WRITER_FUNCTIONS[body.path]!;
  const args = { ...((body.args as Record<string, unknown> | undefined) ?? {}) };
  if (needs === "any" && !anyWork(grants)) return refuse("write scripts");
  if (needs === "admin" && !grants.admin) return refuse("do that: it's for admins");
  if (needs.includes(".") && !has(grants, needs)) return refuse(needs !== "review.share" ? "do that" : body.path === "reviews:remove" ? "delete review links" : "share or fix reviews");
  if (needs === "script" && !grants.admin) {
    // A commit says what it is; a delete is checked against what the script is in the cloud.
    let summary: unknown = args.summary;
    if (body.path === "writer:deleteScript") {
      const row = await convexValue(env, "query", "writer:getScript", { scriptId: args.scriptId });
      if (row === undefined) return json(502, { error: "Convex: couldn't look the script up." });
      summary = row === null ? undefined : isObject(row) ? row.summary : null;
    }
    const work = summary === undefined ? null : workOf(summary);
    if (summary !== undefined && !(work ? has(grants, work) : anyWork(grants))) return refuse("change scripts of that kind");
    if (summary === undefined && !anyWork(grants)) return refuse("write scripts");
    // A commit over a script already in the cloud: only one of the writer's own kind (never another kind's, retitled as theirs).
    if (body.path === "writer:commitScript") {
      if (typeof args.scriptId !== "string") return json(400, { error: "args.scriptId must be a string." });
      const known = await scriptSummary(env, args.scriptId);
      if (known === null) return json(502, { error: "Convex: couldn't look the script up." });
      if (!mayWriteScript(known.summary, grants)) return refuse("change scripts of that kind");
    }
  }
  // A script's review, by its script: seen by who may see the script, shared and fixed by who writes it.
  if (body.path.startsWith("reviews:") && !grants.admin && typeof args.sourceId === "string") {
    const known = await scriptSummary(env, args.sourceId);
    if (known === null) return json(502, { error: "Convex: couldn't look the script up." });
    const allowed = needs === "read" ? mayReadScript(known.summary, found) : mayWriteScript(known.summary, grants);
    if (!allowed) return json(403, { error: SCRIPT_UNAVAILABLE });
  }
  if (body.path === "writer:getScript" && typeof args.scriptId !== "string") return json(400, { error: "args.scriptId must be a string." });
  // A script's review is always Writer's from here, whatever the caller says.
  if (body.path.startsWith("reviews:")) args.app = "writer";
  // Who started a script comes from the verified sign-in, never from the caller (commitScript keeps it on create only).
  if (body.path === "writer:commitScript") {
    delete args.actor;
    const actor = env.STAMP_CREATOR === "1" ? actorOf(found) : null;
    if (actor !== null) args.actor = actor;
  }
  let answer: Response;
  try {
    answer = await fetch(`${env.CONVEX_URL.replace(/\/+$/, "")}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: body.path, args: { ...withCaller(env, found, body.path, args), token: env.CONVEX_SERVICE_TOKEN }, format: "json" }),
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
  // Convex answered: its own shape, as 200 ({status: "success", value} | {status: "error", errorMessage, errorData}).
  if (isObject(parsed) && parsed.status === "success") {
    const value = await readable(body.path, parsed.value ?? null, env, found);
    return value instanceof Response ? value : json(200, { status: "success", value });
  }
  const forbidden = forbiddenOf(parsed);
  if (forbidden !== null) return forbidden;
  if (isObject(parsed) && parsed.status === "error") return json(200, { status: "error", errorMessage: String(parsed.errorMessage ?? "unknown error").trim(), errorData: parsed.errorData });
  const message = isObject(parsed) && parsed.code ? `${parsed.code}: ${parsed.message ?? ""}` : text.slice(0, 500) || `HTTP ${answer.status}`;
  return json(answer.ok ? 502 : answer.status, { error: `Convex: ${message}` });
}

/**
 * What a read gives back, left to what the caller may see: the scripts list
 * without other kinds' scripts, a script of another kind refused, and the
 * script reviews' lists (`reviews:open`, `reviews:changes`) without other
 * kinds' reviews and notes. An admin sees everything. Also Edit's route's
 * (cloud.ts: the handoff's script reads).
 */
export async function readable(path: string, value: unknown, env: CloudEnv, found: Caller): Promise<unknown> {
  if (grantsOf(found).admin) return value;
  if (path === "writer:listScripts") return Array.isArray(value) ? value.filter((row) => isObject(row) && mayReadScript(row.summary ?? {}, found)) : value;
  if (path === "writer:getScript") return isObject(value) && !mayReadScript(value.summary ?? {}, found) ? json(403, { error: SCRIPT_UNAVAILABLE }) : value;
  if (path === "reviews:open" || path === "reviews:changes") {
    const rows = await convexValue(env, "query", "writer:listScripts", {});
    if (!Array.isArray(rows)) return json(502, { error: "Convex couldn't list the scripts to see whose reviews these are; Edit asks again." });
    const summaries = new Map(rows.filter(isObject).map((row) => [String(row.scriptId ?? ""), row.summary ?? {}]));
    // A review whose script isn't listed (deleted since) stays: there's nothing of another kind to keep from anyone.
    const seen = (item: unknown) => !isObject(item) || typeof item.sourceId !== "string" || !summaries.has(item.sourceId) || mayReadScript(summaries.get(item.sourceId), found);
    if (path === "reviews:open") return Array.isArray(value) ? value.filter(seen) : value;
    return isObject(value) && Array.isArray(value.notes) ? { ...value, notes: value.notes.filter(seen) } : value;
  }
  return value;
}

/** One Convex call's value as the relay itself (undefined when it failed). */
async function convexValue(env: CloudEnv, kind: string, path: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const answer = await fetch(`${env.CONVEX_URL!.replace(/\/+$/, "")}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args: { ...args, token: env.CONVEX_SERVICE_TOKEN }, format: "json" }),
    });
    const parsed: unknown = await answer.json();
    return isObject(parsed) && parsed.status === "success" ? (parsed.value ?? null) : undefined;
  } catch {
    return undefined;
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
