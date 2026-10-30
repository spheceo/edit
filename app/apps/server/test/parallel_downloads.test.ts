import { expect, spyOn, test } from "bun:test";
import * as relay from "../src/relay.ts";
import * as seams from "../src/seams.ts";
import { Jobs, replaceFootage, skipFootage, start, timing } from "../src/script.ts";
import { fixtureHome } from "./helpers/home.ts";
import { importStatus } from "../src/edit_tools.ts";

test("script downloads overlap in three slots and a failed file does not strand the others", async () => {
  const scripts = new Jobs();
  const { app, store, cleanup } = fixtureHome("parallel-downloads", { services: { scripts } });
  const before = process.env.EDIT_PARALLEL_DOWNLOADS;
  process.env.EDIT_PARALLEL_DOWNLOADS = "1";
  const cloud = spyOn(relay, "cloudEnabled").mockReturnValue(true);
  // Tried again at once (the pauses are minutes in use): every try fails here.
  const waits = timing.retryWaits;
  timing.retryWaits = [0];
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
    // Each tried twice (once again by itself), never more than three at a time.
    expect(entered).toBe(8);
    expect(peak).toBe(3);
    expect(scripts.get(id)!.files.every(f => f.state === "failed")).toBe(true);
    // Nothing laid out with holes: the import waits for the person.
    expect(scripts.get(id)!.state).toBe("waiting");
    expect(store.get(id)!.project.clips).toEqual([]);
  } finally {
    release(); await work;
    timing.retryWaits = waits;
    download.mockRestore(); cloud.mockRestore(); researched.mockRestore();
    if (before === undefined) delete process.env.EDIT_PARALLEL_DOWNLOADS; else process.env.EDIT_PARALLEL_DOWNLOADS = before;
    cleanup();
  }
});

test("footage that can't be fetched waits for the person: another link, or go on without it", async () => {
  const scripts = new Jobs();
  const { app, store, cleanup } = fixtureHome("missing-footage", { services: { scripts } });
  const cloud = spyOn(relay, "cloudEnabled").mockReturnValue(true);
  const asked: string[] = [];
  // A file nobody shared: retrying can't help, so Edit doesn't, and asks.
  const drive = spyOn(seams.cloudMedia, "driveOriginal").mockImplementation(async (file: string) => {
    asked.push(file);
    throw new Error("This Drive file isn't shared. Set it so anyone with the link can view.");
  });
  const youtube = spyOn(seams.cloudMedia, "youtubeOriginal").mockImplementation(async (_home: string, file: string) => {
    asked.push(file);
    throw new Error("YouTube video abcdefghijk couldn't be downloaded: Private video");
  });
  const settle = async (id: string) => {
    for (let i = 0; i < 500 && ["downloading", "transcribing", "placing", "voicing"].includes(scripts.get(id)?.state ?? "downloading"); i++) await Bun.sleep(2);
  };
  try {
    const id = store.create("missing", { width: 64, height: 36, fps: 30 }).project.id;
    await store.update(id, "test", (p) => {
      p.style = "courtroom";
      p.script = {
        blocks: [
          { kind: "footage", file: "FILEcase0001", url: "https://drive.google.com/file/d/FILEcase0001/view", start: 0, end: 1, label: "00:00–00:01", notes: ["Case 1: link"] },
          { kind: "footage", file: "FILEcase0002", url: "https://drive.google.com/file/d/FILEcase0002/view", start: 0, end: 1, label: "00:00–00:01", notes: ["Case 2: link"] },
        ],
      };
    });
    void start(app, id, false);
    await settle(id);
    expect(asked).toEqual(["FILEcase0001", "FILEcase0002"]);
    expect(scripts.get(id)!.state).toBe("waiting");
    expect(store.get(id)!.project.clips).toEqual([]);
    // The agent hears it, by the names the person knows, and is told to ask.
    const said = importStatus(app, store.get(id)!.project) as { state: string; missing: { file: string; label: string; why: string }[]; ask: string };
    expect(said.state).toBe("waiting");
    expect(said.missing.map((one) => [one.file, one.label])).toEqual([["FILEcase0001", "Case 1"], ["FILEcase0002", "Case 2"]]);
    expect(said.ask).toContain("replace_footage");

    // Not a single video: said, and nothing changes.
    await expect(replaceFootage(app, id, "FILEcase0001", "https://drive.google.com/drive/folders/1abcdefghijkl")).rejects.toThrow("Give a link to one video");
    // A replacement: case 1's blocks take the new link, and the import carries on.
    await replaceFootage(app, id, "FILEcase0001", "https://youtu.be/abcdefghijk");
    await settle(id);
    const footage = store.get(id)!.project.script!.blocks.filter((block) => block.kind === "footage");
    expect(footage.map((block) => block.file)).toEqual(["youtube:abcdefghijk", "FILEcase0002"]);
    expect(asked.slice(2).sort()).toEqual(["FILEcase0002", "youtube:abcdefghijk"]);
    expect(scripts.get(id)!.state).toBe("waiting");

    // Going on without case 2: its ranges leave the script; the last footage can't go.
    await skipFootage(app, id, "FILEcase0002");
    await settle(id);
    expect(store.get(id)!.project.script!.blocks.map((block) => block.kind === "footage" && block.file)).toEqual(["youtube:abcdefghijk"]);
    await expect(skipFootage(app, id, "youtube:abcdefghijk")).rejects.toThrow("That's the only footage in the script");
  } finally {
    drive.mockRestore();
    youtube.mockRestore();
    cloud.mockRestore();
    cleanup();
  }
});
