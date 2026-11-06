// Exports made ahead (export_ahead.ts, exports.ts `startAhead`): made quietly
// once an edit rests, given up to anything someone asks for, then reused.

import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import * as ahead from "../src/export_ahead.ts";
import { aheadFile, exportCloud, ExportRegistry } from "../src/exports.ts";
import type { Project } from "../src/model.ts";
import * as seams from "../src/seams.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip, media } from "./helpers/model.ts";

type Started = { name: string; output: string; background: boolean; cancelled: boolean; release: () => void };

function setUp(name: string) {
  const most = process.env.EDIT_LOCAL_EXPORTS;
  process.env.EDIT_LOCAL_EXPORTS = "1";
  const fixture = fixtureHome(name);
  const { home, store, app, native } = fixture;
  const registry = new ExportRegistry(home);
  app.exports = registry;
  const started: Started[] = [];
  const plan = spyOn(native, "exportPlan").mockReturnValue({ plan: { start: 0, end: 30, width: 64, height: 36, audio: false }, fps: 30 });
  const archive = spyOn(exportCloud, "enabled").mockReturnValue(false);
  const render = spyOn(native.ExportJob, "start").mockImplementation((job) => {
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const one: Started = { name: JSON.parse(job.project.json).name as string, output: job.output, background: (job as { background?: boolean }).background === true, cancelled: false, release };
    started.push(one);
    return {
      cancel: () => { one.cancelled = true; release(); },
      wait: async () => {
        await done;
        if (one.cancelled) throw new Error("cancelled");
        fs.writeFileSync(job.output, "export");
        return { seconds: 1, bytes: 6 };
      },
    };
  });
  const project = async (title: string): Promise<Project> => {
    const id = store.create(title, { width: 64, height: 36, fps: 30 }).project.id;
    await store.update(id, "test", (p) => {
      p.media.push(media({ id: "m1", name: "shot.mp4", path: `${home}/shot.mp4`, kind: "video", duration: 10 }));
      p.clips.push(clip({ id: "shot", track: p.tracks[0]!.id, start: 0, duration: 30, type: "video", media: "m1", source_in: 0 }));
    });
    return structuredClone(store.get(id)!.project);
  };
  const settle = async (until: () => boolean) => {
    for (let tries = 0; !until() && tries < 200; tries++) await Bun.sleep(2);
  };
  return {
    ...fixture, registry, started, project, settle,
    done: () => {
      for (const one of started) one.release();
      render.mockRestore(); archive.mockRestore(); plan.mockRestore();
      if (most === undefined) delete process.env.EDIT_LOCAL_EXPORTS;
      else process.env.EDIT_LOCAL_EXPORTS = most;
      fixture.cleanup();
    },
  };
}

