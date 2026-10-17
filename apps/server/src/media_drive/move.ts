// Moving what's in the data folder to the media drive (`edit media move`) and
// the `edit media` command (media_drive.rs's CLI half; the layout is layout.ts).

import * as fs from "node:fs";

import * as diag from "../diag.ts";
import { ioMessage } from "../files.ts";
import { native } from "../native/index.ts";
import { canonical, join, parent } from "../paths.ts";
import { Store } from "../store.ts";
import {
  check,
  ENV,
  Layout,
  LOCK,
  MOVABLE,
  MOVING,
  moveCommand,
  mounted,
  prepare,
  size,
  sources,
  status,
} from "./layout.ts";

export interface MoveReport {
  to: string;
  /** Files in the data folder's media folders when the move started. */
  files: number;
  bytes: number;
  /** Copied this time. */
  copied: number;
  copied_bytes: number;
  /** Already on the drive, whole, from an earlier run. */
  already: number;
  /** Originals removed once their copy was checked. */
  removed: number;
  /** Projects now pointing at the drive. */
  projects: number;
  /** Files left where they were, and why. */
  problems: string[];
}

type Copied = { made: number } | "already";

/** A file's size and modification time, the time to the nanosecond (what a move must keep exactly). */
function stamp(path: string): { file: boolean; len: bigint; mtime: bigint } {
  const meta = fs.statSync(path, { bigint: true });
  return { file: meta.isFile(), len: meta.size, mtime: meta.mtimeNs };
}

function sameFile(meta: { file: boolean; len: bigint; mtime: bigint }, len: bigint, modified: bigint): boolean {
  return meta.file && meta.len === len && meta.mtime === modified;
}

