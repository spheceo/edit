import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { archiveExportFile, archiveFinished, deleteExport, dropKept, exportCloud, ExportRegistry, holdExport, listExports, restorePrevious, resumeSnapshot, stall, withExport } from "../src/exports.ts";
import type { Project } from "../src/model.ts";
import * as capacity from "../src/export_capacity.ts";
import * as seams from "../src/seams.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";

test("local exports queue across projects, preserve snapshots and advance after failure or queued cancellation", async () => {
  // One at a time, whatever Mac runs the tests (export_capacity.ts lets a big one run more).
  const most = process.env.EDIT_LOCAL_EXPORTS;
  process.env.EDIT_LOCAL_EXPORTS = "1";
  const { dir, home, store, app, native, cleanup } = fixtureHome("queued-exports");
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const started: { name: string; quality: string }[] = [];
  const releases = new Map<string, () => void>();
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const render = spyOn(native.ExportJob, "start").mockImplementation((job) => {
    const name = JSON.parse(job.project.json).name as string;
    started.push({ name, quality: job.options.quality });
    let cancel = false;
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    releases.set(name, release);
    return { cancel: () => { cancel = true; release(); }, wait: async () => { await wait; if (cancel) throw new Error("cancelled"); if (name === "first") throw new Error("Fixture encoder failed"); fs.writeFileSync(job.output, "export"); return { seconds: 1, bytes: 6 }; } };
  });
  try {
    const projects: Project[] = [];
    for (const name of ["first", "cancelled", "third"]) {
      const id = store.create(name, { width: 64, height: 36, fps: 30 }).project.id;
      await store.update(id, "test", p => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
      projects.push(structuredClone(store.get(id)!.project));
    }
    const options = native.exportDefaults();
    for (const project of projects) await registry.start(store, app.library, project, options, `${dir}/${project.name}.mp4`, { drive: false, keepLocal: true });
    expect(started.map(one => one.name)).toEqual(["first"]);
    expect(registry.activity().map(one => [one.name, one.state]).sort()).toEqual([["cancelled", "queued"], ["first", "running"], ["third", "queued"]]);
    const third = projects[2]!;
    await store.update(third.id, "test", p => { p.name = "edited while exporting"; });
    third.name = "mutated caller draft";
    const quality = options.quality;
    options.quality = quality === "small" ? "high" : "small";
    expect(JSON.parse(fs.readFileSync(`${home}/jobs/export-${third.id}.json`, "utf8")).name).toBe("third");
    expect(resumeSnapshot(home, third.id, { snapshot: `${home}/jobs/export-${third.id}.json` })?.name).toBe("third");
    expect(registry.cancel(projects[1]!.id)).toBe(true);
    expect(registry.activity().find(one => one.id === projects[1]!.id)?.state).toBe("cancelled");
    expect(fs.existsSync(`${home}/jobs/export-${projects[1]!.id}.json`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${home}/jobs.json`, "utf8")).some((job: { project: string }) => job.project === projects[1]!.id)).toBe(false);
    releases.get("first")!();
    for (let tries = 0; !releases.has("third") && tries < 100; tries++) await Bun.sleep(1);
    expect(started).toEqual([{ name: "first", quality }, { name: "third", quality }]);
    expect(registry.activity().find(one => one.id === projects[0]!.id)).toMatchObject({ state: "failed", error: "Fixture encoder failed" });
    releases.get("third")!();
    for (let tries = 0; registry.running() && tries < 100; tries++) await Bun.sleep(1);
    expect(registry.running()).toBe(false);
    expect(registry.activity().find(one => one.id === third.id)?.state).toBe("done");
    expect(fs.existsSync(`${home}/jobs/export-${third.id}.json`)).toBe(false);
    // A failed or cancelled export can be run again with the settings it was started with. A finished one cannot.
    expect(registry.replay(third.id)).toBeNull();
    expect(registry.replay(projects[0]!.id)?.options.quality).toBe(quality);
    const cancelled = projects[1]!;
    const again = registry.replay(cancelled.id);
    expect(again).toMatchObject({ output: registry.activity().find((one) => one.id === cancelled.id)?.path, extra: { drive: false, keepLocal: true } });
    await registry.start(store, app.library, store.get(cancelled.id)!.project, again!.options, again!.output, again!.extra);
    for (let tries = 0; !releases.has("cancelled") && tries < 100; tries++) await Bun.sleep(1);
    expect(registry.activity().find((one) => one.id === cancelled.id)?.state).toBe("running");
    expect(registry.replay(cancelled.id)).toBeNull();
    releases.get("cancelled")!();
    for (let tries = 0; registry.running() && tries < 100; tries++) await Bun.sleep(1);
  } finally {
    if (most === undefined) delete process.env.EDIT_LOCAL_EXPORTS;
    else process.env.EDIT_LOCAL_EXPORTS = most;
    for (const release of releases.values()) release();
    render.mockRestore(); archive.mockRestore(); plan.mockRestore(); cleanup();
  }
});

test("a project's exports stay listed across restarts and only a listed one is deleted", () => {
  const home = fs.mkdtempSync(`${os.tmpdir()}/edit-exports-`);
  try {
    const one = `${home}/One.mp4`;
    const two = `${home}/Two.mp4`;
    fs.writeFileSync(one, "a");
    fs.writeFileSync(two, "b");
    const record = (path: string, at: number) => ({ path, name: path.split("/").pop()!, finished_ms: at, seconds: 60, bytes: 1, frames: 900, whole: true, format: "h264" });
    fs.writeFileSync(`${home}/exports.json`, JSON.stringify({ p1: [record(one, 1), record(two, 2)] }));
    // Newest first; a fresh registry (a restart) still hands them out.
    expect(listExports(home, "p1").map((one) => [one.name, one.missing])).toEqual([
      ["Two.mp4", false],
      ["One.mp4", false],
    ]);
    expect(new ExportRegistry(home).exported(two)).toBe(true);
    expect(new ExportRegistry(home).exported(`${home}/exports.json`)).toBe(false);
    // Another project's, or a file that isn't an export: refused, nothing deleted.
    expect(() => deleteExport(home, "p2", one)).toThrow("not one of this project's exports");
    expect(() => deleteExport(home, "p1", `${home}/exports.json`)).toThrow("not one of this project's exports");
    expect(fs.existsSync(one)).toBe(true);
    deleteExport(home, "p1", one);
    expect(fs.existsSync(one)).toBe(false);
    expect(listExports(home, "p1").map((one) => one.name)).toEqual(["Two.mp4"]);
    // A file gone by hand shows as missing.
    fs.rmSync(two);
    expect(listExports(home, "p1")[0]!.missing).toBe(true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a first export with every frame new records this Mac's speed", async () => {
  const { dir, home, store, app, native, cleanup } = fixtureHome("mac-first-exports");
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 1800, width: 64, height: 36, audio: true }, fps: 30 });
  const render = spyOn(native.ExportJob, "start").mockImplementation((job) => ({
    cancel: () => {},
    wait: async () => { await Bun.sleep(20); fs.writeFileSync(job.output, "export"); return { seconds: 1, bytes: 6 }; },
  }));
  try {
    const project = store.create("free", { width: 64, height: 36, fps: 30 }).project;
    await store.update(project.id, "test", p => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 1800, type: "solid" })));
    await registry.start(store, app.library, store.get(project.id)!.project, native.exportDefaults(), `${dir}/free.mp4`);
    for (let tries = 0; registry.running() && tries < 200; tries++) await Bun.sleep(5);
    expect(render).toHaveBeenCalledTimes(1);
    // Every frame new on this Mac: a speed sample.
    const [record] = listExports(home, project.id);
    expect(record!.fresh_fps).toBeGreaterThan(0);
    expect(record!.subtitles).toBe(false);
  } finally {
    render.mockRestore(); plan.mockRestore(); archive.mockRestore(); cleanup();
  }
});

test("archiveExportFile deletes locally only after a size-verified upload", async () => {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/edit-archive-`);
  try {
    const file = `${dir}/Out.mp4`;
    fs.writeFileSync(file, Buffer.alloc(50));
    const io = (size: number | null) => ({ enabled: () => true, upload: async () => {}, head: async () => (size === null ? null : { size }) });
    expect(await archiveExportFile(file, "edit/exports/p/Out.mp4", io(51), () => 0)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    expect(await archiveExportFile(file, "edit/exports/p/Out.mp4", io(null), () => 0)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    // Room to spare: archived and kept, for the next re-export's chunks.
    expect(await archiveExportFile(file, "edit/exports/p/Out.mp4", io(50), () => 100e9)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    // Under 60 GB but over 20 GB free (Sphe's M1, 26 GB): the newest stays too.
    expect(await archiveExportFile(file, "edit/exports/p/Out.mp4", io(50), () => 26e9)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    // A share reading it: archived, and the copy stays until it's done.
    const release = holdExport(file);
    expect(await archiveExportFile(file, "edit/exports/p/Out.mp4", io(50), () => 0)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    // Gone once the share is done with it.
    release();
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, Buffer.alloc(50));
    expect(await archiveExportFile(file, "edit/exports/p/Out.mp4", io(50), () => 0)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a re-export fetches the archived last export back, so its unchanged chunks are reused", async () => {
  const home = fs.mkdtempSync(`${os.tmpdir()}/edit-restore-`);
  try {
    const cache = `${home}/cache`;
    const output = `${home}/Movies/Out.mp4`;
    fs.mkdirSync(`${cache}/export-chunks/p1-2`, { recursive: true });
    const manifest = `${cache}/export-chunks/p1-2/manifest-v1.json`;
    fs.writeFileSync(manifest, JSON.stringify({ version: 1, output, size: 50, fps: 30, chunks: [], sound: null }).replace('"fps"', '"modified_ns":1793238703930730021,"fps"'));
    fs.writeFileSync(`${home}/exports.json`, JSON.stringify({ "p1-2": [{ path: output, name: "Out.mp4", finished_ms: 1, seconds: 1, bytes: 50, frames: 30, whole: true, start: 0, format: "h264", timeline: "t", cloudKey: "edit/exports/p1-2/Out.mp4" }] }));
    const fetched: string[] = [];
    const fetch = async (key: string, dest: string) => { fetched.push(key); fs.writeFileSync(dest, Buffer.alloc(50)); };
    expect(await restorePrevious(cache, home, "p1-2", fetch)).toBe(output);
    expect(fetched).toEqual(["edit/exports/p1-2/Out.mp4"]);
    // The manifest has the fetched copy's own time, to the nanosecond.
    const ns = fs.statSync(output, { bigint: true }).mtimeNs.toString();
    expect(fs.readFileSync(manifest, "utf8")).toContain(`"modified_ns":${ns}`);
    // Already here: nothing to fetch.
    expect(await restorePrevious(cache, home, "p1-2", fetch)).toBeNull();
    // A copy of another size isn't the export: not kept.
    fs.rmSync(output);
    expect(await restorePrevious(cache, home, "p1-2", async (_key, dest) => fs.writeFileSync(dest, Buffer.alloc(49)))).toBeNull();
    expect(fs.existsSync(output)).toBe(false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("an export that stops moving is started again by itself", async () => {
  const { dir, home, store, app, native, cleanup } = fixtureHome("stalled-export");
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const was = { ...stall };
  Object.assign(stall, { ms: 30, everyMs: 10 });
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  let starts = 0;
  const render = spyOn(native.ExportJob, "start").mockImplementation((job, progress) => {
    starts += 1;
    // The first hangs (a read that never answers) until it's stopped; the second finishes.
    if (starts === 1) {
      progress(0.2);
      let stop!: () => void;
      const stopped = new Promise<void>((resolve) => { stop = resolve; });
      return { cancel: () => stop(), wait: async () => { await stopped; throw new Error("cancelled"); } };
    }
    return { cancel: () => {}, wait: async () => { fs.writeFileSync(job.output, "export"); return { seconds: 1, bytes: 6 }; } };
  });
  try {
    const id = store.create("stalls", { width: 64, height: 36, fps: 30 }).project.id;
    await store.update(id, "test", (p) => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
    await registry.start(store, app.library, structuredClone(store.get(id)!.project), native.exportDefaults(), `${dir}/stalls.mp4`, { drive: false, keepLocal: true });
    for (let tries = 0; registry.running() && tries < 500; tries++) await Bun.sleep(5);
    expect(starts).toBe(2);
    expect(registry.activity().find((one) => one.id === id)).toMatchObject({ state: "done", onDisk: true, saved: `${dir}/stalls.mp4` });
    // The archive (or anything else) can remove it after done: the next read says so, and stops naming a path.
    fs.rmSync(`${dir}/stalls.mp4`);
    const gone = registry.activity().find((one) => one.id === id);
    expect(gone).toMatchObject({ state: "done", onDisk: false });
    expect(gone?.saved).toBeUndefined();
  } finally {
    Object.assign(stall, was);
    render.mockRestore(); archive.mockRestore(); plan.mockRestore(); cleanup();
  }
});

test("an export whose progress falls back (the engine trying its chunks again) and moves on isn't taken for stalled", async () => {
  const { dir, home, store, app, native, cleanup } = fixtureHome("retried-export");
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const was = { ...stall };
  Object.assign(stall, { ms: 60, everyMs: 10 });
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  let starts = 0;
  const render = spyOn(native.ExportJob, "start").mockImplementation((job, progress) => {
    starts += 1;
    return {
      cancel: () => {},
      wait: async () => {
        // Up to 0.8, then the engine's retry: back to 0.1 and on, never past 0.8 within the watch's time.
        for (const at of [0.4, 0.8, 0.1, 0.2, 0.3, 0.4, 0.5]) {
          progress(at);
          await Bun.sleep(25);
        }
        fs.writeFileSync(job.output, "export");
        return { seconds: 1, bytes: 6 };
      },
    };
  });
  try {
    const id = store.create("retried", { width: 64, height: 36, fps: 30 }).project.id;
    await store.update(id, "test", (p) => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
    await registry.start(store, app.library, structuredClone(store.get(id)!.project), native.exportDefaults(), `${dir}/retried.mp4`, { drive: false, keepLocal: true });
    for (let tries = 0; registry.running() && tries < 500; tries++) await Bun.sleep(5);
    expect(starts).toBe(1);
    expect(registry.activity().find((one) => one.id === id)?.state).toBe("done");
  } finally {
    Object.assign(stall, was);
    render.mockRestore(); archive.mockRestore(); plan.mockRestore(); cleanup();
  }
});

test("a share that fails while it reads an export lets go of it, so an archive that came meanwhile still takes it", async () => {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/edit-held-`);
  try {
    const file = `${dir}/Out.mp4`;
    fs.writeFileSync(file, Buffer.alloc(50));
    const io = { enabled: () => true, upload: async () => {}, head: async () => ({ size: 50 }) };
    const failed = await withExport(file, async () => {
      expect(await archiveExportFile(file, "edit/exports/p/Out.mp4", io, () => 0)).toBe(true);
      // Archived while it's read: still here.
      expect(fs.existsSync(file)).toBe(true);
      throw new Error("the review link refused it");
    }).catch((error: unknown) => (error as Error).message);
    expect(failed).toBe("the review link refused it");
    // Let go on the way out, failure and all: the archive's deletion happened then.
    expect(fs.existsSync(file)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a local export the disks can't hold is refused up front, saying what it needs and what's free", async () => {
  // TODO.md, Oct 18: a 2h35m export needed ~8 GB of chunks and file with 2.8 GB free, and failed halfway.
  const { exportBytes, roomFor } = await import("../src/exports.ts");
  const options = { format: "h264", quality: "high", target_mb: null } as unknown as Parameters<typeof exportBytes>[0];
  // 26 minutes at 1080p30, high: about 8.96 Mbit/s, so ~1.75 GB.
  const bytes = exportBytes(options, { start: 0, end: 26 * 60 * 30, width: 1920, height: 1080, audio: true }, 30);
  expect(Math.abs(bytes / 1e9 - 1.747)).toBeLessThan(0.01);
  expect(exportBytes({ ...options, format: "mp3" } as never, { start: 0, end: 900, width: 0, height: 0, audio: true }, 30)).toBe(0);
  // One disk holds the chunks and then the file: twice the size and a gigabyte's margin.
  const oneDisk = () => 1;
  expect(roomFor(bytes, "/cache", "/out", () => 5e9, oneDisk)).toBeNull();
  expect(roomFor(bytes, "/cache", "/out", () => 3e9, oneDisk)).toContain("needs about 4.5 GB");
  // Two disks: each holds one of them.
  expect(roomFor(bytes, "/cache", "/out", () => 3e9, (path) => (path === "/cache" ? 1 : 2))).toBeNull();
});

test("a Mac with room exports several at once, and the rest wait for room", async () => {
  const most = process.env.EDIT_LOCAL_EXPORTS;
  process.env.EDIT_LOCAL_EXPORTS = "2";
  const size = capacity.machine.totalBytes;
  capacity.machine.totalBytes = 24 * 1024 ** 3;
  const free = spyOn(capacity.machine, "availablePercent").mockReturnValue(70);
  const load = spyOn(capacity.machine, "load").mockReturnValue(1);
  const { dir, home, store, app, native, cleanup } = fixtureHome("parallel-exports");
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const render = spyOn(native.ExportJob, "start").mockImplementation((job) => {
    const name = JSON.parse(job.project.json).name as string;
    started.push(name);
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    releases.set(name, release);
    return { cancel: () => release(), wait: async () => { await wait; fs.writeFileSync(job.output, "export"); return { seconds: 1, bytes: 6 }; } };
  });
  try {
    const projects: Project[] = [];
    for (const name of ["one", "two", "three"]) {
      const id = store.create(name, { width: 64, height: 36, fps: 30 }).project.id;
      await store.update(id, "test", p => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
      projects.push(structuredClone(store.get(id)!.project));
    }
    const options = native.exportDefaults();
    for (const project of projects) await registry.start(store, app.library, project, options, `${dir}/${project.name}.mp4`, { drive: false, keepLocal: true });
    // Two at once (its most), the third in line.
    for (let tries = 0; started.length < 2 && tries < 100; tries++) await Bun.sleep(1);
    expect(started).toEqual(["one", "two"]);
    expect(registry.activity().find(one => one.name === "three")?.state).toBe("queued");
    releases.get("one")!();
    for (let tries = 0; !releases.has("three") && tries < 100; tries++) await Bun.sleep(1);
    expect(started).toEqual(["one", "two", "three"]);
    // Short of memory, one at a time again: nothing starts beside a running export.
    free.mockReturnValue(20);
    expect(capacity.noRoom(1)).toContain("waiting for memory");
    expect(capacity.noRoom(0)).toBeNull();
    releases.get("two")!();
    releases.get("three")!();
    for (let tries = 0; registry.running() && tries < 100; tries++) await Bun.sleep(1);
    expect(registry.running()).toBe(false);
  } finally {
    for (const release of releases.values()) release();
    render.mockRestore();
    plan.mockRestore();
    archive.mockRestore();
    free.mockRestore();
    load.mockRestore();
    capacity.machine.totalBytes = size;
    if (most === undefined) delete process.env.EDIT_LOCAL_EXPORTS;
    else process.env.EDIT_LOCAL_EXPORTS = most;
    cleanup();
  }
});

test("how many exports a Mac runs at once (one per encode engine), and when there's room for another", () => {
  const mac = (chip: string, gb: number, percent: number | null, load = 1, cores = 12): capacity.Machine => ({ chip, totalBytes: gb * 1024 ** 3, cores, availablePercent: () => percent, load: () => load });
  expect(capacity.mostAtOnce(mac("Apple M1", 8, 50), {})).toBe(1);
  // JJ's: 24 GB, but one encoder (Nov 2, two exports there stalled it).
  expect(capacity.mostAtOnce(mac("Apple M4 Pro", 24, 50), {})).toBe(1);
  expect(capacity.mostAtOnce(mac("Apple M3 Max", 64, 50), {})).toBe(2);
  expect(capacity.mostAtOnce(mac("Apple M2 Ultra", 128, 50), {})).toBe(4);
  expect(capacity.mostAtOnce(mac("Intel(R) Xeon(R)", 64, 50), {})).toBe(1);
  expect(capacity.mostAtOnce(mac("Apple M1", 8, 50), { EDIT_LOCAL_EXPORTS: "2" })).toBe(2);
  expect(capacity.noRoom(0, mac("Apple M1", 8, 5), {})).toBeNull();
  expect(capacity.noRoom(1, mac("Apple M4 Pro", 24, 90), {})).toBe("waiting for the encoder (this Mac has one)");
  expect(capacity.noRoom(1, mac("Apple M3 Max", 64, 60), {})).toBeNull();
  expect(capacity.noRoom(2, mac("Apple M3 Max", 64, 60), {})).toBe("waiting for an encoder (this Mac has 2)");
  expect(capacity.noRoom(1, mac("Apple M3 Max", 64, 30), {})).toContain("waiting for memory");
  expect(capacity.noRoom(1, mac("Apple M3 Max", 64, 60, 10), {})).toContain("less busy");
  expect(capacity.noRoom(1, mac("Apple M3 Max", 64, null), {})).toContain("can't be read");
});

test("a finished export's upload is a job of its own: a restart meanwhile sends the file again, never exports it again", async () => {
  const { dir, home, store, app, native, cleanup } = fixtureHome("archive-job");
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const render = spyOn(native.ExportJob, "start").mockImplementation((job) => ({ cancel: () => {}, wait: async () => { fs.writeFileSync(job.output, "export"); return { seconds: 1, bytes: 6 }; } }));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const uploaded: string[] = [];
  const enabled = spyOn(exportCloud, "enabled").mockReturnValue(true);
  const upload = spyOn(exportCloud, "upload").mockImplementation(async (path, key) => { uploaded.push(key); await held; void path; });
  const head = spyOn(exportCloud, "head").mockResolvedValue({ size: 6 });
  const wanted = spyOn(seams.drive, "wanted").mockReturnValue(false);
  try {
    const id = store.create("archived", { width: 64, height: 36, fps: 30 }).project.id;
    await store.update(id, "test", (p) => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
    const output = `${dir}/archived.mp4`;
    await registry.start(store, app.library, structuredClone(store.get(id)!.project), native.exportDefaults(), output, { drive: false });
    for (let tries = 0; uploaded.length === 0 && tries < 500; tries++) await Bun.sleep(5);
    // Uploading: the export's job is over, the archive's is on the list.
    const listed = (JSON.parse(fs.readFileSync(`${home}/jobs.json`, "utf8")) as { key: string; kind: string; args: { output?: string } }[]);
    expect(listed.map((job) => job.kind)).toEqual(["archive"]);
    expect(listed[0]!.args.output).toBe(output);
    release();
    for (let tries = 0; registry.running() && tries < 500; tries++) await Bun.sleep(5);
    expect(JSON.parse(fs.readFileSync(`${home}/jobs.json`, "utf8"))).toEqual([]);
    // What a restart does with that job: the file goes up again and is listed, nothing renders.
    fs.writeFileSync(output, "export");
    const renders = render.mock.calls.length;
    await archiveFinished(home, id, output, "edit/exports/x/archived.mp4", { path: output, name: "archived.mp4", finished_ms: 1, seconds: 1, bytes: 6, frames: 30, whole: true, format: "h264", cloudKey: "edit/exports/x/archived.mp4" });
    expect(uploaded.at(-1)).toBe("edit/exports/x/archived.mp4");
    expect(render.mock.calls.length).toBe(renders);
    expect(listExports(home, id).some((one) => one.cloudKey === "edit/exports/x/archived.mp4")).toBe(true);
  } finally {
    release();
    render.mockRestore(); plan.mockRestore(); enabled.mockRestore(); upload.mockRestore(); head.mockRestore(); wanted.mockRestore(); cleanup();
  }
});

test("smooth playback's render waits only for the export rendering, goes before the ones in line, and isn't an export itself", async () => {
  // Sphe, Nov 3: with three exports queued, the edit open here got no smooth playback until all were done ("cut the line").
  const most = process.env.EDIT_LOCAL_EXPORTS;
  process.env.EDIT_LOCAL_EXPORTS = "1";
  const { dir, home, store, app, native, cleanup } = fixtureHome("playback-turn");
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const render = spyOn(native.ExportJob, "start").mockImplementation((job) => {
    const name = JSON.parse(job.project.json).name as string;
    started.push(name);
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    releases.set(name, release);
    return { cancel: () => release(), wait: async () => { await wait; fs.writeFileSync(job.output, "export"); return { seconds: 1, bytes: 6 }; } };
  });
  const events: { id?: string; state?: string; waiting?: string; phase?: string }[] = [];
  const unsubscribe = store.subscribe((event) => { if (event.type === "export") events.push(event as never); });
  try {
    // Nothing exporting: a place at once, and nothing waits on it as on an export.
    const alone = registry.takeTurn(() => { throw new Error("given at once"); });
    expect(alone.release).not.toBeNull();
    expect(registry.localRunning()).toBe(false);
    expect(registry.running()).toBe(false);
    // An export asked for meanwhile waits for it, saying so.
    const projects: Project[] = [];
    for (const name of ["one", "two"]) {
      const id = store.create(name, { width: 64, height: 36, fps: 30 }).project.id;
      await store.update(id, "test", p => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
      projects.push(structuredClone(store.get(id)!.project));
    }
    const options = native.exportDefaults();
    await registry.start(store, app.library, projects[0]!, options, `${dir}/one.mp4`, { drive: false, keepLocal: true });
    expect(started).toEqual([]);
    expect(registry.activity().find(one => one.name === "one")).toMatchObject({ state: "queued", waiting: "waiting for smooth playback's render to finish" });
    alone.release!();
    alone.release!();
    for (let tries = 0; started.length < 1 && tries < 100; tries++) await Bun.sleep(1);
    expect(started).toEqual(["one"]);
    expect(registry.localRunning()).toBe(true);
    // "two" in line behind "one"; playback asks after it and still goes first.
    await registry.start(store, app.library, projects[1]!, options, `${dir}/two.mp4`, { drive: false, keepLocal: true });
    expect(registry.activity().find(one => one.name === "two")).toMatchObject({ state: "queued", waiting: "waiting for the encoder (this Mac has one)" });
    expect(events.find(one => one.id === projects[1]!.id && one.state === "queued")).toMatchObject({ waiting: "waiting for the encoder (this Mac has one)" });
    expect(events.some(one => one.id === projects[0]!.id && one.phase === "starting the export")).toBe(true);
    let given: (() => void) | null = null;
    const turn = registry.takeTurn((release) => { given = release; });
    expect(turn.release).toBeNull();
    // A wait dropped is never served; the one after it is.
    const dropped = registry.takeTurn(() => { throw new Error("dropped"); });
    dropped.cancel();
    releases.get("one")!();
    for (let tries = 0; given === null && tries < 100; tries++) await Bun.sleep(1);
    expect(given).not.toBeNull();
    expect(started).toEqual(["one"]);
    // The queued one's reason was said again as it changed.
    expect(registry.activity().find(one => one.name === "two")?.waiting).toBe("waiting for smooth playback's render to finish");
    expect(events.filter(one => one.id === projects[1]!.id && one.state === "queued").length).toBeGreaterThan(1);
    given!();
    for (let tries = 0; started.length < 2 && tries < 100; tries++) await Bun.sleep(1);
    expect(started).toEqual(["one", "two"]);
    releases.get("two")!();
    for (let tries = 0; registry.running() && tries < 100; tries++) await Bun.sleep(1);
    expect(registry.running()).toBe(false);
  } finally {
    unsubscribe();
    for (const release of releases.values()) release();
    render.mockRestore(); archive.mockRestore(); plan.mockRestore();
    if (most === undefined) delete process.env.EDIT_LOCAL_EXPORTS;
    else process.env.EDIT_LOCAL_EXPORTS = most;
    cleanup();
  }
});

test("a share's export keeps for a restart the edit without its watermark, the watermark, and the share", async () => {
  // The audit, Nov 3: a share's export cut by a restart came back a plain export, and its next Share exported the edit again.
  const most = process.env.EDIT_LOCAL_EXPORTS;
  process.env.EDIT_LOCAL_EXPORTS = "1";
  const { dir, home, store, app, native, cleanup } = fixtureHome("share-resume");
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const { timelineHash, withWatermarkKey, optionsKey } = await import("../src/exports.ts");
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const marked = spyOn(seams.channelMarks, "addWatermark").mockImplementation(async (_app, _cache, project) => ({ ...project, media: [...project.media, { id: "watermark-sx", name: "SX watermark", path: "/tmp/logo.png", kind: "image", duration: 1, width: 64, height: 64, fps: 0, has_audio: false }] }) as Project);
  let release!: () => void;
  const render = spyOn(native.ExportJob, "start").mockImplementation((job) => {
    const wait = new Promise<void>(resolve => { release = resolve; });
    expect(JSON.parse(job.project.json).media.some((one: { id: string }) => one.id === "watermark-sx")).toBe(true);
    return { cancel: () => release(), wait: async () => { await wait; fs.writeFileSync(job.output, "export"); return { seconds: 1, bytes: 6 }; } };
  });
  try {
    const id = store.create("shared", { width: 64, height: 36, fps: 30 }).project.id;
    await store.update(id, "test", p => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
    const edit = structuredClone(store.get(id)!.project);
    const options = native.exportDefaults();
    await registry.start(store, app.library, edit, options, `${dir}/shared.mp4`, { share: true, replace: true, note: "Fixes", watermark: "logo-1" });
    const job = (JSON.parse(fs.readFileSync(`${home}/jobs.json`, "utf8")) as { kind: string; args: Record<string, unknown> }[]).find(one => one.kind === "export")!;
    expect(job.args).toMatchObject({ share: true, replace: true, note: "Fixes", watermark: "logo-1" });
    // The edit itself is kept: a restart puts the watermark on again, so the share that asked follows it.
    const kept = resumeSnapshot(home, id, job.args)!;
    expect(kept.media.some(one => one.id === "watermark-sx")).toBe(false);
    expect(registry.runningFor(id)).toMatchObject({ timeline: timelineHash(kept), options: withWatermarkKey(optionsKey(options), "logo-1") });
  } finally {
    release?.();
    for (let tries = 0; registry.running() && tries < 100; tries++) await Bun.sleep(1);
    render.mockRestore(); archive.mockRestore(); plan.mockRestore(); marked.mockRestore();
    if (most === undefined) delete process.env.EDIT_LOCAL_EXPORTS;
    else process.env.EDIT_LOCAL_EXPORTS = most;
    cleanup();
  }
});

test("short of room, kept copies go older first: each project's newest stays while 20 GB is free", () => {
  // Sphe, Nov 3: "keep newest per project"; at 60 GB every re-export on a 256 GB Mac fetched its last export back first.
  const home = fs.mkdtempSync(`${os.tmpdir()}/edit-kept-`);
  try {
    const file = (name: string) => {
      const path = `${home}/${name}.mp4`;
      fs.writeFileSync(path, Buffer.alloc(10));
      return path;
    };
    const record = (name: string, at: number, cloud = true) => ({ path: file(name), name: `${name}.mp4`, finished_ms: at, seconds: 1, bytes: 10, frames: 30, whole: true, format: "h264", ...(cloud ? { cloudKey: `edit/exports/${name}.mp4` } : {}) });
    const write = () => fs.writeFileSync(`${home}/exports.json`, JSON.stringify({
      a: [record("a1", 1), record("a2", 5)],
      b: [record("b1", 2), record("b2", 3)],
      c: [record("c1", 4, false)],
      d: [record("d1", 6)],
    }));
    write();
    const there = () => ["a1", "a2", "b1", "b2", "c1", "d1"].filter((name) => fs.existsSync(`${home}/${name}.mp4`));
    // Room to spare: nothing goes.
    expect(dropKept(home, `${home}/d1.mp4`, () => 100e9)).toBe(0);
    expect(there()).toEqual(["a1", "a2", "b1", "b2", "c1", "d1"]);
    // 26 GB free: the older copies go, each project's newest stays (c1 was never archived: always kept).
    expect(dropKept(home, `${home}/d1.mp4`, () => 26e9)).toBe(20);
    expect(there()).toEqual(["a2", "b2", "c1", "d1"]);
    // Under 20 GB: other projects' newest go too, the oldest first, until there's room.
    let free = 15e9;
    const rm = fs.rmSync;
    const removed = spyOn(fs, "rmSync").mockImplementation(((path: fs.PathLike, options?: fs.RmOptions) => { free += 6e9; rm(path, options); }) as typeof fs.rmSync);
    try {
      dropKept(home, `${home}/d1.mp4`, () => free);
    } finally { removed.mockRestore(); }
    expect(there()).toEqual(["a2", "c1", "d1"]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
