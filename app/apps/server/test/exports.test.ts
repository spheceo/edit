import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { deleteExport, ExportRegistry, listExports } from "../src/exports.ts";
import * as seams from "../src/seams.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";

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
    plan.mockRestore(); render.mockRestore(); enabled.mockRestore(); wanted.mockRestore(); upload.mockRestore(); cleanup();
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
  project.clips.push({ id: "c2", type: "audio", media: "m2", start: 0, duration: 100 } as never);
  expect(seams.modalExports.unsuitable(project, house, whole)).toBe("Local.mov isn't in the cloud");
});
