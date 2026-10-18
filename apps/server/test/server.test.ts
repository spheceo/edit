import { expect, test } from "bun:test";

import * as fs from "node:fs";

import type { App } from "../src/app.ts";
import { ExportRegistry } from "../src/exports.ts";
import { parseRange } from "../src/http/files.ts";
import type { Router } from "../src/http/router.ts";
import { respond } from "../src/http/server.ts";
import { useNative, wrap, type ExportJob, type Native } from "../src/native/index.ts";
import { createStub } from "../src/native/stub.ts";
import { buildRouter, fileStamp, reserveUpload } from "../src/routes.ts";
import { bindAddresses, parseSocketAddr, showAddress } from "../src/serve.ts";
import { defaultExportPath } from "../src/server_seam.ts";
import { fixtureHome, scratch } from "./helpers/home.ts";

test("the router serves the API's routes", () => {
  const served = buildRouter().list();
  expect(served.length).toBeGreaterThan(70);
  for (const route of ["GET /api/health", "GET /api/projects/{id}", "PUT /api/projects/{id}", "POST /mcp", "POST /api/projects/{id}/cloud/open"]) {
    expect(served).toContain(route);
  }
});

test("concurrent_uploads_reserve_different_names", async () => {
  const { dir, cleanup } = scratch("upload-names");
  try {
    const [a, b] = await Promise.all([reserveUpload(dir, "clip.mp4"), reserveUpload(dir, "clip.mp4")]);
    expect(a).not.toBe(b);
    expect(fs.existsSync(a) && fs.existsSync(b)).toBe(true);
    expect([a, b].sort()).toEqual([`${dir}/clip-2.mp4`, `${dir}/clip.mp4`]);
    expect(await reserveUpload(dir, "noext")).toBe(`${dir}/noext`);
    expect(await reserveUpload(dir, "noext")).toBe(`${dir}/noext-2`);
  } finally {
    cleanup();
  }
});

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", "localhost:7700");
  return new Request(`http://localhost:7700${path}`, { ...init, headers });
}

