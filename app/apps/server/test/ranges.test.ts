import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";

import { dispatch } from "../src/mcp/index.ts";
import { saveExportFolder } from "../src/export_folder.ts";
import type { App } from "../src/app.ts";
import { chunkFolder, listExports, listMade } from "../src/exports.ts";
import type { Project, Range } from "../src/model.ts";
import { fileName, join } from "../src/paths.ts";
import { batchOf, exportRanges, forgetBatches, latestBatch, tidy, timing, type Batch } from "../src/ranges.ts";
import * as tools from "../src/tools.ts";
import { fixtureHome, write, type Fixture } from "./helpers/home.ts";

let fixture: Fixture | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

test("marked stretches are kept in order, inside the edit, none empty or overlapping", () => {
  // Sphe, Nov 12: "go to all of the cut-ins and then set all the in and out points for me".
  expect(tidy([{ start: 300, end: 400, name: "b" }, { start: -10, end: 90, name: "a" }, { start: 350, end: 500, name: "c" }, { start: 900, end: 1200, name: "d" }, { start: 50, end: 50, name: "empty" }], 1000)).toEqual([
    { start: 0, end: 90, name: "a" },
    { start: 300, end: 400, name: "b" },
    { start: 400, end: 500, name: "c" },
    { start: 900, end: 1000, name: "d" },
  ]);
});

test("set_ranges marks stretches by time and clears them", async () => {
  fixture = fixtureHome("ranges-tool");
  const { app, store } = fixture;
  const id = store.create("r", { width: 1920, height: 1080, fps: 30 }).project.id;
  await store.update(id, "test", (project) => {
    project.clips.push({ id: "s", track: project.tracks[0]!.id, start: 0, duration: 900, color: "blue", fade_in: 0, fade_out: 0, type: "solid", fill: [0, 0, 0, 1] } as never);
  });
  const call = async (args: Record<string, unknown>) => ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "set_ranges", arguments: { project_id: id, ...args } } }, null)) as { result: { content: { text?: string }[]; isError: boolean } }).result;
  const set = await call({ ranges: [{ start: 2, end: 4, name: "Cut-in 1" }, { start: 10, end: 12 }] });
  expect(set.isError, set.content[0]?.text).toBe(false);
  expect(store.get(id)!.project.ranges).toEqual([{ start: 60, end: 120, name: "Cut-in 1" }, { start: 300, end: 360, name: "Part 2" }]);
  expect((await call({ ranges: [] })).content[0]!.text).toBe("marked stretches cleared");
  expect(store.get(id)!.project.ranges).toBeUndefined();
  expect((await call({})).isError).toBe(true);
  // Every cut-in: from its clips' names, the first of them to the end of the last.
  await store.update(id, "test", (project) => {
    const clip = (cid: string, start: number, duration: number, name: string) => ({ id: cid, track: project.tracks[0]!.id, start, duration, color: "blue", fade_in: 0, fade_out: 0, type: "solid", fill: [0, 0, 0, 1], name }) as never;
    project.clips = [clip("a", 0, 90, "Intro"), clip("b", 90, 60, "Cut-in 4 · B-roll look"), clip("c", 150, 30, "Cut-in 4 · B-roll: porch"), clip("d", 400, 30, "Cut-in 9 · B-roll: street")];
  });
  expect((await call({ cut_ins: true })).isError).toBe(false);
  expect(store.get(id)!.project.ranges).toEqual([{ start: 90, end: 180, name: "Cut-in 4" }, { start: 400, end: 430, name: "Cut-in 9" }]);
});

/** A home with its own exports folder and a project of 30 s of picture with `ranges` marked. */
function exportsHome(name: string, ranges: Range[]) {
  fixture = fixtureHome(name);
  const { app, store } = fixture;
  // Its own exports folder, not the computer's.
  const folder = join(fixture.home, "made");
  fs.mkdirSync(folder, { recursive: true });
  saveExportFolder(fixture.home, folder);
  const made = store.create("Joined", { width: 1920, height: 1080, fps: 30 }).project;
  const project: Project = { ...made, clips: [{ id: "s", track: made.tracks[0]!.id, start: 0, duration: 900, color: "blue", fade_in: 0, fade_out: 0, type: "solid", fill: [0, 0, 0, 1] } as never], ranges };
  return { app, home: fixture.home, folder, project };
}

/**
 * An export line as the registry is to a batch: each stretch asked of it
 * writes a second of test picture (and sound, unless `silent` says not), lists
 * it as the registry does, and writes the project's chunk manifest naming it;
 * one `fails` says leaves its file as it was.
 */
function fakeExports(app: App, home: string, project: Project, how: { silent?: (index: number) => boolean; fails?: (index: number) => boolean } = {}) {
  const asked: [number, number][] = [];
  let running = false;
  (app as unknown as { exports: unknown }).exports = {
    runningFor: () => (running ? { output: "", timeline: "", options: "" } : null),
    cancel: () => true,
    start: async (_store: unknown, _library: unknown, _project: unknown, options: { range: [number, number] }, output: string) => {
      const index = asked.length;
      asked.push(options.range);
      running = true;
      if (how.fails?.(index) !== true) {
        const sound = how.silent?.(index) === true ? [] : ["-f", "lavfi", "-i", "sine=duration=1", "-c:a", "aac", "-shortest"];
        await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1", ...sound, "-c:v", "libx264", "-pix_fmt", "yuv420p", output]);
        listMade(home, project.id, { path: output, name: output, finished_ms: Date.now(), seconds: 1, bytes: 1, frames: 30, whole: false, format: "h264" });
        write(join(chunkFolder(app.store.cacheDir(), project.id), "manifest-v1.json"), JSON.stringify({ output }));
      }
      running = false;
      return output;
    },
  };
  timing.poll = 20;
  return asked;
}

