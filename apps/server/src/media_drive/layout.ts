// The media drive: where Edit keeps its big media files when the Mac's own
// disk is too small. Off unless set (Settings → Media drive, `edit media use
// DIR`, `edit media move --to DIR`, or `EDIT_MEDIA_DIR`), and then exactly as
// before: everything in the data folder (~/.edit).
//
// With a media folder set, what Edit writes as media goes there: Drive
// downloads and their excerpts (`media/drive/`), uploads, voice-over takes
// sent to a project, stills, smoothed shots and map renders (`media/<project>/`),
// and exports by default (`Exports/`). Projects and their history, the cache
// (previews, frames, analysis, watch and seats answers, thumbnails), library
// sounds, logs and settings stay in the data folder.
//
// The media folder mirrors the data folder (`media/…`, `uploads/…`), so a
// file's place on one side is its place on the other:
// - projects keep absolute paths; `Layout.resolve` finds a file that's on the
//   other side now, so a reference to its old place still opens;
// - `Layout.keyPath` names a file on the drive by its data-folder place for
//   cache keys (the addon's `mediaKey`, told the folders by `setMediaFolders`),
//   so previews, transcripts and analysis made before a move still match (a
//   move keeps sizes and modification times exactly);
// - a drive that isn't connected (unplugged, or `/Volumes/X` left behind as an
//   empty folder) is never written to: new media is refused with an error
//   saying so rather than put on the internal disk unannounced, and its files
//   show as missing like any missing file.
//
// This is the layout half; `edit media` and the move (move.ts) are on top
// of it.

import * as fs from "node:fs";

import * as diag from "../diag.ts";
import { ioMessage, nowMs, writeAtomic } from "../files.ts";
import type { Project } from "../model.ts";
import { native } from "../native/index.ts";
import {
  canonical,
  components,
  fileName,
  isAbsolute,
  isDir,
  isFile,
  join,
  parent,
  startsWith,
  stripPrefix,
  userHome,
} from "../paths.ts";
import { stableStringify } from "../stable.ts";

/** Overrides the setting (and can't be changed from the UI). */
export const ENV = "EDIT_MEDIA_DIR";
/** In the media folder: proof it's the folder Edit set up, not an empty mount point left on the internal disk. */
export const MARKER = ".edit-media-drive";
/** The data folder's subfolders that hold media; with a media drive they're mirrored there. */
export const MOVABLE = ["media", "uploads"] as const;
/** Edit's app settings, in the data folder. */
const SETTINGS = "settings.json";
/** Held by a running server (and by `edit media move`), so a move never runs under a server using the same data folder. */
export const LOCK = "server.lock";
/** A copy being made; renamed to the file's name once it's whole. */
export const MOVING = ".edit-moving";

export class Layout {
  constructor(
    /** The data folder (canonical). */
    readonly home: string,
    /** The media folder, when one is set. */
    public media: string | null,
    /** Set by `EDIT_MEDIA_DIR`. */
    readonly fromEnv: boolean,
    /**
     * Every media folder ever set, the current one included: files there are
     * still found, and keep their cache keys, after the setting changes.
     */
    public known: string[],
  ) {}

  /** The data folder's layout: `EDIT_MEDIA_DIR`, else its settings. */
  static load(home: string): Layout {
    const env = process.env[ENV];
    return Layout.fromSettings(home, env !== undefined && env !== "" ? env : null);
  }

  static fromSettings(home: string, env: string | null): Layout {
    const root = canonical(home);
    const settings = readSettings(root);
    const configured = typeof settings.media_dir === "string" && settings.media_dir !== "" ? settings.media_dir : null;
    const fromEnv = env !== null;
    const chosen = env ?? configured;
    const media = chosen === null ? null : canonical(chosen);
    const known = Array.isArray(settings.media_dirs_known)
      ? settings.media_dirs_known.filter((dir): dir is string => typeof dir === "string")
      : [];
    if (media !== null && !known.includes(media)) known.push(media);
    return new Layout(root, media, fromEnv, known);
  }

  clone(): Layout {
    return new Layout(this.home, this.media, this.fromEnv, [...this.known]);
  }

  /** The media folder when one is set (null when not); throws why it can't be used now. */
  drive(): string | null {
    if (this.media === null) return null;
    check(this.media);
    return this.media;
  }

  /**
   * Where new media goes: the media folder, else the data folder; never the
   * data folder in place of a drive that isn't connected (that throws).
   */
  mediaRoot(): string {
    return this.drive() ?? this.home;
  }

  /** Where exports go unless told otherwise. */
  exportsDir(): string {
    return this.media === null ? defaultExportsDir() : join(this.media, "Exports");
  }

