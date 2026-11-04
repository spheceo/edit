import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { ExportRegistry } from "../src/exports.ts";
import { deleteStored, freePath, saveToDownloads, storedExports } from "../src/local_files.ts";
import { fixtureHome } from "./helpers/home.ts";

test("Storage lists Edit's exports on this Mac, deletes only those, and keeps a cloud copy's entry", () => {
  const { home, app, cleanup } = fixtureHome("local-files");
  app.exports = new ExportRegistry(home);
  try {
    const dir = `${home}/exports`;
    fs.mkdirSync(dir, { recursive: true });
    const [old, newest, archived, stray] = ["v1.mp4", "v2.mp4", "v0.mp4", "stray.mov"].map((name) => `${dir}/${name}`);
    for (const path of [old, newest, archived, stray]) fs.writeFileSync(path!, "x".repeat(10));
    fs.writeFileSync(`${dir}/notes.txt`, "not an export");
    const entry = (path: string, finished: number, cloudKey?: string) => ({ path, name: path.split("/").pop(), finished_ms: finished, bytes: 10, ...(cloudKey ? { cloudKey } : {}) });
    fs.writeFileSync(`${home}/exports.json`, JSON.stringify({ p: [entry(archived!, 1, "edit/exports/p/v0.mp4"), entry(old!, 2), entry(newest!, 3)] }));

    const listed = storedExports(app);
    expect(listed.map((one) => one.name).sort()).toEqual(["stray.mov", "v0.mp4", "v1.mp4", "v2.mp4"]);
    expect(listed.find((one) => one.path === newest)).toMatchObject({ project: "p", newest: true });
    expect(listed.find((one) => one.path === stray)).toMatchObject({ project: null, newest: false });
    expect(listed.find((one) => one.path === archived)?.inCloud).toBe(true);

    const done = deleteStored(app, [old!, archived!, stray!, `${dir}/notes.txt`, `${home}/exports.json`]);
    expect(done.files).toBe(3);
    expect(done.refused).toHaveLength(2);
    expect(fs.existsSync(`${dir}/notes.txt`)).toBe(true);
    expect(fs.existsSync(`${home}/exports.json`)).toBe(true);
    // The archived one keeps its entry (its cloud copy is the export now); the other goes from the list with its file.
    const left = JSON.parse(fs.readFileSync(`${home}/exports.json`, "utf8")) as { p: { path: string }[] };
    expect(left.p.map((one) => one.path)).toEqual([archived!, newest!]);
  } finally {
    cleanup();
  }
});

test("a saved file never overwrites one already there", () => {
  const { home, cleanup } = fixtureHome("free-path");
  try {
    fs.writeFileSync(`${home}/frame.png`, "");
    fs.writeFileSync(`${home}/frame (2).png`, "");
    expect(freePath(home, "frame.png")).toBe(`${home}/frame (3).png`);
    expect(freePath(home, "a/b:c.png")).toBe(`${home}/a b c.png`);
  } finally {
    cleanup();
  }
});

test("Save image as… writes into the folder picked, never over a file there, and refuses one that isn't a folder", () => {
  const { home, cleanup } = fixtureHome("save-as");
  try {
    fs.writeFileSync(`${home}/Thumb.jpg`, "old");
    const path = saveToDownloads("Thumb.jpg", new TextEncoder().encode("new"), home);
    expect(path).toBe(`${home}/Thumb (2).jpg`);
    expect(fs.readFileSync(path, "utf8")).toBe("new");
    expect(fs.readFileSync(`${home}/Thumb.jpg`, "utf8")).toBe("old");
    expect(() => saveToDownloads("Thumb.jpg", new Uint8Array(), `${home}/nowhere`)).toThrow("pick a folder");
  } finally {
    cleanup();
  }
});