async function ended(batch: Batch): Promise<void> {
  for (let tries = 0; tries < 300 && !batch.finished; tries++) await Bun.sleep(50);
}

const probe = async (path: string, entries: string, streams: string[] = []) => new TextDecoder().decode(await tools.run([tools.ffprobe(), "-v", "error", ...streams, "-show_entries", entries, "-of", "csv=p=0", path])).trim();

test("marked stretches export one after another, and joined they're one video of them end to end", async () => {
  // The last one runs past the end of the edit, shortened since it was marked: what's left of the others is exported.
  const { app, home, folder, project } = exportsHome("ranges-export", [{ start: 0, end: 30, name: "One" }, { start: 60, end: 90, name: "Two" }, { start: 1000, end: 1100, name: "Gone" }]);
  // The first stretch has nothing heard (the engine exports it picture alone): the joined video has sound all the same.
  const asked = fakeExports(app, home, project, { silent: (index) => index === 0 });
  const manifest = join(chunkFolder(app.store.cacheDir(), project.id), "manifest-v1.json");
  write(manifest, "the last whole export's");
  const batch = exportRanges(app, project, { range: null, format: "h264" } as never, "joined", null);
  expect(batch.total).toBe(2);
  await ended(batch);
  expect(batch.error).toBeNull();
  expect(asked).toEqual([[0, 30], [60, 90]]);
  expect(batch.outputs).toHaveLength(1);
  expect(Number(await probe(batch.outputs[0]!, "format=duration"))).toBeGreaterThan(1.9);
  expect(await probe(batch.outputs[0]!, "stream=codec_type", ["-select_streams", "a"])).toBe("audio");
  expect(batch.outputs[0]!.startsWith(folder)).toBe(true);
  expect(fs.readdirSync(folder)).toEqual([fileName(batch.outputs[0]!)!]);
  // Listed, so its Download hands it out; its parts, gone, aren't.
  expect(listExports(home, project.id).map((one) => one.path)).toEqual(batch.outputs);
  // The edit's next export reuses its last one's chunks, not a stretch's.
  expect(fs.readFileSync(manifest, "utf8")).toBe("the last whole export's");
  // A restart keeps it, for its Download, while it's the last thing to happen to the edit's exports.
  forgetBatches();
  expect(batchOf(app, project.id)?.outputs).toEqual(batch.outputs);
  expect(latestBatch(app, project.id)?.outputs).toEqual(batch.outputs);
  listMade(home, project.id, { path: join(folder, "Joined.mp4"), name: "Joined.mp4", finished_ms: batch.finished_ms! + 1, seconds: 1, bytes: 1, frames: 900, whole: true, format: "h264" });
  expect(latestBatch(app, project.id)).toBeNull();
});

test("a joined batch that stops leaves none of its parts listed, nor a manifest of them", async () => {
  const { app, home, project } = exportsHome("ranges-stop", [{ start: 0, end: 30, name: "One" }, { start: 60, end: 90, name: "Two" }]);
  fakeExports(app, home, project, { fails: (index) => index === 1 });
  const batch = exportRanges(app, project, { range: null, format: "h264" } as never, "joined", null);
  await ended(batch);
  expect(batch.error).toBe("Two didn't export");
  expect(listExports(home, project.id)).toEqual([]);
  expect(fs.existsSync(join(chunkFolder(app.store.cacheDir(), project.id), "manifest-v1.json"))).toBe(false);
});

test("a stretch whose export fails isn't taken for done by the file a run before left", async () => {
  const { app, home, folder, project } = exportsHome("ranges-stale", [{ start: 0, end: 30, name: "One" }, { start: 60, end: 90, name: "Two" }]);
  write(join(folder, "Joined - Two.mp4"), "yesterday's");
  fakeExports(app, home, project, { fails: (index) => index === 1 });
  const batch = exportRanges(app, project, { range: null, format: "h264" } as never, "each", null);
  await ended(batch);
  expect(batch.error).toBe("Two didn't export");
  expect(batch.outputs).toEqual([join(folder, "Joined - One.mp4")]);
});

test("a project's exports of parts are listed apart from its whole exports", () => {
  fixture = fixtureHome("ranges-listed");
  const record = (path: string, whole: boolean, at: number) => ({ path, name: path, finished_ms: at, seconds: 1, bytes: 1, frames: 1, whole, format: "h264" });
  for (let n = 0; n < 31; n++) listMade(fixture.home, "p", record(`/w${n}.mp4`, true, n));
  // A batch of 40 cut-ins, after them.
  for (let n = 0; n < 40; n++) listMade(fixture.home, "p", record(`/c${n}.mp4`, false, 100 + n));
  const listed = listExports(fixture.home, "p");
  expect(listed.filter((one) => one.whole)).toHaveLength(30);
  expect(listed.filter((one) => !one.whole)).toHaveLength(40);
  // Newest first, still: the oldest whole export alone went.
  expect(listed[0]!.path).toBe("/c39.mp4");
  expect(listed.at(-1)!.path).toBe("/w1.mp4");
});
