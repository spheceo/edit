import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { archiveExportFile, deleteExport, exportCloud, ExportRegistry, holdExport, listExports, macSpeed, restorePrevious, resumeSnapshot, stall, withExport } from "../src/exports.ts";
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
    for (const project of projects) await registry.start(store, app.library, project, options, `${dir}/${project.name}.mp4`, { backend: "local", drive: false, keepLocal: true });
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

test("three remote exports leave local work free and retain their timeline snapshots", async () => {
  const registry = new ExportRegistry();
  const { dir, store, app, native, cleanup } = fixtureHome("remote-exports", { services: { exports: registry } });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const snapshots: string[] = [];
  const enabled = spyOn(seams.cloudExports, "enabled").mockReturnValue(true);
  // The older cloud path: Modal off, as on CI (on a Mac with Modal's driver, these went to Modal and the test failed).
  const modal = spyOn(seams.modalExports, "enabled").mockReturnValue(false);
  const render = spyOn(seams.cloudExports, "run").mockImplementation(async (project, _options, _plan, output) => {
    snapshots.push(project.name);
    await wait;
    fs.writeFileSync(output, "cloud export");
  });
  try {
    const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
    const ids: string[] = [];
    for (const name of ["one", "two", "three"]) {
      const project = store.create(name, { width: 64, height: 36, fps: 30 }).project;
      await store.update(project.id, "test", p => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
      ids.push(project.id);
    }
    await Promise.all(ids.map(id => registry.start(store, app.library, store.get(id)!.project, native.exportDefaults(), `${dir}/${id}.mp4`)));
    expect(render).toHaveBeenCalledTimes(3);
    expect(registry.running()).toBe(true);
    expect(registry.localRunning()).toBe(false);
    await store.update(ids[0]!, "test", p => { p.name = "edited while exporting"; });
    expect(snapshots).toEqual(["one", "two", "three"]);
    release();
    for (let tries = 0; registry.running() && tries < 100; tries++) await Bun.sleep(1);
    expect(registry.running()).toBe(false);
    expect(ids.every(id => registry.exported(`${fs.realpathSync(dir)}/${id}.mp4`))).toBe(true);
    plan.mockRestore();
  } finally {
    release();
    render.mockRestore(); enabled.mockRestore(); modal.mockRestore(); cleanup();
  }
});

test("house exports of cloud footage render on Modal at once, and drive false keeps a subtitled video off Drive", async () => {
  const registry = new ExportRegistry();
  const { dir, store, app, native, cleanup } = fixtureHome("modal-exports", { services: { exports: registry } });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const enabled = spyOn(seams.modalExports, "enabled").mockReturnValue(true);
  const better = spyOn(seams.modalExports, "cloudBetter").mockReturnValue("it would take about 13 min on this Mac");
  const render = spyOn(seams.modalExports, "run").mockImplementation(async (_home, _project, _options, output) => {
    await wait;
    fs.writeFileSync(output, "modal export");
    return { bytes: 12, key: null };
  });
  const wanted = spyOn(seams.drive, "wanted").mockReturnValue(true);
  const uploaded: string[] = [];
  const upload = spyOn(seams.drive, "start").mockImplementation((_store, _library, project) => { uploaded.push(project.name); });
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: true }, fps: 30 });
  try {
    const ids: string[] = [];
    for (const name of ["kept", "uploaded"]) {
      const project = store.create(name, { width: 64, height: 36, fps: 30 }).project;
      await store.update(project.id, "test", p => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
      ids.push(project.id);
    }
    const house = native.exportDefaults();
    await registry.start(store, app.library, store.get(ids[0]!)!.project, house, `${dir}/kept.mp4`, { drive: false });
    await registry.start(store, app.library, store.get(ids[1]!)!.project, house, `${dir}/uploaded.mp4`);
    expect(render).toHaveBeenCalledTimes(2);
    expect(registry.localRunning()).toBe(false);
    // A span, a size or a format of its own is this Mac's: refused when Modal is asked for.
    const span = { ...house, range: [0, 10] as [number, number] };
    plan.mockReturnValue({ plan: { start: 0, end: 10, width: 64, height: 36, audio: true }, fps: 30 });
    expect(seams.modalExports.unsuitable(store.get(ids[0]!)!.project, span, { start: 0, end: 10, width: 64, height: 36, audio: true })).toContain("whole edit");
    expect(seams.modalExports.unsuitable(store.get(ids[0]!)!.project, { ...house, size: 720 }, { start: 0, end: 30, width: 64, height: 36, audio: true })).toContain("size");
    release();
    for (let tries = 0; registry.running() && tries < 100; tries++) await Bun.sleep(1);
    expect(uploaded).toEqual(["uploaded"]);
  } finally {
    release();
    plan.mockRestore(); render.mockRestore(); enabled.mockRestore(); better.mockRestore(); wanted.mockRestore(); upload.mockRestore(); cleanup();
  }
});

