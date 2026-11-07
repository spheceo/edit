// Files on the Mac running Edit, as the person sees them there (Sphe, Nov 4:
// a teammate clicked "Download export" in the desktop app again and again and
// couldn't tell where it went). The window is a page onto this Mac's server,
// so a browser download there is a second copy dropped somewhere unseen. Here
// instead:
//   - what the page makes (a thumbnail, a frame) is saved into Downloads by
//     the server, and the page says where with a Show in Finder;
//   - an export is shown in Finder, or copied to a folder the person picks;
//   - Settings → Storage lists every export Edit knows of on this Mac (its
//     exports list, and any other video in its export folders), with sizes,
//     to delete what isn't wanted.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import * as drive from "./drive.ts";
import { exportRoots } from "./export_folder.ts";
import * as cloud from "./cloud.ts";
import { beingRead, cloudKeyFor, listed } from "./exports.ts";
import { ioMessage, writeAtomic } from "./files.ts";
import { ApiError, bad, json, notFound } from "./http/errors.ts";
import { readBytes, readJson, type RouteContext, type Router } from "./http/router.ts";
import { extension, fileName, fileStem, homePath, isDir, isFile, join, parent, userHome } from "./paths.ts";
import * as reviews from "./reviews.ts";

type Context = RouteContext<App>;

/** Files this server saved for the person (Downloads): theirs to reveal. */
const saved = new Set<string>();

/** What an export file is, by its extension. */
const EXPORTED = /\.(mp4|mov|m4v|mp3|wav|m4a|aac|gif|png)$/i;

