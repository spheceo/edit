// The HTTP server : every request is timed
// by its route and logged when it failed (outermost, so it also sees requests
// the host check turned away or that crashed); the host check; a route that
// has a bug answers with a JSON error and the server carries on; `/api/ws`
// streams the store's events; `/fonts/{file}` serves the bundled fonts; and
// everything else is the web UI.

import type { Server, ServerWebSocket } from "bun";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { isBug, panicResponse } from "../guard.ts";
import * as mcp from "../mcp/index.ts";
import * as patches from "../patch.ts";
import * as relay from "../relay.ts";
import { staticAsset } from "./assets.ts";
import { compressed } from "./compress.ts";
import { ApiError, notFound, text } from "./errors.ts";
import { checkHost, secure } from "./host.ts";
import { Router, withPosition, type RouteContext } from "./router.ts";

interface Socket {
  unsubscribe: (() => void) | null;
  /** Asked for project changes as patches (`/api/ws?patches=1`, patch.ts) rather than whole. */
  patches: boolean;
  /** Events were dropped while it couldn't keep up: it's told to resync once it drains. */
  lagged: boolean;
}

/** The routes every server has; packages add theirs to the same router. */
export function baseRouter(): Router<App> {
  return new Router<App>()
    .get("/api/ws", websocket)
    .get("/fonts/{file}", font)
    .post("/mcp", mcp.handle)
    .get("/mcp", mcp.rejectGet);
}

function websocket(context: RouteContext<App>): Response | undefined {
  const socket: Socket = { unsubscribe: null, lagged: false, patches: context.query.get("patches") === "1" };
  if (context.upgrade(socket)) return undefined;
  return text("Connection header did not include 'upgrade'", 400);
}

/** Each project event's patch text, made once however many connections take it. */
const patchTexts = new WeakMap<object, string | null>();

/** A project event as a patch against what it was (store.ts `before`), or null to send it whole. */
function patchText(event: Record<string, unknown>): string | null {
  if (event.type !== "project") return null;
  const cached = patchTexts.get(event);
  if (cached !== undefined) return cached;
  const before = (event as { before?: { rev: number; project: Record<string, unknown> } }).before;
  let made: string | null = null;
  if (before !== undefined) {
    try {
      const patch = patches.diff(before.project, event.project as Record<string, unknown>);
      made = JSON.stringify({ type: "project", id: event.id, rev: event.rev, base_rev: before.rev, origin: event.origin, patch });
    } catch (error) {
      diag.warn("store", `a project change as a patch: ${diag.messageOf(error)}`);
    }
  }
  patchTexts.set(event, made);
  return made;
}

function font(context: RouteContext<App>): Response {
  const bytes = context.app.native.bundledFont(context.params.file ?? "");
  if (bytes === null) throw notFound("no such font");
  return new Response(bytes, {
    headers: { "content-type": (context.params.file ?? "").endsWith(".otf") ? "font/otf" : "font/ttf", "cache-control": "public, max-age=31536000, immutable" },
  });
}

