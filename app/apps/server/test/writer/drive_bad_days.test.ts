// writer/drive.ts against a fake Drive on its bad days: busy, refusing, answering
// something else, dropping a download half-way, going quiet, and coming up short.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { kindOf } from "../../src/effect/service.ts";
import { ranged } from "../../src/ranged_download.ts";
import * as drive from "../../src/writer/drive.ts";

const VIDEO = Buffer.alloc(200_000, 7);
let handler: (request: Request, n: number) => Response | Promise<Response> = () => new Response("not set", { status: 500 });
let seen: Request[] = [];
let server: ReturnType<typeof Bun.serve>;
let dir: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, idleTimeout: 30, fetch: (request) => (seen.push(request), handler(request, seen.length)) });
  process.env.EDIT_GOOGLE_API_URL = `http://127.0.0.1:${server.port}`;
  drive.timing.instant = true;
  dir = fs.mkdtempSync(join(os.tmpdir(), "edit-drive-"));
});
afterEach(() => {
  seen = [];
  drive.STALL_MS.value = 60_000;
});
afterAll(() => {
  delete process.env.EDIT_GOOGLE_API_URL;
  drive.timing.instant = false;
  void server.stop(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

const FOLDER = { kind: "folder", id: "1AbCdEfGhIjKlMnOpQrStUvWxYz" } as const;
const listing = (request: Request) =>
  new URL(request.url).searchParams.has("q")
    ? Response.json({ files: [{ id: "f1", name: "Interview.mp4", mimeType: "video/mp4", size: String(VIDEO.length), md5Checksum: "a" }] })
    : Response.json({ name: "Case folder" });

test("Drive busy (503, then 429 with a Retry-After) is asked again; the folder's recordings come back", async () => {
  handler = (request, n) => (n === 1 ? new Response("down", { status: 503 }) : n === 2 ? new Response("busy", { status: 429, headers: { "retry-after": "0" } }) : listing(request));
  const [title, found] = await drive.recordings("token", FOLDER);
  expect(title).toBe("Case folder");
  expect(found.map((one) => one.name)).toEqual(["Interview.mp4"]);
  expect(seen.length).toBe(4);
});

test("a folder not shared with the team's account is said at once, for someone to share", async () => {
  handler = () => new Response("not found", { status: 404 });
  const failed = await drive.recordings("token", FOLDER).catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(drive.DriveNotShared);
  expect((failed as Error).message).toContain("Share it with that account");
  expect(kindOf(failed)).toBe("later");
  expect(seen.length).toBe(1);
});

test("an answer that isn't Drive's is said at once, not read as an empty folder", async () => {
  handler = (request) => (new URL(request.url).searchParams.has("q") ? Response.json({ files: "nothing" }) : Response.json({ name: "Case" }));
  const failed = await drive.recordings("token", FOLDER).catch((error: unknown) => error);
  expect((failed as { _tag: string })._tag).toBe("AnswerInvalid");
  expect(kindOf(failed)).toBe("permanent");
  expect(seen.length).toBe(2);
});

const recording: drive.Recording = { id: "f1", name: "Interview.mp4", size: VIDEO.length, audio: false, md5: null };

/** The bytes from a Range request's start, or all of them. */
const from = (request: Request) => Number(/bytes=(\d+)-/.exec(request.headers.get("range") ?? "")?.[1] ?? 0);
/** As Drive answers: a range with its Content-Range (`at`: where it says it starts, if not where it was asked). */
const media = (request: Request, body: ReadableStream<Uint8Array> | Uint8Array, at = from(request)) =>
  new Response(body, { status: from(request) > 0 ? 206 : 200, headers: { "content-type": "video/mp4", ...(from(request) > 0 ? { "content-range": `bytes ${at}-${VIDEO.length - 1}/${VIDEO.length}` } : {}) } });

test("a download whose connection closes half-way carries on from where it got to", async () => {
  // 80 kB of 200 kB, then the answer ends: no error, just a connection closed early.
  handler = (request, n) => media(request, n === 1 ? VIDEO.subarray(0, 80_000) : VIDEO.subarray(from(request)));
  const dest = join(dir, "dropped.mp4");
  await drive.download("token", recording, dest);
  expect(Buffer.compare(fs.readFileSync(dest), VIDEO)).toBe(0);
  expect(seen.length).toBe(2);
  expect(from(seen[1]!)).toBe(80_000);
});

test("a download that goes quiet is abandoned and carried on from its bytes", async () => {
  drive.STALL_MS.value = 300;
  handler = (request, n) =>
    media(
      request,
      n === 1
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(VIDEO.subarray(0, 50_000));
              // Then nothing, for ever.
            },
          })
        : VIDEO.subarray(from(request)),
    );
  const dest = join(dir, "quiet.mp4");
  await drive.download("token", recording, dest);
  expect(Buffer.compare(fs.readFileSync(dest), VIDEO)).toBe(0);
  expect(from(seen[1]!)).toBe(50_000);
}, 30_000);

