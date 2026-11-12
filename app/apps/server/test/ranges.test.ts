import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";

import { dispatch } from "../src/mcp/index.ts";
import { saveExportFolder } from "../src/export_folder.ts";
import { listExports } from "../src/exports.ts";
import { join } from "../src/paths.ts";
import { batchOf, exportRanges, forgetBatches, tidy, timing } from "../src/ranges.ts";
import * as tools from "../src/tools.ts";
import { fixtureHome, type Fixture } from "./helpers/home.ts";

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

test("marked stretches export one after another, and joined they're one video of them end to end", async () => {
  fixture = fixtureHome("ranges-export");
  const { app, store } = fixture;
  // Its own exports folder, not the computer's.
  const folder = join(fixture.home, "made");
  fs.mkdirSync(folder, { recursive: true });
  saveExportFolder(fixture.home, folder);
  const project = { ...store.create("Joined", { width: 1920, height: 1080, fps: 30 }).project, ranges: [{ start: 0, end: 30, name: "One" }, { start: 60, end: 90, name: "Two" }] };
  // An export line that writes a second of test picture and sound for each stretch asked of it.
  const asked: [number, number][] = [];
  let running = false;
  (app as unknown as { exports: unknown }).exports = {
    runningFor: () => (running ? { output: "", timeline: "", options: "" } : null),
    cancel: () => true,
    start: async (_store: unknown, _library: unknown, _project: unknown, options: { range: [number, number] }, output: string) => {
      asked.push(options.range);
      running = true;
      await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1", "-f", "lavfi", "-i", "sine=duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", output]);
      running = false;
      return output;
    },
  };
  timing.poll = 20;
  const batch = exportRanges(app, project, { range: null } as never, "joined", null);
  for (let tries = 0; tries < 300 && !batch.finished; tries++) await Bun.sleep(50);
  expect(batch.error).toBeNull();
  expect(asked).toEqual([[0, 30], [60, 90]]);
  expect(batch.outputs).toHaveLength(1);
  const length = Number(new TextDecoder().decode(await tools.run([tools.ffprobe(), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", batch.outputs[0]!])).trim());
  expect(length).toBeGreaterThan(1.9);
  expect(fs.existsSync(batch.outputs[0]!)).toBe(true);
  expect(batch.outputs[0]!.startsWith(folder)).toBe(true);
  // Listed, so its Download hands it out; its parts, gone, aren't.
  expect(listExports(fixture.home, project.id).map((one) => one.path)).toEqual(batch.outputs);
  // A restart keeps it, for its Download.
  forgetBatches();
  expect(batchOf(app, project.id)?.outputs).toEqual(batch.outputs);
});
