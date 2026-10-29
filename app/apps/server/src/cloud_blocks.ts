// Cloud previews read in big blocks and kept a while. Measured Oct 29 from
// this Mac (South Africa): every read of R2 waits ~0.25 s for its first byte
// whatever its size, and the page reads 256 KiB at a time, its picture and
// sound workers each reading the same file. Mom & Teen played at 21 fps with a
// 4.8 s freeze, cold seeks took up to 3 s or more, and a scrub showed one
// picture in five. The bytes weren't slow; the round trips were.
//
// So a range the page asks for is served from 2 MiB blocks of the object:
// each block read from R2 once (two asks for it share the read), kept on disk
// under `<cache>/cloud/blocks/`, and the next two read ahead as the reads move
// on. The cleaner drops blocks past the cache's budget after a few hours, as
// every other copy of an R2 object (cache_cleanup.ts, CLOUD_EVICTABLE).

import * as fs from "node:fs";
import { createHash } from "node:crypto";

import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { join } from "./paths.ts";

export const BLOCK = 2 * 1024 * 1024;
/** Blocks read ahead past the last one asked for. */
const AHEAD = 2;
/** R2 reads at once across every object (read-ahead waits its turn behind asks). */
const AT_ONCE = 6;

interface Meta {
  size: number;
  type: string;
}

const reading = new Map<string, Promise<Uint8Array>>();
let inFlight = 0;
const queue: (() => void)[] = [];

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (inFlight >= AT_ONCE) await new Promise<void>((resolve) => queue.push(resolve));
  inFlight++;
  try {
    return await work();
  } finally {
    inFlight--;
    queue.shift()?.();
  }
}

const folderOf = (root: string, key: string) => join(root, createHash("sha1").update(key).digest("hex"));

function metaOf(folder: string): Meta | null {
  try {
    return JSON.parse(fs.readFileSync(join(folder, "meta.json"), "utf8")) as Meta;
  } catch {
    return null;
  }
}

/** One block of the object, from disk or R2 (once, however many ask). */
function block(root: string, key: string, index: number, url: () => Promise<string>): Promise<Uint8Array> {
  const folder = folderOf(root, key);
  const path = join(folder, `${index}`);
  try {
    const bytes = fs.readFileSync(path);
    // Touched, so the cleaner keeps what's being played longest.
    const now = new Date();
    fs.utimesSync(path, now, now);
    return Promise.resolve(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    // Not here yet.
  }
  const id = `${key}#${index}`;
  const known = reading.get(id);
  if (known !== undefined) return known;
  const read = slot(async () => {
    const start = index * BLOCK;
    const answer = await fetch(await url(), { headers: { range: `bytes=${start}-${start + BLOCK - 1}` } });
    if (answer.status !== 206) {
      void answer.body?.cancel();
      throw new Error(`R2 answered ${answer.status} to a block read`);
    }
    const total = Number(/\/(\d+)$/.exec(answer.headers.get("content-range") ?? "")?.[1] ?? NaN);
    const bytes = new Uint8Array(await answer.arrayBuffer());
    fs.mkdirSync(folder, { recursive: true });
    if (Number.isFinite(total) && metaOf(folder) === null) writeAtomic(join(folder, "meta.json"), JSON.stringify({ size: total, type: answer.headers.get("content-type") ?? "video/mp4" }));
    writeAtomic(path, bytes);
    return bytes;
  }).finally(() => reading.delete(id));
  reading.set(id, read);
  return read;
}

/** A bounded range (`bytes=a-b`) of a cloud object, from its blocks; null for any other kind of ask, which goes straight to R2. */
export async function serve(root: string, key: string, range: string | null, url: () => Promise<string>): Promise<Response | null> {
  const asked = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
  if (asked === null) return null;
  let [from, to] = [Number(asked[1]), Number(asked[2])];
  if (!(to >= from)) return null;
  const first = Math.floor(from / BLOCK);
  // The first block says how big the object is.
  const opening = await block(root, key, first, url);
  const meta = metaOf(folderOf(root, key));
  if (meta === null) return null;
  if (from >= meta.size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${meta.size}` } });
  to = Math.min(to, meta.size - 1);
  const last = Math.floor(to / BLOCK);
  const blocks = [opening, ...(await Promise.all(Array.from({ length: last - first }, (_, n) => block(root, key, first + 1 + n, url))))];
  const out = new Uint8Array(to - from + 1);
  let written = 0;
  blocks.forEach((bytes, n) => {
    const base = (first + n) * BLOCK;
    const slice = bytes.subarray(Math.max(from - base, 0), Math.min(to - base + 1, bytes.length));
    out.set(slice, written);
    written += slice.length;
  });
  // What's next, read while this plays.
  for (let n = 1; n <= AHEAD; n++) {
    const next = last + n;
    if (next * BLOCK < meta.size) void block(root, key, next, url).catch((error: unknown) => diag.warn("cloud", `reading ahead in ${key}: ${diag.messageOf(error)}`));
  }
  return new Response(out, {
    status: 206,
    headers: { "content-type": meta.type, "content-length": String(out.length), "content-range": `bytes ${from}-${to}/${meta.size}`, "accept-ranges": "bytes", "cache-control": "no-cache" },
  });
}
