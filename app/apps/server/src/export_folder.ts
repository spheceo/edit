// Where this Mac's exports go, once someone has picked a folder
// (`<home>/export-folder.json`). Until then nothing is saved: exports use the
// suggested folder (`paths.defaultExportsDir`, ~/Movies/Edit or ~/Videos/Edit)
// and the editor asks them to choose. A later export uses the saved folder.
// The old Movies folder stays a place retention may clean, so files written
// before the change are not stranded.

import * as fs from "node:fs";

import { writeAtomic } from "./files.ts";
import { defaultExportsDir, expandHome, homePath, isDir, join, parent, userHome } from "./paths.ts";
import { THIS_MACHINE } from "./machine.ts";

const FILE = "export-folder.json";

/** The folder future exports are written into, and whether anyone saved that choice. */
export interface ExportFolder {
  /** Absolute folder. The suggestion when `chosen` is false. */
  path: string;
  /** `path` with home as `~`. */
  shown: string;
  /** Saved in `export-folder.json`. False: `path` is only the suggestion. */
  chosen: boolean;
  /** ~/Movies/Edit, or ~/Videos/Edit when Movies isn't a folder. */
  suggested: string;
  /** `suggested` with home as `~`. */
  suggestedShown: string;
  /** This Mac's home, so the picker can write other folders as `~/…`. */
  home: string;
}

/** The folder a new export is written into: the saved one, or the suggestion. */
export function exportsDir(home: string): string {
  return readExportFolder(home).path;
}

/** The saved folder, the suggestion, and `<home>/exports`: retention may clean any of them. */
export function exportRoots(home: string): string[] {
  return [...new Set([exportsDir(home), defaultExportsDir(), join(home, "exports")])];
}

/** Reads the choice. A missing file, bad JSON, or a folder that is gone counts as not chosen. */
export function readExportFolder(home: string): ExportFolder {
  const suggested = defaultExportsDir();
  const saved = readSaved(home);
  const path = saved ?? suggested;
  return { path, shown: homePath(path), chosen: saved !== null, suggested, suggestedShown: homePath(suggested), home: userHome() };
}

/**
 * Remembers `given` as the exports folder. An existing directory is kept as
 * its real path. One new directory is created when its parent exists. The
 * suggested folder is created even when its parents are missing (`~/Videos/Edit`
 * on a Mac with neither Movies nor Videos).
 */
export function saveExportFolder(home: string, given: string): ExportFolder {
  const expanded = expandHome(given.trim());
  if (expanded === "" || expanded === ".") throw new Error("pick a folder");
  let path = expanded;
  if (!isDir(path)) {
    if (fs.existsSync(path)) throw new Error("that isn't a folder");
    const suggested = defaultExportsDir();
    if (path === suggested) fs.mkdirSync(path, { recursive: true });
    else {
      const above = parent(path);
      if (above === null || !isDir(above)) throw new Error(`that folder isn't on ${THIS_MACHINE}`);
      fs.mkdirSync(path);
    }
  }
  if (!isDir(path)) throw new Error("that isn't a folder");
  path = fs.realpathSync(path);
  fs.mkdirSync(home, { recursive: true });
  writeAtomic(join(home, FILE), `${JSON.stringify({ path })}\n`);
  return readExportFolder(home);
}

function readSaved(home: string): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(join(home, FILE), "utf8")) as { path?: unknown };
    return typeof value?.path === "string" && value.path !== "" && isDir(value.path) ? value.path : null;
  } catch {
    return null;
  }
}