test("an export made ahead is quiet, and the export asked for stops it, then spends its file", async () => {
  const t = setUp("ahead-quiet");
  try {
    const project = await t.project("Cops");
    const options = t.native.exportDefaults();
    const file = aheadFile(t.store.cacheDir(), project.id);
    expect(t.registry.startAhead(t.store, t.app.library, project, options, file)).toBe(true);
    await t.settle(() => t.started.length === 1);
    // In the background, and nothing anyone waits on: not listed, not "an export", not one to follow.
    expect(t.started[0]).toMatchObject({ name: "Cops", output: file, background: true });
    expect(t.registry.activity()).toEqual([]);
    expect(t.registry.running()).toBe(false);
    expect(t.registry.localRunning()).toBe(false);
    expect(t.registry.runningFor(project.id)).toBeNull();
    expect(t.registry.aheadFor()).toBe(project.id);
    // Only one at a time.
    expect(t.registry.startAhead(t.store, t.app.library, await t.project("Other"), options, aheadFile(t.store.cacheDir(), "other"))).toBe(false);
    // Finished: its file, and a note of what it shows.
    t.started[0]!.release();
    await t.settle(() => t.registry.aheadFor() === null && fs.existsSync(`${file}.json`));
    expect(fs.readFileSync(file, "utf8")).toBe("export");
    expect(JSON.parse(fs.readFileSync(`${file}.json`, "utf8")).timeline).toBeString();
    expect(t.registry.activity()).toEqual([]);
    // Made again of a newer picture, then someone exports: the one made ahead stops first, and the export runs.
    expect(t.registry.startAhead(t.store, t.app.library, project, options, file)).toBe(true);
    await t.settle(() => t.started.length === 3);
    const output = `${t.dir}/Cops.mp4`;
    await t.registry.start(t.store, t.app.library, project, options, output, { drive: false, keepLocal: true });
    expect(t.started.find((one) => one.output === file && one !== t.started[0])?.cancelled).toBe(true);
    await t.settle(() => t.started.some((one) => one.output === output));
    expect(t.registry.running()).toBe(true);
    t.started.find((one) => one.output === output)!.release();
    await t.settle(() => !t.registry.running());
    expect(t.registry.activity().find((one) => one.id === project.id)?.state).toBe("done");
    // The export's manifest is the one now: the file made ahead is spent.
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.json`)).toBe(false);
  } finally {
    t.done();
  }
});

test("an export of another project, or smooth playback for someone watching, takes the encoder from one made ahead", async () => {
  const t = setUp("ahead-yields");
  try {
    const first = await t.project("First");
    const second = await t.project("Second");
    const options = t.native.exportDefaults();
    expect(t.registry.startAhead(t.store, t.app.library, first, options, aheadFile(t.store.cacheDir(), first.id))).toBe(true);
    await t.settle(() => t.started.length === 1);
    // The Mac renders one at a time: the export asked for has it.
    const output = `${t.dir}/Second.mp4`;
    await t.registry.start(t.store, t.app.library, second, options, output, { drive: false, keepLocal: true });
    await t.settle(() => t.started.some((one) => one.output === output));
    expect(t.started[0]!.cancelled).toBe(true);
    expect(t.registry.aheadFor()).toBeNull();
    // Not while an export runs.
    expect(t.registry.startAhead(t.store, t.app.library, first, options, aheadFile(t.store.cacheDir(), first.id))).toBe(false);
    t.started.find((one) => one.output === output)!.release();
    await t.settle(() => !t.registry.running());
    // Smooth playback's render asks for a place: it gets it once the one made ahead lets go.
    expect(t.registry.startAhead(t.store, t.app.library, first, options, aheadFile(t.store.cacheDir(), first.id))).toBe(true);
    await t.settle(() => t.started.length === 3);
    let given: (() => void) | null = null;
    const turn = t.registry.takeTurn((release) => { given = release; });
    expect(turn.release).toBeNull();
    await t.settle(() => given !== null);
    expect(t.started[2]!.cancelled).toBe(true);
    (given as unknown as () => void)();
  } finally {
    t.done();
  }
});

test("an edit's export is made ahead with its next share's settings, unless it's on battery or already made", async () => {
  const t = setUp("ahead-when");
  const battery = ahead.hooks.onBattery;
  const smoothing = spyOn(seams.broll, "smoothingPending").mockReturnValue([]);
  try {
    const project = await t.project("Shared");
    // Its share asked for small pictures before: made ahead that way, for YouTube.
    fs.writeFileSync(`${t.home}/reviews.json`, JSON.stringify({ shareOptions: { [project.id]: { quality: "small" } } }));
    expect(ahead.nextShare(t.home, project.id).options).toMatchObject({ quality: "small", preset: "youtube", range: null, chapters: [] });
    ahead.hooks.onBattery = () => true;
    expect(ahead.tryNow(t.app, project.id)).toBe("on battery");
    ahead.hooks.onBattery = () => false;
    smoothing.mockReturnValue(["c1"]);
    expect(ahead.tryNow(t.app, project.id)).toBe("slowed shots still smoothing");
    smoothing.mockReturnValue([]);
    expect(ahead.tryNow(t.app, project.id)).toBeNull();
    await t.settle(() => t.started.length === 1);
    expect(t.started[0]).toMatchObject({ name: "Shared", background: true });
    expect(ahead.tryNow(t.app, project.id)).toBe("already making it");
    t.started[0]!.release();
    await t.settle(() => fs.existsSync(`${aheadFile(t.store.cacheDir(), project.id)}.json`));
    await t.settle(() => t.registry.aheadFor() === null);
    // Made of this very edit with these settings: nothing to do until it changes.
    expect(ahead.tryNow(t.app, project.id)).toBe("up to date");
    await t.store.update(project.id, "test", (p) => { p.clips[0]!.duration = 20; });
    expect(ahead.tryNow(t.app, project.id)).toBeNull();
    await t.settle(() => t.started.length === 2);
    await t.registry.stopAhead();
  } finally {
    ahead.hooks.onBattery = battery;
    smoothing.mockRestore();
    t.done();
  }
});
