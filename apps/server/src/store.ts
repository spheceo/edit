// Projects on disk plus the live revision every client and agent edits against.
//
// Every write ends in `commitUnguarded`, which runs without a single await:
// the rev check, the atomic write, the addon keeping that revision for renders
// by reference (`projectKeep`) and the in-memory swap happen with nothing else
// running in between. The project is validated and serialized once before
// (`projectPrepare`). The one await on the way is the cloud hook's `mayWrite`
// (it may take a lock over the network), so the rev is checked after it;
// `update` awaits it before reading the project, so its read, edit and save
// have no await between them and can't lose a race.
//
// The live projects are frozen: the Rust store handed out clones, and a caller
// here that changed what `get` returned would change every reader's copy.
// `checkout` gives a copy to edit; `update` does read-modify-write in one go.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { copyFile, ioMessage, nextFileId, nowMs, writeAtomic } from "./files.ts";
import * as mediaDrive from "./media_drive/layout.ts";
import type { Clip, DriveFile, Project, ProjectSummary, Settings, Style } from "./model.ts";
import { native, type Prepared } from "./native/index.ts";
import { extension, fileStem, join } from "./paths.ts";
import { duration, mediaOf, newProject } from "./project.ts";
import { asSerdeRead, jsonForSerde } from "./rust.ts";

export { nextFileId, nowMs, writeAtomic } from "./files.ts";

/** How often a project's previous version is kept, and how many are kept. */
const HISTORY_EVERY_MS = 10 * 60 * 1000;
const HISTORY_KEEP = 30;

export interface Live {
  rev: number;
  /** Frozen: `checkout` (or structuredClone) for a copy to change. */
  project: Project;
}

export type UpdateKind = "not_found" | "conflict" | "invalid" | "refused";

/** Why a write didn't happen; callers word it for whoever asked. */
export class UpdateError extends Error {
  constructor(
    readonly kind: UpdateKind,
    message: string,
    /** The current revision, for a conflict. */
    readonly live?: Live,
  ) {
    super(message);
  }
}

/**
 * Cloud projects (`cloud_projects`): asked before every write (a cloud project
 * someone else is editing is refused) and told of each. The server's store has
 * it; tests' stores don't.
 */
export interface CloudHook {
  /** Resolves when project `id` may be changed here now; rejects with why not (HTTP 423 for the UI). */
  mayWrite(id: string): Promise<void>;
  /** A write landed (the push loop picks it up). */
  wrote(id: string): void;
  /** A project was made on this machine (a new cloud project). */
  created(id: string): void;
}

export type Event = Record<string, unknown>;

/**
 * Everything clients hear about (`/api/ws`): project saves, media progress,
 * exports, jobs. A subscriber gets the event and its JSON text, made once
 * however many listen.
 */
export class Events {
  private listeners = new Set<(event: Event, text: () => string) => void>();

  subscribe(listener: (event: Event, text: () => string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: Event): void {
    let text: string | null = null;
    const once = () => (text ??= JSON.stringify(event));
    for (const listener of [...this.listeners]) {
      try {
        listener(event, once);
      } catch (error) {
        diag.warn("store", `an event listener failed: ${diag.messageOf(error)}`);
      }
    }
  }
}

export class Store {
  readonly home: string;
  /** Where media goes (the media drive, when set) and how it's found. */
  private currentLayout: mediaDrive.Layout;
  /** Layout changes reach cache keys (`mediaDrive.publish`): the server's store. */
  private publishes = false;
  private projects = new Map<string, Live>();
  /** The project the UI opened last; agent tools default to it. */
  private active: string | null = null;
  readonly events = new Events();
  private cloudHook: CloudHook | null = null;

  private constructor(home: string, layout: mediaDrive.Layout) {
    this.home = home;
    this.currentLayout = layout;
  }

  static open(home: string): Store {
    fs.mkdirSync(join(home, "projects"), { recursive: true });
    fs.mkdirSync(join(home, "cache"), { recursive: true });
    const layout = mediaDrive.Layout.load(home);
    mediaDrive.prepareEnv(layout);
    return new Store(home, layout);
  }

  /** Makes this store's writes go through `cloud` (the server's store). */
  attachCloud(cloud: CloudHook): void {
    this.cloudHook ??= cloud;
  }