  /** Refuses (throws) a write into the media folder while its drive isn't connected. */
  writable(path: string): void {
    if (this.media !== null && startsWith(path, this.media)) check(this.media);
  }

  /** Every other place a media file could be now: the same place under the media folder, the data folder and earlier media folders. */
  places(path: string): string[] {
    const roots: string[] = [];
    if (this.media !== null) roots.push(this.media);
    roots.push(this.home);
    for (const dir of this.known) {
      if (!roots.includes(dir)) roots.push(dir);
    }
    for (const root of roots) {
      for (const sub of MOVABLE) {
        const rest = stripPrefix(path, join(root, sub));
        if (rest !== null) {
          return roots
            .map((other) => (rest === "" ? join(other, sub) : join(other, sub, rest)))
            .filter((place) => !samePath(place, path));
        }
      }
    }
    return [];
  }

  /**
   * Where a project's file is now when it isn't where the project says (moved
   * to the media drive, or back): null when it's there, or isn't anywhere
   * (then it shows as missing, as before).
   */
  resolve(path: string): string | null {
    if (fs.existsSync(path)) return null;
    return this.places(path).find((place) => isFile(place)) ?? null;
  }

  /** Points a project's media at where the files are now. Whether anything changed. */
  resolveProject(project: Project): boolean {
    let changed = false;
    for (const media of project.media) {
      const found = this.resolve(media.path);
      if (found !== null) {
        diag.info("media", `${project.id} (${media.id}): ${media.path} is at ${found} now`);
        media.path = found;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * The name a file's cache key uses: a file in a media folder is named by its
   * place in the data folder, so moving it there (or importing it there in the
   * first place) keeps its key. (The addon does this itself for `mediaKey`;
   * this is for the layout's own checks and tests.)
   */
  keyPath(path: string): string {
    for (const dir of this.known) {
      const rest = stripPrefix(path, dir);
      if (rest !== null) return rest === "" ? this.home : join(this.home, rest);
    }
    return path;
  }

  /** Where a data-folder file goes on the media drive. */
  onDrive(drive: string, path: string): string | null {
    const rest = stripPrefix(path, this.home);
    if (rest === null) return null;
    const first = components(rest)[0];
    return MOVABLE.some((sub) => sub === first) ? join(drive, rest) : null;
  }
}

/** Whether two paths name the same place, component by component. */
function samePath(a: string, b: string): boolean {
  return startsWith(a, b) && startsWith(b, a);
}

/** Tells the addon where media folders are, so `mediaKey` names files there by their data-folder place. */
export function publish(layout: Layout): void {
  native().setMediaFolders(layout.known);
}

/** Whether the media folder can be used (throws why not): its drive is mounted and the folder is the one Edit set up. */
export function check(dir: string): void {
  checkUnder(dir, "/Volumes");
}

export function checkUnder(dir: string, volumes: string): void {
  mounted(dir, volumes);
  if (!isFile(join(dir, MARKER))) {
    throw new Error(
      notConnected(dir, `it has no ${MARKER} in it (set it again in Settings, or with \`edit media use\`)`),
    );
  }
}

/**
 * A folder under `/Volumes/<drive>` needs that drive mounted: when it isn't,
 * macOS can leave `/Volumes/<drive>` behind as an empty folder on the internal
 * disk, which must not be mistaken for the drive. Throws when it isn't mounted.
 */
export function mounted(dir: string, volumes: string): void {
  const rest = stripPrefix(dir, volumes);
  if (rest === null) return;
  const name = components(rest)[0];
  if (name === undefined) return;
  const volume = join(volumes, name);
  let isMounted: boolean;
  try {
    isMounted = fs.statSync(volume).dev !== fs.statSync(volumes).dev;
  } catch {
    isMounted = false;
  }
  if (!isMounted) throw new Error(notConnected(dir, `${volume} isn't mounted`));
}

function notConnected(dir: string, why: string): string {
  return `The media drive (${dir}) isn't connected: ${why}. Plug it in, or turn the media drive off in Settings to keep new media on this Mac.`;
}

/**
 * Makes `dir` the media folder: its drive must be connected; the folder is
 * made (only its last part: never a whole path inside an empty mount point)
 * and marked. Returns it canonical.
 */
export function prepare(home: string, dir: string): string {
  if (!isAbsolute(dir)) throw new Error(`Give the media folder's full path, not ${dir}.`);
  mounted(dir, "/Volumes");
  const above = parent(dir);
  if (above === null || above === "") throw new Error("The media folder can't be the root of the disk.");
  if (!isDir(above)) throw new Error(`${above} doesn't exist (is the drive connected?).`);
  const name = fileName(dir);
  if (name === null) throw new Error(`${dir} has no folder name`);
  const target = join(canonical(above), name);
  const root = canonical(home);
  if (startsWith(target, root) || startsWith(root, target)) {
    throw new Error(`The media folder must be outside Edit's data folder (${root}).`);
  }
  if (!isDir(target)) {
    try {
      fs.mkdirSync(target);
    } catch (error) {
      throw new Error(`${target}: ${ioMessage(error)}`);
    }
  }
  const made = canonical(target);
  const marker = join(made, MARKER);
  if (!isFile(marker)) {
    const note = {
      about:
        "Edit keeps its media here (Settings → Media drive). Keep this file: without it Edit takes the folder for an unplugged drive.",
      home: root,
      created_ms: nowMs(),
    };
    try {
      writeAtomic(marker, stableStringify(note));
    } catch (error) {
      throw new Error(`${marker}: ${ioMessage(error)}`);
    }
  }
  return made;
}

/** Makes the env's media folder usable at startup (it's set on purpose). */
export function prepareEnv(layout: Layout): void {
  if (!layout.fromEnv || layout.media === null) return;
  try {
    check(layout.media);
  } catch {
    try {
      prepare(layout.home, layout.media);
    } catch (error) {
      diag.warn("media", `${ENV}: ${diag.messageOf(error)}`);
    }
  }
}

function readSettings(home: string): Record<string, unknown> {
  try {
    const value = JSON.parse(fs.readFileSync(join(home, SETTINGS), "utf8")) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // No settings yet (or unreadable ones): the defaults.
  }
  return {};
}

/** Saves the media folder setting (other settings kept as they are). */
export function save(layout: Layout): void {
  const settings = readSettings(layout.home);
  if (!layout.fromEnv) settings.media_dir = layout.media;
  settings.media_dirs_known = layout.known;
  try {
    writeAtomic(join(layout.home, SETTINGS), stableStringify(settings, 2));
  } catch (error) {
    throw new Error(`saving ${SETTINGS}: ${ioMessage(error)}`);
  }
}

export function defaultExportsDir(): string {
  const home = userHome();
  const movies = join(home, "Movies");
  return isDir(movies) ? join(movies, "Edit") : join(home, "Videos", "Edit");
}

/** The status the UI's settings show. */
export function status(layout: Layout): Record<string, unknown> {
  let state: "off" | "connected" | "offline";
  let problem: string | null = null;
  try {
    state = layout.drive() === null ? "off" : "connected";
  } catch (error) {
    state = "offline";
    problem = diag.messageOf(error);
  }
  let internal = 0;
  for (const path of sources(layout.home)) {
    try {
      internal += fs.statSync(path).size;
    } catch {
      // Gone since the walk: nothing to count.
    }
  }
  return {
    dir: layout.media,
    env: layout.fromEnv,
    state,
    problem,
    home: layout.home,
    exports: layout.exportsDir(),
    internal_bytes: internal,
    move_command: layout.media === null ? null : moveCommand(layout.home, layout.media),
    volumes: volumes(),
  };
}

/** The command that moves what's still in the data folder to `dir`. */
export function moveCommand(home: string, dir: string): string {
  const quote = (path: string) =>
    /^[A-Za-z0-9/._-]*$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
  let command = `edit media move --to ${quote(dir)}`;
  const user = process.env.HOME;
  const standard = user !== undefined && canonical(join(user, ".edit")) === home;
  if (!standard) command += ` --home ${quote(home)}`;
  return command;
}

/** Drives mounted under /Volumes (suggestions for the setting). */
function volumes(): { name: string | null; path: string }[] {
  const root = "/Volumes";
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((path) => {
      try {
        mounted(path, root);
        return true;
      } catch {
        return false;
      }
    })
    .map((path) => ({ name: fileName(path), path }));
  // Sorted by their JSON, as they've always been sorted.
  return out.sort((a, b) => {
    const x = stableStringify(a);
    const y = stableStringify(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/**
 * Every file in the data folder's media folders (not following links; half-made
 * copies of an earlier move left out).
 */
export function sources(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && !path.endsWith(MOVING)) out.push(path);
    }
  };
  for (const sub of MOVABLE) walk(join(home, sub));
  return out.sort();
}

/** "1.2 GB", "340 MB", "12 KB". */
export function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.max(bytes / 1e3, bytes > 0 ? 1 : 0).toFixed(0)} KB`;
}

/**
 * Takes the data folder's lock for the life of the process (a server). A move
 * holding it shows as a warning, not a refusal to start.
 */
export function holdLock(home: string): void {
  let held: boolean;
  try {
    held = native().holdLock(join(home, LOCK));
  } catch {
    return;
  }
  if (!held) diag.warn("media", `another Edit is using ${home} (a server, or \`edit media move\`)`);
}
