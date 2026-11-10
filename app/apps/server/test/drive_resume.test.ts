// An upload to Drive a restart cut short carries on from its kept session
// (Sphe, Nov 10: an update goes through at any time): Drive is asked where the
// session is, and the file is never sent again whole, nor made twice.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import * as drive from "../src/drive.ts";
import * as jobs from "../src/jobs.ts";
import { Library } from "../src/library.ts";
import { fixtureHome, write } from "./helpers/home.ts";
import { MockServer, type Recorded } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({
    GOOGLE_DRIVE_CLIENT_ID: "id",
    GOOGLE_DRIVE_CLIENT_SECRET: "secret",
    GOOGLE_DOCS_REFRESH_TOKEN: "refresh",
    EDIT_SUBTITLES_FOLDER: undefined,
    EDIT_RENDER_FOLDER: undefined,
  });
  drive.timing.sleep = async () => {};
});

afterAll(() => {
  restore();
  mock.stop();
});

const SESSIONS = "/www.googleapis.com/upload/drive/v3/files";

/** A Drive that holds `have` bytes of session `id` (or all of it, done as `done`), and records what it's sent. */
function fakeDrive(id: string, have: { bytes?: number; done?: string; gone?: boolean }) {
  const seen = { asked: 0, sent: [] as Recorded[], started: [] as Recorded[], shared: [] as string[] };
  mock.on("POST", SESSIONS, (request, server) => {
    seen.started.push(request);
    return new Response(null, { status: 200, headers: { location: `${server.url}${SESSIONS}?uploadType=resumable&upload_id=new-${id}` } });
  });
  mock.on("PUT", SESSIONS, (request) => {
    const range = request.headers.get("content-range") ?? "";
    if (/^bytes \*\/\d+$/.test(range)) {
      seen.asked += 1;
      if (request.query.get("upload_id") !== id || have.gone === true) return Response.json({ error: { message: "gone" } }, { status: 404 });
      if (have.done !== undefined) return Response.json({ id: have.done }, { status: 200 });
      return new Response(null, { status: 308, headers: have.bytes === 0 ? {} : { range: `bytes=0-${have.bytes! - 1}` } });
    }
    seen.sent.push(request);
    return Response.json({ id: `file-${id}` });
  });
  mock.on("POST", /^\/www\.googleapis\.com\/drive\/v3\/files\/[^/]+\/permissions$/, (request) => {
    seen.shared.push(request.path.split("/")[5]!);
    return Response.json({ id: "anyone" });
  });
  return seen;
}

async function settled(events: Record<string, unknown>[]): Promise<Record<string, unknown>> {
  for (let i = 0; i < 400 && !events.some((event) => event.state !== "uploading"); i++) await Bun.sleep(25);
  return events.at(-1)!;
}

function setUp(name: string) {
  const fx = fixtureHome(name);
  const project = fx.app.store.create("Case (subtitles)", { width: 1920, height: 1080, fps: 30 }).project;
  const path = `${fx.dir}/case.mp4`;
  write(path, new Uint8Array(4096).map((_, i) => i % 251));
  const events: Record<string, unknown>[] = [];
  fx.app.store.subscribe((event) => {
    if (event.type === "drive") events.push(event);
  });
  /** The job a restart left: its session kept for this file as it is. */
  const cut = (id: string, over: Partial<drive.Session> = {}) =>
    jobs.begin(fx.app.store.home, "drive", project.id, {
      path,
      session: { uri: `${mock.url}${SESSIONS}?uploadType=resumable&upload_id=${id}`, size: 4096, mtime_ms: fs.statSync(path).mtimeMs, replacing: null, ...over },
    });
  return { ...fx, project, path, events, cut };
}