  /** Cloud projects, when attached (the server's store). */
  cloud(): CloudHook | null {
    return this.cloudHook;
  }

  /** Resolves when project `id` may be changed here now: a cloud project only while this machine holds its lock. */
  async mayWrite(id: string): Promise<void> {
    if (this.cloudHook !== null) await this.cloudHook.mayWrite(id);
  }

  cacheDir(): string {
    return join(this.home, "cache");
  }

  /**
   * Where footage downloaded from Google Drive is kept, one folder per file
   * (shared by projects): on the media drive when one is set, and an error
   * (never the internal disk) while it isn't connected.
   */
  driveDir(): string {
    return join(this.layout().mediaRoot(), "media", "drive");
  }

  /**
   * Where media made for a project is kept (uploads from other devices,
   * voice-over takes, stills, smoothed shots, map renders): on the media drive
   * when one is set, as `driveDir`.
   */
  uploadsDir(project: string): string {
    return join(this.layout().mediaRoot(), "media", project);
  }

  /** Where media goes and how it's found (`media_drive`). */
  layout(): mediaDrive.Layout {
    return this.currentLayout.clone();
  }

  /** Makes this store's layout the one cache keys use (the server's store). */
  publishLayout(): void {
    this.publishes = true;
    mediaDrive.publish(this.currentLayout);
  }

  /**
   * Sets (or, with null, turns off) the media drive and saves it in
   * `settings.json`. Files already somewhere stay there.
   */
  setMediaDir(dir: string | null): mediaDrive.Layout {
    if (this.currentLayout.fromEnv) {
      throw new Error(`${mediaDrive.ENV} is set, and it decides the media drive: change or unset it instead.`);
    }
    const next = this.currentLayout.clone();
    if (dir !== null) {
      const made = mediaDrive.prepare(next.home, dir);
      if (!next.known.includes(made)) next.known.push(made);
      next.media = made;
    } else {
      next.media = null;
    }
    mediaDrive.save(next);
    this.currentLayout = next;
    if (this.publishes) mediaDrive.publish(next);
    diag.info(
      "media",
      next.media !== null ? `new media goes to the media drive, ${next.media}` : `new media goes to ${next.home}`,
    );
    return next.clone();
  }

  subscribe(listener: (event: Event, text: () => string) => void): () => void {
    return this.events.subscribe(listener);
  }

  emit(event: Event): void {
    this.events.emit(event);
  }

  private path(id: string): string {
    return join(this.home, "projects", `${id}.json`);
  }

  /** The project's agent chat, kept beside it (and deleted with it). */
  chatPath(id: string): string {
    return join(this.home, "projects", `${id}.chat.json`);
  }