/** Answers one request (exported for tests: `fetch` without a socket). */
export async function respond(
  app: App,
  router: Router<App>,
  request: Request,
  server: Server<Socket> | null,
): Promise<Response | undefined> {
  const started = performance.now();
  const url = new URL(request.url);
  const method = request.method;
  const match = router.match(method, url.pathname);
  const route = match.kind === "route" ? match.route.pattern : match.kind === "method" ? match.pattern : "(static)";
  let response: Response | undefined;
  try {
    const refused = checkHost(request, app.allowedHosts);
    if (refused !== null) {
      response = refused;
    } else {
      if (match.kind === "route") {
        const answer = await match.route.handler({
          app,
          request,
          url,
          route,
          params: match.params,
          query: url.searchParams,
          bodyLimit: match.route.bodyLimit,
          upgrade: (data) => server?.upgrade(request, { data: data as Socket }) ?? false,
        });
        response = answer === undefined ? undefined : await compressed(request, answer);
      } else if (match.kind === "method") {
        response = new Response(null, { status: 405, headers: { allow: match.allowed.join(",") } });
      } else if (method === "GET" && url.pathname.startsWith("/v1/3dtiles/")) {
        // The map page's tiles, through the relay with this Edit's sign-in.
        response = await relay.forwardTiles(request, url);
      } else if (method === "GET" || method === "HEAD") {
        response = await compressed(request, staticAsset(url.pathname), url.pathname);
      } else {
        response = new Response(null, { status: 405, headers: { allow: "GET,HEAD" } });
      }
      if (response !== undefined) secure(response);
    }
  } catch (error) {
    if (error instanceof ApiError) {
      response = secure(withPosition(error, request).response());
    } else if (isBug(error)) {
      response = panicResponse(error);
    } else {
      // Routes word their own failures; one that slipped through still answers.
      response = secure(Response.json({ error: diag.messageOf(error) }, { status: 500 }));
    }
  }
  if (response === undefined) {
    // Upgraded to a websocket: the handshake is the request.
    diag.record("http", `${method} ${route}`, performance.now() - started, null);
    return undefined;
  }
  return logged(method, route, url.pathname, performance.now() - started, response);
}

/** Times a request (by route) and logs the ones that failed, with why. */
async function logged(method: string, route: string, path: string, ms: number, response: Response): Promise<Response> {
  const name = `${method} ${route}`;
  const status = response.status;
  // axum's Json says "application/json"; Bun's Response.json adds a charset.
  if (response.headers.get("content-type") === "application/json;charset=utf-8") {
    try {
      response.headers.set("content-type", "application/json");
    } catch {
      // immutable headers (a passed-on response): leave them
    }
  }
  if (status < 400) {
    // The window's long poll for "come to the front" is meant to take its 25 s: not timed.
    if (route !== "/api/window/next") diag.record("http", name, ms, null);
    return response;
  }
  // Errors answer with a small JSON body: read it for the log, then pass it on.
  const body = await response.clone().text();
  let why: string | null = null;
  try {
    const value = JSON.parse(body) as { error?: unknown };
    if (typeof value.error === "string") why = value.error;
  } catch {
    why = null;
  }
  why ??= [...body].slice(0, 300).join("");
  const failure = `${status} ${path}: ${why}`;
  if (status >= 500) {
    diag.record("http", name, ms, failure);
  } else {
    diag.record("http", name, ms, null);
    // A missing thumbnail or frame is routine; other refusals are worth seeing.
    if (status !== 404 || method !== "GET") diag.warn("http", `${method} ${failure}`);
  }
  return response;
}

/** Starts listening on `hostname:port` (one per address `bind_addresses` gives). */
export function listen(app: App, router: Router<App>, hostname: string, port: number): Server<Socket> {
  return Bun.serve<Socket>({
    hostname,
    port,
    // Uploads stream to disk with their own limits; the routes enforce the rest.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    // Agent tool calls and exports can take minutes without a byte sent.
    idleTimeout: 0,
    fetch: (request, server) => respond(app, router, request, server),
    websocket: {
      // Every commit sends the whole project (a couple of MB): compressed, a tenth of that.
      perMessageDeflate: true,
      open(ws: ServerWebSocket<Socket>) {
        ws.data.unsubscribe = app.store.subscribe((event, text) => {
          if (ws.data.lagged) return;
          const sent = (ws.data.patches && patchText(event)) || text();
          if (ws.send(sent) === 0) ws.data.lagged = true;
        });
      },
      drain(ws: ServerWebSocket<Socket>) {
        if (ws.data.lagged && ws.send(JSON.stringify({ type: "resync" })) > 0) ws.data.lagged = false;
      },
      message() {
        // Clients only listen.
      },
      close(ws: ServerWebSocket<Socket>) {
        ws.data.unsubscribe?.();
        ws.data.unsubscribe = null;
      },
    },
  });
}

