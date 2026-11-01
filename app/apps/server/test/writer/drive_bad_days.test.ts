// writer/drive.ts against a fake Drive on its bad days: busy, refusing, answering
// something else, dropping a download half-way, going quiet, and coming up short.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { kindOf } from "../../src/effect/service.ts";
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

const recording: drive.Recording = { id: "f1", name: "Interview.mp4", size: VIDEO.length, audio: false };

/** The bytes from a Range request's start, or all of them. */
const from = (request: Request) => Number(/bytes=(\d+)-/.exec(request.headers.get("range") ?? "")?.[1] ?? 0);
const media = (request: Request, body: ReadableStream<Uint8Array> | Uint8Array) =>
  new Response(body, { status: from(request) > 0 ? 206 : 200, headers: { "content-type": "video/mp4" } });

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
