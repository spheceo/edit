// The photos of who started each project (`Project::created_by`, the cloud's
// `createdBy`): Google's, by address, fetched here once and kept in the cache,
// so Home's cards don't each ask Google (which limits those addresses) and the
// photos stay when offline. Only Google's photo hosts are fetched; anything
// else, or a photo that won't come, is a 404 and the UI shows initials.

import { createHash } from "node:crypto";
import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import type { Router } from "./http/router.ts";
import { isFile, join } from "./paths.ts";

/** The size asked of Google: twice the largest avatar shown. */
const SIZE = 96;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;
/** A photo that wouldn't come isn't asked for again for this long. */
const MISS_MS = 10 * 60_000;

/** The address to fetch for `given`, sized; null when it isn't a Google photo. */
export function source(given: string): string | null {
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !/^lh\d+\.googleusercontent\.com$/u.test(url.hostname) || url.port !== "" || url.username !== "") return null;
  url.search = "";
  url.hash = "";
  const sized = /=[a-z0-9-]+$/iu.test(url.pathname) ? url.pathname.replace(/=[a-z0-9-]+$/iu, `=s${SIZE}-c`) : `${url.pathname}=s${SIZE}-c`;
  return `${url.origin}${sized}`;
}

/** The image's type from its first bytes; null when it isn't one shown. */
function typeOf(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  if (String.fromCharCode(...bytes.subarray(0, 4)) === "GIF8") return "image/gif";
  return null;
}

const missed = new Map<string, number>();
const fetching = new Map<string, Promise<boolean>>();

async function fetchTo(url: string, dir: string, out: string): Promise<boolean> {
  // No referrer (Google refuses some hotlinked photos that send one) and no cookies.
  const response = await fetch(url, { redirect: "error", referrerPolicy: "no-referrer", credentials: "omit", headers: { accept: "image/*" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) return false;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_BYTES || typeOf(bytes) === null) return false;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, out);
  return true;
}

export function routes(router: Router<App>): void {
  router.get("/api/avatar", async ({ app, query }) => {
    const url = source(query.get("url") ?? "");
    if (url === null) return new Response(null, { status: 404 });
    const dir = join(app.store.cacheDir(), "avatars");
    const out = join(dir, createHash("sha256").update(url).digest("hex").slice(0, 32));
    if (!isFile(out)) {
      if (Date.now() - (missed.get(url) ?? 0) < MISS_MS) return new Response(null, { status: 404 });
      let pending = fetching.get(url);
      if (pending === undefined) {
        pending = fetchTo(url, dir, out)
          .catch((error: unknown) => {
            diag.warn("avatars", `a photo: ${diag.messageOf(error)}`);
            return false;
          })
          .finally(() => fetching.delete(url));
        fetching.set(url, pending);
      }
      if (!(await pending)) {
        missed.set(url, Date.now());
        return new Response(null, { status: 404 });
      }
    }
    const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
    return new Response(bytes, { headers: { "content-type": typeOf(bytes) ?? "application/octet-stream", "cache-control": "private, max-age=86400" } });
  });
}
