import * as fs from "node:fs";
import * as os from "node:os";

import { expect, test } from "bun:test";

import { exportRoots, readExportFolder, saveExportFolder } from "../src/export_folder.ts";
import type { Project } from "../src/model.ts";
import { defaultExportsDir } from "../src/paths.ts";
import { defaultExportPath } from "../src/server_seam.ts";
import type { Store } from "../src/store.ts";
import { THIS_MACHINE } from "../src/machine.ts";

test("exports stay in the suggested folder until a folder is saved", () => {
  const home = fs.mkdtempSync(`${os.tmpdir()}/edit-export-folder-`);
  try {
    const folder = readExportFolder(home);
    expect(folder.chosen).toBe(false);
    expect(folder.path).toBe(defaultExportsDir());
    expect(folder.shown.endsWith("/Movies/Edit") || folder.shown.endsWith("/Videos/Edit")).toBe(true);
    expect(defaultExportPath({ home } as Store, { name: "Teen: the edit?" } as Project)).toBe(`${defaultExportsDir()}/Teen_ the edit_.mp4`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a saved folder is where the next export goes, and retention still knows the old one", () => {
  const home = fs.mkdtempSync(`${os.tmpdir()}/edit-export-folder-`);
  const parent = fs.mkdtempSync(`${os.tmpdir()}/edit-export-dest-`);
  try {
    const created = saveExportFolder(home, `${parent}/Renders`);
    expect(created.chosen).toBe(true);
    expect(created.path).toBe(fs.realpathSync(`${parent}/Renders`));
    expect(fs.statSync(created.path).isDirectory()).toBe(true);
    expect(defaultExportPath({ home } as Store, { name: "Teen: the edit?" } as Project)).toBe(`${created.path}/Teen_ the edit_.mp4`);
    expect(exportRoots(home)).toEqual(expect.arrayContaining([created.path, defaultExportsDir(), `${home}/exports`]));
    fs.rmSync(created.path, { recursive: true });
    expect(readExportFolder(home).chosen).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a file, or a folder whose parent is missing, is refused", () => {
  const home = fs.mkdtempSync(`${os.tmpdir()}/edit-export-folder-`);
  const parent = fs.mkdtempSync(`${os.tmpdir()}/edit-export-dest-`);
  try {
    const file = `${parent}/clip.mp4`;
    fs.writeFileSync(file, "x");
    expect(() => saveExportFolder(home, file)).toThrow("that isn't a folder");
    expect(() => saveExportFolder(home, `${parent}/missing/Edit`)).toThrow(`that folder isn't on ${THIS_MACHINE}`);
    expect(() => saveExportFolder(home, "  ")).toThrow("pick a folder");
    expect(readExportFolder(home).chosen).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
