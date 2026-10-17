import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { deleteExport, ExportRegistry, listExports } from "../src/exports.ts";

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
