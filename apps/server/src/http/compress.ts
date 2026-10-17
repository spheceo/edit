// Compressed answers for a browser that takes them: over Tailscale the UI,
// the project (a couple of MB of JSON) and every save's answer went
// uncompressed (867 KB of JS and 853 KB of WASM on every cold load). JSON is
// gzipped as it goes (fast); the UI's own files are compressed once with
// brotli and kept. Pictures, sound and video are already compressed; ranges
// and HEADs pass as they are.

import * as zlib from "node:zlib";

/** Types worth compressing. */
function compressible(type: string | null): boolean {
  if (type === null) return false;
  const base = type.split(";")[0]!.trim().toLowerCase();
  // Server-sent events stream: never held back to compress.
  if (base === "text/event-stream") return false;
  return (
    base.startsWith("text/") ||
    base === "application/json" ||
    base === "application/javascript" ||
    base === "application/wasm" ||
    base === "image/svg+xml" ||
    base === "application/manifest+json"
  );
}

/** Smaller than this isn't worth the bytes of a header. */
const SMALLEST = 1024;

/** The UI's files compressed once (by path and encoding), as they're immutable for the process. */
const kept = new Map<string, Uint8Array>();

function accepts(request: Request, encoding: string): boolean {
  const given = request.headers.get("accept-encoding") ?? "";
  return given
    .split(",")
    .map((part) => part.split(";")[0]!.trim().toLowerCase())
    .includes(encoding);
}

/**
 * `response` compressed for `request` when it can be: brotli for a UI file
 * (`asset`, its path, kept compressed), gzip for anything else.
 */
export async function compressed(request: Request, response: Response, asset: string | null = null): Promise<Response> {
  if (request.method !== "GET" || response.status !== 200 || response.body === null) return response;
  if (response.headers.has("content-encoding") || response.headers.has("content-range")) return response;
  if (!compressible(response.headers.get("content-type"))) return response;
  const brotli = asset !== null && accepts(request, "br");
  const gzip = !brotli && accepts(request, "gzip");
  if (!brotli && !gzip) return response;
  const encoding = brotli ? "br" : "gzip";
  let bytes: Uint8Array | undefined = asset === null ? undefined : kept.get(`${encoding}:${asset}`);
  if (bytes === undefined) {
    const plain = new Uint8Array(await response.arrayBuffer());
    if (plain.byteLength < SMALLEST) return copy(response, plain);
    bytes = brotli
      ? new Uint8Array(zlib.brotliCompressSync(plain, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: plain.byteLength } }))
      : Bun.gzipSync(plain, { level: 4 });
    if (asset !== null) kept.set(`${encoding}:${asset}`, bytes);
  } else {
    await response.body.cancel();
  }
  const headers = new Headers(response.headers);
  headers.set("content-encoding", encoding);
  headers.set("content-length", String(bytes.byteLength));
  headers.append("vary", "accept-encoding");
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
}

/** The same answer again, its body already read. */
function copy(response: Response, body: Uint8Array): Response {
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
