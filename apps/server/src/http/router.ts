// Routes as axum declared them: `/api/projects/{id}/media/{media}/{kind}`,
// a literal segment winning over a `{param}` where both match (matchit's
// rule), a known path asked with another method answering 405, and the
// pattern itself as the name every request is timed under ("GET /api/projects/{id}").

import { ApiError } from "./errors.ts";

/** axum's default body limit for extracted bodies (2 MiB); routes may raise or lift it. */
export const DEFAULT_BODY_LIMIT = 2 << 20;

export interface RouteContext<C> {
  app: C;
  request: Request;
  url: URL;
  /** The pattern that matched ("/api/projects/{id}"). */
  route: string;
  /** Path parameters, percent-decoded. */
  params: Record<string, string>;
  query: URLSearchParams;
  /** The route's body limit in bytes (null: none). */
  bodyLimit: number | null;
  /** Upgrades the request to a websocket (Bun's `server.upgrade`); false when it isn't one. */
  upgrade(data: unknown): boolean;
}

/** A route's answer; undefined once the request was upgraded to a websocket. */
export type Handler<C> = (context: RouteContext<C>) => Response | undefined | Promise<Response | undefined>;

export interface RouteOptions {
  /** Bytes a body may have (default 2 MiB, as axum's DefaultBodyLimit); null for none (uploads). */
  bodyLimit?: number | null;
}

type Segment = { literal: string } | { param: string };

export interface Route<C> {
  method: string;
  pattern: string;
  segments: Segment[];
  handler: Handler<C>;
  bodyLimit: number | null;
}

export type Match<C> =
  | { kind: "route"; route: Route<C>; params: Record<string, string> }
  | { kind: "method"; allowed: string[]; pattern: string }
  | { kind: "none" };

export class Router<C> {
  private routes: Route<C>[] = [];

  route(method: string, pattern: string, handler: Handler<C>, options: RouteOptions = {}): this {
    const segments: Segment[] = split(pattern).map((part) =>
      part.startsWith("{") && part.endsWith("}") ? { param: part.slice(1, -1) } : { literal: part },
    );
    if (this.routes.some((existing) => existing.method === method && existing.pattern === pattern)) {
      throw new Error(`route ${method} ${pattern} is registered twice`);
    }
    const bodyLimit = options.bodyLimit === undefined ? DEFAULT_BODY_LIMIT : options.bodyLimit;
    this.routes.push({ method, pattern, segments, handler, bodyLimit });
    return this;
  }

  get(pattern: string, handler: Handler<C>, options?: RouteOptions): this {
    return this.route("GET", pattern, handler, options);
  }

  post(pattern: string, handler: Handler<C>, options?: RouteOptions): this {
    return this.route("POST", pattern, handler, options);
  }

  put(pattern: string, handler: Handler<C>, options?: RouteOptions): this {
    return this.route("PUT", pattern, handler, options);
  }

  delete(pattern: string, handler: Handler<C>, options?: RouteOptions): this {
    return this.route("DELETE", pattern, handler, options);
  }

  /** Every registered route, as "METHOD /pattern" (the parity test compares them with server.rs's). */
  list(): string[] {
    return this.routes.map((route) => `${route.method} ${route.pattern}`);
  }

  /**
   * The route for `method` and `path`: the path picks a pattern first (the
   * most literal one that fits), then the method picks among that pattern's
   * routes, as axum routes.
   */
  match(method: string, path: string): Match<C> {
    const parts = split(path);
    let best: { pattern: string; rank: number[]; params: Record<string, string> } | null = null;
    for (const route of this.routes) {
      if (best !== null && route.pattern === best.pattern) continue;
      const fitted = fit(route.segments, parts);
      if (fitted === null) continue;
      if (best === null || compareRank(fitted.rank, best.rank) > 0) {
        best = { pattern: route.pattern, rank: fitted.rank, params: fitted.params };
      }
    }
    if (best === null) return { kind: "none" };
    const pattern = best.pattern;
    const routes = this.routes.filter((route) => route.pattern === pattern);
    const chosen =
      routes.find((route) => route.method === method) ??
      (method === "HEAD" ? routes.find((route) => route.method === "GET") : undefined);
    if (chosen === undefined) return { kind: "method", allowed: routes.map((route) => route.method), pattern };
    return { kind: "route", route: chosen, params: best.params };
  }
}

/** Whether a pattern fits the path's parts: its params, and how literal it is segment by segment. */
function fit(segments: Segment[], parts: string[]): { params: Record<string, string>; rank: number[] } | null {
  if (segments.length !== parts.length) return null;
  const params: Record<string, string> = {};
  const rank: number[] = [];
  for (let index = 0; index < parts.length; index++) {
    const segment = segments[index]!;
    const part = parts[index]!;
    if ("literal" in segment) {
      if (segment.literal !== part) return null;
      rank.push(1);
      continue;
    }
    if (part === "") return null;
    try {
      params[segment.param] = decodeURIComponent(part);
    } catch {
      return null;
    }
    rank.push(0);
  }
  return { params, rank };
}

function split(path: string): string[] {
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  return trimmed === "" ? [] : trimmed.split("/");
}

function compareRank(a: number[], b: number[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

/** The request's body as text, refusing more than `limit` bytes (axum's "length limit exceeded"). */
export async function readText(request: Request, limit: number | null): Promise<string> {
  return new TextDecoder().decode(await readBytes(request, limit));
}

export async function readBytes(request: Request, limit: number | null): Promise<Uint8Array> {
  const tooBig = () => new ApiError(413, "Failed to buffer the request body: length limit exceeded", true);
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (limit !== null && Number.isFinite(declared) && declared > limit) throw tooBig();
  if (request.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (limit !== null && total > limit) throw tooBig();
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * The body as JSON, refused as axum's `Json` extractor refuses it: 415 without
 * a JSON content type, 413 past the limit, 400 when it doesn't parse.
 */
export async function readJson<T = unknown>(context: Pick<RouteContext<unknown>, "request" | "bodyLimit">): Promise<T> {
  const type = context.request.headers.get("content-type") ?? "";
  const mime = (type.split(";")[0] ?? "").trim().toLowerCase();
  if (!(mime === "application/json" || (mime.startsWith("application/") && mime.endsWith("+json")))) {
    throw new ApiError(415, "Expected request with `Content-Type: application/json`", true);
  }
  const body = await readText(context.request, context.bodyLimit);
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new ApiError(400, `Failed to parse the request body as JSON: ${(error as Error).message}`, true);
  }
}

/** A JSON body that isn't the shape a route wants (axum's 422). */
export function badShape(why: string): ApiError {
  return new ApiError(422, `Failed to deserialize the JSON body into the target type: ${why}`, true);
}
