// The cloud behind Edit's relay, in memory: the relay's `/v1/cloud/*` routes
// (apps/relay/src/cloud.ts: presigned R2 URLs, multipart, head, list, delete,
// and Convex calls), R2 itself behind the presigned URLs (PUT with an exact
// Content-Length, ranged GETs, ETags, multipart parts), and Convex's `edit:`
// functions as Repack's `convex/edit.ts` defines them (projects with revs and
// bodies in storage, leases, the footage registry), answering in Convex's
// shapes ({status: "success", value} | {status: "error", errorMessage, errorData}).
// Nothing here reaches the real relay, R2 or Convex.

import { createHash } from "node:crypto";

import type { MockServer, Recorded } from "./server.ts";

/** The relay's key rule (cloud.ts validKey). */
export function relayValidKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length > 1024 || !key.startsWith("edit/")) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(key)) return false;
  return key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function relayValidPrefix(prefix: unknown): prefix is string {
  if (typeof prefix !== "string") return false;
  if (prefix === "edit/") return true;
  return relayValidKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
}

const json = (status: number, body: unknown) => Response.json(body, { status });

export function etagOf(data: Uint8Array): string {
  return `"${createHash("md5").update(data).digest("hex")}"`;
}

/** A key's path in a presigned URL (each segment escaped). */
export function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function decodeKey(path: string): string {
  return path.split("/").map(decodeURIComponent).join("/");
}

interface Upload {
  key: string;
  contentType: string | null;
  parts: Map<number, Uint8Array>;
}

export class CloudMock {
  /** Objects on "R2", by key. */
  readonly objects = new Map<string, Uint8Array>();
  readonly contentTypes = new Map<string, string>();
  readonly uploads = new Map<string, Upload>();
  readonly convex = new ConvexMock();
  /** Objects per r2/list page (the relay's is 1000). */
  listPage = 1000;
  /** R2 PUTs answered 500 while above 0 (each counts one down). */
  failPuts = 0;
  /** When set, /v1/cloud/* needs `Bearer <token>` (the relay's CLOUD_TOKEN). */
  token: string | null = null;
  private nextUpload = 1;
  private nextUrl = 1;

  constructor(private readonly mock: MockServer) {}

  /** A presigned-looking URL for `key` (the signature makes it a credential, as R2's are). */
  url(key: string, query: Record<string, string> = {}): string {
    const params = new URLSearchParams({ ...query, "X-Amz-Signature": `mock-signature-${this.nextUrl++}` });
    return `${this.mock.url}/r2/${encodeKey(key)}?${params}`;
  }

  /** Puts an object straight in (as if uploaded earlier). */
  put(key: string, data: Uint8Array | string, contentType?: string): void {
    this.objects.set(key, typeof data === "string" ? new TextEncoder().encode(data) : data);
    if (contentType !== undefined) this.contentTypes.set(key, contentType);
  }

  text(key: string): string | null {
    const data = this.objects.get(key);
    return data === undefined ? null : new TextDecoder().decode(data);
  }