function client(app: App, router: Router<App> = buildRouter()) {
  const send = async (path: string, init: RequestInit = {}) => (await respond(app, router, request(path, init), null))!;
  const jsonBody = (method: string, value: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  return { send, jsonBody };
}

test("projects: create, read, replace with a stale rev, delete; refusals as server.rs words them", async () => {
  const { app, cleanup } = fixtureHome("server-projects");
  try {
    const { send, jsonBody } = client(app);
    expect(await (await send("/api/health")).json()).toEqual({ machine: app.machine, name: "edit", version: expect.any(String) });
    const made = await send("/api/projects", jsonBody("POST", { name: "  Teen  ", width: 1080, height: 1920 }));
    const { rev, project } = (await made.json()) as { rev: number; project: { id: string; name: string; settings: unknown } };
    expect([rev, project.name, project.settings]).toEqual([1, "Teen", { width: 1080, height: 1920, fps: 30 }]);
    expect((await send("/api/projects", jsonBody("POST", { width: 2 }))).status).toBe(422);
    expect((await send("/api/projects", jsonBody("POST", { name: "x", style: "nope" }))).status).toBe(422);
    const listed = (await (await send("/api/projects")).json()) as { projects: { id: string }[] };
    expect(listed.projects.map((item) => item.id)).toContain(project.id);
    const got = (await (await send(`/api/projects/${project.id}`)).json()) as { rev: number; project: unknown };
    expect(got.rev).toBe(1);
    const renamed = { ...(got.project as object), name: "Renamed" };
    expect(await (await send(`/api/projects/${project.id}`, jsonBody("PUT", { base_rev: 1, project: renamed }))).json()).toEqual({ rev: 2 });
    const stale = await send(`/api/projects/${project.id}`, jsonBody("PUT", { base_rev: 1, project: renamed }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "conflict", rev: 2, project: { name: "Renamed" } });
    expect((await send(`/api/projects/nope`, jsonBody("PUT", { project: renamed }))).status).toBe(404);
    // Only what changed (patch.ts), against the revision it changes.
    const patch = { set: { name: "Patched" }, unset: [], lists: {} };
    expect(await (await send(`/api/projects/${project.id}`, jsonBody("PUT", { base_rev: 2, patch }))).json()).toEqual({ rev: 3 });
    expect(((await (await send(`/api/projects/${project.id}`)).json()) as { project: { name: string } }).project.name).toBe("Patched");
    const late = await send(`/api/projects/${project.id}`, jsonBody("PUT", { base_rev: 2, patch }));
    expect([late.status, ((await late.json()) as { rev: number }).rev]).toEqual([409, 3]);
    const misfit = { set: {}, unset: [], lists: { clips: { put: [{ no: "id" }], remove: [] } } };
    expect((await send(`/api/projects/${project.id}`, jsonBody("PUT", { base_rev: 3, patch: misfit }))).status).toBe(400);
    expect(await (await send(`/api/projects/nope`)).json()).toEqual({ error: "no such project" });
    const empty = await send(`/api/projects/${project.id}/import`, jsonBody("POST", { paths: [] }));
    expect([empty.status, await empty.json()]).toEqual([400, { error: "no paths" }]);
    expect(await (await send(`/api/projects/${project.id}`, { method: "DELETE" })).json()).toEqual({ ok: true });
    expect((await send(`/api/projects/${project.id}`, { method: "DELETE" })).status).toBe(404);
    // A package's routes are on the same server (WP4's voice-overs).
    const voice = await send("/api/voice");
    expect([voice.status, await voice.json()]).toEqual([200, { projects: [] }]);
  } finally {
    cleanup();
  }
});

const ffmpeg = Bun.which("ffmpeg");

test.skipIf(ffmpeg === null)("an upload streams to the project's media folder and is imported; refusals say why", async () => {
  const { dir, app, store, cleanup } = fixtureHome("server-upload");
  try {
    const sound = `${dir}/tone.wav`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=duration=1", sound]).exitCode).toBe(0);
    const bytes = fs.readFileSync(sound);
    const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    const { send } = client(app);
    const upload = (query: string, body: Uint8Array) => send(`/api/projects/${id}/upload?${query}`, { method: "POST", body });
    const ok = await upload(`name=${encodeURIComponent("../tone.wav")}&size=${bytes.length}`, bytes);
    const answer = (await ok.json()) as { rev: number; added: string[]; project: { media: { path: string; name: string }[] } };
    expect(ok.status).toBe(200);
    expect(answer.added.length).toBe(1);
    const path = answer.project.media[0]!.path;
    expect(path).toBe(`${fs.realpathSync(store.uploadsDir(id))}/tone.wav`);
    expect(fs.readFileSync(path).equals(bytes)).toBe(true);
    expect(fs.readdirSync(store.uploadsDir(id))).toEqual(["tone.wav"]);
    // The announced size is what's read.
    const short = await upload(`name=tone.wav&size=${bytes.length + 10}`, bytes);
    expect(await short.json()).toEqual({ error: `upload of tone.wav failed: received ${bytes.length} of ${bytes.length + 10} bytes` });
    expect(fs.readdirSync(store.uploadsDir(id))).toEqual(["tone.wav"]);
    expect(await (await upload("name=.hidden.wav", bytes)).json()).toEqual({ error: "invalid file name" });
    expect(await (await upload("name=notes.txt", bytes)).json()).toEqual({ error: "notes.txt is not a supported video or audio file" });
    const zero = await upload("name=a.wav&size=0", bytes);
    expect(zero.status).toBe(413);
    const missing = await send(`/api/projects/${id}/upload`, { method: "POST", body: bytes });
    expect([missing.status, await missing.text()]).toEqual([400, "Failed to deserialize query string: missing field `name`"]);
    // Its files: whole, and by range (the video element seeks with them).
    const media = answer.project.media[0]!;
    const mediaId = answer.added[0]!;
    // (The original until its preview is made; the stub makes a small one.)
    const whole = await send(`/api/projects/${id}/media/${mediaId}/audio`);
    const all = Buffer.from(await whole.arrayBuffer());
    expect([whole.status, whole.headers.get("cache-control"), Number(whole.headers.get("content-length"))]).toEqual([
      200,
      "no-cache",
      all.length,
    ]);
    const part = await send(`/api/projects/${id}/media/${mediaId}/audio`, { headers: { range: "bytes=4-11" } });
    expect([part.status, part.headers.get("content-range")]).toEqual([206, `bytes 4-11/${all.length}`]);
    expect(Buffer.from(await part.arrayBuffer()).equals(all.subarray(4, 12))).toBe(true);
    expect((await send(`/api/projects/${id}/media/${mediaId}/light`)).status).toBe(404);
    expect(await (await send(`/api/projects/${id}/media/${mediaId}/nope`)).json()).toEqual({ error: "unknown media file" });
    expect(await (await send(`/api/projects/${id}/media/none/audio`)).json()).toEqual({ error: "no such media" });
    expect(media.name).toBe("tone.wav");
    const statuses = (await (await send(`/api/projects/${id}/media-status`)).json()) as { media: Record<string, { stamps: unknown }> };
    const paths = app.media.paths(media.path);
    expect(statuses.media[mediaId]!.stamps).toEqual({ light: fileStamp(paths.light), preview: fileStamp(paths.proxyDone) });
  } finally {
    cleanup();
  }
});

test("byte ranges as ServeFile reads them", () => {
  expect(parseRange("bytes=0-99", 50)).toEqual([0, 49]);
  expect(parseRange("bytes=10-", 50)).toEqual([10, 49]);
  expect(parseRange("bytes=-5", 50)).toEqual([45, 49]);
  expect(parseRange("bytes=50-", 50)).toBe("unsatisfiable");
  expect(parseRange("bytes=0-1,4-5", 50)).toBe("unsatisfiable");
  expect(parseRange("items=0-1", 50)).toBeNull();
});

test("the file browser lists folders first, then media, without hidden files", async () => {
  const { dir, app, cleanup } = fixtureHome("server-fs");
  try {
    const folder = `${dir}/pick`;
    fs.mkdirSync(`${folder}/Zeta`, { recursive: true });
    fs.mkdirSync(`${folder}/alpha`);
    fs.writeFileSync(`${folder}/b.MP4`, "x");
    fs.writeFileSync(`${folder}/a.wav`, "xy");
    fs.writeFileSync(`${folder}/notes.txt`, "x");
    fs.writeFileSync(`${folder}/.secret.mp4`, "x");
    const { send } = client(app);
    const listed = (await (await send(`/api/fs?path=${encodeURIComponent(folder)}`)).json()) as {
      path: string;
      parent: string;
      entries: { name: string; dir: boolean; size: number }[];
      places: { name: string }[];
    };
    expect(listed.path).toBe(folder);
    expect(listed.parent).toBe(dir);
    expect(listed.entries.map((entry) => [entry.name, entry.dir])).toEqual([
      ["alpha", true],
      ["Zeta", true],
      ["a.wav", false],
      ["b.MP4", false],
    ]);
    expect(listed.places.at(-1)!.name).toBe("Home");
    expect(await (await send(`/api/fs?path=${encodeURIComponent(`${dir}/none`)}`)).json()).toEqual({ error: "folder not found" });
  } finally {
    cleanup();
  }
});

test("frames: a frame must be a number, and max a u32", async () => {
  const { app, store, cleanup } = fixtureHome("server-frame");
  try {
    const id = store.create("p", { width: 64, height: 36, fps: 30 }).project.id;
    const { send } = client(app);
    expect(await (await send(`/api/projects/${id}/frame/x.png`)).json()).toEqual({ error: "frame must be a number" });
    const max = await send(`/api/projects/${id}/frame/1.png?max=-1`);
    expect([max.status, await max.text()]).toEqual([400, "Failed to deserialize query string: invalid digit found in string"]);
    // The stub renders nothing: that's the renderer's failure, a 500 with its words.
    expect((await send(`/api/projects/${id}/frame/1.png`)).status).toBe(500);
  } finally {
    cleanup();
  }
});

/** A stand-in addon whose export writes a small file after `delay` ms (or waits to be cancelled). */
function exportingNative(delay: number): Native {
  const stub = createStub();
  return wrap({
    ...stub,
    exportPlan: () => ({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 }),
    ExportJob: {
      start(job, onProgress): ExportJob {
        let cancelled = false;
        let stop = () => {};
        const stopped = new Promise<void>((resolve) => {
          stop = resolve;
        });
        const done = (async () => {
          onProgress(0.5);
          await Promise.race([Bun.sleep(delay), stopped]);
          if (cancelled) throw new Error("cancelled");
          fs.writeFileSync(job.output, "exported");
          return { seconds: delay / 1000, bytes: 8 };
        })();
        return {
          cancel: () => {
            cancelled = true;
            stop();
          },
          wait: () => done,
        };
      },
    },
  } as Native);
}

test("an export runs one at a time, tells clients how it goes, and only its file is handed out", async () => {
  const { dir, app, store, cleanup } = fixtureHome("server-export", { services: { exports: new ExportRegistry() } });
  const before = useNative(exportingNative(50));
  try {
    const id = store.create("Teen: the edit?", { width: 64, height: 36, fps: 30 }).project.id;
    const events: Record<string, unknown>[] = [];
    store.subscribe((event) => {
      if (event.type === "export") events.push(event);
    });
    const { send, jsonBody } = client(app);
    const output = `${dir}/out/teen`;
    const started = await send(`/api/projects/${id}/export`, jsonBody("POST", { path: output, options: { format: "h264" } }));
    const { path } = (await started.json()) as { path: string };
    expect(path).toBe(`${fs.realpathSync(dir)}/out/teen.mp4`);
    const second = await send(`/api/projects/${id}/export`, jsonBody("POST", { path: output }));
    expect(await second.json()).toEqual({
      error: "an export is already running; wait for it or cancel it before starting another",
    });
    const busy = await send("/api/update", { method: "POST" });
    expect([busy.status, await busy.json()]).toEqual([409, { error: "an export or Drive upload is running; update when it's done" }]);
    expect((await send(`/api/exports/file?path=${encodeURIComponent(path)}`)).status).toBe(404);
    while (app.exports.running()) await Bun.sleep(10);
    expect(events.map((event) => event.state)).toEqual(["running", "running", "done"]);
    expect(events.at(-1)).toMatchObject({ id, path, progress: 1, bytes: 8, drive: false });
    const file = await send(`/api/exports/file?path=${encodeURIComponent(path)}`);
    expect([file.status, file.headers.get("content-disposition"), await file.text()]).toEqual([
      200,
      'attachment; filename="teen.mp4"',
      "exported",
    ]);
    // Cancelled: said so, and the file isn't one to hand out.
    useNative(exportingNative(5000));
    const other = (await (await send(`/api/projects/${id}/export`, jsonBody("POST", { path: `${dir}/b.mp4` }))).json()) as { path: string };
    expect(await (await send(`/api/projects/${id}/export/cancel`, { method: "POST" })).json()).toEqual({ cancelled: true });
    while (app.exports.running()) await Bun.sleep(10);
    expect(events.at(-1)).toMatchObject({ state: "cancelled", error: "cancelled" });
    expect(app.exports.exported(other.path)).toBe(false);
    expect(await (await send(`/api/projects/${id}/export/cancel`, { method: "POST" })).json()).toEqual({ cancelled: false });
    // The default name: the project's, made safe, in the exports folder.
    const project = store.get(id)!.project;
    expect(defaultExportPath(store, project)).toBe(`${store.layout().exportsDir()}/Teen_ the edit_.mp4`);
  } finally {
    useNative(before);
    cleanup();
  }
});

test("addresses parse as Rust's SocketAddr and show the same", () => {
  expect(bindAddresses("0.0.0.0", 7700).map(showAddress)).toEqual(["0.0.0.0:7700"]);
  expect(bindAddresses("[::1]", 7700).map(showAddress)).toEqual(["[::1]:7700"]);
  // A host name isn't an address: nothing to listen on.
  expect(bindAddresses("localhost", 7700)).toEqual([]);
  expect(bindAddresses(null, 7799, "100.64.0.1").map(showAddress)).toEqual(["127.0.0.1:7799", "100.64.0.1:7799"]);
  expect(parseSocketAddr("256.1.1.1:80")).toBeNull();
  expect(parseSocketAddr("::1:80")).toBeNull();
});

test("a file's stamp is its length and modification time in hex", () => {
  const { dir, cleanup } = scratch("stamp");
  try {
    fs.writeFileSync(`${dir}/f`, "x".repeat(255));
    fs.utimesSync(`${dir}/f`, 1_700_000_000, 1_700_000_000.5);
    expect(fileStamp(`${dir}/f`)).toBe(`ff-${(1_700_000_000_500).toString(16)}`);
    expect(fileStamp(`${dir}/none`)).toBeNull();
  } finally {
    cleanup();
  }
});
