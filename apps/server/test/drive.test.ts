// drive.ts's tests, and an upload against the mock Drive.

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as drive from "../src/drive.ts";
import { answerExists, bodyOf, location, mime, percent, uploadName, viewUrl, wanted } from "../src/drive.ts";
import { Library } from "../src/library.ts";
import type { ExportOptions, Plan, Project } from "../src/model.ts";
import { duration } from "../src/project.ts";
import { fixtureHome, write } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

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

test("names_and_links", () => {
  expect(uploadName("Teen Hit-And-Run (subtitles)", "mp4")).toBe("Teen Hit-And-Run.mp4");
  expect(uploadName("  Case  ", "mov")).toBe("Case.mov");
  expect(uploadName("(subtitles)", "mp4")).toBe("Edit.mp4");
  expect(viewUrl("abc")).toBe("https://drive.google.com/file/d/abc/view");
  expect(mime("a.MOV")).toBe("video/quicktime");
  expect(mime("a.mp4")).toBe("video/mp4");
});

test("reads_curl_progress", () => {
  expect(percent("######                      45.0%")).toBe(Math.fround(Math.fround(45) / 100));
  expect(percent("##########################################  100.0%")).toBe(1.0);
  expect(percent("curl: (56) Recv failure")).toBeNull();
  expect(percent("")).toBeNull();
});

test("finds_the_upload_session", () => {
  const answer =
    "HTTP/2 200\r\nx-guploader-uploadid: abc\r\nLocation: https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=xyz\r\ncontent-length: 0\r\n\r\n";
  const before = process.env.EDIT_GOOGLE_API_URL;
  delete process.env.EDIT_GOOGLE_API_URL;
  try {
    expect(location(answer)).toBe("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=xyz");
    expect(location("HTTP/2 200\r\nlocation: https://evil.example/\r\n\r\n")).toBeNull();
  } finally {
    process.env.EDIT_GOOGLE_API_URL = before;
  }
  expect(bodyOf('HTTP/2 404\r\na: b\r\n\r\n{"error":{}}')).toBe('{"error":{}}');
});

test("tells_whether_a_file_is_still_there", () => {
  expect(answerExists(200, '{"trashed":false}')).toBe(true);
  expect(answerExists(200, '{"trashed":true}')).toBe(false);
  expect(answerExists(404, "")).toBe(false);
  expect(() => answerExists(401, "")).toThrow();
  expect(() => answerExists(500, "")).toThrow();
});

const OPTIONS: ExportOptions = {
  format: "h264",
  range: null,
  shape: "original",
  fill: "blur",
  size: null,
  fps: null,
  quality: "high",
  target_mb: null,
  loudness: null,
  hardware: true,
  wait_for_smoothing: false,
  audio: true,
  chapters: [],
};

test("uploads_whole_videos_only", () => {
  const plan = (start: number, end: number): Plan => ({ start, end, width: 1920, height: 1080, audio: true });
  const { app, cleanup } = fixtureHome("drive-wanted");
  try {
    const project = structuredClone(app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project) as Project;
    project.media.push({ id: "m", name: "bodycam", path: "/tmp/bodycam.mp4", kind: "video", duration: 10, width: 1920, height: 1080, fps: 30, has_audio: false });
    const track = project.tracks[0]!.id;
    project.clips.push({
      id: "c1",
      track,
      start: 0,
      duration: 300,
      color: "blue",
      name: "bodycam",
      fade_in: 0,
      fade_out: 0,
      type: "video",
      media: "m",
      source_in: 0,
      speed: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      opacity: 1,
    });
    const whole = plan(0, duration(project));
    // A normal edit stays off Drive (downloaded from Edit instead).
    expect(wanted(project, OPTIONS, whole)).toBe(false);
    // A subtitled video goes to Subtitles.
    project.clips.push({ id: "c2", track, start: 0, duration: 300, color: "blue", name: "Subtitle · Hands up", fade_in: 0, fade_out: 0, type: "solid", fill: [0, 0, 0, 1] } as never);
    expect(wanted(project, OPTIONS, whole)).toBe(true);
    // Part of it, or not a video file: no.
    expect(wanted(project, OPTIONS, plan(30, duration(project)))).toBe(false);
    expect(wanted(project, OPTIONS, plan(0, 100))).toBe(false);
    expect(wanted(project, { ...OPTIONS, format: "gif" }, whole)).toBe(false);
    expect(wanted(project, { ...OPTIONS, format: "prores" }, whole)).toBe(true);
  } finally {
    cleanup();
  }
});

test.skipIf(process.env.EDIT_DRIVE_LIVE === undefined)("uploads_to_drive", () => {
  // Live (Rust: #[ignore]): uploads to the real Subtitles folder and deletes the file again.
  // Never run against Drive here; the mock test below covers the protocol.
});

test("an export goes up through a resumable session, is shared by link and linked to the project", async () => {
  const { app, cleanup, dir } = fixtureHome("drive-upload");
  try {
    const project = app.store.create("Case (subtitles)", { width: 1920, height: 1080, fps: 30 }).project;
    const path = `${dir}/case.mp4`;
    write(path, new Uint8Array(4096).fill(7));
    let session: { metadata: unknown; headers: Headers } | null = null;
    mock.on("POST", "/www.googleapis.com/upload/drive/v3/files", (request, server) => {
      session = { metadata: request.json(), headers: request.headers };
      return new Response(null, {
        status: 200,
        headers: { location: `${server.url}/www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=xyz` },
      });
    });
    // A busy Drive the first time: the file is sent again.
    mock.on("PUT", "/www.googleapis.com/upload/drive/v3/files", () => Response.json({ id: "file1" }));
    mock.on("PUT", "/www.googleapis.com/upload/drive/v3/files", () => new Response("busy", { status: 503 }), 1);
    mock.on("POST", "/www.googleapis.com/drive/v3/files/file1/permissions", () => Response.json({ id: "anyone" }));
    const events: Record<string, unknown>[] = [];
    app.store.subscribe((event) => {
      if (event.type === "drive") events.push(event);
    });
    drive.start(app.store, new Library(), project, path);
    expect(drive.uploading()).toBe(true);
    for (let i = 0; i < 200 && !events.some((event) => event.state !== "uploading"); i++) await Bun.sleep(25);
    const last = events.at(-1)!;
    expect(last).toEqual({ id: project.id, name: "Case.mp4", progress: 1, state: "done", type: "drive", url: "https://drive.google.com/file/d/file1/view" });
    // Not a subtitled video (no subtitles yet): to Render.
    expect(session!.metadata).toEqual({ name: "Case.mp4", parents: ["15Fp5Zq_RKwYRohpE5t_uEho8T2Q1RwwL"] });
    expect(session!.headers.get("x-upload-content-length")).toBe("4096");
    expect(mock.calls("/www.googleapis.com/upload/drive/v3/files", "PUT").at(-1)!.body.length).toBe(4096);
    const linked = app.store.get(project.id)!.project.drive!;
    expect(linked.file_id).toBe("file1");
    expect(linked.name).toBe("Case.mp4");
    expect(drive.uploading()).toBe(false);
    // Just uploaded: answered without asking Drive.
    expect((await drive.checked(app.store, new Library(), project.id))?.file_id).toBe("file1");
    // Gone from Drive later: the link is cleared.
    drive.forget();
    mock.on("GET", "/www.googleapis.com/drive/v3/files/file1", () => Response.json({ trashed: true }));
    expect(await drive.checked(app.store, new Library(), project.id)).toBeNull();
    expect(app.store.get(project.id)!.project.drive ?? null).toBeNull();
  } finally {
    cleanup();
  }
});