test("Modal takes only footage that's in the cloud", () => {
  const project = {
    settings: { width: 1920, height: 1080, fps: 24, ntsc: true },
    media: [{ id: "m1", name: "Bodycam.mp4", cloud: { original: "edit/originals/sha256/aa", proxy: "edit/proxies/aa" } }, { id: "m2", name: "Local.mov" }],
    clips: [{ id: "c1", type: "video", media: "m1", start: 0, duration: 100 }],
  } as unknown as Parameters<typeof seams.modalExports.unsuitable>[0];
  const house = { format: "h264", shape: "original", fill: "blur", size: null, fps: null, quality: "high", target_mb: null, hardware: true, wait_for_smoothing: false, audio: true, loudness: -14, range: null, chapters: [] } as unknown as Parameters<typeof seams.modalExports.unsuitable>[1];
  const whole = { start: 0, end: 100, width: 1920, height: 1080, audio: true };
  expect(seams.modalExports.unsuitable(project, house, whole)).toBeNull();
  expect(seams.modalExports.unsuitable(project, { ...house, size: 1080 }, whole)).toBeNull();
  // Chapters too: the worker adds them as it joins the file (a share with chapters went to the Mac, Oct 31).
  expect(seams.modalExports.unsuitable(project, { ...house, chapters: [{ start: 0, title: "Intro" }, { start: 600, title: "Story" }] } as typeof house, whole)).toBeNull();
  // The worker makes a waveform's sound levels from the cloud original.
  project.clips.push({ id: "w1", type: "waveform", start: 0, duration: 100 } as never);
  expect(seams.modalExports.unsuitable(project, house, whole)).toBeNull();
  project.clips.push({ id: "c2", type: "audio", media: "m2", start: 0, duration: 100 } as never);
  expect(seams.modalExports.unsuitable(project, house, whole)).toBe("Local.mov isn't in the cloud");
});

test("a free Mac keeps an export it can finish in 25 minutes; a busy one or a very long edit goes to Modal", () => {
  const project = (clips: unknown[]) => ({ settings: { width: 1920, height: 1080, fps: 24, ntsc: true }, media: [], clips, script: null }) as unknown as Parameters<typeof seams.modalExports.cloudBetter>[0];
  const plan = (end: number) => ({ start: 0, end, width: 1920, height: 1080, audio: true });
  const footage = { id: "v", type: "video", media: "m", start: 0, duration: 41_777, name: "Bodycam" };
  const subtitle = { id: "t", type: "text", start: 0, duration: 48, name: "Subtitle · Officer", style: {} };
  // Cop Father's subtitles: 3:29 here, 5:05 on Modal.
  expect(seams.modalExports.cloudBetter(project([footage, subtitle]), plan(41_777), false, 0.3)).toBeNull();
  expect(seams.modalExports.cloudBetter(project([footage, subtitle]), plan(41_777), true, 0.3)).toBe("this Mac is already exporting");
  expect(seams.modalExports.cloudBetter(project([footage, subtitle]), plan(41_777), false, 0.9)).toBeNull();
  expect(seams.modalExports.cloudBetter(project([footage, subtitle]), plan(41_777), false, 1.5)).toContain("busy");
  // Corrupt Cop, an edit: 13 min here, kept here (Oct 31: Modal only when the Mac really can't).
  expect(seams.modalExports.cloudBetter(project([footage]), plan(34_987), false, 0.3)).toBeNull();
  expect(seams.modalExports.cloudBetter(project([footage]), plan(90_000), false, 0.3)).toContain("33 min");
  expect(seams.modalExports.cloudBetter(project([footage]), plan(4_600), false, 0.3)).toBeNull();
});