test("an upload cut part-way carries on from what Drive has, in the same session", async () => {
  const fx = setUp("drive-resume-part");
  try {
    const seen = fakeDrive("part", { bytes: 1024 });
    fx.cut("part");
    drive.start(fx.app.store, new Library(), fx.project, fx.path);
    expect((await settled(fx.events)).state).toBe("done");
    expect(seen.asked).toBe(1);
    // No new session, and only the bytes Drive didn't have.
    expect(seen.started.length).toBe(0);
    expect(seen.sent.length).toBe(1);
    expect(seen.sent[0]!.headers.get("content-range")).toBe("bytes 1024-4095/4096");
    expect(seen.sent[0]!.body).toEqual(fs.readFileSync(fx.path).subarray(1024));
    expect(fx.app.store.get(fx.project.id)!.project.drive?.file_id).toBe("file-part");
    // A first upload: shared by link once.
    expect(seen.shared).toEqual(["file-part"]);
    expect(jobs.list(fx.app.store.home, "drive")).toEqual([]);
  } finally {
    fx.cleanup();
  }
});

test("an upload Drive finished before the restart is linked from Drive's answer: nothing sent again, no second file", async () => {
  const fx = setUp("drive-resume-done");
  try {
    const seen = fakeDrive("done", { done: "file-first" });
    fx.cut("done");
    drive.start(fx.app.store, new Library(), fx.project, fx.path);
    expect((await settled(fx.events)).state).toBe("done");
    expect(seen.started.length).toBe(0);
    expect(seen.sent.length).toBe(0);
    expect(seen.shared).toEqual(["file-first"]);
    expect(fx.app.store.get(fx.project.id)!.project.drive?.file_id).toBe("file-first");
    expect(jobs.list(fx.app.store.home, "drive")).toEqual([]);
  } finally {
    fx.cleanup();
  }
});

test("a session Drive no longer has starts a new one, kept before a byte goes; one kept for another version of the file isn't asked", async () => {
  const fx = setUp("drive-resume-gone");
  try {
    const seen = fakeDrive("gone", { gone: true });
    fx.cut("gone");
    let keptWhileSending: unknown = null;
    mock.on("PUT", SESSIONS, (request) => {
      if (/^bytes \*\//.test(request.headers.get("content-range") ?? "")) return Response.json({}, { status: 404 });
      keptWhileSending = jobs.list(fx.app.store.home, "drive")[0]?.args.session;
      seen.sent.push(request);
      return Response.json({ id: "file-again" });
    });
    drive.start(fx.app.store, new Library(), fx.project, fx.path);
    expect((await settled(fx.events)).state).toBe("done");
    expect(seen.started.length).toBe(1);
    expect(seen.sent.at(-1)!.body.length).toBe(4096);
    expect(keptWhileSending).toMatchObject({ uri: `${mock.url}${SESSIONS}?uploadType=resumable&upload_id=new-gone`, size: 4096, replacing: null });

    // Exported again since (another mtime): its old session isn't this file's.
    mock.on("PATCH", `${SESSIONS}/file-again`, (_request, server) =>
      new Response(null, { status: 200, headers: { location: `${server.url}${SESSIONS}?uploadType=resumable&upload_id=patch` } }),
    );
    const asked = seen.asked;
    fx.cut("gone", { mtime_ms: 1 });
    fx.events.length = 0;
    drive.start(fx.app.store, new Library(), fx.app.store.get(fx.project.id)!.project, fx.path);
    expect((await settled(fx.events)).state).toBe("done");
    expect(seen.asked).toBe(asked);
    // The file it made before gets the new contents (same link), not a new file.
    expect(mock.calls(`${SESSIONS}/file-again`, "PATCH").length).toBe(1);
    expect(seen.started.length).toBe(1);
    expect(seen.sent.at(-1)!.body.length).toBe(4096);
  } finally {
    fx.cleanup();
  }
});

test("Drive's 308 says how much it has", () => {
  expect(drive.received("HTTP/1.1 308 Resume Incomplete\r\nRange: bytes=0-1023\r\ncontent-length: 0\r\n\r\n")).toBe(1024);
  expect(drive.received("HTTP/1.1 308 Resume Incomplete\r\ncontent-length: 0\r\n\r\n")).toBe(0);
});