  install(): void {
    const mock = this.mock;
    const relay = (route: string, handler: (body: Record<string, unknown>) => Response) =>
      mock.on("POST", `/v1/cloud/${route}`, (request) => {
        if (this.token !== null && request.headers.get("authorization") !== `Bearer ${this.token}`) {
          return json(401, { error: "This relay needs Edit's cloud token." });
        }
        let body: unknown;
        try {
          body = request.json();
        } catch {
          return json(400, { error: "Send a JSON object." });
        }
        if (typeof body !== "object" || body === null || Array.isArray(body)) return json(400, { error: "Send a JSON object." });
        return handler(body as Record<string, unknown>);
      });
    const bad = (message: string) => json(400, { error: message });
    relay("r2/url", (body) => {
      if (!relayValidKey(body.key)) return bad("key must be a path under edit/ (no empty, . or .. segments).");
      const method = body.method ?? "GET";
      if (method !== "GET" && method !== "PUT" && method !== "HEAD") return bad("method must be GET, PUT or HEAD.");
      const expires = typeof body.expires === "number" ? body.expires : method === "GET" ? 21600 : 3600;
      return json(200, { url: this.url(body.key, { "X-Amz-Expires": String(expires) }), expires });
    });
    relay("r2/multipart/create", (body) => {
      if (!relayValidKey(body.key)) return bad("key must be a path under edit/ (no empty, . or .. segments).");
      const uploadId = `upload-${this.nextUpload++}`;
      this.uploads.set(uploadId, {
        key: body.key,
        contentType: typeof body.contentType === "string" ? body.contentType : null,
        parts: new Map(),
      });
      return json(200, { uploadId });
    });
    relay("r2/multipart/urls", (body) => {
      if (!relayValidKey(body.key)) return bad("key must be a path under edit/ (no empty, . or .. segments).");
      if (typeof body.uploadId !== "string") return bad("Invalid uploadId.");
      if (!Array.isArray(body.parts) || body.parts.length === 0) return bad("parts must list 1 to 1000 part numbers.");
      const urls: Record<string, string> = {};
      for (const part of body.parts) {
        urls[String(part)] = this.url(body.key, { partNumber: String(part), uploadId: body.uploadId });
      }
      return json(200, { urls });
    });
    relay("r2/multipart/complete", (body) => {
      const upload = typeof body.uploadId === "string" ? this.uploads.get(body.uploadId) : undefined;
      if (upload === undefined || upload.key !== body.key) {
        return json(502, { error: "R2: NoSuchUpload: The specified multipart upload does not exist." });
      }
      const parts = (body.parts as { partNumber: number; etag: string }[]).slice().sort((a, b) => a.partNumber - b.partNumber);
      const chunks: Uint8Array[] = [];
      for (const part of parts) {
        const data = upload.parts.get(part.partNumber);
        if (data === undefined || etagOf(data) !== part.etag) {
          return json(502, { error: "R2: InvalidPart: One or more of the specified parts could not be found." });
        }
        chunks.push(data);
      }
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const whole = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        whole.set(chunk, at);
        at += chunk.length;
      }
      this.objects.set(upload.key, whole);
      if (upload.contentType !== null) this.contentTypes.set(upload.key, upload.contentType);
      this.uploads.delete(body.uploadId as string);
      return json(200, { ok: true, size: total, etag: etagOf(whole) });
    });
    relay("r2/multipart/abort", (body) => {
      if (typeof body.uploadId === "string") this.uploads.delete(body.uploadId);
      return json(200, { ok: true });
    });
    relay("r2/head", (body) => {
      if (!relayValidKey(body.key)) return bad("key must be a path under edit/ (no empty, . or .. segments).");
      const data = this.objects.get(body.key);
      if (data === undefined) return json(200, { exists: false });
      return json(200, { exists: true, size: data.length, etag: etagOf(data), contentType: this.contentTypes.get(body.key) });
    });
    relay("r2/delete", (body) => {
      if (!Array.isArray(body.keys) || body.keys.length > 40) return bad("keys must list at most 40 keys.");
      for (const key of body.keys) {
        if (!relayValidKey(key)) return bad("key must be a path under edit/ (no empty, . or .. segments).");
      }
      for (const key of body.keys as string[]) {
        this.objects.delete(key);
        this.contentTypes.delete(key);
      }
      return json(200, { ok: true, deleted: body.keys.length });
    });
    relay("r2/list", (body) => {
      if (!relayValidPrefix(body.prefix)) return bad("prefix must start with edit/.");
      const prefix = body.prefix;
      const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const from = typeof body.cursor === "string" ? Number(body.cursor) : 0;
      const page = keys.slice(from, from + this.listPage);
      const next = from + this.listPage < keys.length ? String(from + this.listPage) : undefined;
      return json(200, {
        objects: page.map((key) => ({ key, size: this.objects.get(key)!.length })),
        cursor: next,
      });
    });
    relay("convex", (body) => {
      const kind = body.kind;
      if (kind !== "query" && kind !== "mutation" && kind !== "action") return bad("kind must be query, mutation or action.");
      if (typeof body.path !== "string" || !/^edit:[A-Za-z_][A-Za-z0-9_]*$/.test(body.path)) {
        return json(403, { error: "Only edit: functions can be called." });
      }
      return json(200, this.convex.call(body.path.slice("edit:".length), (body.args ?? {}) as Record<string, unknown>, mock.url));
    });
    // R2 itself, behind the presigned URLs.
    mock.on("PUT", /^\/r2\//, (request) => this.r2Put(request));
    mock.on("GET", /^\/r2\//, (request) => this.r2Get(request));
    // Convex's file storage (upload URLs and body URLs).
    mock.on("POST", /^\/convex\/upload\//, (request) => {
      const type = request.headers.get("content-type") ?? "";
      return json(200, { storageId: this.convex.store(request.body, type) });
    });
    mock.on("GET", /^\/convex\/storage\//, (request) => {
      const id = decodeURIComponent(request.path.slice("/convex/storage/".length));
      const file = this.convex.files.get(id);
      return file === undefined ? new Response("not found", { status: 404 }) : new Response(file.data);
    });
  }

  private r2Put(request: Recorded): Response {
    if (request.headers.get("transfer-encoding") !== null || request.headers.get("content-length") === null) {
      return new Response(
        "<?xml version=\"1.0\"?><Error><Code>NotImplemented</Code><Message>A header you provided implies functionality that is not implemented</Message></Error>",
        { status: 501 },
      );
    }
    if (!request.query.has("X-Amz-Signature")) return new Response("<Error><Code>AccessDenied</Code><Message>no signature</Message></Error>", { status: 403 });
    const key = decodeKey(request.path.slice("/r2/".length));
    if (this.failPuts > 0) {
      this.failPuts -= 1;
      return new Response("<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>", { status: 500 });
    }
    const uploadId = request.query.get("uploadId");
    if (uploadId !== null) {
      const upload = this.uploads.get(uploadId);
      if (upload === undefined) {
        return new Response("<Error><Code>NoSuchUpload</Code><Message>The specified multipart upload does not exist.</Message></Error>", { status: 404 });
      }
      upload.parts.set(Number(request.query.get("partNumber")), request.body);
      return new Response(null, { status: 200, headers: { etag: etagOf(request.body) } });
    }
    this.objects.set(key, request.body);
    const type = request.headers.get("content-type");
    if (type !== null) this.contentTypes.set(key, type);
    else this.contentTypes.delete(key);
    return new Response(null, { status: 200, headers: { etag: etagOf(request.body) } });
  }

  private r2Get(request: Recorded): Response {
    const key = decodeKey(request.path.slice("/r2/".length));
    const data = this.objects.get(key);
    if (data === undefined) {
      return new Response("<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>", { status: 404 });
    }
    const etag = etagOf(data);
    const range = /^bytes=(\d+)-$/.exec(request.headers.get("range") ?? "");
    // R2 ignores If-Range: a range is always served (Edit checks the ETag itself).
    if (range !== null) {
      const from = Number(range[1]);
      if (from >= data.length) return new Response(null, { status: 416, headers: { etag } });
      return new Response(data.subarray(from), {
        status: 206,
        headers: { etag, "content-range": `bytes ${from}-${data.length - 1}/${data.length}` },
      });
    }
    return new Response(data, { status: 200, headers: { etag } });
  }
}

