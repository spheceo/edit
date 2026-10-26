import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { archiveExportFile, deleteExport, exportCloud, ExportRegistry, listExports, resumeSnapshot } from "../src/exports.ts";
import type { Project } from "../src/model.ts";
import * as seams from "../src/seams.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";

test("local exports queue across projects, preserve snapshots and advance after failure or queued cancellation", async () => {
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
    render.mockRestore(); enabled.mockRestore(); cleanup();
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
  // The worker makes a waveform's sound levels from the cloud original.
  project.clips.push({ id: "w1", type: "waveform", start: 0, duration: 100 } as never);
  expect(seams.modalExports.unsuitable(project, house, whole)).toBeNull();
  project.clips.push({ id: "c2", type: "audio", media: "m2", start: 0, duration: 100 } as never);
  expect(seams.modalExports.unsuitable(project, house, whole)).toBe("Local.mov isn't in the cloud");
});

test("a free Mac keeps a short export or a subtitle video; a busy one or a long edit goes to Modal", () => {
  const project = (clips: unknown[]) => ({ settings: { width: 1920, height: 1080, fps: 24, ntsc: true }, media: [], clips, script: null }) as unknown as Parameters<typeof seams.modalExports.cloudBetter>[0];
  const plan = (end: number) => ({ start: 0, end, width: 1920, height: 1080, audio: true });
  const footage = { id: "v", type: "video", media: "m", start: 0, duration: 41_777, name: "Bodycam" };
  const subtitle = { id: "t", type: "text", start: 0, duration: 48, name: "Subtitle · Officer", style: {} };
  // Cop Father's subtitles: 3:29 here, 5:05 on Modal.
  expect(seams.modalExports.cloudBetter(project([footage, subtitle]), plan(41_777), false, 0.3)).toBeNull();
  expect(seams.modalExports.cloudBetter(project([footage, subtitle]), plan(41_777), true, 0.3)).toBe("this Mac is already exporting");
  expect(seams.modalExports.cloudBetter(project([footage, subtitle]), plan(41_777), false, 0.9)).toContain("busy");
  // Corrupt Cop, an edit: 13 min here.
  expect(seams.modalExports.cloudBetter(project([footage]), plan(34_987), false, 0.3)).toContain("13 min");
  expect(seams.modalExports.cloudBetter(project([footage]), plan(4_600), false, 0.3)).toBeNull();
});

test("archiveExportFile deletes locally only after a size-verified upload", async () => {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/edit-archive-`);
  try {
    const file = `${dir}/Out.mp4`;
    fs.writeFileSync(file, Buffer.alloc(50));
    const io = (size: number | null) => ({ enabled: () => true, upload: async () => {}, head: async () => (size === null ? null : { size }) });
    expect(await archiveExportFile(file, "edit/exports/p/Out.mp4", io(51))).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    expect(await archiveExportFile(file, "edit/exports/p/Out.mp4", io(null))).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    expect(await archiveExportFile(file, "edit/exports/p/Out.mp4", io(50))).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