test("a free Mac keeps an export Modal could take, and its first export teaches it its speed", async () => {
  const { dir, home, store, app, native, cleanup } = fixtureHome("mac-first-exports");
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const enabled = spyOn(seams.modalExports, "enabled").mockReturnValue(true);
  const suitable = spyOn(seams.modalExports, "unsuitable").mockReturnValue(null);
  const better = spyOn(seams.modalExports, "cloudBetter").mockReturnValue(null);
  const modal = spyOn(seams.modalExports, "run");
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 1800, width: 64, height: 36, audio: true }, fps: 30 });
  const render = spyOn(native.ExportJob, "start").mockImplementation((job) => ({
    cancel: () => {},
    wait: async () => { await Bun.sleep(20); fs.writeFileSync(job.output, "export"); return { seconds: 1, bytes: 6 }; },
  }));
  try {
    const project = store.create("free", { width: 64, height: 36, fps: 30 }).project;
    await store.update(project.id, "test", p => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 1800, type: "solid" })));
    // Until Nov 1 the 25-minute rule was never asked: every export Modal could take went there.
    await registry.start(store, app.library, store.get(project.id)!.project, native.exportDefaults(), `${dir}/free.mp4`);
    expect(better).toHaveBeenCalledTimes(1);
    expect(better.mock.calls[0]![2]).toBe(false);
    for (let tries = 0; registry.running() && tries < 200; tries++) await Bun.sleep(5);
    expect(render).toHaveBeenCalledTimes(1);
    expect(modal).not.toHaveBeenCalled();
    // Every frame new on this Mac: a speed sample, which the next choice reads.
    const [record] = listExports(home, project.id);
    expect(record!.fresh_fps).toBeGreaterThan(0);
    expect(record!.subtitles).toBe(false);
    expect(macSpeed(home).edit).toBe(record!.fresh_fps);
    expect(macSpeed(home).subtitles).toBeUndefined();
  } finally {
    render.mockRestore(); plan.mockRestore(); archive.mockRestore(); modal.mockRestore(); better.mockRestore(); suitable.mockRestore(); enabled.mockRestore(); cleanup();
  }
});

// Nov 2, JJ's Mac: Modal refused Cops Surprise (429), it exported here
// outside the line, and Mom Secretly's v2 started beside it: two whole renders
// on a Mac with 0.1 GB free, until the second's encoder stalled.
test("an export Modal refuses waits its turn for this Mac like any other, and the next one waits for it", async () => {
  const { dir, home, store, app, native, cleanup } = fixtureHome("modal-refused-queues");
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const enabled = spyOn(seams.modalExports, "enabled").mockReturnValue(true);
  const suitable = spyOn(seams.modalExports, "unsuitable").mockReturnValue(null);
  // The first goes to Modal (long); the second is asked while the first renders here.
  const better = spyOn(seams.modalExports, "cloudBetter").mockImplementation((_project, _plan, busy) => (busy ? "this Mac is already exporting" : "it would take about 36 min on this Mac"));
  let refuse = true;
  const modal = spyOn(seams.modalExports, "run").mockImplementation(async (_home, _project, _options, output) => {
    if (refuse) throw new Error("modal-http: Input rate limit (0/s) exceeded (429)");
    fs.writeFileSync(output, "modal export");
    return { bytes: 12, key: null };
  });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 1800, width: 64, height: 36, audio: true }, fps: 30 });
  let rendering = 0;
  let most = 0;
  let finish!: () => void;
  const held = new Promise<void>((resolve) => (finish = resolve));
  const render = spyOn(native.ExportJob, "start").mockImplementation((job) => ({
    cancel: () => {},
    wait: async () => {
      rendering++;
      most = Math.max(most, rendering);
      await held;
      fs.writeFileSync(job.output, "export");
      rendering--;
      return { seconds: 1, bytes: 6 };
    },
  }));
  try {
    const ids: string[] = [];
    for (const name of ["cops", "mom"]) {
      const project = store.create(name, { width: 64, height: 36, fps: 30 }).project;
      await store.update(project.id, "test", p => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 1800, type: "solid" })));
      ids.push(project.id);
    }
    await registry.start(store, app.library, store.get(ids[0]!)!.project, native.exportDefaults(), `${dir}/cops.mp4`);
    for (let tries = 0; render.mock.calls.length === 0 && tries < 200; tries++) await Bun.sleep(5);
    expect(registry.localRunning()).toBe(true);
    // Modal would take it now, but this Mac is the one asked about: busy.
    refuse = false;
    await registry.start(store, app.library, store.get(ids[1]!)!.project, native.exportDefaults(), `${dir}/mom.mp4`);
    expect(better.mock.calls.at(-1)![2]).toBe(true);
    finish();
    for (let tries = 0; registry.running() && tries < 400; tries++) await Bun.sleep(5);
    expect(most).toBe(1);
    expect(registry.localRunning()).toBe(false);
  } finally {
    finish();
    render.mockRestore(); plan.mockRestore(); archive.mockRestore(); modal.mockRestore(); better.mockRestore(); suitable.mockRestore(); enabled.mockRestore(); cleanup();
  }
});

