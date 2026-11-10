// What a restart cut after it was up isn't sent again (Sphe, Nov 10: an update
// goes through at any time, and nothing it cuts is uploaded twice): a finished
// export's archive and a review's full-quality file ask the cloud first.

import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as cloud from "../src/cloud.ts";
import { archiveExportFile, archiveFinished, dropLeftSnapshot, exportCloud, listExports, type ExportRecord } from "../src/exports.ts";
import * as jobs from "../src/jobs.ts";
import { fullBehind } from "../src/reviews.ts";

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), "edit-once-"));

test("an export already up isn't uploaded again", async () => {
  const dir = folder();
  try {
    const file = path.join(dir, "Out.mp4");
    fs.writeFileSync(file, Buffer.alloc(50));
    let sent = 0;
    const io = (size: number) => ({ enabled: () => true, upload: async () => void (sent += 1), head: async () => ({ size }) });
    // Carried on after a restart, and its size there: not sent again.
    expect(await archiveExportFile(file, "edit/exports/p/Out.mp4", io(50), () => 100e9, undefined, true)).toBe(true);
    expect(sent).toBe(0);
    // Another size there (an older export of the name): this one goes up.
    expect(await archiveExportFile(file, "edit/exports/p/Out.mp4", io(49), () => 100e9, undefined, true)).toBe(false);
    expect(sent).toBe(1);
    // Right after its export, what's there is the export it writes over, whatever its size: this one goes up.
    expect(await archiveExportFile(file, "edit/exports/p/Out.mp4", io(50), () => 100e9)).toBe(true);
    expect(sent).toBe(2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an archive a restart cut after its upload asks the cloud first and isn't sent again", async () => {
  const home = folder();
  try {
    const output = path.join(home, "Case.mp4");
    fs.writeFileSync(output, Buffer.alloc(50));
    const key = "edit/exports/p1/Case.mp4";
    const record: ExportRecord = { path: output, name: "Case.mp4", finished_ms: 1, seconds: 1, bytes: 50, frames: 30, whole: true, format: "h264", cloudKey: key };
    // Its job, begun by the run before this one.
    fs.writeFileSync(path.join(home, "jobs.json"), JSON.stringify([{ key: "archive:p1", kind: "archive", project: "p1", args: { output, key, record }, state: "running", attempts: 1, started_ms: 1, updated_ms: 1 }]));
    let sent = 0;
    spies.push(
      spyOn(exportCloud, "head").mockImplementation(async () => ({ size: 50 })),
      spyOn(exportCloud, "upload").mockImplementation(async () => void (sent += 1)),
    );
    await archiveFinished(home, "p1", output, key, record);
    expect(sent).toBe(0);
    expect(listExports(home, "p1")).toEqual([expect.objectContaining({ cloudKey: key })]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an archive whose file went after it was up is listed from the cloud; one with nothing anywhere is crossed off", async () => {
  const home = folder();
  try {
    const output = path.join(home, "Case.mp4");
    const key = "edit/exports/p1/Case.mp4";
    const record: ExportRecord = { path: output, name: "Case.mp4", finished_ms: 1, seconds: 1, bytes: 1234, frames: 30, whole: true, format: "h264" };
    spies.push(spyOn(exportCloud, "head").mockImplementation(async () => ({ size: 1234 })));
    await archiveFinished(home, "p1", output, key, record);
    expect(listExports(home, "p1")).toEqual([expect.objectContaining({ path: output, cloudKey: key, missing: false })]);
    spies.splice(0).forEach((spy) => spy.mockRestore());
    spies.push(spyOn(exportCloud, "head").mockImplementation(async () => null));
    await expect(archiveFinished(home, "p2", output, key, record)).rejects.toBeInstanceOf(jobs.Gone);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a share's export's kept timeline the last run left goes; one this run wrote stays", () => {
  const home = folder();
  try {
    const snapshot = path.join(home, "jobs", "export-p1.json");
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    fs.writeFileSync(snapshot, "{}");
    dropLeftSnapshot(home, "p1", { snapshot });
    expect(fs.existsSync(snapshot)).toBe(true);
    const before = new Date(performance.timeOrigin - 60_000);
    fs.utimesSync(snapshot, before, before);
    // Only the file Edit keeps for it.
    dropLeftSnapshot(home, "p1", { snapshot: path.join(home, "elsewhere.json") });
    expect(fs.existsSync(snapshot)).toBe(true);
    dropLeftSnapshot(home, "p1", { snapshot });
    expect(fs.existsSync(snapshot)).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a review's full-quality file already up goes straight to telling the review", async () => {
  const home = folder();
  try {
    const file = path.join(home, "Case.mp4");
    fs.writeFileSync(file, "export");
    const told: Record<string, unknown>[] = [];
    let sent = 0;
    spies.push(
      spyOn(cloud, "head").mockImplementation(async () => ({ size: 6 }) as never),
      spyOn(cloud, "uploadFile").mockImplementation(async () => void (sent += 1)),
      spyOn(cloud, "mutation").mockImplementation(async (_name: string, args: unknown) => (told.push((args as { meta: Record<string, unknown> }).meta), null as never)),
    );
    await fullBehind(home, "p1", "Case", file, "edit/reviews/p1/t/full.mp4", 2);
    expect(sent).toBe(0);
    expect(told.at(-1)).toEqual({ fullKey: "edit/reviews/p1/t/full.mp4", fullUpload: null });
    expect(jobs.list(home, "full")).toEqual([]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
