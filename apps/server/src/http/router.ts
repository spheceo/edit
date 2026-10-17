// Routes as axum declared them: `/api/projects/{id}/media/{media}/{kind}`,
// a literal segment winning over a `{param}` where both match (matchit's
// rule), a known path asked with another method answering 405, and the
// pattern itself as the name every request is timed under ("GET /api/projects/{id}").

import { ApiError } from "./errors.ts";
import { serdeParse } from "../rust.ts";

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
  bodies.set(context.request, body);
  try {
    return serdeParse(body) as T;
  } catch (error) {
    throw new ApiError(400, `Failed to parse the request body as JSON: ${(error as Error).message}`, true);
  }
}

/** A JSON body that isn't the shape a route wants (axum's 422). */
export function badShape(why: string): ApiError {
  return new ApiError(422, `${SHAPE}${why}`, true);
}

const SHAPE = "Failed to deserialize the JSON body into the target type: ";

/** The JSON bodies read, by request: where a 422 points (serde says the line and column). */
const bodies = new WeakMap<Request, string>();

/**
 * A 422 from `badShape` as axum words it: serde's place in the body appended
 * (" at line L column C"), which is just past the value the path names, or
 * past the object a missing field belongs in.
 */
export function withPosition(error: ApiError, request: Request): ApiError {
  if (error.status !== 422 || !error.message.startsWith(SHAPE) || / at line \d+ column \d+$/.test(error.message)) return error;
  const text = bodies.get(request);
  if (text === undefined) return error;
  const why = error.message.slice(SHAPE.length);
  // serde_path_to_error's path ("project.clips[0]: …"), when there is one.
  const pathed = /^((?:[A-Za-z_][\w]*|\[\d+\])(?:\.[A-Za-z_]\w*|\[\d+\])*): /.exec(why);
  const path = pathed === null ? [] : [...pathed[1]!.matchAll(/([A-Za-z_]\w*)|\[(\d+)\]/g)].map((part) => part[1] ?? Number(part[2]));
  // The path names the value that failed; for a missing field, the object it's missing from,
  // which serde notices at its closing brace. Either way the place is just past that value.
  const end = valueEnd(text, path);
  if (end === null) return error;
  let line = 1;
  let start = 0;
  for (let index = 0; index < end; index++) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      start = index + 1;
    }
  }
  const column = new TextEncoder().encode(text.slice(start, end)).length;
  return new ApiError(error.status, `${error.message} at line ${line} column ${column}`, error.plain);
}

/** The text of the JSON body `readJson` read for `request`, if it did. */
export function bodyText(request: Request): string | undefined {
  return bodies.get(request);
}

/**
 * The path (keys and indexes) of the innermost JSON value in `text` that ends
 * (exclusive) at `end`: where serde stopped when it refused something, given
 * its column on a one-line text. Null when no value ends there.
 */
export function pathEndingAt(text: string, end: number): (string | number)[] | null {
  let at = 0;
  let found: (string | number)[] | null = null;
  const space = () => {
    while (at < text.length && " \t\n\r".includes(text[at]!)) at++;
  };
  const string = (): string => {
    const from = at;
    at++;
    while (at < text.length && text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    at++;
    try {
      return JSON.parse(text.slice(from, at)) as string;
    } catch {
      return "";
    }
  };
  // Reads the value at `at` (its path `path`); notes it when it ends at `end` (inner ones first).
  const value = (path: (string | number)[]): void => {
    space();
    const first = text[at];
    if (first === "{") {
      at++;
      space();
      if (text[at] === "}") at++;
      else {
        for (;;) {
          space();
          const key = string();
          space();
          at++; // ':'
          value([...path, key]);
          space();
          if (text[at] === ",") {
            at++;
            continue;
          }
          at++; // '}'
          break;
        }
      }
    } else if (first === "[") {
      at++;
      space();
      if (text[at] === "]") at++;
      else {
        for (let index = 0; ; index++) {
          value([...path, index]);
          space();
          if (text[at] === ",") {
            at++;
            continue;
          }
          at++; // ']'
          break;
        }
      }
    } else if (first === '"') {
      string();
    } else {
      while (at < text.length && !",}] \t\n\r".includes(text[at]!)) at++;
    }
    if (at === end && found === null) found = path;
  };
  try {
    value([]);
  } catch {
    return null;
  }
  return found;
}

/** A path as serde_path_to_error shows it: `project.clips[0].start`. */
export function showPath(path: (string | number)[]): string {
  return path.map((part, index) => (typeof part === "number" ? `[${part}]` : index === 0 ? part : `.${part}`)).join("");
}

/** Where the JSON value at `path` (keys and indexes) ends in `text` (exclusive), or null. */
export function valueEnd(text: string, path: (string | number)[]): number | null {
  let at = 0;
  const space = () => {
    while (at < text.length && " \t\n\r".includes(text[at]!)) at++;
  };
  const skipString = () => {
    at++;
    while (at < text.length && text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    at++;
  };
  const readString = (): string => {
    const from = at;
    skipString();
    try {
      return JSON.parse(text.slice(from, at)) as string;
    } catch {
      return "";
    }
  };
  // Skips the value at `at`; returns where it ends.
  const skip = (): number => {
    space();
    const first = text[at];
    if (first === '"') {
      skipString();
    } else if (first === "{" || first === "[") {
      let depth = 0;
      while (at < text.length) {
        const char = text[at]!;
        if (char === '"') {
          skipString();
          continue;
        }
        if (char === "{" || char === "[") depth++;
        if (char === "}" || char === "]") depth--;
        at++;
        if (depth === 0) break;
      }
    } else {
      while (at < text.length && !",}] \t\n\r".includes(text[at]!)) at++;
    }
    return at;
  };
  for (const step of path) {
    space();
    if (typeof step === "number") {
      if (text[at] !== "[") return null;
      at++;
      for (let index = 0; index < step; index++) {
        skip();
        space();
        if (text[at] !== ",") return null;
        at++;
      }
    } else {
      if (text[at] !== "{") return null;
      at++;
      let found = false;
      while (!found) {
        space();
        if (text[at] !== '"') return null;
        const key = readString();
        space();
        if (text[at] !== ":") return null;
        at++;
        if (key === step) {
          found = true;
          break;
        }
        skip();
        space();
        if (text[at] !== ",") return null;
        at++;
      }
    }
  }
  return skip();
}