test("a Mac's speed is the median of its newest fresh exports of that kind, and the 25 minutes go by it", () => {
  const home = fs.mkdtempSync(`${os.tmpdir()}/edit-speed-`);
  try {
    const record = (fps: number, finished: number, subtitles = false) => ({ path: `/x/${finished}.mp4`, name: "x.mp4", finished_ms: finished, seconds: 1, bytes: 1, frames: 1800, whole: true, format: "h264", fresh_fps: fps, subtitles });
    expect(macSpeed(home)).toEqual({});
    fs.writeFileSync(`${home}/exports.json`, JSON.stringify({
      a: [record(500, 1), record(40, 2), record(22, 3)],
      b: [record(30, 4), record(25, 5), record(60, 6), record(180, 7, true), { ...record(0, 8), fresh_fps: undefined }],
    }));
    // The newest five edits (500 is the sixth): 22, 25, 30, 40, 60.
    expect(macSpeed(home)).toEqual({ edit: 30, subtitles: 180 });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  const project = { settings: { width: 1920, height: 1080, fps: 30, ntsc: false }, media: [], clips: [{ id: "v", type: "video", media: "m", start: 0, duration: 48_060 }], script: null } as unknown as Parameters<typeof seams.modalExports.cloudBetter>[0];
  const plan = { start: 0, end: 48_060, width: 1920, height: 1080, audio: true };
  // The 16-Year-Old (26.7 min): ~18 min at the old guess of 45 frames/s, 36 at the 22 an M1 measured.
  expect(seams.modalExports.cloudBetter(project, plan, false, 0.3)).toBeNull();
  expect(seams.modalExports.cloudBetter(project, plan, false, 0.3, { edit: 22 })).toContain("36 min");
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
    await registry.start(store, app.library, structuredClone(store.get(id)!.project), native.exportDefaults(), `${dir}/stalls.mp4`, { backend: "local", drive: false, keepLocal: true });
    for (let tries = 0; registry.running() && tries < 500; tries++) await Bun.sleep(5);
    expect(starts).toBe(2);
    expect(registry.activity().find((one) => one.id === id)?.state).toBe("done");
  } finally {
    Object.assign(stall, was);
    render.mockRestore(); archive.mockRestore(); plan.mockRestore(); cleanup();
  }
});

test("five projects the Mac can't take export on Modal at the same time, none queued, while this Mac stays free", async () => {
  const registry = new ExportRegistry();
  const { dir, store, app, native, cleanup } = fixtureHome("modal-five", { services: { exports: registry } });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let atOnce = 0;
  let most = 0;
  const enabled = spyOn(seams.modalExports, "enabled").mockReturnValue(true);
  const better = spyOn(seams.modalExports, "cloudBetter").mockReturnValue("this Mac is busy (load 2.00 a core)");
  const render = spyOn(seams.modalExports, "run").mockImplementation(async (_home, _project, _options, output) => {
    most = Math.max(most, ++atOnce);
    await wait;
    atOnce--;
    fs.writeFileSync(output, "modal export");
    return { bytes: 12, key: null };
  });
  const wanted = spyOn(seams.drive, "wanted").mockReturnValue(false);
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: true }, fps: 30 });
  try {
    const ids: string[] = [];
    for (const name of ["one", "two", "three", "four", "five"]) {
      const project = store.create(name, { width: 64, height: 36, fps: 30 }).project;
      await store.update(project.id, "test", p => p.clips.push(clip({ id: "solid", track: p.tracks[0]!.id, start: 0, duration: 30, type: "solid" })));
      ids.push(project.id);
    }
    const house = native.exportDefaults();
    await Promise.all(ids.map(id => registry.start(store, app.library, store.get(id)!.project, house, `${dir}/${id}.mp4`)));
    for (let tries = 0; most < 5 && tries < 100; tries++) await Bun.sleep(1);
    expect(most).toBe(5);
    expect(registry.localRunning()).toBe(false);
    // Still one per project.
    await expect(registry.start(store, app.library, store.get(ids[0]!)!.project, house, `${dir}/again.mp4`)).rejects.toThrow("already has an export running");
    release();
    for (let tries = 0; registry.running() && tries < 200; tries++) await Bun.sleep(1);
    expect(ids.every(id => registry.exported(`${fs.realpathSync(dir)}/${id}.mp4`))).toBe(true);
  } finally {
    release();
    plan.mockRestore(); render.mockRestore(); better.mockRestore(); enabled.mockRestore(); wanted.mockRestore(); cleanup();
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
    for (const project of projects) await registry.start(store, app.library, project, options, `${dir}/${project.name}.mp4`, { backend: "local", drive: false, keepLocal: true });
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