  list(): ProjectSummary[] {
    const out: ProjectSummary[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(join(this.home, "projects"), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const path = join(this.home, "projects", entry.name);
      if (extension(path) !== "json") continue;
      const id = fileStem(path);
      if (id === null) continue;
      let modifiedMs = 0;
      try {
        modifiedMs = Math.floor(fs.statSync(path).mtimeMs);
      } catch {
        modifiedMs = 0;
      }
      const loaded = this.load(id);
      if (loaded === null) continue;
      if ("problem" in loaded) {
        // Shown, not hidden: a project that won't open must not look deleted.
        let name = id;
        try {
          const value = JSON.parse(fs.readFileSync(path, "utf8")) as { name?: unknown };
          if (typeof value.name === "string") name = value.name;
        } catch {
          name = id;
        }
        out.push({
          id,
          name,
          style: "bodycam",
          modified_ms: modifiedMs,
          width: 0,
          height: 0,
          fps: 0,
          duration_frames: 0,
          clips: 0,
          problem: loaded.problem,
        });
        continue;
      }
      const project = loaded.project;
      const summary: ProjectSummary = {
        id: project.id,
        name: project.name,
        style: project.style,
        modified_ms: modifiedMs,
        width: project.settings.width,
        height: project.settings.height,
        fps: project.settings.fps,
        duration_frames: duration(project),
        clips: project.clips.length,
      };
      if (isSubtitled(project)) summary.subtitles = true;
      if (project.drive !== undefined && project.drive !== null) summary.drive = project.drive as DriveFile;
      out.push(summary);
    }
    return out.sort((a, b) => b.modified_ms - a.modified_ms);
  }

  get(id: string): Live | null {
    const loaded = this.load(id);
    return loaded === null || "problem" in loaded ? null : loaded;
  }

  /** A copy of the project to change (for `replace`), with the rev it's based on. */
  checkout(id: string): { rev: number; project: Project } | null {
    const live = this.get(id);
    return live === null ? null : { rev: live.rev, project: structuredClone(live.project) as Project };
  }

  /**
   * The project, or why not: null when there's no such project, else what's
   * wrong with its file (which is left untouched).
   */
  private load(id: string): Live | { problem: string } | null {
    if (!validId(id)) return null;
    const cached = this.projects.get(id);
    if (cached !== undefined) return cached;
    let text: string;
    try {
      text = fs.readFileSync(this.path(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return { problem: `can't read it: ${ioMessage(error)}` };
    }
    // As serde reads it (the addon reads numbers exactly).
    const loaded = native().projectLoad(asSerdeRead(text));
    if (loaded.problem !== undefined) {
      // A file holding another project says so, even when it doesn't validate either.
      const holds = idIn(text);
      if (holds !== null && holds !== id && !loaded.problem.startsWith("it can't be read")) {
        return { problem: `its file holds project ${holds}` };
      }
      return { problem: loaded.problem };
    }
    const project = JSON.parse(loaded.json) as Project;
    if (project.id !== id) return { problem: `its file holds project ${project.id}` };
    // Files moved to (or back from) the media drive are found.
    this.currentLayout.resolveProject(project);
    const live: Live = { rev: 1, project: deepFreeze(project) };
    this.projects.set(id, live);
    return live;
  }

  /** A new project (the default style). */
  create(name: string, settings: Settings): Live {
    return this.createAs(name, "bodycam", settings);
  }

  /** A new project of a given style (the kind of video). */
  createAs(name: string, style: Style, settings: Settings): Live {
    const id = `p${nowMs()}-${nextFileId()}`;
    const trimmed = name.trim() === "" ? "Untitled" : name.trim();
    const project = newProject(id, trimmed, settings, style);
    const live = this.write(id, 1, project);
    this.projects.set(id, live);
    this.cloudHook?.created(id);
    return live;
  }

  /**
   * A copy of `project` under a new id and `name`, kept on this machine only
   * (a cloud conflict's "conflicted copy"): cloud projects aren't told.
   */
  createCopy(project: Project, name: string): Live {
    const copy = structuredClone(project) as Project;
    copy.id = `p${nowMs()}-${nextFileId()}`;
    copy.name = name;
    delete copy.drive;
    const live = this.write(copy.id, 1, copy);
    this.projects.set(copy.id, live);
    return live;
  }

  /**
   * Takes `project` as it is in the cloud (`cloud_projects`): saved over this
   * machine's copy, or as a new project, without asking the cloud projects
   * (it's not an edit made here). Clients see it as a `project` event from
   * `origin`.
   */
  putFromCloud(given: Project, origin: string): Live {
    const project = structuredClone(given) as Project;
    const id = project.id;
    if (!validId(id)) throw new Error(`not a project id: ${JSON.stringify(id)}`);
    this.currentLayout.resolveProject(project);
    const prepared = native().projectPrepare(id, jsonForSerde(project));
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = this.load(id);
      if (current === null) {
        const live = this.save(id, 1, prepared);
        this.projects.set(id, live);
        return live;
      }
      // Never written over (see `list`).
      if ("problem" in current) throw new Error(`this machine's copy of ${id} won't load: ${current.problem}`);
      try {
        return this.commitUnguarded(id, current.rev, prepared, origin);
      } catch (error) {
        if (error instanceof UpdateError && (error.kind === "conflict" || error.kind === "not_found")) continue;
        throw error instanceof UpdateError ? new Error(error.message) : error;
      }
    }
    throw new Error(`${id} kept changing; try again`);
  }

  delete(id: string): boolean {
    if (!validId(id)) return false;
    this.projects.delete(id);
    if (this.active === id) this.active = null;
    // Kept aside rather than erased, so a deletion can be undone by hand.
    const bin = join(this.home, "projects", "deleted");
    try {
      fs.mkdirSync(bin, { recursive: true });
    } catch {
      // The renames below say whether it worked.
    }
    const stamp = nowMs();
    try {
      fs.renameSync(this.chatPath(id), join(bin, `${id}-${stamp}.chat.json`));
    } catch {
      // No chat to keep.
    }
    try {
      fs.renameSync(this.path(id), join(bin, `${id}-${stamp}.json`));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Replaces the project if `baseRev` is current (null: whatever is current).
   * `origin` lets clients skip their own echo. Throws UpdateError.
   */
  async replace(id: string, baseRev: number | null, project: Project, origin: string): Promise<Live> {
    const current = this.get(id);
    if (current === null) throw new UpdateError("not_found", `no project ${id}`);
    if (baseRev !== null && baseRev !== current.rev) {
      throw new UpdateError("conflict", `revision conflict: current ${current.rev}`, current);
    }
    const next = Object.isFrozen(project) ? (structuredClone(project) as Project) : project;
    next.id = id;
    return this.commit(id, current.rev, next, origin);
  }

  /**
   * Read-modify-write used by agent tools and server-side edits: `edit` gets a
   * copy to change and must not await (it runs atomically). Throws an Error
   * with the reason.
   *
   * The cloud lock is settled first, so reading, editing and saving run with
   * no await between them: another save can't land in between and turn this
   * one into a conflict (edits count and collect as they go, so they aren't
   * run twice).
   */
  async update<T>(id: string, origin: string, edit: (project: Project) => T): Promise<[Live, T]> {
    if (this.get(id) === null) throw new Error(`no project ${id}`);
    const cloud = this.cloudHook;
    if (cloud !== null) {
      try {
        await cloud.mayWrite(id);
      } catch (error) {
        throw new Error(diag.messageOf(error));
      }
    }
    const current = this.get(id);
    if (current === null) throw new Error("project was deleted while editing");
    const project = structuredClone(current.project) as Project;
    const value = edit(project);
    if (value instanceof Promise) {
      throw new TypeError("store.update's edit must be synchronous (it runs atomically)");
    }
    project.id = id;
    try {
      const live = this.commitUnguarded(id, current.rev, this.prepare(id, project), origin);
      cloud?.wrote(id);
      return [live, value];
    } catch (error) {
      if (!(error instanceof UpdateError)) throw error;
      switch (error.kind) {
        case "not_found":
          throw new Error("project was deleted while editing");
        case "conflict":
          throw new Error("project changed while editing; retry");
        default:
          throw new Error(error.message);
      }
    }
  }

  /**
   * Saves `project` as the next rev after `rev`, if cloud projects let this
   * machine change it (every write path ends here). Throws UpdateError.
   */
  async commit(id: string, rev: number, project: Project, origin: string): Promise<Live> {
    // Invalid before refused: a bad save says what's wrong with it first.
    const prepared = this.prepare(id, project);
    const cloud = this.cloudHook;
    if (cloud !== null) {
      try {
        await cloud.mayWrite(id);
      } catch (error) {
        throw new UpdateError("refused", diag.messageOf(error));
      }
    }
    const live = this.commitUnguarded(id, rev, prepared, origin);
    cloud?.wrote(id);
    return live;
  }

  /** `project` validated and serialized as saved; throws UpdateError "invalid". */
  private prepare(id: string, project: Project): Prepared {
    try {
      return native().projectPrepare(id, jsonForSerde(project));
    } catch (error) {
      throw new UpdateError("invalid", diag.messageOf(error));
    }
  }

  /** Synchronous from the rev check to the swap: nothing can land in between. */
  private commitUnguarded(id: string, rev: number, prepared: Prepared, origin: string): Live {
    // Another writer may have landed between read and commit.
    const current = this.projects.get(id);
    if (current === undefined) throw new UpdateError("not_found", `no project ${id}`);
    if (current.rev !== rev) throw new UpdateError("conflict", `revision conflict: current ${current.rev}`, current);
    try {
      this.writeFile(id, prepared.json);
    } catch (error) {
      throw new UpdateError("invalid", ioMessage(error));
    }
    native().projectKeep(prepared.token, rev + 1);
    const live: Live = { rev: rev + 1, project: deepFreeze(JSON.parse(prepared.json) as Project) };
    this.projects.set(id, live);
    const event: Event = { type: "project", id, rev: live.rev, origin, project: live.project };
    // What it was before, for connections that take patches (http/server.ts); not sent as it is.
    Object.defineProperty(event, "before", { value: { rev, project: current.project }, enumerable: false });
    this.emit(event);
    return live;
  }

  /** Validates and saves a project new to this store as `rev`; throws the reason. */
  private write(id: string, rev: number, project: Project): Live {
    return this.save(id, rev, native().projectPrepare(id, jsonForSerde(project)));
  }

  private save(id: string, rev: number, prepared: Prepared): Live {
    try {
      this.writeFile(id, prepared.json);
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    native().projectKeep(prepared.token, rev);
    return { rev, project: deepFreeze(JSON.parse(prepared.json) as Project) };
  }

  /**
   * Writes a project file: compact JSON (speed-plan 6.1: 40% smaller than the
   * pretty-printed files were, on disk and in every history copy).
   */
  private writeFile(id: string, text: string): void {
    const path = this.path(id);
    // A bad save (a bug, an agent gone wrong) can always be walked back.
    try {
      this.keepHistory(id, path);
    } catch (error) {
      diag.warn("store", `keeping history for ${id}: ${ioMessage(error)}`);
    }
    writeAtomic(path, text);
  }

  /**
   * Copies the saved file to `projects/history/<id>/` before it's replaced, at
   * most every HISTORY_EVERY_MS, keeping the last HISTORY_KEEP.
   */
  private keepHistory(id: string, path: string): void {
    if (!isRegularFile(path)) return;
    const dir = join(this.home, "projects", "history", id);
    fs.mkdirSync(dir, { recursive: true });
    const kept: [number, string][] = [];
    for (const name of fs.readdirSync(dir)) {
      const stem = fileStem(name);
      if (stem === null || !/^\d+$/.test(stem)) continue;
      kept.push([Number(stem), join(dir, name)]);
    }
    kept.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    const now = nowMs();
    const last = kept[kept.length - 1];
    if (last !== undefined && Math.max(now - last[0], 0) < HISTORY_EVERY_MS) return;
    copyFile(path, join(dir, `${now}.json`));
    kept.push([now, ""]);
    for (const [, old] of kept.slice(0, Math.max(kept.length - HISTORY_KEEP, 0))) {
      fs.rmSync(old, { force: true });
    }
  }

  setActive(id: string): void {
    this.active = id;
  }

  /** Explicit id, else the project the UI has open, else the most recent. */
  resolve(id?: string | null): string {
    if (id !== undefined && id !== null && id !== "") {
      if (this.get(id) === null) throw new Error(`no project ${id}`);
      return id;
    }
    if (this.active !== null) return this.active;
    const first = this.list()[0];
    if (first === undefined) throw new Error("no projects yet; create one in the UI first");
    return first.id;
  }
}

/** The `"id"` a project file names, read without parsing the whole of it, or null. */
function idIn(text: string): string | null {
  try {
    const value = JSON.parse(text) as { id?: unknown };
    return typeof value.id === "string" ? value.id : null;
  } catch {
    return null;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

export function validId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id);
}

/** Freezes `value` and everything in it (live projects are shared by every reader). */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}

/** How a subtitle's clip name starts ("Subtitle · <who>"). */
export const SUBTITLE_NAME = "Subtitle";

/**
 * Whether `project` is a subtitled video: subtitles over its footage and
 * nothing else (an edit's subtitles carry the same name, among cut-ins,
 * B-roll and sound). Here, not in subtitles.ts, because `list` needs it.
 */
export function isSubtitled(project: Project): boolean {
  const prefix = `${SUBTITLE_NAME} · `;
  const subtitle = (clip: Clip) => typeof clip.name === "string" && clip.name.startsWith(prefix);
  const footage = (clip: Clip) => {
    if (clip.type !== "video" && clip.type !== "audio") return false;
    return mediaOf(project, clip.media)?.kind === "video";
  };
  return project.clips.some(subtitle) && project.clips.every((clip) => subtitle(clip) || footage(clip));
}