function exists(path: string): boolean {
  try {
    fs.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies `from` to `to` through a `.edit-moving` file, keeping its
 * modification time, and only names it `to` once its size and time match the
 * original's. A whole copy already there is left alone; a different file there
 * is never overwritten.
 */
export function copyChecked(from: string, to: string): Copied {
  let original: ReturnType<typeof stamp>;
  try {
    original = stamp(from);
  } catch (error) {
    throw new Error(ioMessage(error));
  }
  const { len, mtime: modified } = original;
  if (exists(to)) {
    let there: ReturnType<typeof stamp> | null = null;
    try {
      there = stamp(to);
    } catch {
      there = null;
    }
    if (there !== null && sameFile(there, len, modified)) return "already";
    throw new Error(`${to} is on the media drive already and differs from this one (size or date): both kept`);
  }
  const folder = parent(to);
  if (folder === null) throw new Error(`${to} has no folder`);
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (error) {
    throw new Error(`${folder}: ${ioMessage(error)}`);
  }
  const partial = `${to}${MOVING}`;
  try {
    // Truncates what an interrupted run left.
    const source = fs.openSync(from, "r");
    let copy: number | null = null;
    try {
      copy = fs.openSync(partial, "w");
      const buffer = Buffer.allocUnsafe(4 << 20);
      for (;;) {
        const read = fs.readSync(source, buffer, 0, buffer.length, null);
        if (read === 0) break;
        let written = 0;
        while (written < read) written += fs.writeSync(copy, buffer, written, read - written);
      }
      // Its times to the nanosecond (Node's utimes takes doubles, which can't hold them).
      const touched = Bun.spawnSync(["touch", "-r", from, partial], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      if (touched.exitCode !== 0) throw new Error(touched.stderr.toString().trim() || "couldn't set its modification time");
      fs.fsyncSync(copy);
    } finally {
      fs.closeSync(source);
      if (copy !== null) fs.closeSync(copy);
    }
    const now = stamp(from);
    if (!sameFile(now, len, modified)) throw new Error("it changed while it was being copied");
    const copied = stamp(partial);
    if (copied.len !== len) throw new Error(`the copy has ${copied.len} of its ${len} bytes`);
    if (copied.mtime !== modified) {
      throw new Error(
        "the media drive didn't keep its modification time exactly (format the drive as APFS); previews and transcripts are found by it",
      );
    }
    fs.renameSync(partial, to);
    return { made: Number(len) };
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw new Error(`${from}: ${error instanceof Error && !("code" in error) ? error.message : ioMessage(error)}`);
  }
}

/** Removes the empty folders left under `dir` (not `dir` itself). */
function removeEmpty(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    removeEmpty(path);
    try {
      fs.rmdirSync(path);
    } catch {
      // Still holds something.
    }
  }
}

/**
 * Moves the data folder's media (`media/`, `uploads/`) to `to` and makes it
 * the media folder. Every file is copied and checked (size and modification
 * time) first; then projects are pointed at the copies; only then do the
 * originals go, each checked against its copy once more. Run again after an
 * interruption, it carries on: whole copies are kept, half-made ones made
 * again, and nothing is removed that hasn't a checked copy.
 */
export function moveMedia(store: Store, to: string, dryRun: boolean, say: (line: string) => void): Promise<MoveReport> {
  const subject = `${store.layout().home} → ${to}`;
  return diag.timeOnAsync("media", "media: move", subject, () => moveUntil(store, to, dryRun, null, say));
}

/** `moveMedia`, stopping (as if interrupted) before copying file `stopBefore` when given. */
export async function moveUntil(
  store: Store,
  to: string,
  dryRun: boolean,
  stopBefore: number | null,
  say: (line: string) => void,
): Promise<MoveReport> {
  let layout = store.layout();
  const files = sources(layout.home);
  let bytes = 0;
  for (const path of files) {
    try {
      bytes += fs.statSync(path).size;
    } catch {
      // Gone since the walk.
    }
  }
  const report: MoveReport = {
    to,
    files: files.length,
    bytes,
    copied: 0,
    copied_bytes: 0,
    already: 0,
    removed: 0,
    projects: 0,
    problems: [],
  };
  const folders = MOVABLE.map((sub) => join(layout.home, sub)).join(" and ");
  if (dryRun) {
    say(`${report.files} files (${size(report.bytes)}) in ${folders} would move to ${to}`);
    try {
      mounted(to, "/Volumes");
    } catch (error) {
      say(diag.messageOf(error));
    }
    return report;
  }
  if (layout.fromEnv) {
    if (layout.media !== canonical(to)) throw new Error(`${ENV} is set to ${layout.media ?? ""}; move to that, or change it`);
    prepare(layout.home, to);
  } else {
    // New media goes to the drive from now on, so nothing new lands behind the move.
    layout = store.setMediaDir(to);
  }
  const drive = layout.media;
  if (drive === null) throw new Error("no media folder");
  check(drive);
  report.to = drive;
  say(`moving ${report.files} files (${size(report.bytes)}) to ${drive}`);
  const checked: [string, string][] = [];
  for (const [index, from] of files.entries()) {
    if (stopBefore === index) throw new Error("stopped");
    const target = layout.onDrive(drive, from);
    if (target === null) continue;
    const started = performance.now();
    let copied: Copied | null = null;
    let problem: string | null = null;
    try {
      copied = copyChecked(from, target);
    } catch (error) {
      problem = diag.messageOf(error);
    }
    const took = performance.now() - started;
    diag.record("media", "media: move file", took, problem);
    if (copied === "already") {
      report.already += 1;
      checked.push([from, target]);
    } else if (copied !== null) {
      report.copied += 1;
      report.copied_bytes += copied.made;
      say(
        `[${index + 1}/${report.files}] copied ${from} (${size(copied.made)} in ${diag.human(took)}, ${size(Math.floor(copied.made / Math.max(took / 1000, 0.001)))}/s)`,
      );
      checked.push([from, target]);
    } else if (problem !== null) {
      say(`[${index + 1}/${report.files}] kept ${problem}`);
      report.problems.push(problem);
      try {
        check(drive);
      } catch (gone) {
        throw new Error(`${diag.messageOf(gone)} Nothing was removed; run the move again once it's back.`);
      }
    }
  }

  // Projects point at the copies before any original goes. (A project that
  // can't be opened now, or an old version in its history, still finds its
  // files: `Layout.resolve` looks on both sides.)
  const moved = new Map(checked);
  const keep = new Set<string>();
  for (const summary of store.list()) {
    const live = store.get(summary.id);
    if (live === null) continue;
    const uses = live.project.media.filter((media) => moved.has(media.path)).map((media) => media.path);
    if (uses.length === 0) continue;
    try {
      await store.update(summary.id, "media-move", (project) => {
        for (const media of project.media) {
          const there = moved.get(media.path);
          if (there !== undefined) media.path = there;
        }
      });
      report.projects += 1;
    } catch (error) {
      const problem = `${summary.id}: couldn't point it at the drive (${diag.messageOf(error)}); its ${uses.length} files kept here`;
      say(problem);
      report.problems.push(problem);
      for (const path of uses) keep.add(path);
    }
  }

  for (const [from, target] of checked) {
    if (keep.has(from)) continue;
    let matches = false;
    try {
      const original = stamp(from);
      matches = sameFile(stamp(target), original.len, original.mtime);
    } catch {
      matches = false;
    }
    if (!matches) {
      report.problems.push(`${from}: kept, its copy no longer matches it`);
      continue;
    }
    try {
      fs.unlinkSync(from);
      report.removed += 1;
    } catch (error) {
      report.problems.push(`${from}: couldn't remove it: ${ioMessage(error)}`);
    }
  }
  for (const sub of MOVABLE) removeEmpty(join(layout.home, sub));
  say(
    `done: ${report.copied} copied (${size(report.copied_bytes)}), ${report.already} already there, ${report.removed} originals removed, ${report.projects} projects pointed at ${drive}${report.problems.length === 0 ? "" : `; ${report.problems.length} kept here (above)`}`,
  );
  diag.info(
    "media",
    `moved media to ${drive}: ${report.copied} copied (${size(report.copied_bytes)}), ${report.already} already there, ${report.removed} removed, ${report.projects} projects, ${report.problems.length} problems`,
  );
  return report;
}

// ---------------------------------------------------------------------------
// `edit media …`

/**
 * Why it isn't safe to change `home`'s media now: a server is using it. Holds
 * the lock for the rest of this process when it isn't.
 */
export async function takeLock(home: string, port: number): Promise<void> {
  try {
    fs.mkdirSync(home, { recursive: true });
  } catch (error) {
    throw new Error(ioMessage(error));
  }
  const running = `Edit is running with ${home} — quit it (or stop \`edit serve\`) first`;
  if (!native().holdLock(join(home, LOCK))) throw new Error(running);
  // An Edit from before the lock: ask the port what data folder it serves.
  const served = await servedHome(port);
  if (served !== null && canonical(served) === canonical(home)) throw new Error(`${running} on port ${port}`);
}

/** The data folder the Edit on `port` serves, if one answers. */
export async function servedHome(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics`, {
      headers: { host: `127.0.0.1:${port}`, connection: "close" },
      signal: AbortSignal.timeout(5000),
    });
    const value = (await response.json()) as { home?: unknown };
    return typeof value.home === "string" ? value.home : null;
  } catch {
    return null;
  }
}

export const HELP = `edit media — where Edit keeps its big media files

  edit media
      Where new media goes, and whether the media drive is connected.
  edit media use DIR
      Keep new media (downloads, uploads, exports) in DIR, e.g. a folder on an
      external drive. Projects, cache, library and logs stay in the data folder.
  edit media off
      Keep new media in the data folder again (files already on the drive stay
      there and keep working while it's connected).
  edit media move --to DIR [--dry-run]
      Move what's in the data folder's media/ and uploads/ to DIR and use it:
      every file is copied and checked (size, modification time) before its
      original is removed, and projects are pointed at the copies. Safe to stop
      and run again. Quit Edit first.

  --home DIR   data folder (default ~/.edit, or EDIT_HOME)
  --port N     the port Edit serves on, to check it isn't running (default 7700)
  EDIT_MEDIA_DIR overrides the setting.
`;

/** `edit media …`; `fail` prints "edit: <why>" and exits 2 (main.rs fail). */
export async function runCli(home: string, port: number, args: string[], fail: (message: string) => never): Promise<void> {
  const flag = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const second = args[1];
  const positional = second !== undefined && !second.startsWith("--") ? second : undefined;
  const locked = async () => {
    try {
      await takeLock(home, port);
    } catch (error) {
      fail(diag.messageOf(error));
    }
  };
  const command = args[0];
  switch (command) {
    case undefined:
    case "status": {
      const layout = Layout.load(home);
      const shown = status(layout);
      if (layout.media === null) {
        console.log(`Media stays in ${layout.home} (no media drive set).`);
      } else {
        console.log(`New media goes to ${layout.media}${layout.fromEnv ? ` (${ENV})` : ""}.`);
        if (typeof shown.problem === "string") console.log(shown.problem);
      }
      const internal = typeof shown.internal_bytes === "number" ? shown.internal_bytes : 0;
      if (internal > 0) {
        console.log(`${size(internal)} of media is in ${MOVABLE.map((sub) => join(layout.home, sub)).join(" and ")}.`);
        if (layout.media !== null) console.log(`Move it with: ${moveCommand(layout.home, layout.media)}`);
      }
      return;
    }
    case "use": {
      if (positional === undefined) fail("edit media use DIR");
      await locked();
      const store = openStore(home, fail);
      try {
        const layout = store.setMediaDir(positional);
        console.log(`New media goes to ${layout.media ?? ""} from now on.`);
      } catch (error) {
        fail(diag.messageOf(error));
      }
      return;
    }
    case "off": {
      await locked();
      const store = openStore(home, fail);
      try {
        const layout = store.setMediaDir(null);
        console.log(`New media stays in ${layout.home} from now on.`);
      } catch (error) {
        fail(diag.messageOf(error));
      }
      return;
    }
    case "move": {
      const to = flag("--to") ?? positional;
      if (to === undefined) fail("edit media move --to DIR");
      const dryRun = args.includes("--dry-run");
      await locked();
      diag.open(home);
      const store = openStore(home, fail);
      let report: MoveReport;
      try {
        report = await moveMedia(store, to, dryRun, (line) => console.log(line));
      } catch (error) {
        fail(diag.messageOf(error));
      }
      if (report.problems.length > 0) {
        console.error(
          `edit: ${report.problems.length} files were kept in the data folder (above); run the move again to retry them`,
        );
        process.exit(1);
      }
      return;
    }
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(HELP);
      return;
    default:
      fail(`unknown media command ${command}\n\n${HELP}`);
  }
}

function openStore(home: string, fail: (message: string) => never): Store {
  try {
    return Store.open(home);
  } catch (error) {
    fail(`${home}: ${diag.messageOf(error)}`);
  }
}
