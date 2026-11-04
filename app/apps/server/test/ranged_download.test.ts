import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as rd from "../src/ranged_download.ts";

const MIB = 1 << 20;
const file = Uint8Array.from({ length: 5 * MIB + 12_345 }, (_, i) => (i * 31 + (i >> 11)) % 251);
/** What the stand-in Drive does to the next requests, by part start: "fail", "refuse", "shifted" (answers from 1 byte on), "short". */
const trouble = new Map<number, string[]>();
const asked: number[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
      if (match === null) return new Response(file);
      let [from, to] = [Number(match[1]), Math.min(Number(match[2]), file.length - 1)];
      asked.push(from);
      const what = trouble.get(from)?.shift();
      if (what === "fail") return new Response("busy", { status: 503 });
      if (what === "refuse") return new Response("no", { status: 403 });
      if (what === "shifted") from += 1;
      const body = file.subarray(from, what === "short" ? to - 100 : to + 1);
      return new Response(body, { status: 206, headers: { "content-range": `bytes ${from}-${to}/${file.length}` } });
    },
  });
  rd.ranged.part = MIB;
  rd.ranged.parallel = 3;
  rd.ranged.sleep = async () => {};
});

afterAll(() => {
  void server.stop(true);
});

afterEach(() => {
  trouble.clear();
  asked.length = 0;
});

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ranged-"));
const run = (dest: string, onBytes?: (bytes: number) => void) => rd.download({ url: `http://127.0.0.1:${server.port}/f`, size: file.length, dest, fetch: (url, init) => fetch(url, init), onBytes });

test("a big file comes down in parts at once, each where it belongs, and progress only grows to its size", async () => {
  const dest = path.join(dir(), "a.mp4");
  const seen: number[] = [];
  await run(dest, (bytes) => seen.push(bytes));
  expect(Buffer.from(fs.readFileSync(dest)).equals(Buffer.from(file))).toBe(true);
  expect(asked.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5].map((n) => n * MIB));
  expect(seen.at(-1)).toBe(file.length);
  expect(seen.every((bytes, i) => i === 0 || bytes >= seen[i - 1]! - MIB)).toBe(true);
  expect(rd.partlyDone(dest)).toBe(false);
});

test("a part that fails, comes short or starts elsewhere is asked again; the file comes out whole", async () => {
  const dest = path.join(dir(), "b.mp4");
  trouble.set(2 * MIB, ["fail", "shifted"]);
  trouble.set(4 * MIB, ["short"]);
  await run(dest);
  expect(Buffer.from(fs.readFileSync(dest)).equals(Buffer.from(file))).toBe(true);
  expect(asked.filter((from) => from === 2 * MIB)).toHaveLength(3);
  expect(asked.filter((from) => from === 4 * MIB)).toHaveLength(2);
});

test("stopped part-way, it carries on with the parts left; a file that's gone starts over", async () => {
  const dest = path.join(dir(), "c.mp4");
  // Part 3 refused (Drive said no): the download stops, the parts done are noted.
  trouble.set(3 * MIB, ["refuse"]);
  await expect(run(dest)).rejects.toBeInstanceOf(rd.Refused);
  expect(rd.partlyDone(dest)).toBe(true);
  const before = asked.length;
  await run(dest);
  const again = asked.slice(before);
  expect(again).toContain(3 * MIB);
  expect(again.length).toBeLessThan(6);
  expect(Buffer.from(fs.readFileSync(dest)).equals(Buffer.from(file))).toBe(true);
  // Removed (as damaged) with its parts still noted: all of it again.
  fs.writeFileSync(`${dest}.parts`, JSON.stringify({ size: file.length, part: MIB, done: [0, 1, 2, 3, 4] }));
  fs.rmSync(dest);
  const from = asked.length;
  await run(dest);
  expect(asked.slice(from)).toHaveLength(6);
  expect(Buffer.from(fs.readFileSync(dest)).equals(Buffer.from(file))).toBe(true);
});