// ---------------------------------------------------------------------------
// Convex

const LEASE_MS = 2 * 60_000;

interface ProjectRow {
  projectId: string;
  name: string;
  rev: number;
  body: string;
  bodySize: number;
  updatedAt: number;
  updatedBy: string;
  summary: unknown;
}

interface LockRow {
  holder: string;
  token: string;
  until: number;
}

export interface MediaRow {
  source: string;
  name: string;
  originalKey: string;
  originalReady: boolean;
  proxyKey?: string;
  proxyReady: boolean;
  size: number;
  duration?: number;
  createdAt: number;
  updatedAt: number;
}

class Fail {
  constructor(
    readonly code: string,
    readonly message: string,
    readonly extra: Record<string, unknown> = {},
  ) {}
}

/** Repack's `convex/edit.ts`, in memory. */
export class ConvexMock {
  readonly projects = new Map<string, ProjectRow>();
  readonly locks = new Map<string, LockRow>();
  readonly media = new Map<string, MediaRow>();
  readonly files = new Map<string, { data: Uint8Array; contentType: string }>();
  /** Convex's clock (leases), changeable by tests. */
  now: () => number = () => Date.now();
  private nextFile = 1;
  private nextToken = 1;

  store(data: Uint8Array, contentType: string): string {
    const id = `kg${String(this.nextFile++).padStart(4, "0")}storage`;
    this.files.set(id, { data, contentType });
    return id;
  }

