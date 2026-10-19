import { expect, spyOn, test } from "bun:test";
import * as relay from "../src/relay.ts";
import * as seams from "../src/seams.ts";
import { Jobs, start } from "../src/script.ts";
import { fixtureHome } from "./helpers/home.ts";

test("script downloads overlap in three slots and a failed file does not strand the others", async () => {
  const scripts = new Jobs();
  const { app, store, cleanup } = fixtureHome("parallel-downloads", { services: { scripts } });
  const before = process.env.EDIT_PARALLEL_DOWNLOADS;
  process.env.EDIT_PARALLEL_DOWNLOADS = "1";
  const cloud = spyOn(relay, "cloudEnabled").mockReturnValue(true);
  const researched = spyOn(seams.research, "articles").mockReturnValue([{ id: "fixture", title: "Fixture", url: "https://example.test", outlet: "Fixture", text: "", summary: "" }]);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let active = 0, peak = 0, entered = 0;
  const download = spyOn(seams.cloudMedia, "driveOriginal").mockImplementation(async () => {
    entered++; active++; peak = Math.max(peak, active);
    if (entered <= 3) await barrier;
    active--;
    throw new Error("fixture transfer failed");
  });
  let work: Promise<void> | null = null;
  try {
    const id = store.create("downloads", { width: 64, height: 36, fps: 30 }).project.id;
    await store.update(id, "test", p => {
      p.style = "courtroom";
      p.script = { blocks: Array.from({ length: 4 }, (_, i) => ({ kind: "footage", file: `FILEabcdef${i}`, url: "", start: 0, end: 1, label: "00:00–00:01" })) };
    });
    work = start(app, id, false);
    for (let i = 0; entered < 3 && i < 100; i++) await Bun.sleep(1);
    expect(entered).toBe(3);
    expect(peak).toBe(3);
    expect(scripts.get(id)!.files.map(f => f.state)).toEqual(["downloading", "downloading", "downloading", "queued"]);
    release();
    await work;
    expect(entered).toBe(4);
    expect(peak).toBe(3);
    expect(scripts.get(id)!.files.every(f => f.state === "failed")).toBe(true);
  } finally {
    release(); await work;
    download.mockRestore(); cloud.mockRestore(); researched.mockRestore();
    if (before === undefined) delete process.env.EDIT_PARALLEL_DOWNLOADS; else process.env.EDIT_PARALLEL_DOWNLOADS = before;
    cleanup();
  }
});