test("a download Drive won't give is said at once; one that keeps coming up short is short, and Try again can carry it on", async () => {
  handler = () => new Response("no", { status: 403 });
  const refused = await drive.download("token", recording, join(dir, "refused.mp4")).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(drive.DriveNotShared);
  expect(seen.length).toBe(1);

  seen = [];
  handler = () => new Response("down", { status: 503 });
  const short = await drive.download("token", recording, join(dir, "short.mp4")).catch((error: unknown) => error);
  expect(short).toBeInstanceOf(drive.DownloadShort);
  expect((short as Error).message).toContain("came down short");
  expect(kindOf(short)).toBe("temporary");
  // Five tries in all: the first and four more.
  expect(seen.length).toBe(5);
});

// Nov 1, Mathias's Mac: a 5.3 GB recording's copy was the right size but damaged
// (FFmpeg read it as thousands of "Invalid NAL unit size"), and every retry used
// it again. A download is now proven to be Drive's file: its MD5, once.

const MD5 = new Bun.CryptoHasher("md5").update(VIDEO).digest("hex");
const checked: drive.Recording = { ...recording, md5: MD5 };

test("a range Drive answers from anywhere but where the file stops is never appended: the file starts over", async () => {
  handler = (request, n) => (n === 1 ? media(request, VIDEO.subarray(0, 80_000)) : n === 2 ? media(request, VIDEO.subarray(40_000), 40_000) : media(request, VIDEO.subarray(from(request))));
  const dest = join(dir, "misplaced.mp4");
  await drive.download("token", checked, dest);
  expect(Buffer.compare(fs.readFileSync(dest), VIDEO)).toBe(0);
  expect(drive.rangeStart("bytes 40000-199999/200000")).toBe(40_000);
  expect(drive.rangeStart(null)).toBeNull();
});

test("a whole download that isn't Drive's file is fetched again from scratch; damaged twice, it's said and removed", async () => {
  const damaged = Buffer.from(VIDEO);
  damaged[100_000] = 9;
  handler = (request, n) => media(request, n === 1 ? damaged : VIDEO);
  const dest = join(dir, "damaged.mp4");
  await drive.download("token", checked, dest);
  expect(Buffer.compare(fs.readFileSync(dest), VIDEO)).toBe(0);
  expect(fs.readFileSync(`${dest}.verified`, "utf8")).toBe(`${VIDEO.length} ${MD5}`);

  seen = [];
  handler = (request) => media(request, damaged);
  const twice = join(dir, "twice.mp4");
  const failed = await drive.download("token", checked, twice).catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(drive.DownloadCorrupt);
  expect(kindOf(failed)).toBe("temporary");
  expect(fs.existsSync(twice)).toBe(false);
});

test("a copy already here of the right size is used only if it's Drive's file; Drive's MD5 is asked when the manifest has none", async () => {
  const dest = join(dir, "kept.mp4");
  const damaged = Buffer.from(VIDEO);
  damaged[5] = 1;
  fs.writeFileSync(dest, damaged);
  const asked: string[] = [];
  handler = (request) => (asked.push(new URL(request.url).searchParams.get("fields") ?? ""), Response.json({ md5Checksum: MD5 }));
  const unknown: drive.Recording = { id: "f1", name: "Interview.mp4", size: VIDEO.length, audio: false };
  expect(await drive.intact("token", unknown, dest)).toBe(false);
  expect(asked).toEqual(["md5Checksum"]);
  fs.writeFileSync(dest, VIDEO);
  expect(await drive.intact("token", unknown, dest)).toBe(true);
  // Proven once: not read through again.
  seen = [];
  expect(await drive.intact("token", checked, dest)).toBe(true);
  expect(seen.length).toBe(0);
  // Drive keeping no MD5: the size is all there is.
  expect(await drive.intact("token", recording, join(dir, "missing.mp4"))).toBe(false);
});

test("a big recording comes down in parts at once, a failed part asked again, and is checked against Drive's MD5", async () => {
  const was = { ...ranged };
  Object.assign(ranged, { from: 100_000, part: 30_000, parallel: 3, sleep: async () => {} });
  try {
    const md5 = createHash("md5").update(VIDEO).digest("base64");
    let failedOnce = false;
    handler = (request) => {
      const url = new URL(request.url);
      // Drive's MD5, asked once it's all down.
      if (!url.searchParams.has("alt")) return Response.json({ md5Checksum: Buffer.from(md5, "base64").toString("hex") });
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(request.headers.get("range") ?? "")!;
      if (Number(a) === 60_000 && !failedOnce) {
        failedOnce = true;
        return new Response("busy", { status: 503 });
      }
      const end = Math.min(Number(b), VIDEO.length - 1);
      return new Response(VIDEO.subarray(Number(a), end + 1), { status: 206, headers: { "content-range": `bytes ${a}-${end}/${VIDEO.length}` } });
    };
    const dest = join(dir, "parted.mp4");
    await drive.download("token", recording, dest);
    expect(Buffer.compare(fs.readFileSync(dest), VIDEO)).toBe(0);
    const parts = seen.filter((request) => new URL(request.url).searchParams.has("alt"));
    // Seven parts of 30 kB, the one at 60 kB twice.
    expect(parts.length).toBe(8);
    expect(parts.every((request) => request.headers.get("authorization") === "Bearer token")).toBe(true);
    expect(fs.existsSync(`${dest}.parts`)).toBe(false);
  } finally {
    Object.assign(ranged, was);
  }
});