  /** The project body stored for `projectId`, parsed. */
  body(projectId: string): Record<string, unknown> | null {
    const row = this.projects.get(projectId);
    const file = row === undefined ? undefined : this.files.get(row.body);
    return file === undefined ? null : (JSON.parse(new TextDecoder().decode(file.data)) as Record<string, unknown>);
  }

  /** Saves `project` as the next rev, as another machine's commit would. */
  saveElsewhere(project: Record<string, unknown>, holder: string): number {
    const id = String(project.id);
    const body = this.store(new TextEncoder().encode(JSON.stringify(project)), "application/json");
    const row = this.projects.get(id);
    const rev = (row?.rev ?? 0) + 1;
    this.projects.set(id, {
      projectId: id,
      name: String(project.name),
      rev,
      body,
      bodySize: this.files.get(body)!.data.length,
      updatedAt: this.now(),
      updatedBy: holder,
      summary: null,
    });
    return rev;
  }

  /** Gives the lease to `holder` (another machine), live for `ms`. */
  lockFor(projectId: string, holder: string, ms = LEASE_MS): string {
    const token = `their-token-${this.nextToken++}`;
    this.locks.set(projectId, { holder, token, until: this.now() + ms });
    return token;
  }

  call(name: string, args: Record<string, unknown>, base: string): unknown {
    try {
      const value = this.run(name, args, base);
      return { status: "success", value: value === undefined ? null : value };
    } catch (error) {
      if (error instanceof Fail) {
        const data = { code: error.code, message: error.message, ...error.extra };
        return { status: "error", errorMessage: `Uncaught ConvexError: ${JSON.stringify(data)}`, errorData: data };
      }
      return { status: "error", errorMessage: `Uncaught Error: ${(error as Error).message}` };
    }
  }

  private live(lock: LockRow | undefined): lock is LockRow {
    return lock !== undefined && lock.until > this.now();
  }

  private card(row: ProjectRow) {
    const lock = this.locks.get(row.projectId);
    return {
      projectId: row.projectId,
      name: row.name,
      rev: row.rev,
      bodySize: row.bodySize,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      summary: row.summary,
      lock: lock === undefined ? null : { holder: lock.holder, until: lock.until },
    };
  }

