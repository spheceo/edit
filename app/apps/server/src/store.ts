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

import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";

import { creator } from "./accounts.ts";
import * as diag from "./diag.ts";
import * as kinds from "./kinds.ts";
import { enforceOneLine } from "./one_line.ts";
import { enforcePointers } from "./pointers.ts";
import { enforceSoundRoom, type Words } from "./sound_room.ts";
import { copyFile, ioMessage, nextFileId, nowMs, writeAtomic } from "./files.ts";
import type { Clip, DriveFile, Media, Project, ProjectSummary, Settings, Style } from "./model.ts";
import { native, type Prepared } from "./native/index.ts";
import { canonical, extension, fileStem, join } from "./paths.ts";
import { clipEnd, duration, mediaOf, newProject } from "./project.ts";
import { asSerdeRead, jsonForSerde } from "./rust.ts";
import * as patches from "./patch.ts";
import { RELEASE } from "./version.ts";

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
 * An agent tool call under way (mcp/index.ts `call`): every `update` it makes
 * is checked against what the agent last read of the project (`agentView`),
 * and refused with the conflict when it changes what changed since (by hand
 * or by another tool), so the agent never silently wins over a hand edit
 * (Nov 8 audit, 2d). `active` goes false when the call returns: work it left
 * running in the background (a smoothed shot swapped in) isn't the agent's
 * edit and isn't checked.
 */
export const agentCalls = new AsyncLocalStorage<{ active: boolean }>();

