// Host protects against DNS rebinding; Origin also protects local APIs and
// websockets from a malicious page making requests to an allowed localhost.

import { hostname } from "../app.ts";
import { empty, text } from "./errors.ts";

/** A Host header's parts, or null when it isn't an authority (`host[:port]`). */
export function authority(value: string): { host: string; port: number | null } | null {
  if (value === "" || /[\s/?#\\]/.test(value)) return null;
  // An authority may carry user info; the host is what follows it.
  const raw = value.slice(value.lastIndexOf("@") + 1);
  if (raw === "") return null;
  let url: URL;
  try {
    url = new URL(`http://${raw}`);
  } catch {
    return null;
  }
  const port = /:(\d+)$/.exec(raw)?.[1];
  if (port !== undefined && Number(port) > 65535) return null;
  return { host: url.hostname, port: port === undefined ? null : Number(port) };
}

/**
 * Refuses a request that names a host this server doesn't answer to, comes
 * from another site's page, or says it's cross-site. Null when it may go on.
 */
export function checkHost(request: Request, allowed: string[]): Response | null {
  const host = request.headers.get("host") ?? "";
  const parsed = authority(host);
  if (parsed === null) return empty(403);
  const name = parsed.host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!(allowed.includes(name) || name.endsWith(".localhost"))) {
    return text(`host ${name} is not allowed; set EDIT_HOSTS`, 403);
  }
  // The sign-in's loopback redirect (accounts.ts, RFC 8252) is a top-level
  // GET from accounts.spheceo.com: cross-site by nature. It's safe to let in:
  // it only takes the `state` of a sign-in this server started, with a
  // one-use code that's useless without the PKCE verifier kept here.
  if (request.method === "GET" && new URL(request.url).pathname === "/callback") return null;
  const origin = request.headers.get("origin");
  // Media bytes and map tiles come from a sibling loopback host (below), so
  // they get their own connection pool and can't queue the API behind them.
  const pathname = new URL(request.url).pathname;
  if ((request.method === "GET" || request.method === "OPTIONS") && origin !== null && (pathname.startsWith("/v1/3dtiles/") || mediaPath(pathname)) && loopbackSibling(origin, host)) return null;
  // An <img>, a CSS background or an <audio> sends no Origin; the browser names
  // the page in Referer instead, which no other site can set. Without this the
  // timeline's thumbnails and smooth playback's sound were refused as
  // cross-site in Edit's window (Nov 4, JJ's log: 88 in a day).
  if (request.method === "GET" && origin === null && mediaPath(pathname)) {
    const page = refererOrigin(request.headers.get("referer"));
    if (page !== null && loopbackSibling(page, host)) return null;
  }
  // Opening Edit from a link in another app (a chat, Slack) is a top-level GET
  // the browser marks cross-site; the page that loads only shows Edit, which
  // the other site can't read or frame (x-frame-options). The API stays
  // closed to it. Nov 7: a link to the editor in T3 Code was refused.
  if (request.method === "GET" && origin === null && request.headers.get("sec-fetch-mode") === "navigate" && request.headers.get("sec-fetch-dest") === "document" && !pathname.startsWith("/api/") && pathname !== "/mcp") return null;
  if (origin !== null && !sameOrigin(origin, host)) return text("cross-origin requests are not allowed", 403);
  if (request.headers.get("sec-fetch-site") === "cross-site") return text("cross-site requests are not allowed", 403);
  return null;
}

/**
 * Whether a path serves media bytes the viewer reads (as opposed to a control
 * call): a project's media files, smooth playback's file, chunks and sound,
 * and the scrub tier's pieces. These go on the sibling host; the small JSON
 * around them (`playback/stream`, `playback`, the scrub asks) stays on the
 * page's host with the rest of the API.
 */
export function mediaPath(pathname: string): boolean {
  return (
    /^\/api\/projects\/[^/]+\/media\//.test(pathname) ||
    /^\/api\/projects\/[^/]+\/playback\.mp4$/.test(pathname) ||
    /^\/api\/projects\/[^/]+\/playback\/(segment\/|sound$)/.test(pathname) ||
    /^\/api\/projects\/[^/]+\/scrub\/[^/]+\/[^/]+$/.test(pathname)
  );
}

/**
 * Whether a request comes from Edit's own page on another loopback name of
 * this same server: the page is on one loopback address and reads media (and
 * the map page its tiles, from `t0…t7.localhost`) from a sibling on the same
 * port, which browsers reach over more connections at once (six a host over
 * HTTP/1.1: a map's hundreds of tiles took minutes, Oct 28; on nightly-50 a
 * handful of slow media reads queued every API call behind them).
 */
export function loopbackSibling(origin: string, host: string): boolean {
  const match = /^http:\/\/([^/?#]+)$/.exec(origin);
  const from = match === null ? null : authority(match[1]!);
  const to = authority(host);
  const loopback = (name: string) => name === "127.0.0.1" || name === "localhost" || name.endsWith(".localhost");
  return from !== null && to !== null && loopback(from.host.toLowerCase()) && loopback(to.host.toLowerCase()) && from.port !== null && from.port === to.port;
}

/** The page a Referer names, as an origin (`http://127.0.0.1:7700`); null when there's none to read. */
export function refererOrigin(referer: string | null): string | null {
  if (referer === null || referer === "") return null;
  try {
    const url = new URL(referer);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** The map page's name for `loopbackSibling` (its tiles were the first sibling reads). */
export const mapSibling = loopbackSibling;

/** The headers every answer that passed the check carries. */
export function secure(response: Response): Response {
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  return response;
}

/** Whether an Origin header is the site the Host header names (scheme's default port allowed). */
export function sameOrigin(origin: string, host: string): boolean {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/.exec(origin);
  if (match === null) return false;
  const [, scheme, auth, path, query, fragment] = match;
  if (scheme !== "http" && scheme !== "https") return false;
  if (fragment !== undefined) return false;
  const from = authority(auth ?? "");
  const to = authority(host);
  if (from === null || to === null) return false;
  const defaultPort = scheme === "https" ? 443 : 80;
  return (
    from.host.toLowerCase() === to.host.toLowerCase() &&
    (from.port ?? defaultPort) === (to.port ?? defaultPort) &&
    (path === undefined || path === "/") &&
    query === undefined
  );
}

/**
 * The host names this server answers to: localhost, this machine's name, its
 * Tailscale address and name when there is one (serve.ts gathers those), the
 * host it was told to bind, and `EDIT_HOSTS` (comma-separated).
 */
export function allowedHosts(extra: { host?: string | null; tailscale?: (string | null)[] } = {}): string[] {
  const allowed = ["localhost", "127.0.0.1", "::1"];
  // The machine's own name only when it listens beyond this Mac (Tailscale, or a host it was told): on loopback alone it's never needed.
  const name = hostname();
  const offLoopback = (extra.tailscale ?? []).some((entry) => entry !== null && entry !== "") || (extra.host !== undefined && extra.host !== null && !["localhost", "127.0.0.1", "::1"].includes(extra.host.toLowerCase()));
  if (name !== null && offLoopback) allowed.push(name);
  for (const entry of extra.tailscale ?? []) {
    if (entry !== null && entry !== "") allowed.push(entry);
  }
  if (extra.host !== undefined && extra.host !== null) allowed.push(extra.host.toLowerCase());
  const listed = process.env.EDIT_HOSTS;
  if (listed !== undefined) {
    for (const entry of listed.split(",")) {
      const trimmed = entry.trim().toLowerCase();
      if (trimmed !== "") allowed.push(trimmed);
    }
  }
  return allowed;
}
