import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { BLOCK, noteViewerMiss, prefetch, serve, sizeOf, viewerBusy, viewerHooks, waitForViewerRest } from "../src/cloud_blocks.ts";

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

test("a range to the object's end is sent a block at a time, whole; a reader that stops stops the reads (Nov 10: a long script preview was \"Out of memory\")", async () => {
  const key = "edit/proxies/whole.mp4";
  const before = reads.length;
  // Through a server, as the page gets it: the length said, every byte there.
  const edit = Bun.serve({ port: 0, fetch: async (request) => (await serve(root, key, request.headers.get("range"), url))! });
  try {
    const answer = await fetch(`http://127.0.0.1:${edit.port}/`, { headers: { range: `bytes=10-${size - 1}` } });
    expect(answer.status).toBe(206);
    // Bun sends a stream chunked, as it does R2's own body on the way through.
    expect(answer.headers.get("content-range")).toBe(`bytes 10-${size - 1}/${size}`);
    expect(new Uint8Array(await answer.arrayBuffer())).toEqual(object.subarray(10));
  } finally {
    void edit.stop(true);
  }
  expect(reads.length - before).toBe(6);
  // Another object, read only as far as its first block: the rest isn't fetched (its next two ahead at most).
  const other = "edit/proxies/stopped.mp4";
  const started = reads.length;
  const response = await serve(root, other, `bytes=0-${size - 1}`, url);
  const reader = response!.body!.getReader();
  expect((await reader.read()).value!.length).toBe(BLOCK);
  await reader.cancel();
  await Bun.sleep(50);
  expect(reads.length - started).toBeLessThanOrEqual(3);
});

test("an open-ended or odd ask isn't served from blocks; one past the end is refused", async () => {
  expect(await serve(root, "edit/proxies/a.mp4", "bytes=100-", url)).toBeNull();
  expect(await serve(root, "edit/proxies/a.mp4", null, url)).toBeNull();
  expect((await serve(root, "edit/proxies/a.mp4", `bytes=${size + 10}-${size + 20}`, url))?.status).toBe(416);
});

test("a viewer read that misses on R2 marks the viewer busy; a cache hit does not, and prefetch waits for rest", async () => {
  const key = "edit/proxies/viewer-busy.mp4";
  noteViewerMiss(0);
  expect(viewerBusy()).toBe(false);
  // A miss: the page waited on R2, so background work must pause.
  await serve(root, key, "bytes=0-1023", url);
  expect(viewerBusy()).toBe(true);
  // Backdate the miss past the rest window: a hit must not mark it again.
  const rest = viewerHooks.restMs;
  noteViewerMiss(Date.now() - rest - 1000);
  expect(viewerBusy()).toBe(false);
  await serve(root, key, "bytes=0-1023", url);
  expect(viewerBusy()).toBe(false);
  // Prefetch waits while the viewer is busy, then goes once it rests.
  viewerHooks.restMs = 200;
  noteViewerMiss();
  const began = Date.now();
  const got = await prefetch(root, "edit/proxies/after-rest.mp4", [0], url);
  expect(got).toBe(BLOCK);
  expect(Date.now() - began).toBeGreaterThanOrEqual(150);
  viewerHooks.restMs = rest;
  noteViewerMiss(0);
});

test("a bounded rest wait proceeds anyway once it is up, however busy the viewer stays", async () => {
  noteViewerMiss();
  const began = Date.now();
  // The viewer stays busy (a miss within the rest window): the bound, not rest, ends this wait.
  expect(await waitForViewerRest(() => false, 120)).toBe(true);
  expect(Date.now() - began).toBeGreaterThanOrEqual(100);
  // A stop still wins over the bound.
  expect(await waitForViewerRest(() => true, 60_000)).toBe(false);
  noteViewerMiss(0);
});

test("read ahead: blocks asked for in order come from R2 once, those here cost nothing, and a stop stops it", async () => {
  const key = "edit/proxies/prefetched.mp4";
  reads.length = 0;
  const got = await prefetch(root, key, [3, 4, 5], url);
  expect(got).toBe(BLOCK * 2 + BLOCK / 2);
  expect(reads).toEqual([`${3 * BLOCK}-${4 * BLOCK - 1}`, `${4 * BLOCK}-${5 * BLOCK - 1}`, `${5 * BLOCK}-${6 * BLOCK - 1}`]);
  expect(sizeOf(root, key)).toBe(size);
  // Here already: nothing read; the page's read of them comes from disk.
  reads.length = 0;
  expect(await prefetch(root, key, [3, 4], url)).toBe(0);
  expect(reads).toEqual([]);
  // Stopped: nothing more.
  expect(await prefetch(root, key, [0, 1], url, () => true)).toBe(0);
  expect(reads).toEqual([]);
});
