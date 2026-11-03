/**
 * Proxies read through the relay and cached at Cloudflare's edge (off Modal,
 * step 5; Sphe, Nov 2). Edit read every proxy block from R2 through a
 * presigned URL straight to <account>.r2.cloudflarestorage.com, which the
 * edge never caches: each Mac in South Africa paid R2's ~0.25 s for every
 * 2 MiB block, every time, even right after a teammate read the same block.
 *
 * With `MEDIA_HOST` (the relay on a custom domain of the team's zone: the
 * Cache API does nothing on workers.dev) and `MEDIA_SECRET` set,
 * `/v1/cloud/r2/url {key, method: GET, edge: true}` for a proxy hands out
 * `https://<MEDIA_HOST>/v1/media/<key>?exp=&sig=` instead: signed by the
 * relay for that key and time (no sign-in on each read), and each byte range
 * asked for (Edit asks in fixed 2 MiB blocks) kept at the edge for a year, so
 * the team's second read of a block comes from Johannesburg's cache. Only
 * proxies (`edit/proxies/…`): they're named by what they hold and never
 * change. Without both settings nothing changes: presigned URLs, as before.
 */
import { objectUrl, type R2 } from "./cloud";

export interface MediaEnv {
  /** The relay's host on the team's zone (`media.<zone>`), where the edge cache works. */
  MEDIA_HOST?: string;
  /** Signs media URLs (any long random string, a Worker secret). */
  MEDIA_SECRET?: string;
}

/** Keys the edge may keep: immutable proxies. */
export const cacheable = (key: string) => key.startsWith("edit/proxies/") && !key.includes("..");

const encodePath = (path: string) => path.split("/").map((part) => encodeURIComponent(part)).join("/");

async function signature(secret: string, key: string, exp: number): Promise<string> {
  const imported = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(`${key}\n${exp}`)));
  return Array.from(signed, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The edge URL of proxy `key` for `expires` seconds, or null when the relay isn't set up for it (or `key` isn't a proxy). */
export async function mediaUrl(env: MediaEnv, key: string, expires: number, now = Date.now()): Promise<string | null> {
  if (!env.MEDIA_HOST || !env.MEDIA_SECRET || !cacheable(key)) return null;
  const exp = Math.floor(now / 1000) + expires;
  return `https://${env.MEDIA_HOST}/v1/media/${encodePath(key)}?exp=${exp}&sig=${await signature(env.MEDIA_SECRET, key, exp)}`;
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let differ = 0;
  for (let at = 0; at < a.length; at++) differ |= a.charCodeAt(at) ^ b.charCodeAt(at);
  return differ === 0;
}

/** The edge's cache, or none (tests, workers.dev). */
export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/**
 * `GET /v1/media/<key>?exp=&sig=` with a `Range: bytes=a-b`: that range of
 * the proxy, from the edge's cache or from R2 (then kept there). Ranges only:
 * a whole proxy is hundreds of megabytes, past what the edge keeps.
 */
export async function media(request: Request, url: URL, env: MediaEnv, r2: R2 | null, cache: EdgeCache | null, now = Date.now()): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("GET only", { status: 405 });
  if (!env.MEDIA_SECRET || r2 === null) return new Response("media isn't set up on this relay", { status: 404 });
  const key = decodeURIComponent(url.pathname.slice("/v1/media/".length));
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  if (!cacheable(key) || !Number.isInteger(exp) || exp * 1000 < now || !same(sig, await signature(env.MEDIA_SECRET, key, exp))) {
    return new Response("not a valid media address (or it has lapsed)", { status: 403 });
  }
  const asked = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
  if (asked === null) return new Response("a range (bytes=a-b) is needed", { status: 416 });
  const [from, to] = [Number(asked[1]), Number(asked[2])];
  if (!(to >= from) || to - from > 8 * 1024 * 1024) return new Response("ranges of up to 8 MiB", { status: 416 });
  // One entry per object and range, whoever signed the URL: the signature isn't part of what's kept.
  const keyed = new Request(`${url.origin}/v1/media/${encodePath(key)}?range=${from}-${to}`);
  const kept = await cache?.match(keyed);
  if (kept !== undefined) {
    return new Response(request.method === "HEAD" ? null : kept.body, { status: 206, headers: rangeHeaders(kept.headers, "HIT") });
  }
  const answer = await fetch(await objectUrl(r2, "GET", key, {}, 60), { headers: { range: `bytes=${from}-${to}` } });
  if (answer.status !== 206) {
    return new Response(answer.status === 404 ? "no such proxy" : `R2 answered ${answer.status}`, { status: answer.status === 404 ? 404 : 502 });
  }
  const body = await answer.arrayBuffer();
  const headers = new Headers({
    "content-type": answer.headers.get("content-type") ?? "video/mp4",
    "content-range": answer.headers.get("content-range") ?? `bytes ${from}-${from + body.byteLength - 1}/*`,
    "cache-control": "public, max-age=31536000, immutable",
  });
  // The Cache API keeps 200s only: the range rides in its own header.
  await cache?.put(keyed, new Response(body.slice(0), { status: 200, headers: { ...Object.fromEntries(headers), "x-content-range": headers.get("content-range")! } })).catch(() => {});
  return new Response(request.method === "HEAD" ? null : body, { status: 206, headers: rangeHeaders(headers, "MISS") });
}

function rangeHeaders(from: Headers, state: "HIT" | "MISS"): Headers {
  return new Headers({
    "content-type": from.get("content-type") ?? "video/mp4",
    "content-range": from.get("x-content-range") ?? from.get("content-range") ?? "",
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable",
    "x-edit-edge": state,
  });
}
