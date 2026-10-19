// A file from disk as tower-http's ServeFile answers it: its type by
// extension, length, Last-Modified (a matching If-Modified-Since is a 304),
// and single byte ranges (206; one past the end is a 416), which the
// browser's video element relies on to seek.

import * as fs from "node:fs";

import { mimeOf } from "./assets.ts";

/** Types the UI's own files don't have but media do (mime_guess's first guesses). */
const MEDIA_TYPES: Record<string, string> = {
  m4a: "audio/m4a",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mts: "model/vnd.mts",
  mxf: "application/mxf",
  aac: "audio/aac",
  flac: "audio/flac",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  ogg: "audio/ogg",
  opus: "audio/opus",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  bin: "application/octet-stream",
};

export function typeOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  return MEDIA_TYPES[ext] ?? mimeOf(path);
}

/** Serves `path` for `request`; 404 when it isn't a file (as ServeFile). */
export function serveFile(request: Request, path: string): Response {
  let meta: fs.Stats;
  try {
    meta = fs.statSync(path);
  } catch {
    return new Response(null, { status: 404 });
  }
  if (!meta.isFile()) return new Response(null, { status: 404 });
  const size = meta.size;
  const modified = new Date(Math.floor(meta.mtimeMs / 1000) * 1000);
  const headers = new Headers({
    "content-type": typeOf(path),
    "accept-ranges": "bytes",
    "last-modified": modified.toUTCString(),
  });
  const since = request.headers.get("if-modified-since");
  if (since !== null) {
    const when = Date.parse(since);
    if (Number.isFinite(when) && modified.getTime() <= when) {
      return new Response(null, { status: 304, headers: { "last-modified": headers.get("last-modified")! } });
    }
  }
  const head = request.method === "HEAD";
  const range = request.headers.get("range");
  if (range !== null) {
    const parsed = parseRange(range, size);
    if (parsed === "unsatisfiable") {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    if (parsed !== null) {
      const [start, end] = parsed;
      headers.set("content-range", `bytes ${start}-${end}/${size}`);
      headers.set("content-length", String(end - start + 1));
      return new Response(head ? null : Bun.file(path).slice(start, end + 1), { status: 206, headers });
    }
  }
  headers.set("content-length", String(size));
  return new Response(head ? null : Bun.file(path), { status: 200, headers });
}

/** One `bytes=` range within `size`, inclusive; null to send the whole file (not a byte range). */
export function parseRange(header: string, size: number): [number, number] | "unsatisfiable" | null {
  const match = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (match === null) return null;
  const parts = match[1]!.split(",").map((part) => part.trim());
  // Several ranges would be a multipart answer, which ServeFile doesn't make.
  if (parts.length !== 1) return "unsatisfiable";
  const one = /^(\d*)-(\d*)$/.exec(parts[0]!);
  if (one === null) return "unsatisfiable";
  const [, first, last] = one;
  if (first === "" && last === "") return "unsatisfiable";
  let start: number;
  let end: number;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(first);
    end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return [start, end];
}