  private run(name: string, args: Record<string, unknown>, base: string): unknown {
    const projectId = String(args.projectId ?? "");
    switch (name) {
      case "listProjects":
        return [...this.projects.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((row) => this.card(row));
      case "getProject": {
        const row = this.projects.get(projectId);
        if (row === undefined) return null;
        return { ...this.card(row), bodyUrl: `${base}/convex/storage/${row.body}` };
      }
      case "uploadUrl":
        return `${base}/convex/upload/${this.nextFile}`;
      case "commitProject": {
        if (typeof args.holder !== "string" || args.holder.trim() === "") throw new Fail("invalid", "holder must be 1 to 200 characters.");
        if (JSON.stringify(args.summary ?? null).length > 64 * 1024) throw new Fail("invalid", "The summary is too large.");
        const file = this.files.get(String(args.storageId));
        if (file === undefined) throw new Fail("missing_body", "The uploaded body was not found.");
        const row = this.projects.get(projectId);
        const lock = this.locks.get(projectId);
        const mine = this.live(lock) && lock.token === args.lockToken;
        if (row !== undefined ? !mine : this.live(lock) && !mine) {
          throw new Fail(
            "locked",
            this.live(lock) ? `${lock.holder} is editing this project.` : "Take the project's lock before saving.",
            { heldBy: this.live(lock) ? lock.holder : null, until: lock?.until ?? null },
          );
        }
        const rev = row?.rev ?? 0;
        if (args.baseRev !== rev) {
          throw new Fail("conflict", `This project was saved elsewhere since rev ${String(args.baseRev)}; it is now at rev ${rev}.`, { rev });
        }
        if (row !== undefined && row.body !== args.storageId) this.files.delete(row.body);
        this.projects.set(projectId, {
          projectId,
          name: String(args.name).slice(0, 500),
          rev: rev + 1,
          body: String(args.storageId),
          bodySize: file.data.length,
          updatedAt: this.now(),
          updatedBy: args.holder,
          summary: args.summary ?? null,
        });
        return { rev: rev + 1 };
      }
      case "deleteProject": {
        const lock = this.locks.get(projectId);
        if (this.live(lock) && lock.token !== args.lockToken) {
          throw new Fail("locked", `${lock.holder} is editing this project.`, { heldBy: lock.holder, until: lock.until });
        }
        this.locks.delete(projectId);
        const row = this.projects.get(projectId);
        if (row === undefined) return { deleted: false };
        this.projects.delete(projectId);
        this.files.delete(row.body);
        return { deleted: true };
      }
      case "acquireLock": {
        const holder = String(args.holder ?? "");
        if (holder.trim() === "" || holder.length > 200) throw new Fail("invalid", "holder must be 1 to 200 characters.");
        const lock = this.locks.get(projectId);
        if (this.live(lock) && lock.holder !== holder && args.force !== true) {
          return { acquired: false, heldBy: lock.holder, until: lock.until };
        }
        const fields = { holder, token: `token-${this.nextToken++}`, until: this.now() + LEASE_MS };
        this.locks.set(projectId, fields);
        return { acquired: true, token: fields.token, until: fields.until };
      }
      case "renewLock": {
        const lock = this.locks.get(projectId);
        if (lock === undefined || lock.token !== args.lockToken) {
          return { renewed: false, heldBy: lock?.holder ?? null, until: lock?.until ?? null };
        }
        lock.until = this.now() + LEASE_MS;
        return { renewed: true, until: lock.until };
      }
      case "releaseLock": {
        const lock = this.locks.get(projectId);
        if (lock === undefined || lock.token !== args.lockToken) return { released: false };
        this.locks.delete(projectId);
        return { released: true };
      }
      case "getMedia": {
        const row = this.media.get(String(args.source));
        return row === undefined ? null : mediaAnswer(row);
      }
      case "listMedia":
        return [...new Set(args.sources as string[])].flatMap((source) => {
          const row = this.media.get(source);
          return row === undefined ? [] : [mediaAnswer(row)];
        });
      case "putMedia": {
        const { token: _token, source, ...given } = args;
        const key = String(source ?? "");
        if (key.trim() === "" || key.length > 200) throw new Fail("invalid", "source must be 1 to 200 characters.");
        const fields = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)) as Partial<MediaRow>;
        const row = this.media.get(key);
        const now = this.now();
        if (row !== undefined) {
          Object.assign(row, fields, { updatedAt: now });
          return mediaAnswer(row);
        }
        if (fields.name === undefined || fields.originalKey === undefined || fields.size === undefined) {
          throw new Fail("invalid", "New footage needs a name, originalKey and size.");
        }
        const created: MediaRow = {
          ...fields,
          source: key,
          name: fields.name,
          originalKey: fields.originalKey,
          size: fields.size,
          originalReady: fields.originalReady ?? false,
          proxyReady: fields.proxyReady ?? false,
          createdAt: now,
          updatedAt: now,
        };
        this.media.set(key, created);
        return mediaAnswer(created);
      }
      case "deleteMedia": {
        const had = this.media.delete(String(args.source));
        return { deleted: had };
      }
      default:
        throw new Error(`Could not find public function for 'edit:${name}'`);
    }
  }
}

function mediaAnswer(row: MediaRow) {
  return {
    source: row.source,
    name: row.name,
    originalKey: row.originalKey,
    originalReady: row.originalReady,
    proxyKey: row.proxyKey ?? null,
    proxyReady: row.proxyReady,
    size: row.size,
    duration: row.duration ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