/** What the agent last read of a project, and what it learns from its own writes (edit_tools.ts keeps it). */
export const agentView = {
  known: (_id: string): { rev: number; project: Project } | null => null,
  learned: (_id: string, _rev: number, _project: Project): void => {},
  /**
   * A change that is Edit's own work (`update` outside an agent's call: a
   * file put in the cloud, a smoothed shot or a preview swapped in, voices
   * named): no person made it and there is nothing in it for the agent to
   * read, so what the agent knows takes it along. Only what a person saves
   * from the page (`replace`) stays unread until the agent reads again.
   */
  background: (_id: string, _before: Project, _after: Project): void => {},
};

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
  private projects = new Map<string, Live>();
  /** Summaries of projects not loaded, by id, with the file version (size:mtime) they were read from. */
  private summaries = new Map<string, { stamp: string; summary: ProjectSummary; media: string[] }>();
  /** The project the UI opened last; agent tools default to it. */
  private active: string | null = null;
  readonly events = new Events();
  private cloudHook: CloudHook | null = null;
  private resolveMedia: ((project: Project) => void) | null = null;
  /** A file's words on this machine, for its sounds' crossfade room (sound_room.ts); tests' stores have none. */
  private words: ((media: Media) => Words | null) | null = null;

  /** Machine-local media locations, applied on every read and save, including cloud pulls. */
  setMediaResolver(resolve: (project: Project) => void): void {
    if (this.projects.size !== 0) throw new Error("configure media playback before loading projects");
    this.resolveMedia = resolve;
    this.summaries.clear();
  }

  /** Where a file's words are read from, so every save gives its sounds their crossfade room (sound_room.ts). */
  setWords(read: (media: Media) => Words | null): void {
    this.words = read;
  }

  /** Each footage sound's crossfade room from its file's words, as the house rules are kept: on every save. */
  private enforceRoom(before: Project | null, project: Project): void {
    const read = this.words;
    if (read === null) return;
    try {
      enforceSoundRoom(before, project, read);
    } catch (error) {
      // Only the crossfades go without: never a save refused for them.
      diag.warn("store", `${project.id}: the sounds' crossfade room: ${diag.messageOf(error)}`);
    }
  }

  /**
   * The revision a project new to this machine starts at. Revisions then go on
   * from the last one across restarts (kept beside each project file,
   * `projects/revs/<id>.json`, with the hash of the file it was), so a page
   * or an agent plan from before a restart still matches what it read; a file
   * that changed without its revision (a crash between the two writes, a copy
   * put in by hand) gets the next one, which nobody holds. Until Nov 8 each
   * start began from a random base, and every plan made before a restart was
   * refused (13 on Marc's Mac in a day).
   */
  readonly firstRev = 1;

  /**
   * Whether new projects are marked dev projects (`Project::origin` "dev"):
   * on any build that isn't a release (`just dev`, the dev server, the trial
   * server), so Home can hide and clear the test projects (Sphe, Oct 31: "the
   * project list gets huge"). Off in tests.
   */
  marksDev = devBuild();

  private constructor(home: string) {
    this.home = home;
  }

  static open(home: string): Store {
    const root = canonical(home);
    fs.mkdirSync(join(root, "projects"), { recursive: true });
    fs.mkdirSync(join(root, "cache"), { recursive: true });
    return new Store(root);
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

  /** Where footage downloaded from Google Drive is kept, one folder per file (shared by projects). */
  driveDir(): string {
    return join(this.home, "media", "drive");
  }

  /** Where media made for a project is kept (uploads, voice-over takes, stills, smoothed shots, map renders). */
  uploadsDir(project: string): string {
    return join(this.home, "media", project);
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

  /**
   * Every project's summary, newest first. Read without keeping the projects:
   * an open one is summarised from memory, any other from its file, parsed
   * once per version of the file (size and mtime) and let go, so the home
   * screen doesn't hold every project's whole document.
   */
  list(): ProjectSummary[] {
    return this.listed().map(([summary]) => summary);
  }

  /** The ids of the projects whose media include `path` (as saved, or as found here). */
  usingMedia(path: string): string[] {
    return this.listed()
      .filter(([summary, media]) => summary.problem === undefined && media.includes(path))
      .map(([summary]) => summary.id);
  }

  private listed(): [ProjectSummary, string[]][] {
    const out: [ProjectSummary, string[]][] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(join(this.home, "projects"), { withFileTypes: true });
    } catch {
      return out;
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      const path = join(this.home, "projects", entry.name);
      if (extension(path) !== "json") continue;
      const id = fileStem(path);
      if (id === null || !validId(id)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      seen.add(id);
      const modifiedMs = Math.floor(stat.mtimeMs);
      const live = this.projects.get(id);
      if (live !== undefined) {
        out.push([summaryOf(live.project, modifiedMs), live.project.media.map((media) => media.path)]);
        continue;
      }
      const stamp = `${stat.size}:${stat.mtimeMs}`;
      let cached = this.summaries.get(id);
      if (cached === undefined || cached.stamp !== stamp) {
        const read = this.readSummary(id, path, modifiedMs);
        if (read === null) continue;
        cached = { stamp, summary: read[0], media: read[1] };
        this.summaries.set(id, cached);
      }
      out.push([cached.summary, cached.media]);
    }
    for (const id of this.summaries.keys()) if (!seen.has(id)) this.summaries.delete(id);
    return out.sort((a, b) => b[0].modified_ms - a[0].modified_ms);
  }

  /** A project file's summary and media paths, read without keeping it (null: gone). */
  private readSummary(id: string, path: string, modifiedMs: number): [ProjectSummary, string[]] | null {
    const loaded = this.read(id);
    if (loaded === null) return null;
    if ("problem" in loaded) {
      // Shown, not hidden: a project that won't open must not look deleted.
      let name = id;
      try {
        const value = JSON.parse(fs.readFileSync(path, "utf8")) as { name?: unknown };
        if (typeof value.name === "string") name = value.name;
      } catch {
        name = id;
      }
      const summary: ProjectSummary = {
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
      };
      return [summary, []];
    }
    const project = loaded.project;
    return [summaryOf(project, modifiedMs), project.media.map((item) => item.path)];
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
    const read = this.read(id);
    if (read === null || "problem" in read) return read;
    const project = read.project;
    this.resolveMedia?.(project);
    const live: Live = { rev: this.revOnDisk(id, read.text), project: deepFreeze(project) };
    this.projects.set(id, live);
    this.summaries.delete(id);
    return live;
  }

  /** Project `id`'s file, parsed and validated (not kept), or why not. */
  private read(id: string): { project: Project; text: string } | { problem: string } | null {
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
    return { project, text };
  }

  private revPath(id: string): string {
    return join(this.home, "projects", "revs", `${id}.json`);
  }

  /**
   * The revision project `id`'s file `text` is: the one kept beside it when it
   * was written, else (none kept, or the file changed since) the next one,
   * kept now so the next start agrees.
   */
  private revOnDisk(id: string, text: string): number {
    const hash = fileHash(text);
    let kept: { rev?: unknown; hash?: unknown } | null = null;
    try {
      kept = JSON.parse(fs.readFileSync(this.revPath(id), "utf8")) as { rev?: unknown; hash?: unknown };
    } catch {
      kept = null;
    }
    const rev = typeof kept?.rev === "number" && Number.isSafeInteger(kept.rev) && kept.rev > 0 ? kept.rev : null;
    if (rev !== null && kept?.hash === hash) return rev;
    const next = rev === null ? this.firstRev : rev + 1;
    this.keepRev(id, next, hash);
    return next;
  }

  /** The revision kept for project `id` (0: none). */
  private keptRev(id: string): number {
    try {
      const rev = (JSON.parse(fs.readFileSync(this.revPath(id), "utf8")) as { rev?: unknown }).rev;
      return typeof rev === "number" && Number.isSafeInteger(rev) && rev > 0 ? rev : 0;
    } catch {
      return 0;
    }
  }

  /** Keeps `rev` as the revision of project `id`'s file (its hash `hash`). */
  private keepRev(id: string, rev: number, hash: string): void {
    try {
      fs.mkdirSync(join(this.home, "projects", "revs"), { recursive: true });
      writeAtomic(this.revPath(id), JSON.stringify({ rev, hash }));
    } catch (error) {
      // The next start then gives the file a revision nobody holds: a reload, never a wrong match.
      diag.warn("store", `keeping ${id}'s revision: ${ioMessage(error)}`);
    }
  }

  /** A new project (the default style). */
  create(name: string, settings: Settings): Live {
    return this.createAs(name, "bodycam", settings);
  }

  /** A new project of a given style (the kind of video); `hq`, a Bodycam HQ project (Edit V2, beta.ts). */
  createAs(name: string, style: Style, settings: Settings, hq = false): Live {
    const id = `p${nowMs()}-${nextFileId()}`;
    const trimmed = name.trim() === "" ? "Untitled" : name.trim();
    const project = newProject(id, trimmed, settings, style);
    // Only when on: an ordinary project's file stays as it was, with no `hq` key.
    if (hq) project.hq = true;
    const by = creator();
    if (by !== null) project.created_by = by;
    if (this.marksDev) project.origin = "dev";
    const live = this.write(id, this.firstRev, project);
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
    const live = this.write(copy.id, this.firstRev, copy);
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
    this.resolveMedia?.(project);
    const prepared = native().projectPrepare(id, jsonForSerde(project));
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = this.load(id);
      if (current === null) {
        // Past any revision a project of this id had here before (deleted, then brought back from the cloud).
        const live = this.save(id, this.keptRev(id) + 1, prepared);
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
    // What Edit rendered for it and can render again (smoothed slow motion,
    // map shots) goes: a teaching loop's 15 deleted trials left 8 GB of it.
    for (const made of ["smooth", "maps"]) fs.rmSync(join(this.uploadsDir(id), made), { recursive: true, force: true });
    // Its chat and its sub-agents' (`<id>~review.chat.json`, the fresh-eyes pass).
    let names: string[] = [];
    try {
      names = fs.readdirSync(join(this.home, "projects"));
    } catch {
      // No folder, no chats.
    }
    const chats = [id, ...names.flatMap((name) => (name.startsWith(`${id}~`) && name.endsWith(".chat.json") ? [name.slice(0, -".chat.json".length)] : []))];
    for (const chat of chats) {
      try {
        fs.renameSync(this.chatPath(chat), join(bin, `${chat}-${stamp}.chat.json`));
      } catch {
        // No chat to keep.
      }
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
  async update<T>(id: string, origin: string, edit: (project: Project) => T, read?: { rev: number; project: Project }): Promise<[Live, T]> {
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
    // The house rules: no subtitle takes two lines (one_line.ts), and what points at someone ends with their shot (pointers.ts).
    enforceOneLine(current.project, project);
    enforcePointers(current.project, project);
    const refused = refusalOf(current.project, project);
    if (refused !== null) throw new Error(refused);
    // Made from what the caller read (an agent tool): refused when it changes what changed since, by hand or by another tool.
    const call = agentCalls.getStore();
    const agents = call?.active === true;
    const knew = read ?? (agents ? agentView.known(id) : null);
    if (knew !== null && knew.project !== current.project) {
      const clash = patches.overlap(patches.diff(knew.project, current.project), patches.diff(current.project, project));
      if (clash.length > 0) throw new Error(revisionConflict(knew.rev, current.rev, clash));
    }
    // After the check: a room it sets is Edit's own, never a clash with what changed since the agent read.
    this.enforceRoom(current.project, project);
    try {
      const live = this.commitUnguarded(id, current.rev, this.prepare(id, project), origin);
      cloud?.wrote(id);
      // What the agent knows now: what it read, with its own change on top (not what changed by hand meanwhile, which
      // it hasn't read). Its change as it was saved, not as the tool wrote it: saving rounds numbers and drops empty
      // fields, and a view holding the tool's own spelling of a clip read as "changed since you read it" the next time
      // the agent touched that clip, at the very revision it had just written (Nov 9, Marc's Mac: 14 such refusals in
      // one turn, a batch of six update_clips and the same three sounds twice).
      if (agents && knew !== null) {
        try {
          agentView.learned(id, live.rev, knew.project === current.project ? live.project : patches.apply(knew.project, patches.diff(current.project, live.project)));
        } catch (error) {
          // The change is saved; it only doesn't fit over what the agent read (a list reordered by hand since). What
          // it knows stays as it was, so it reads again before it changes those things: never a failed call for a saved change.
          diag.warn("store", `${id}: noting the agent's own change: ${diag.messageOf(error)}`);
        }
      }
      // Edit's own work, not a person's and not a call of the agent's: what the agent knows takes it along.
      else if (!agents && read === undefined) agentView.background(id, current.project, live.project);
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
  async commit(id: string, rev: number, given: Project, origin: string): Promise<Live> {
    const before = this.projects.get(id);
    // The house rules: no subtitle takes two lines (one_line.ts), and what points at someone ends with their shot (pointers.ts).
    const project = Object.isFrozen(given) ? (structuredClone(given) as Project) : given;
    enforceOneLine(before?.project ?? null, project);
    enforcePointers(before?.project ?? null, project);
    this.enforceRoom(before?.project ?? null, project);
    // Invalid before refused: a bad save says what's wrong with it first.
    const prepared = this.prepare(id, project);
    const refused = before === undefined ? null : refusalOf(before.project, project);
    if (refused !== null) throw new UpdateError("refused", refused);
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
      this.resolveMedia?.(project);
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
      this.writeFile(id, prepared.json, rev + 1);
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
    this.resolveMedia?.(project);
    return this.save(id, rev, native().projectPrepare(id, jsonForSerde(project)));
  }

  private save(id: string, rev: number, prepared: Prepared): Live {
    try {
      this.writeFile(id, prepared.json, rev);
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
  private writeFile(id: string, text: string, rev: number): void {
    const path = this.path(id);
    // A bad save (a bug, an agent gone wrong) can always be walked back.
    try {
      this.keepHistory(id, path);
    } catch (error) {
      diag.warn("store", `keeping history for ${id}: ${ioMessage(error)}`);
    }
    writeAtomic(path, text);
    // After the file: a crash between the two leaves a hash that doesn't match, so the next start counts on past it.
    this.keepRev(id, rev, fileHash(text));
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

  /** The projects the signed-in person may work on (`kinds`): what Home and the agent are shown. */
  visible(): ProjectSummary[] {
    const given = kinds.granted();
    const all = this.list();
    return given === null ? all : all.filter((summary) => summary.problem !== undefined || kinds.mayWork(summaryShape(summary), given));
  }

  /** Null when the signed-in person may work on project `id` (or it isn't here); else why not. */
  unavailable(id: string): string | null {
    const live = this.get(id);
    if (live === null) return null;
    const shape = shapeOf(live.project);
    return kinds.mayWork(shape) ? null : kinds.unavailable(shape);
  }

  /** Explicit id, else the project the UI has open, else the most recent (of those the signed-in person may work on). */
  resolve(id?: string | null): string {
    if (id !== undefined && id !== null && id !== "") {
      if (this.get(id) === null) throw new Error(`no project ${id}`);
      const why = this.unavailable(id);
      if (why !== null) throw new Error(why);
      return id;
    }
    if (this.active !== null && this.unavailable(this.active) === null) return this.active;
    const first = this.visible()[0];
    if (first === undefined) throw new Error("no projects yet; create one in the UI first");
    return first.id;
  }
}

/**
 * Why a change made from revision `read` doesn't go on `current`: what it
 * changes was changed since (by hand, or by another tool), named. The agent
 * reads the project again (Nov 8 audit, 2d: its other tools silently won
 * over hand edits).
 */
export function revisionConflict(read: number, current: number, clash: string[]): string {
  const named = clash.slice(0, 6).map((name) => name.replace(":", " ")).join(", ");
  return `revision conflict: expected ${read}, current ${current}; ${named}${clash.length > 6 ? ` and ${clash.length - 6} more` : ""} changed since you read ${clash.length === 1 ? "it" : "them"}; nothing saved; refresh get_edit_context`;
}

/** A project file's hash, for the revision kept beside it (fast, not a secret). */
function fileHash(text: string): string {
  return Bun.hash(text).toString(36);
}

/** A dev build, as `Store.marksDev` says. */
function devBuild(): boolean {
  return process.env.NODE_ENV !== "test" && !RELEASE;
}

function summaryOf(project: Project, modifiedMs: number): ProjectSummary {
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
  else if (shapeOf(project).footageOnly) summary.footage_only = true;
  if (project.drive !== undefined && project.drive !== null) summary.drive = project.drive as DriveFile;
  if (project.created_by !== undefined && project.created_by !== null) summary.created_by = project.created_by;
  if (project.origin === "dev") summary.dev = true;
  if (typeof project.note === "string" && project.note !== "") summary.note = project.note;
  if (project.hq === true) summary.hq = true;
  const missing = missingMedia(project);
  const used = usedMedia(project).length;
  if (used > 0) summary.media_used = used;
  if (missing.length > 0) summary.missing = missing.length;
  const remote = usedMedia(project).filter((media) => media.cloud !== undefined && media.cloud !== null && !isRegularFile(media.path)).length;
  if (remote > 0) summary.remote = remote;
  summary.cover_frame = coverFrame(project, `${project.id}:${modifiedMs}`);
  return summary;
}

/**
 * The frame a project's card shows: picked at random (by `seed`, so the same
 * until the project changes) from the stretches where the footage is simply
 * running: footage on screen whose file is on this machine (a frame of
 * missing footage is black), no narration playing (a cut-in's B-roll), no
 * card, picture, map or transition (a short adjustment; long ones, a
 * redaction or a grade, are part of the footage's look), and at least a
 * second from any cut. Null when there's no such stretch.
 */
export function coverFrame(project: Project, seed: string): number | null {
  const fps = project.settings.fps;
  const visible = new Set(project.tracks.filter((track) => !track.hidden).map((track) => track.id));
  const here = new Map<string, boolean>();
  const footage = (mediaId: string) => {
    if (!here.has(mediaId)) {
      const media = mediaOf(project, mediaId);
      // A map shot is a graphic, not the footage.
      here.set(mediaId, media !== undefined && media.kind === "video" && !media.name.startsWith("map-") && isRegularFile(media.path));
    }
    return here.get(mediaId)!;
  };
  // [start, end, footage step, busy step] for every clip that matters, and every cut.
  const spans: [number, number, number, number][] = [];
  const cuts: number[] = [];
  for (const clip of project.clips) {
    if (!visible.has(clip.track)) continue;
    const [start, end] = [clip.start, clipEnd(clip)];
    if (clip.type === "audio") {
      if (clip.name === "Voice-over") spans.push([start, end, 0, 1]);
    } else if (clip.type === "video") {
      cuts.push(start, end);
      spans.push([start, end, footage(clip.media) ? 1 : 0, footage(clip.media) ? 0 : 1]);
    } else if (clip.type === "solid" || clip.type === "waveform" || (clip.type === "adjustment" && end - start <= 3 * fps)) {
      cuts.push(start, end);
      spans.push([start, end, 0, 1]);
    }
  }
  const events = spans.flatMap(([start, end, shown, busy]): [number, number, number][] => [
    [start, shown, busy],
    [end, -shown, -busy],
  ]);
  for (const at of cuts) events.push([at, 0, 0]);
  events.sort((a, b) => a[0] - b[0]);
  const plain: [number, number][] = [];
  let [shown, busy] = [0, 0];
  for (const [index, [at, shownStep, busyStep]] of events.entries()) {
    shown += shownStep;
    busy += busyStep;
    const next = events[index + 1]?.[0];
    if (next === undefined || next === at) continue;
    if (shown > 0 && busy === 0 && next - at > 2 * fps) plain.push([at + fps, next - fps]);
  }
  const total = plain.reduce((sum, [from, to]) => sum + (to - from), 0);
  if (total <= 0) return null;
  let hash = 2166136261;
  for (const c of seed) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  let at = hash % total;
  for (const [from, to] of plain) {
    if (at < to - from) return from + at;
    at -= to - from;
  }
  return null;
}

/** The media the timeline plays (a clip uses them). */
function usedMedia(project: Project): Project["media"] {
  const used = new Set(project.clips.flatMap((clip) => ("media" in clip && typeof clip.media === "string" ? [clip.media] : [])));
  return project.media.filter((media) => used.has(media.id));
}

/**
 * The media the timeline plays whose file isn't on this machine and that the
 * cloud can't bring back (a cloud media's copy is fetched when it opens):
 * footage deleted or on a drive that isn't plugged in.
 */
export function missingMedia(project: Project): Project["media"] {
  return usedMedia(project).filter((media) => (media.cloud === undefined || media.cloud === null) && !isRegularFile(media.path));
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
  const subtitle = isSubtitleClip;
  return project.clips.some(subtitle) && project.clips.every((clip) => subtitle(clip) || isFootageClip(project, clip));
}

function isSubtitleClip(clip: Clip): boolean {
  return typeof clip.name === "string" && clip.name.startsWith(`${SUBTITLE_NAME} · `);
}

function isFootageClip(project: Project, clip: Clip): boolean {
  if (clip.type !== "video" && clip.type !== "audio") return false;
  return mediaOf(project, clip.media)?.kind === "video";
}

/** What `kinds` needs to know of a project: its style, whether it's a subtitled video, or only footage yet. */
export function shapeOf(project: Project): kinds.Shape {
  const subtitles = isSubtitled(project);
  return { style: project.style, subtitles, footageOnly: !subtitles && project.clips.every((clip) => isFootageClip(project, clip)) };
}

/** A summary's shape (`footage_only` is set by `summaryOf`). */
export function summaryShape(summary: ProjectSummary): kinds.Shape {
  return { style: summary.style, subtitles: summary.subtitles === true, footageOnly: summary.footage_only === true };
}

/**
 * A change the signed-in person may not make (`kinds`): to a project of a
 * kind they can't work on, or one that turns it into one. Null when it's fine.
 */
export function refusalOf(before: Project, after: Project): string | null {
  const given = kinds.granted();
  if (given === null) return null;
  const was = shapeOf(before);
  if (!kinds.mayWork(was, given)) return kinds.unavailable(was);
  const now = shapeOf(after);
  return kinds.mayWork(now, given) ? null : kinds.cantMake(kinds.kindOf(now));
}