/** A free name for `name` in `folder`: "name.png", then "name (2).png"… */
export function freePath(folder: string, name: string): string {
  const clean = name.replace(/[/\\:\0]+/g, " ").trim() || "file";
  const ext = extension(clean);
  const stem = ext === null ? clean : (fileStem(clean) ?? clean);
  for (let n = 1; ; n++) {
    const candidate = join(folder, `${stem}${n === 1 ? "" : ` (${n})`}${ext === null ? "" : `.${ext}`}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/** Saves bytes the page made into the person's Downloads; the path. */
export function saveToDownloads(name: string, bytes: Uint8Array): string {
  const folder = join(userHome(), "Downloads");
  fs.mkdirSync(folder, { recursive: true });
  const path = freePath(folder, name);
  fs.writeFileSync(path, bytes);
  saved.add(path);
  return path;
}

/**
 * Shows `path` in Finder (or the file manager) on this machine. On Linux the
 * desktop's file manager is asked over D-Bus to show it selected (GNOME's
 * Files, Dolphin and the rest answer `org.freedesktop.FileManager1`), else its
 * folder is opened.
 */
export async function reveal(path: string): Promise<void> {
  const ran = async (command: string[]) => {
    try {
      return (await Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited) === 0;
    } catch {
      return false;
    }
  };
  if (process.platform === "darwin") {
    if (await ran(["open", "-R", path])) return;
  } else {
    const uri = `file://${path.split("/").map(encodeURIComponent).join("/")}`;
    const selected = await ran(["gdbus", "call", "--session", "--dest", "org.freedesktop.FileManager1", "--object-path", "/org/freedesktop/FileManager1", "--method", "org.freedesktop.FileManager1.ShowItems", `['${uri.replaceAll("'", "%27")}']`, ""]);
    if (selected || (await ran(["xdg-open", parent(path) || path]))) return;
  }
  throw new Error("couldn't open a file browser on this machine");
}

// ---------------------------------------------------------------- the exports on this Mac

interface Listed {
  path: string;
  name: string;
  finished_ms: number;
  cloudKey?: string;
}

/** One export file on this Mac, as Settings → Storage shows it. */
export interface StoredExport {
  path: string;
  /** Where it is, said from the home folder ("~/Movies/Edit/…"). */
  shown: string;
  name: string;
  bytes: number;
  /** When it was made (the file's time, for one Edit didn't list). */
  at: number;
  /** The project it's an export of; null for a file found in an export folder that Edit didn't list. */
  project: string | null;
  projectName: string | null;
  /** The project's newest export: a re-export copies its unchanged parts from it. */
  newest: boolean;
  /** A copy is kept in the cloud: deleting this one frees the Mac, the export stays. */
  inCloud: boolean;
  /** Exporting, being shared or uploading now: it can't be deleted yet. */
  busy: boolean;
}

function readListed(home: string): Record<string, Listed[]> {
  try {
    const value = JSON.parse(fs.readFileSync(join(home, "exports.json"), "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Listed[]>) : {};
  } catch {
    return {};
  }
}

function busy(app: App, project: string | null, path: string): boolean {
  if (beingRead(path)) return true;
  if (project === null) return false;
  try {
    if (app.exports.runningFor?.(project)?.output === path) return true;
  } catch {
    // No exports here (tests).
  }
  return reviews.sharingNow(project) || drive.uploading(project);
}

/**
 * Every export file on this Mac Edit knows of: each project's listed exports
 * still here, then any other export-like file in Edit's export folders (an
 * older build's, or a list that lost its entry). Largest first.
 */
export function storedExports(app: App): StoredExport[] {
  const home = app.store.home;
  const out: StoredExport[] = [];
  const seen = new Set<string>();
  for (const [project, own] of Object.entries(readListed(home))) {
    const newest = [...own].sort((a, b) => a.finished_ms - b.finished_ms).at(-1);
    for (const record of own) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(record.path);
      } catch {
        continue;
      }
      if (!stat.isFile() || seen.has(record.path)) continue;
      seen.add(record.path);
      out.push({
        path: record.path,
        shown: homePath(record.path),
        name: record.name || (fileName(record.path) ?? record.path),
        bytes: stat.size,
        at: record.finished_ms,
        project,
        projectName: app.store.get(project)?.project.name ?? null,
        newest: record === newest,
        inCloud: record.cloudKey !== undefined,
        busy: busy(app, project, record.path),
      });
    }
  }
  for (const root of exportRoots(home)) {
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(root, name);
      if (seen.has(path) || name.startsWith(".") || !EXPORTED.test(name)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      seen.add(path);
      out.push({ path, shown: homePath(path), name, bytes: stat.size, at: stat.mtimeMs, project: null, projectName: null, newest: false, inCloud: false, busy: busy(app, null, path) });
    }
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/**
 * Deletes export files the person picked in Settings → Storage. Only a file
 * that list shows is ever deleted, never one in use. A listed export with a
 * cloud copy keeps its entry (the export is still there to fetch back and
 * share); one without goes from the list with its file.
 */
export function deleteStored(app: App, paths: string[]): { files: number; bytes: number; refused: string[] } {
  const home = app.store.home;
  const known = new Map(storedExports(app).map((one) => [one.path, one]));
  const refused: string[] = [];
  const gone = new Set<string>();
  let bytes = 0;
  for (const path of paths) {
    const one = known.get(path);
    if (one === undefined) {
      refused.push(`${homePath(path)}: not one of Edit's exports on this Mac`);
      continue;
    }
    if (one.busy) {
      refused.push(`${one.name}: in use (exporting, sharing or uploading)`);
      continue;
    }
    try {
      fs.rmSync(path, { force: true });
    } catch (error) {
      refused.push(`${one.name}: ${ioMessage(error)}`);
      continue;
    }
    gone.add(path);
    bytes += one.bytes;
    diag.info("export", `deleted ${one.shown} (${(one.bytes / 1e9).toFixed(2)} GB) from Settings → Storage${one.projectName ? `, an export of ${one.projectName}` : ""}`);
  }
  if (gone.size > 0) {
    const records = readListed(home);
    let changed = false;
    for (const [project, own] of Object.entries(records)) {
      const kept = own.filter((record) => !gone.has(record.path) || record.cloudKey !== undefined);
      if (kept.length !== own.length) {
        records[project] = kept;
        changed = true;
      }
    }
    if (changed) writeAtomic(join(home, "exports.json"), JSON.stringify(records, null, 1));
  }
  return { files: gone.size, bytes, refused };
}

/** Copies an export to a folder the person picked (fetched back from the cloud when only its copy there is left); the copy's path. */
export async function copyExport(app: App, path: string, folder: string): Promise<string> {
  if (!app.exports.exported(path) && !listed(app.store.home, path)) throw new Error("not one of Edit's exports");
  if (!isDir(folder)) throw new Error("pick a folder");
  const to = freePath(folder, fileName(path) ?? "export.mp4");
  if (isFile(path)) fs.copyFileSync(path, to);
  else {
    const key = cloudKeyFor(app.store.home, path);
    if (key === null) throw new Error("that export isn't on this Mac or in the cloud any more");
    await cloud.download(key, to);
  }
  saved.add(to);
  return to;
}

// ---------------------------------------------------------------- routes

const LIMIT = 100 * 1024 * 1024;

export function routes(router: Router<App>): void {
  router
    .post(
      "/api/files/save",
      async (context: Context) => {
        const name = context.query.get("name") ?? "";
        if (name.trim() === "") throw bad("name is required");
        try {
          return json({ path: saveToDownloads(name, await readBytes(context.request, LIMIT)) });
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw bad(ioMessage(error));
        }
      },
      { bodyLimit: LIMIT },
    )
    .post("/api/files/reveal", async (context: Context) => {
      const { path } = await readJson<{ path?: unknown }>(context);
      if (typeof path !== "string" || path === "") throw bad("path is required");
      const known = saved.has(path) || context.app.exports.exported(path) || storedExports(context.app).some((one) => one.path === path);
      if (!known || !fs.existsSync(path)) throw notFound("not a file Edit made on this Mac");
      try {
        await reveal(path);
      } catch (error) {
        throw bad(diag.messageOf(error));
      }
      return json({ ok: true });
    })
    .post("/api/exports/copy", async (context: Context) => {
      const { path, folder } = await readJson<{ path?: unknown; folder?: unknown }>(context);
      if (typeof path !== "string" || typeof folder !== "string") throw bad("path and folder are required");
      try {
        return json({ path: await copyExport(context.app, path, folder) });
      } catch (error) {
        throw bad(diag.messageOf(error));
      }
    })
    .get("/api/storage/exports", ({ app }: Context) => {
      let free: number | null = null;
      try {
        const disk = fs.statfsSync(app.store.home);
        free = disk.bavail * disk.bsize;
      } catch {
        free = null;
      }
      return json({ exports: storedExports(app), free });
    })
    .post("/api/storage/exports/delete", async (context: Context) => {
      const { paths } = await readJson<{ paths?: unknown }>(context);
      if (!Array.isArray(paths) || paths.some((one) => typeof one !== "string")) throw bad("paths is a list of files");
      return json(deleteStored(context.app, paths as string[]));
    });
}
