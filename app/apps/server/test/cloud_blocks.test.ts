import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { BLOCK, serve } from "../src/cloud_blocks.ts";

// R2 stood in for: a 5½-block object, every range read counted.
const size = BLOCK * 5 + BLOCK / 2;
const object = new Uint8Array(size).map((_, i) => (i * 7) % 251);
const reads: string[] = [];
const r2 = Bun.serve({
  port: 0,
  fetch(request) {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(request.headers.get("range") ?? "") ?? [];
    reads.push(`${a}-${b}`);
    const [from, to] = [Number(a), Math.min(Number(b), size - 1)];
    return new Response(object.subarray(from, to + 1), { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes ${from}-${to}/${size}` } });
  },
});
afterAll(() => r2.stop(true));
const url = async () => `http://127.0.0.1:${r2.port}/object`;
const root = fs.mkdtempSync(join(os.tmpdir(), "edit-blocks-"));
const bytes = async (response: Response | null) => new Uint8Array(await response!.arrayBuffer());

test("a range comes from 2 MiB blocks read once, the next two read ahead, picture and sound sharing them", async () => {
  // The page's 256 KiB reads of one block: R2 is read once for it (plus the two after it, ahead).
  const asks = [0, 1, 2, 3].map((n) => serve(root, "edit/proxies/a.mp4", `bytes=${n * 262144}-${(n + 1) * 262144 - 1}`, url));
  const answers = await Promise.all(asks);
  expect(answers.map((answer) => answer!.status)).toEqual([206, 206, 206, 206]);
  expect(await bytes(answers[2]!)).toEqual(object.subarray(2 * 262144, 3 * 262144));
  expect(answers[0]!.headers.get("content-range")).toBe(`bytes 0-262143/${size}`);
  await Bun.sleep(50);
  expect(reads.sort()).toEqual([`0-${BLOCK - 1}`, `${BLOCK}-${2 * BLOCK - 1}`, `${2 * BLOCK}-${3 * BLOCK - 1}`].sort());
  // Across a block's edge, and to the object's end: from the blocks kept, and the end clamped.
  const across = await serve(root, "edit/proxies/a.mp4", `bytes=${BLOCK - 10}-${BLOCK + 9}`, url);
  expect(await bytes(across)).toEqual(object.subarray(BLOCK - 10, BLOCK + 10));
  const end = await serve(root, "edit/proxies/a.mp4", `bytes=${size - 5}-${size + 100}`, url);
  expect(end!.headers.get("content-range")).toBe(`bytes ${size - 5}-${size - 1}/${size}`);
  expect(await bytes(end)).toEqual(object.subarray(size - 5));
});

test("an open-ended or odd ask isn't served from blocks; one past the end is refused", async () => {
  expect(await serve(root, "edit/proxies/a.mp4", "bytes=100-", url)).toBeNull();
  expect(await serve(root, "edit/proxies/a.mp4", null, url)).toBeNull();
  expect((await serve(root, "edit/proxies/a.mp4", `bytes=${size + 10}-${size + 20}`, url))?.status).toBe(416);
});
