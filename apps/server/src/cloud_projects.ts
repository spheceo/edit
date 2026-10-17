// Cloud projects (cloud_projects.rs): with cloud on (a relay token, Settings →
// Cloud), projects are kept in Convex (Edit's `edit:` functions, through the
// relay: `cloud.ts`), so a teammate can open one on their Mac and carry on
// where someone else stopped. One machine edits a project at a time: it holds
// the project's lock, a two-minute lease renewed every 45 s, and every write
// to a cloud project goes through `Cloud.mayWrite` (the store's commit), which
// refuses one another machine holds.
//
// What this machine knows lives in the data folder: `cloud.json` (the
// setting: token, holder label; mode 600, it holds the token) and
// `cloud/projects.json` (per cloud project: the cloud rev its copy is based
// on, whether it has changes not pushed yet, and its lock token). A
// background loop (`start`) pushes changes ~2 s after the last one (the JSON
// uploaded, then `commitProject` with the base rev), renews and releases
// locks, retries with backoff while offline, and watches a project someone
// else holds so the editor refreshes when they let go. The editor and the
// agent never wait on the network to save: saves land on disk and are queued.
//
// Locks: Unknown (not asked this session; the first write asks), Provisional
// (a new project, or the cloud couldn't be reached: edits are allowed and
// pushed once the lock is ours), Held, Elsewhere (read-only). Losing the lock
// with unpushed changes (renewing says someone took over, a commit is
// refused) or a commit refused as a `conflict` keeps this machine's version
// as "<name> (conflicted copy)", on this machine only, and takes the cloud's:
// nothing is overwritten either way.
//
// Rust ran the network calls on blocking threads; here they're awaited. The
// store's `mayWrite` is async, so the store re-checks the rev after it.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import { ConvexFailure } from "./cloud.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { crashed, isBug } from "./guard.ts";
import { ApiError } from "./http/errors.ts";
import { badShape, readJson, type RouteContext, type Router } from "./http/router.ts";
import type { Project } from "./model.ts";
import { join } from "./paths.ts";
import { duration } from "./project.ts";
import * as relay from "./relay.ts";
import { byteLength, isWhitespace, serdeParse, takeChars } from "./rust.ts";
import { stableStringify } from "./stable.ts";
import { isSubtitled, nowMs, validId, type CloudHook, type Store } from "./store.ts";

/** A push waits this long after the last change (more changes restart it). */
const DEBOUNCE = 2_000;
/** A held lock is renewed this often (its lease lasts two minutes). */
const RENEW_EVERY = 45_000;
/** An editor that hasn't said it's still open for this long has gone. */
const VIEWER_TTL = 75_000;
/** A lock nobody here is using (no editor open, no write) is let go after this. */
const IDLE_RELEASE = 60_000;
/** How often a project someone else holds is checked while it's open here. */
const CHECK_EVERY = 10_000;
/** Retries after a failure wait 5 s, 10 s, 20 s… up to this. */
export const BACKOFF_MAX = 60_000;
/** Seconds a lock or status call may take; bodies get longer. */
const QUICK = 15;
const SLOW = 180;
/** What a project is saved as when the cloud's version wins. */
const CONFLICTED = "(conflicted copy)";

export const SETTINGS = "cloud.json";
export const STATE_DIR = "cloud";
export const STATE = "projects.json";

/** The clock entries run on (Rust's Instant): milliseconds, monotonic. */
export function now(): number {
  return performance.now();
}

/** Settings → Cloud, in `<home>/cloud.json`. */
export interface Settings {
  /** The relay's cloud token (used when `EDIT_RELAY_TOKEN` isn't set). */
  token?: string;
  /** How teammates see this machine ("<holder> is editing"). */
  holder?: string;
}

/** What's kept on disk per cloud project. */
export interface Saved {
  /** The cloud rev this machine's copy is (or is based on); 0 before the first push. */
  rev: number;
  /** Changes made here that aren't in the cloud yet. */
  dirty: boolean;
  /** This machine's lock, when it holds it. */
  token?: string;
}

/** Who may edit a cloud project, as far as this machine knows. */
export type Lock =
  /** Not asked yet: the first write (or opening it) asks. */
  | { kind: "unknown" }
  /** Edits allowed before the lock is ours: a project just made here, or the cloud couldn't be reached. */
  | { kind: "provisional" }
  /** This machine's. */
  | { kind: "held" }
  /** Someone else is editing: read-only here. */
  | { kind: "elsewhere"; holder: string };

/** The next network job for a project (named as Rust's Debug names them, for the log). */
export type Step =
  /** Take the cloud's version. */
  | "Pull"
  /** Fetch the footage a pulled project needs (`cloud_media.ensureLocal`). */
  | "Media"
  | "Acquire"
  | "Push"
  | "Renew"
  | "Release"
  /** See whether whoever holds it has let go. */
  | "Check";

/** What `Cloud.mayWrite` does with a write. */
export type Permission = { kind: "allow" } | { kind: "refuse"; why: string } | { kind: "ask" };

export function readOnly(holder: string): string {
  return `${holder} is editing this project, so it's read-only here until they close it (or you take over in the editor).`;
}

/** Something to tell the user about a project. */
export type Note = { kind: "conflict"; message: string } | { kind: "error"; message: string };

const since = (now: number, at: number) => Math.max(now - at, 0);

/** A cloud project's state on this machine. */
export class Entry {
  saved: Saved;
  lock: Lock;
  /** The network job running for it. */
  busy: Step | null = null;
  /** Counts local writes, so a push knows whether more came in meanwhile. */
  edits = 0;
  changedAt: number | null = null;
  renewedAt: number | null = null;
  checkedAt: number | null = null;
  retryAt: number | null = null;
  failures = 0;
  offline = false;
  /** The editor closed it: push now and let go. */
  closing = false;
  wantPull = false;
  wantMedia = false;
  /** UI clients with it open, and when they last said so. */
  viewers = new Map<string, number>();
  note: Note | null = null;
  /**
   * Media the project uses that are neither on this machine nor in the cloud
   * (`cloud_media.ensureLocal`), said in a sentence naming them.
   */
  missing: string | null = null;

  constructor(saved: Saved) {
    this.saved = { ...saved };
    // A token from before a restart is renewed straight away (and if it has
    // gone, taken again: the same holder may).
    this.lock = saved.token !== undefined ? { kind: "held" } : { kind: "unknown" };
  }

  /** A project made here (or moved to the cloud): pushed as rev 1. */
  static fresh(): Entry {
    const entry = new Entry({ rev: 0, dirty: true });
    entry.lock = { kind: "provisional" };
    return entry;
  }

  watched(now: number): boolean {
    for (const seen of this.viewers.values()) if (since(now, seen) < VIEWER_TTL) return true;
    return false;
  }

  recentlyChanged(now: number): boolean {
    return this.changedAt !== null && since(now, this.changedAt) < IDLE_RELEASE;
  }

  /** What to do next, if anything (the state machine's one decision). */
  step(now: number): Step | null {
    if (this.busy !== null || (this.retryAt !== null && now < this.retryAt)) return null;
    if (this.wantPull) return "Pull";
    if (this.wantMedia) return "Media";
    const watched = this.watched(now);
    const recent = this.recentlyChanged(now);
    switch (this.lock.kind) {
      case "held": {
        const settled = this.closing || this.changedAt === null || since(now, this.changedAt) >= DEBOUNCE;
        if (this.saved.dirty && settled) return "Push";
        if (!this.saved.dirty && !watched && (this.closing || !recent)) return "Release";
        const renew = this.renewedAt === null || since(now, this.renewedAt) >= RENEW_EVERY;
        return renew ? "Renew" : null;
      }
      // A write asks for itself (`Cloud.mayWrite`); this is for changes
      // waiting to go and an editor open on it.
      case "unknown":
      case "provisional":
        return this.saved.dirty || watched ? "Acquire" : null;
      case "elsewhere": {
        const due = this.checkedAt === null || since(now, this.checkedAt) >= CHECK_EVERY;
        return watched && due ? "Check" : null;
      }
    }
  }

  /**
   * Whether a write may go ahead (cloud on). Someone else's lock last seen a
   * while ago is asked about again: they may have let go.
   */
  permission(now: number): Permission {
    switch (this.lock.kind) {
      case "held":
      case "provisional":
        return { kind: "allow" };
      case "elsewhere":
        if (this.checkedAt === null || since(now, this.checkedAt) >= CHECK_EVERY) return { kind: "ask" };
        return { kind: "refuse", why: readOnly(this.lock.holder) };
      case "unknown":
        return { kind: "ask" };
    }
  }

  wrote(now: number): void {
    this.edits += 1;
    this.changedAt = now;
    this.closing = false;
    this.saved.dirty = true;
  }

  acquired(token: string, now: number): void {
    this.saved.token = token;
    this.lock = { kind: "held" };
    this.renewedAt = now;
    this.succeeded();
  }

  /** Someone else holds it (this machine's changes are dealt with first). */
  elsewhere(holder: string, now: number): void {
    delete this.saved.token;
    this.lock = { kind: "elsewhere", holder };
    this.checkedAt = now;
    this.closing = false;
    this.succeeded();
  }

  /** The lock went (expired, or a commit was refused) but nobody else has it: take it again on the next step. */
  forgetLock(): void {
    delete this.saved.token;
    this.lock = { kind: "unknown" };
  }

  released(): void {
    delete this.saved.token;
    this.lock = { kind: "unknown" };
    this.closing = false;
    this.renewedAt = null;
  }

  /** A push of the edits counted up to `edits` landed as cloud `rev`. */
  pushed(rev: number, edits: number): void {
    this.saved.rev = rev;
    if (this.edits === edits) this.saved.dirty = false;
    this.note = null;
    this.succeeded();
  }

  succeeded(): void {
    this.offline = false;
    this.failures = 0;
    this.retryAt = null;
  }

  /** The cloud couldn't be reached: carry on locally and try again later. */
  unreachable(now: number): void {
    this.offline = true;
    this.backOff(now);
    if (this.lock.kind === "unknown") this.lock = { kind: "provisional" };
  }

  failed(message: string, now: number): void {
    this.note = { kind: "error", message };
    this.backOff(now);
  }

  backOff(now: number): void {
    this.failures += 1;
    const wait = Math.min(5_000 * 2 ** Math.min(Math.max(this.failures - 1, 0), 8), BACKOFF_MAX);
    this.retryAt = now + wait;
  }

  /** What the UI shows: `sync` is one of off, synced, pending, syncing, offline, conflict, readonly, error. */
  status(on: boolean): Record<string, unknown> {
    const holder = this.lock.kind === "elsewhere" ? this.lock.holder : null;
    const pushing = this.busy === "Push" || this.busy === "Pull";
    const sync = !on
      ? "off"
      : holder !== null
        ? "readonly"
        : this.note?.kind === "conflict"
          ? "conflict"
          : pushing
            ? "syncing"
            : this.offline
              ? "offline"
              : this.note?.kind === "error"
                ? "error"
                : this.saved.dirty
                  ? "pending"
                  : "synced";
    return {
      cloud: true,
      dirty: this.saved.dirty,
      holder,
      lock: this.lock.kind,
      message: this.note?.message ?? null,
      missing: this.missing,
      on,
      rev: this.saved.rev,
      sync,
    };
  }
}

/** A Saved as serde reads it (defaults for what's missing), or null when it isn't one. */
function readSaved(value: unknown): Saved | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const rev = fields.rev ?? 0;
  const dirty = fields.dirty ?? false;
  const token = fields.token ?? null;
  if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 0) return null;
  if (typeof dirty !== "boolean") return null;
  if (token !== null && typeof token !== "string") return null;
  const saved: Saved = { rev, dirty };
  if (token !== null) saved.token = token;
  return saved;
}

/** What's kept per project, as serde writes a `Saved` (token left out when None). */
function writeSaved(saved: Saved): Saved {
  const out: Saved = { rev: saved.rev, dirty: saved.dirty };
  if (saved.token !== undefined) out.token = saved.token;
  return out;
}

/** Cloud projects on this machine (one per server, attached to its store). */
export class Cloud implements CloudHook {
  readonly home: string;
  /** This machine's name, the default holder label. */
  readonly machine: string;
  private settings: Settings;
  readonly projects = new Map<string, Entry>();
  private store: Store | null = null;
  private permit = false;
  private waiter: (() => void) | null = null;
  stopped = false;

  constructor(home: string, machine: string, settings: Settings = {}) {
    this.home = home;
    this.machine = machine;
    this.settings = settings;
  }

  /** Reads the setting and per-project state, and applies the token. */
  static open(home: string, machine: string): Cloud {
    const settings = readSettings(home);
    apply(settings);
    const cloud = new Cloud(home, machine, settings);
    for (const [id, saved] of readState(home)) cloud.projects.set(id, new Entry(saved));
    return cloud;
  }

  /** Makes `store`'s writes go through this (the server's store). */
  attach(store: Store): void {
    this.store = store;
    store.attachCloud(this);
  }

  /** Whether cloud is on (a token: always on with one). */
  on(): boolean {
    return cloud.enabled();
  }

  /**
   * How teammates see this machine: `EDIT_CLOUD_HOLDER`, the setting, else
   * its name. Stable across restarts, so this machine takes its own lock back
   * after one.
   */
  holder(): string {
    const given = (process.env.EDIT_CLOUD_HOLDER ?? "").trim();
    if (given !== "") return given;
    return this.settings.holder ?? this.machine;
  }

  isCloud(id: string): boolean {
    return this.projects.has(id);
  }

  /** The project's cloud status for the UI (`{cloud: false}` for a project only on this machine). */
  status(id: string): Record<string, unknown> {
    const on = this.on();
    const entry = this.projects.get(id);
    return entry !== undefined ? entry.status(on) : { cloud: false, on };
  }

  /** Every cloud project's status, by id. */
  statuses(): Record<string, unknown> {
    const on = this.on();
    const out: Record<string, unknown> = {};
    for (const [id, entry] of this.projects) out[id] = entry.status(on);
    return out;
  }

  emit(id: string): void {
    this.store?.emit({ type: "cloud", id, status: this.status(id) });
  }

  persist(): void {
    const saved: Record<string, Saved> = {};
    for (const [id, entry] of this.projects) saved[id] = writeSaved(entry.saved);
    const dir = join(this.home, STATE_DIR);
    try {
      fs.mkdirSync(dir, { recursive: true });
      writePrivate(join(dir, STATE), JSON.stringify(saved, null, 2));
    } catch (error) {
      diag.warn("cloud", `saving cloud/${STATE}: ${diag.messageOf(error)}`);
    }
  }

  /** What `cloud_media.ensureLocal` found missing (null: nothing). */
  setMissing(id: string, missing: string | null): void {
    const changed = this.with(id, (entry) => {
      const changed = entry.missing !== missing;
      entry.missing = missing;
      return changed;
    });
    if (changed === true) this.emit(id);
  }

  with<T>(id: string, change: (entry: Entry) => T): T | undefined {
    const entry = this.projects.get(id);
    return entry === undefined ? undefined : change(entry);
  }

  /** Wakes the loop (tokio's Notify::notify_one: a wake with nobody waiting is kept for the next wait). */
  wake(): void {
    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      waiter();
    } else {
      this.permit = true;
    }
  }

  /** Waits `ms`, or until woken. */
  nap(ms: number): Promise<void> {
    if (this.permit) {
      this.permit = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter === done) this.waiter = null;
        resolve();
      }, ms);
      (timer as { unref?: () => void }).unref?.();
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiter = done;
    });
  }

  // -------------------------------------------------------------------------
  // The store's hooks (every write passes here).

  /**
   * Whether this machine may change project `id` now. Only a cloud project
   * someone else is editing is refused; one not asked about yet is asked
   * (once: an agent or a background job editing a project the editor hasn't
   * opened). Unreachable, it's allowed and queued.
   */
  async mayWrite(id: string): Promise<void> {
    if (!this.on()) return;
    const started = now();
    for (;;) {
      const entry = this.projects.get(id);
      if (entry === undefined) return;
      const permission = entry.permission(now());
      if (permission.kind === "allow") return;
      if (permission.kind === "refuse") throw new Error(permission.why);
      if (entry.busy === null) {
        entry.busy = "Acquire";
        break;
      }
      if (now() - started > (QUICK + 5) * 1000) throw new Error("still checking who's editing this project; try again");
      await Bun.sleep(100);
    }
    try {
      await this.claim(id);
    } finally {
      this.with(id, (entry) => {
        entry.busy = null;
      });
      this.persist();
      this.emit(id);
      this.wake();
    }
  }

  /**
   * Takes the lock for a write (see `mayWrite`); a newer cloud version is
   * taken first, so the write lands on it (and is retried by its caller).
   */
  private async claim(id: string): Promise<void> {
    const holder = this.holder();
    const at = now();
    let acquired: Acquired;
    try {
      acquired = await remote.acquire(id, holder, false);
    } catch (error) {
      if (!(error instanceof ConvexFailure)) throw error;
      if (error.kind === "unreachable") {
        // Last seen in someone else's hands: still theirs.
        const theirs = this.with(id, (entry) => {
          entry.unreachable(at);
          entry.checkedAt = at;
          return entry.lock.kind === "elsewhere" ? entry.lock.holder : null;
        });
        if (theirs !== undefined && theirs !== null) throw new Error(readOnly(theirs));
        return;
      }
      throw new Error(`couldn't take the project's cloud lock: ${error.message}`);
    }
    if ("heldBy" in acquired) {
      const message = readOnly(acquired.heldBy);
      const dirty = this.dirty(id);
      this.with(id, (entry) => {
        entry.elsewhere(acquired.heldBy, at);
        // Changes made here are kept as a copy by the loop.
        entry.wantPull = dirty || entry.wantPull;
      });
      throw new Error(message);
    }
    this.with(id, (entry) => entry.acquired(acquired.got, at));
    let meta: Meta | null;
    try {
      meta = await remote.get(id);
    } catch {
      // A newer version over changes made here: the loop's next push meets
      // the conflict and keeps both.
      return;
    }
    if (meta !== null && meta.rev > this.savedRev(id) && !this.dirty(id)) {
      const project = await remote.download(meta.bodyUrl);
      this.take(id, project, meta.rev);
      this.with(id, (entry) => {
        entry.wantMedia = true;
      });
    }
  }

  /** A project was saved here. */
  wrote(id: string): void {
    const flipped = this.with(id, (entry) => {
      const was = entry.saved.dirty;
      entry.wrote(now());
      return !was;
    });
    if (flipped === true) this.persist();
    this.wake();
  }

  /** A project was made here: with cloud on it's a cloud project. */
  created(id: string): void {
    if (!this.on()) return;
    this.projects.set(id, Entry.fresh());
    this.persist();
    this.wake();
  }

  savedRev(id: string): number {
    return this.with(id, (entry) => entry.saved.rev) ?? 0;
  }

  dirty(id: string): boolean {
    return this.with(id, (entry) => entry.saved.dirty) ?? false;
  }

  /** Saves the cloud's `project` at `rev` as this machine's copy. */
  take(id: string, project: Project, rev: number): void {
    if (project.id !== id) throw new Error(`the cloud's body for ${id} holds project ${project.id}`);
    this.attached().putFromCloud(project, "cloud");
    let entry = this.projects.get(id);
    if (entry === undefined) {
      entry = new Entry({ rev: 0, dirty: false });
      this.projects.set(id, entry);
    }
    entry.saved.rev = rev;
    entry.saved.dirty = false;
    this.persist();
  }

  attached(): Store {
    if (this.store === null) throw new Error("cloud projects aren't attached to a store");
    return this.store;
  }

  // -------------------------------------------------------------------------
  // The UI's calls.

  /** The editor has `id` open (`client` says so every 30 s). */
  viewing(id: string, client: string): void {
    this.with(id, (entry) => {
      entry.viewers.set(client, now());
      entry.closing = false;
    });
    this.wake();
  }

  /** The editor closed `id`: push what's left and let the lock go. */
  closed(id: string, client: string): void {
    this.with(id, (entry) => {
      entry.viewers.delete(client);
      if (entry.viewers.size === 0) entry.closing = true;
    });
    this.wake();
  }

  /** Registers a project only on this machine as a cloud project, pushed as new. */
  adopt(id: string): void {
    if (!this.projects.has(id)) this.projects.set(id, Entry.fresh());
    this.persist();
    this.wake();
  }

  /** Forgets a project (deleted, or deleted from the cloud). */
  forget(id: string): void {
    this.projects.delete(id);
    this.persist();
  }

  // -------------------------------------------------------------------------
  // Settings → Cloud.

  /** Settings → Cloud: on, where the token comes from, the holder label. */
  settingsStatus(): Record<string, unknown> {
    const token = relay.envToken() !== null ? "env" : this.settings.token !== undefined ? "saved" : null;
    return { holder: this.holder(), on: this.on(), relay: relay.url(), token };
  }

  /**
   * Changes the setting: a field left undefined is unchanged, null forgets it
   * (Rust's `Option<Option<String>>`).
   */
  setSettings(token: string | null | undefined, holder: string | null | undefined): void {
    const next: Settings = { ...this.settings };
    if (token !== undefined) {
      const trimmed = token === null ? "" : token.trim();
      if (trimmed !== "") {
        if (byteLength(trimmed) > 512 || [...trimmed].some((char) => CONTROL.test(char) || isWhitespace(char))) {
          throw new Error("That doesn't look like a cloud token (one line, no spaces).");
        }
        next.token = trimmed;
      } else {
        delete next.token;
      }
    }
    if (holder !== undefined) {
      const trimmed = holder === null ? "" : holder.trim();
      if (trimmed !== "") {
        if (byteLength(trimmed) > 100) throw new Error("Keep the name under 100 characters.");
        next.holder = trimmed;
      } else {
        delete next.holder;
      }
    }
    writePrivate(join(this.home, SETTINGS), JSON.stringify(writeSettings(next), null, 2));
    apply(next);
    this.settings = next;
    this.wake();
  }

  /** Whether the relay takes the token: null when it does, else why not. */
  async connectionProblem(): Promise<string | null> {
    if (relay.token() === null) return "No cloud token yet.";
    try {
      await cloud.convexCall("query", "edit:getProject", { projectId: "edit-connection-check" }, QUICK);
      return null;
    } catch (error) {
      if (error instanceof ConvexFailure && error.kind === "unreachable") return "Can't reach Edit's relay (offline?).";
      return diag.messageOf(error);
    }
  }
}

const CONTROL = /^\p{Cc}$/u;

/** Uses the setting: its token (unless `EDIT_RELAY_TOKEN` is set). */
function apply(settings: Settings): void {
  relay.setSavedToken(settings.token ?? null);
}

function writeSettings(settings: Settings): Settings {
  const out: Settings = {};
  if (settings.token !== undefined) out.token = settings.token;
  if (settings.holder !== undefined) out.holder = settings.holder;
  return out;
}

export function readSettings(home: string): Settings {
  try {
    const value = JSON.parse(fs.readFileSync(join(home, SETTINGS), "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const fields = value as Record<string, unknown>;
    const token = fields.token ?? null;
    const holder = fields.holder ?? null;
    if ((token !== null && typeof token !== "string") || (holder !== null && typeof holder !== "string")) return {};
    const settings: Settings = {};
    if (token !== null) settings.token = token as string;
    if (holder !== null) settings.holder = holder as string;
    return settings;
  } catch {
    return {};
  }
}

/** What `cloud/projects.json` keeps (nothing when it won't read, as serde's `.ok()`). */
export function readState(home: string): Map<string, Saved> {
  const out = new Map<string, Saved>();
  try {
    const value = JSON.parse(fs.readFileSync(join(home, STATE_DIR, STATE), "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
    for (const [id, given] of Object.entries(value as Record<string, unknown>)) {
      const saved = readSaved(given);
      if (saved === null) return new Map();
      out.set(id, saved);
    }
  } catch {
    return new Map();
  }
  return out;
}

/** The saved token for `edit cloud …` (no server running). */
export function useSavedToken(home: string): void {
  apply(readSettings(home));
}

/** Writes `text` atomically, readable by this user only (it may hold the token). */
export function writePrivate(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, path);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`saving ${path}: ${diag.messageOf(error)}`);
  }
}

/** What `commitProject` keeps beside a body, for listing without it (≤ 64 KB). */
export function summary(project: Project): Record<string, unknown> {
  return {
    clips: project.clips.length,
    cloudMedia: project.media.filter((media) => media.cloud !== undefined && media.cloud !== null).length,
    durationFrames: duration(project),
    fps: project.settings.fps,
    height: project.settings.height,
    media: project.media.length,
    style: project.style,
    subtitles: isSubtitled(project),
    width: project.settings.width,
  };
}

/** `value[name]`, null when it isn't there. */
function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const found = (value as Record<string, unknown>)[name];
  return found === undefined ? null : found;
}

function asU64(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function conflictedName(name: string): string {
  return `${name} ${CONFLICTED}`;
}

// ---------------------------------------------------------------------------
// Convex through the relay, and the bodies Convex stores.

type Acquired = { got: string } | { heldBy: string };
type Renewed = { yes: true } | { lost: string | null };

interface Meta {
  rev: number;
  bodyUrl: string;
  /** Who holds a live lease (expired ones are dropped). */
  holder: string | null;
}

export const remote = {
  async acquire(id: string, holder: string, force: boolean): Promise<Acquired> {
    const answer = await cloud.convexCall("mutation", "edit:acquireLock", { projectId: id, holder, force }, QUICK);
    if (field(answer, "acquired") === true) {
      const token = field(answer, "token");
      if (typeof token !== "string" || token === "") throw ConvexFailure.relay("acquireLock gave no token");
      return { got: token };
    }
    const heldBy = field(answer, "heldBy");
    return { heldBy: typeof heldBy === "string" ? heldBy : "Someone" };
  },

  async renew(id: string, token: string): Promise<Renewed> {
    const answer = await cloud.convexCall("mutation", "edit:renewLock", { projectId: id, lockToken: token }, QUICK);
    if (field(answer, "renewed") === true) return { yes: true };
    const until = asU64(field(answer, "until"));
    const live = until !== null && until > nowMs();
    const heldBy = field(answer, "heldBy");
    return { lost: live && typeof heldBy === "string" ? heldBy : null };
  },

  async release(id: string, token: string): Promise<void> {
    await cloud.convexCall("mutation", "edit:releaseLock", { projectId: id, lockToken: token }, QUICK);
  },

  async get(id: string): Promise<Meta | null> {
    const answer = await cloud.convexCall("query", "edit:getProject", { projectId: id }, QUICK);
    if (answer === null || answer === undefined) return null;
    const bodyUrl = field(answer, "bodyUrl");
    return {
      rev: asU64(field(answer, "rev")) ?? 0,
      bodyUrl: typeof bodyUrl === "string" ? bodyUrl : "",
      holder: liveHolder(field(answer, "lock")),
    };
  },

  async list(): Promise<unknown[]> {
    const answer = await cloud.convexCall("query", "edit:listProjects", {}, QUICK);
    return Array.isArray(answer) ? answer : [];
  },

  /** Whether there was a project to delete (its lock goes either way). */
  async delete(id: string, token: string | null): Promise<boolean> {
    const args: Record<string, unknown> = token !== null ? { projectId: id, lockToken: token } : { projectId: id };
    const answer = await cloud.convexCall("mutation", "edit:deleteProject", args, QUICK);
    return field(answer, "deleted") === true;
  },

  /** Uploads `project` and commits it as the rev after `base`: the new rev. */
  async push(project: Project, base: number, token: string | null, holder: string): Promise<number> {
    const body = JSON.stringify(project);
    const url = await cloud.convexCall("mutation", "edit:uploadUrl", {}, QUICK);
    if (typeof url !== "string") throw ConvexFailure.relay("uploadUrl gave no URL");
    const answer = await http("POST", url, body, SLOW);
    let storage: unknown = null;
    try {
      storage = field(JSON.parse(new TextDecoder().decode(answer)) as unknown, "storageId");
    } catch {
      storage = null;
    }
    if (typeof storage !== "string") throw ConvexFailure.relay("the upload gave no storage id");
    const args: Record<string, unknown> = {
      baseRev: base,
      bodySize: byteLength(body),
      holder,
      name: project.name,
      projectId: project.id,
      storageId: storage,
      summary: summary(project),
    };
    if (token !== null) args.lockToken = token;
    const committed = await cloud.convexCall("mutation", "edit:commitProject", args, QUICK);
    const rev = asU64(field(committed, "rev"));
    if (rev === null) throw ConvexFailure.relay("commitProject gave no rev");
    return rev;
  },

  /** The project stored at `url` (a `getProject` body URL). */
  async download(url: string): Promise<Project> {
    const bytes = await http("GET", url, null, SLOW);
    let value: unknown;
    try {
      value = serdeParse(new TextDecoder().decode(bytes));
    } catch (error) {
      throw new Error(`the cloud's project file: ${diag.messageOf(error)}`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("the cloud's project file: invalid type: expected struct Project");
    }
    return value as Project;
  },
};

/** The holder of a lease that hasn't run out by this machine's clock. */
export function liveHolder(lock: unknown): string | null {
  const until = asU64(field(lock, "until"));
  if (until === null || until <= nowMs()) return null;
  const holder = field(lock, "holder");
  return typeof holder === "string" ? holder : null;
}

/**
 * One request to Convex's storage; the answer's body. A request that gets
 * nowhere is unreachable (offline), like the relay's.
 */
async function http(method: string, url: string, body: string | null, timeout: number): Promise<Uint8Array> {
  if (!url.startsWith("https://") && !url.startsWith("http://")) throw ConvexFailure.relay(`not a URL: ${takeChars(url, 60)}`);
  let response: Response;
  let answer: Uint8Array;
  try {
    response = await fetch(url, {
      method,
      body: body ?? undefined,
      headers: body !== null ? { "content-type": "application/json" } : {},
      signal: AbortSignal.timeout(timeout * 1000),
    });
    answer = await response.bytes();
  } catch (error) {
    throw ConvexFailure.unreachable(`could not reach the cloud: ${diag.scrub(diag.messageOf(error))}`);
  }
  if (response.status !== 200) {
    throw ConvexFailure.relay(`cloud storage answered ${response.status}: ${takeChars(new TextDecoder().decode(answer), 200)}`);
  }
  return answer;
}

// ---------------------------------------------------------------------------
// The loop.

let server: { cloud: Cloud; app: App } | null = null;

/** The cloud projects attached to `app`'s store, if any. */
export function cloudOf(app: App): Cloud | null {
  const hook = app.store.cloud();
  return hook instanceof Cloud ? hook : null;
}

/**
 * The server's cloud projects (main.rs: `Cloud::open(home, machine)` then
 * `cloud_projects::start`): attaches the store's hook and starts the loop.
 */
export function start(app: App): Cloud {
  const cloudProjects = Cloud.open(app.store.home, app.machine);
  attach(app, cloudProjects);
  return cloudProjects;
}

/** Attaches `cloudProjects` to `app`'s store and runs its loop (tests attach their own). */
export function attach(app: App, cloudProjects: Cloud): void {
  cloudProjects.attach(app.store);
  server ??= { cloud: cloudProjects, app };
  if (cloudProjects.on()) diag.info("cloud", `cloud on as ${cloudProjects.holder()} (${relay.url()})`);
  void loop(app, cloudProjects);
}

/** Stops `cloudProjects`' loop (tests; the server's runs until it exits). */
export function stop(cloudProjects: Cloud): void {
  cloudProjects.stopped = true;
  cloudProjects.wake();
  if (server?.cloud === cloudProjects) server = null;
}

async function loop(app: App, cloudProjects: Cloud): Promise<void> {
  while (!cloudProjects.stopped) {
    if (cloudProjects.on()) {
      const at = now();
      const due: [string, Step][] = [];
      for (const [id, entry] of cloudProjects.projects) {
        const step = entry.step(at);
        if (step === null) continue;
        entry.busy = step;
        due.push([id, step]);
      }
      for (const [id, step] of due) {
        void (async () => {
          try {
            if (step === "Push" || step === "Pull") cloudProjects.emit(id);
            await runStep(app, cloudProjects, id, step);
          } finally {
            cloudProjects.with(id, (entry) => {
              entry.busy = null;
            });
            cloudProjects.persist();
            cloudProjects.emit(id);
            cloudProjects.wake();
          }
        })();
      }
    }
    await cloudProjects.nap(1000);
  }
}

/** Runs one step for `id` (the entry is marked busy meanwhile); a failure is noted on it. */
export async function runStep(app: App, cloudProjects: Cloud, id: string, step: Step): Promise<void> {
  try {
    switch (step) {
      case "Pull":
        await pull(app, cloudProjects, id);
        break;
      case "Media":
        cloudProjects.with(id, (entry) => {
          entry.wantMedia = false;
        });
        await cloudMedia.ensureLocal(app, id);
        break;
      case "Acquire":
        await acquire(app, cloudProjects, id, false);
        break;
      case "Push":
        await push(app, cloudProjects, id);
        break;
      case "Renew":
        await renew(app, cloudProjects, id);
        break;
      case "Release":
        await release(cloudProjects, id);
        break;
      case "Check":
        await check(app, cloudProjects, id);
        break;
    }
  } catch (error) {
    const message = isBug(error) ? crashed(`cloud ${step} ${id}`, error) : diag.messageOf(error);
    diag.warn("cloud", `${step} ${id}: ${message}`);
    cloudProjects.with(id, (entry) => entry.failed(message, now()));
  }
}

/**
 * Handles a failed call: offline is a retry, a refused lock is someone else's
 * turn, anything else an error (thrown).
 */
async function failure(app: App, cloudProjects: Cloud, id: string, given: unknown): Promise<void> {
  if (!(given instanceof ConvexFailure)) throw given;
  if (given.kind === "unreachable") {
    cloudProjects.with(id, (entry) => entry.unreachable(now()));
    return;
  }
  if (given.code === "locked" && given.kind === "function") {
    const holder = field(given.data, "heldBy");
    if (typeof holder === "string" && holder !== cloudProjects.holder()) return lost(app, cloudProjects, id, holder);
    // Expired, or this holder's under another token: take it again.
    cloudProjects.with(id, (entry) => entry.forgetLock());
    return;
  }
  if (given.code === "conflict") return conflict(app, cloudProjects, id);
  throw new Error(given.message);
}

/**
 * Takes the lock (`force`: from whoever has it), then catches up with the
 * cloud: a newer version is pulled (or, over changes made here, kept beside
 * them as a conflict).
 */
async function acquire(app: App, cloudProjects: Cloud, id: string, force: boolean): Promise<void> {
  const holder = cloudProjects.holder();
  let acquired: Acquired;
  try {
    acquired = await remote.acquire(id, holder, force);
  } catch (error) {
    return failure(app, cloudProjects, id, error);
  }
  if ("got" in acquired) {
    cloudProjects.with(id, (entry) => entry.acquired(acquired.got, now()));
    return catchUp(app, cloudProjects, id);
  }
  if (acquired.heldBy === holder) return;
  return lost(app, cloudProjects, id, acquired.heldBy);
}

/**
 * With the lock just taken: a newer cloud version comes here (a conflict when
 * there are changes here too); a project deleted from the cloud stays on this
 * machine only.
 */
async function catchUp(app: App, cloudProjects: Cloud, id: string): Promise<void> {
  let meta: Meta | null;
  try {
    meta = await remote.get(id);
  } catch (error) {
    return failure(app, cloudProjects, id, error);
  }
  const rev = cloudProjects.savedRev(id);
  const dirty = cloudProjects.dirty(id);
  if (meta !== null) {
    if (meta.rev > rev && dirty) return conflict(app, cloudProjects, id);
    if (meta.rev > rev) return pull(app, cloudProjects, id);
    return;
  }
  // Deleted from the cloud by a teammate (it had been pushed): this
  // machine's copy stays, as a project here only.
  if (rev > 0) {
    await release(cloudProjects, id);
    cloudProjects.forget(id);
    diag.info("cloud", `${id} was deleted from the cloud; kept on this machine only`);
  }
}

/** Takes the cloud's version (and the footage it needs here). */
async function pull(app: App, cloudProjects: Cloud, id: string): Promise<void> {
  cloudProjects.with(id, (entry) => {
    entry.wantPull = false;
  });
  let fetched: [Project, number] | null;
  try {
    const meta = await remote.get(id);
    if (meta === null) {
      fetched = null;
    } else {
      let project: Project;
      try {
        project = await remote.download(meta.bodyUrl);
      } catch (error) {
        if (error instanceof ConvexFailure || isBug(error)) throw error;
        throw ConvexFailure.relay(diag.messageOf(error));
      }
      fetched = [project, meta.rev];
    }
  } catch (error) {
    return failure(app, cloudProjects, id, error);
  }
  if (fetched === null) throw new Error("it isn't in the cloud any more");
  const [project, rev] = fetched;
  // Changes made here since are kept, never overwritten.
  if (cloudProjects.dirty(id)) keepCopy(app, cloudProjects, id, null);
  cloudProjects.take(id, project, rev);
  try {
    await cloudMedia.ensureLocal(app, id);
  } catch (error) {
    diag.warn("cloud", `fetching ${id}'s footage: ${diag.messageOf(error)}`);
  }
}

/** Keeps this machine's version of `id` as "<name> (conflicted copy)" (on this machine only) and says so. */
function keepCopy(app: App, cloudProjects: Cloud, id: string, tookOver: string | null): void {
  const live = app.store.get(id);
  if (live === null) return;
  const name = conflictedName(live.project.name);
  const copy = app.store.createCopy(live.project, name);
  diag.warn(
    "cloud",
    `${id}: ${tookOver === null ? "a conflict" : `${tookOver} took over`}; this machine's changes kept as ${copy.project.id} (${name})`,
  );
  const message =
    tookOver !== null
      ? `${tookOver} took over “${live.project.name}” before your last changes reached the cloud. They're kept as “${name}” on this Mac.`
      : `“${live.project.name}” was changed on another machine meanwhile, so the cloud's version is open. Your changes here are kept as “${name}” on this Mac.`;
  cloudProjects.with(id, (entry) => {
    entry.saved.dirty = false;
    entry.note = { kind: "conflict", message };
  });
  app.store.emit({ type: "cloud-conflict", id, message, copy: { id: copy.project.id, name } });
}

/** The cloud has moved on past this machine's base: keep ours as a copy, take theirs. */
async function conflict(app: App, cloudProjects: Cloud, id: string): Promise<void> {
  if (cloudProjects.dirty(id)) keepCopy(app, cloudProjects, id, null);
  return pull(app, cloudProjects, id);
}

/** Someone else has the lock: changes made here become a copy, the editor goes read-only and shows their version. */
async function lost(app: App, cloudProjects: Cloud, id: string, holder: string): Promise<void> {
  const hadChanges = cloudProjects.dirty(id);
  if (hadChanges) keepCopy(app, cloudProjects, id, holder);
  cloudProjects.with(id, (entry) => entry.elsewhere(holder, now()));
  let newer: boolean;
  try {
    const meta = await remote.get(id);
    newer = meta !== null && meta.rev > cloudProjects.savedRev(id);
  } catch (error) {
    return failure(app, cloudProjects, id, error);
  }
  if (hadChanges || newer) await pull(app, cloudProjects, id);
}

async function push(app: App, cloudProjects: Cloud, id: string): Promise<void> {
  const live = app.store.get(id);
  if (live === null) {
    cloudProjects.forget(id);
    return;
  }
  const state = cloudProjects.with(id, (entry) => [entry.saved.rev, entry.saved.token ?? null, entry.edits] as const);
  if (state === undefined) return;
  const [base, token, edits] = state;
  const started = performance.now();
  let rev: number;
  try {
    rev = await remote.push(live.project, base, token, cloudProjects.holder());
  } catch (error) {
    return failure(app, cloudProjects, id, error);
  }
  diag.record("cloud", "cloud: push", performance.now() - started, null);
  cloudProjects.with(id, (entry) => entry.pushed(rev, edits));
  // Whatever the edit uses that isn't in the cloud yet goes up.
  cloudMedia.backfillSoon(app, id);
}

async function renew(app: App, cloudProjects: Cloud, id: string): Promise<void> {
  const token = cloudProjects.with(id, (entry) => entry.saved.token ?? null) ?? null;
  if (token === null) {
    cloudProjects.with(id, (entry) => entry.forgetLock());
    return;
  }
  let renewed: Renewed;
  try {
    renewed = await remote.renew(id, token);
  } catch (error) {
    return failure(app, cloudProjects, id, error);
  }
  if ("yes" in renewed) {
    cloudProjects.with(id, (entry) => {
      entry.renewedAt = now();
      entry.succeeded();
    });
    return;
  }
  if (renewed.lost !== null && renewed.lost !== cloudProjects.holder()) return lost(app, cloudProjects, id, renewed.lost);
  cloudProjects.with(id, (entry) => entry.forgetLock());
}

async function release(cloudProjects: Cloud, id: string): Promise<void> {
  const token = cloudProjects.with(id, (entry) => entry.saved.token ?? null) ?? null;
  cloudProjects.with(id, (entry) => entry.released());
  if (token === null) return;
  try {
    await remote.release(id, token);
  } catch {
    // Offline, the lease runs out by itself in two minutes.
  }
}

/** Someone else holds it and it's open here: when they let go, take it (with their latest version). */
async function check(app: App, cloudProjects: Cloud, id: string): Promise<void> {
  cloudProjects.with(id, (entry) => {
    entry.checkedAt = now();
  });
  let meta: Meta | null;
  try {
    meta = await remote.get(id);
  } catch (error) {
    return failure(app, cloudProjects, id, error);
  }
  if (meta === null) return;
  const holder = meta.holder;
  if (holder !== null && holder !== cloudProjects.holder()) {
    const newer = meta.rev > cloudProjects.savedRev(id);
    cloudProjects.with(id, (entry) => {
      entry.lock = { kind: "elsewhere", holder };
    });
    if (newer) await pull(app, cloudProjects, id);
    return;
  }
  return acquire(app, cloudProjects, id, false);
}

// ---------------------------------------------------------------------------
// Requests from the UI.

/**
 * Opens `id` in the editor for `client`: a project only in the cloud is
 * downloaded first; the lock is asked for (or who has it found out) before
 * answering, so the editor knows whether it's read-only. Offline answers at
 * once and edits are queued.
 */
export async function open(app: App, id: string, client: string): Promise<Record<string, unknown>> {
  const cloudProjects = cloudOf(app);
  if (cloudProjects === null) return { cloud: false, on: false };
  if (!cloudProjects.on()) return cloudProjects.status(id);
  if (app.store.get(id) === null) await download(app, cloudProjects, id);
  cloudProjects.viewing(id, client);
  const step = cloudProjects.with(id, (entry) => {
    // A new look: what was said last time has been seen.
    entry.note = null;
    if (entry.busy !== null) return null;
    const next: Step | null = entry.lock.kind === "unknown" || entry.lock.kind === "provisional" ? "Acquire" : entry.lock.kind === "elsewhere" ? "Check" : null;
    // A step about to run anyway goes now.
    entry.retryAt = null;
    entry.busy = next;
    return next;
  });
  if (step !== undefined && step !== null) {
    try {
      await runStep(app, cloudProjects, id, step);
    } finally {
      cloudProjects.with(id, (entry) => {
        entry.busy = null;
      });
      cloudProjects.persist();
      cloudProjects.emit(id);
    }
  }
  cloudMedia.backfillSoon(app, id);
  return cloudProjects.status(id);
}

/** A project only in the cloud, brought to this machine. */
async function download(app: App, cloudProjects: Cloud, id: string): Promise<void> {
  if (!validId(id)) throw new Error("no such project");
  if (!cloudProjects.projects.has(id)) cloudProjects.projects.set(id, new Entry({ rev: 0, dirty: false }));
  let fetched: [Project, number] | null;
  try {
    const meta = await remote.get(id);
    fetched = meta === null ? null : [await remote.download(meta.bodyUrl), meta.rev];
  } catch (error) {
    if (isBug(error)) throw error;
    cloudProjects.forget(id);
    throw new Error(`Couldn't download it from the cloud: ${diag.messageOf(error)}`);
  }
  if (fetched === null) {
    cloudProjects.forget(id);
    throw new Error("no such project");
  }
  const [project, rev] = fetched;
  cloudProjects.take(id, project, rev);
  diag.info("cloud", `${id} downloaded from the cloud (rev ${rev})`);
  try {
    await cloudMedia.ensureLocal(app, id);
  } catch (error) {
    diag.warn("cloud", `fetching ${id}'s footage: ${diag.messageOf(error)}`);
  }
}

/** Takes the lock from whoever has it and shows their latest version. */
export async function takeOver(app: App, id: string): Promise<Record<string, unknown>> {
  const cloudProjects = cloudOf(app);
  if (cloudProjects === null) throw new Error("cloud is off");
  if (!cloudProjects.on() || !cloudProjects.isCloud(id)) throw new Error("this isn't a cloud project");
  let waited = 0;
  while ((cloudProjects.with(id, (entry) => entry.busy !== null) ?? false) && waited < 300) {
    await Bun.sleep(100);
    waited += 1;
  }
  cloudProjects.with(id, (entry) => {
    entry.busy = "Acquire";
  });
  try {
    await acquire(app, cloudProjects, id, true);
  } finally {
    cloudProjects.with(id, (entry) => {
      entry.busy = null;
    });
    cloudProjects.persist();
    cloudProjects.emit(id);
  }
  return cloudProjects.status(id);
}

/**
 * Moves a project only on this machine to the cloud; its media follow in the
 * background after the first push (`cloud_media.backfillSoon`).
 */
export async function moveToCloud(app: App, id: string): Promise<Record<string, unknown>> {
  const cloudProjects = cloudOf(app);
  if (cloudProjects === null) throw new Error("cloud is off");
  if (!cloudProjects.on()) throw new Error("Turn cloud on first (Settings → Cloud).");
  if (app.store.get(id) === null) throw new Error("no such project");
  cloudProjects.adopt(id);
  cloudProjects.emit(id);
  return cloudProjects.status(id);
}

/**
 * Deletes `id` from the cloud (before it's deleted here): refused while
 * someone else is editing it, or while the cloud can't be reached. Whether
 * the cloud had it.
 */
export async function remove(app: App, id: string): Promise<boolean> {
  const cloudProjects = cloudOf(app);
  if (cloudProjects === null) return false;
  const local = app.store.get(id) !== null;
  if (!cloudProjects.on() || !validId(id)) {
    cloudProjects.forget(id);
    return false;
  }
  if (local && !cloudProjects.isCloud(id)) return false;
  const holder = cloudProjects.holder();
  const kept = cloudProjects.with(id, (entry) => entry.saved.token ?? null) ?? null;
  let deleted: boolean;
  try {
    let token = kept;
    if (token === null) {
      const acquired = await remote.acquire(id, holder, false);
      if ("heldBy" in acquired) throw ConvexFailure.function(`${acquired.heldBy} is editing it.`, "locked", null);
      token = acquired.got;
    }
    deleted = await remote.delete(id, token);
  } catch (error) {
    if (!(error instanceof ConvexFailure)) throw error;
    if (error.kind === "unreachable") throw new Error("Can't reach the cloud to delete it there too; try again when you're online.");
    if (error.kind === "function" && error.code === "locked") throw new Error(`Can't delete it: ${error.said}`);
    throw new Error(error.message);
  }
  cloudProjects.forget(id);
  diag.info("cloud", `${id} deleted from the cloud`);
  return deleted;
}

/**
 * The cloud's projects for the home screen, with each one's lock (live only),
 * whether it's on this machine, and this machine's statuses.
 */
export async function list(app: App): Promise<Record<string, unknown>> {
  const cloudProjects = cloudOf(app);
  if (cloudProjects === null) return { on: false };
  if (!cloudProjects.on()) return { on: false, statuses: cloudProjects.statuses() };
  const holder = cloudProjects.holder();
  let items: unknown[];
  try {
    items = await remote.list();
  } catch (error) {
    const statuses = cloudProjects.statuses();
    if (error instanceof ConvexFailure) {
      return { error: error.message, holder, offline: error.kind === "unreachable", on: true, statuses };
    }
    return { error: diag.messageOf(error), on: true, statuses };
  }
  const statuses = cloudProjects.statuses();
  const projects = items.map((item) => {
    const projectId = field(item, "projectId");
    const id = typeof projectId === "string" ? projectId : "";
    const holderNow = liveHolder(field(item, "lock"));
    return {
      here: holderNow === holder,
      holder: holderNow,
      id,
      local: validId(id) && app.store.get(id) !== null,
      name: field(item, "name"),
      rev: field(item, "rev"),
      summary: field(item, "summary"),
      updated_by: field(item, "updatedBy"),
      updated_ms: field(item, "updatedAt"),
    };
  });
  return { holder, on: true, projects, statuses };
}

/**
 * On the way out (the window closed, Ctrl-C): pushes what's left and lets
 * every lock go, so a teammate can open them straight away. A few seconds at
 * most per project.
 */
export async function shutdown(): Promise<void> {
  if (server === null) return;
  const { cloud: cloudProjects, app } = server;
  if (!cloudProjects.on()) return;
  const held: [string, string, boolean, number][] = [];
  for (const [id, entry] of cloudProjects.projects) {
    if (entry.saved.token !== undefined) held.push([id, entry.saved.token, entry.saved.dirty, entry.saved.rev]);
  }
  const holder = cloudProjects.holder();
  for (const [id, token, dirty, base] of held) {
    if (dirty) {
      const live = app.store.get(id);
      if (live !== null) {
        const edits = cloudProjects.with(id, (entry) => entry.edits) ?? 0;
        try {
          const rev = await remote.push(live.project, base, token, holder);
          cloudProjects.with(id, (entry) => entry.pushed(rev, edits));
        } catch (error) {
          // Left dirty: pushed (or kept as a conflict) next time.
          diag.warn("cloud", `pushing ${id} on exit: ${diag.messageOf(error)}`);
        }
      }
    }
    try {
      await remote.release(id, token);
    } catch {
      // The lease runs out by itself.
    }
    cloudProjects.with(id, (entry) => entry.released());
  }
  cloudProjects.persist();
}

/** Lets go of every lock (the token forgotten). */
export async function releaseAll(app: App): Promise<void> {
  const cloudProjects = cloudOf(app);
  if (cloudProjects === null) return;
  const held = [...cloudProjects.projects].filter(([, entry]) => entry.saved.token !== undefined).map(([id]) => id);
  for (const id of held) await release(cloudProjects, id);
  cloudProjects.persist();
}

// ---------------------------------------------------------------------------
// HTTP routes

/** JSON with sorted keys (a `json!` value), as `Json(value)` answered. */
function sorted(value: unknown, status = 200): Response {
  return new Response(stableStringify(value), { status, headers: { "content-type": "application/json" } });
}

export function routes(router: Router<App>): void {
  router.get("/api/cloud", getSettings);
  router.post("/api/cloud", postSettings);
  router.get("/api/cloud/projects", async ({ app }) => sorted(await list(app)));
  router.get("/api/projects/{id}/cloud", ({ app, params }) => {
    const cloudProjects = cloudOf(app);
    return sorted(cloudProjects === null ? { cloud: false, on: false } : cloudProjects.status(params.id ?? ""));
  });
  router.post("/api/projects/{id}/cloud/open", postOpen);
  router.post("/api/projects/{id}/cloud/close", postClose);
  router.post("/api/projects/{id}/cloud/takeover", async ({ app, params }) => sorted(await refusing(409, () => takeOver(app, params.id ?? ""))));
  router.post("/api/projects/{id}/cloud/upload", async ({ app, params }) => sorted(await refusing(400, () => moveToCloud(app, params.id ?? ""))));
  router.post("/api/projects/{id}/cloud/backfill", async ({ app, params }) => sorted(await refusing(400, () => cloudMedia.backfill(app, params.id ?? ""))));
}

/** `work`'s answer, or its failure as `{error}` with `status` (a bug stays a 500). */
async function refusing<T>(status: number, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError || isBug(error)) throw error;
    throw new ApiError(status, diag.messageOf(error));
  }
}

function needCloud(app: App): Cloud {
  const cloudProjects = cloudOf(app);
  if (cloudProjects === null) throw new ApiError(404, "no cloud here");
  return cloudProjects;
}

/** Settings → Cloud, and (`?check=true`) whether the relay takes the token. */
async function getSettings({ app, query }: RouteContext<App>): Promise<Response> {
  const cloudProjects = needCloud(app);
  const check = query.get("check");
  if (check !== null && check !== "true" && check !== "false") {
    throw new ApiError(400, "Failed to deserialize query string: check: provided string was not `true` or `false`", true);
  }
  return sorted(await settingsReply(cloudProjects, check === "true"));
}

async function settingsReply(cloudProjects: Cloud, check: boolean): Promise<Record<string, unknown>> {
  const answer = cloudProjects.settingsStatus();
  if (check && typeof answer.token === "string") {
    let problem: string | null;
    try {
      problem = await cloudProjects.connectionProblem();
    } catch (error) {
      problem = diag.messageOf(error);
    }
    answer.connected = problem === null;
    answer.problem = problem;
  }
  return answer;
}

/** serde's word for a JSON value of the wrong type. */
function unexpected(value: unknown): string {
  if (typeof value === "boolean") return `boolean \`${value}\``;
  if (typeof value === "number") return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (Array.isArray(value)) return "sequence";
  if (value === null) return "null";
  return "map";
}

async function body(context: RouteContext<App>, struct: string): Promise<Record<string, unknown>> {
  const given = await readJson<unknown>(context);
  if (typeof given !== "object" || given === null || Array.isArray(given)) {
    throw badShape(`invalid type: ${unexpected(given)}, expected struct ${struct}`);
  }
  return given as Record<string, unknown>;
}

/** A field that may be absent (unchanged), null (cleared) or a string. */
function present(given: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in given)) return undefined;
  const value = given[key];
  if (value === null || typeof value === "string") return value;
  throw badShape(`${key}: invalid type: ${unexpected(value)}, expected a string`);
}

async function postSettings(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  const cloudProjects = needCloud(app);
  const given = await body(context, "SettingsBody");
  const token = present(given, "token");
  const holder = present(given, "holder");
  const wasOn = cloudProjects.on();
  // Let go of this machine's locks while the old token still works.
  if (wasOn && token === null) await releaseAll(app);
  try {
    cloudProjects.setSettings(token, holder);
  } catch (error) {
    if (isBug(error)) throw error;
    throw new ApiError(400, diag.messageOf(error));
  }
  diag.info("cloud", cloudProjects.on() ? `cloud on as ${cloudProjects.holder()}` : "cloud off: no token");
  app.store.emit({ type: "cloud-settings", on: cloudProjects.on() });
  return sorted(await settingsReply(cloudProjects, true));
}

/** `{client, heartbeat}` (both defaulted, as serde reads `Client`). */
async function client(context: RouteContext<App>): Promise<{ client: string; heartbeat: boolean }> {
  const given = await body(context, "Client");
  const name = given.client ?? "";
  const heartbeat = given.heartbeat ?? false;
  if (typeof name !== "string") throw badShape(`client: invalid type: ${unexpected(name)}, expected a string`);
  if (typeof heartbeat !== "boolean") throw badShape(`heartbeat: invalid type: ${unexpected(heartbeat)}, expected a boolean`);
  return { client: name, heartbeat };
}

/** The editor opened `id` (and says so again every 30 s while it's open). */
async function postOpen(context: RouteContext<App>): Promise<Response> {
  const { app } = context;
  const id = context.params.id ?? "";
  const given = await client(context);
  const cloudProjects = cloudOf(app);
  if (given.heartbeat && cloudProjects !== null) {
    cloudProjects.viewing(id, given.client);
    return sorted(cloudProjects.status(id));
  }
  return sorted(await refusing(404, () => open(app, id, given.client)));
}

async function postClose(context: RouteContext<App>): Promise<Response> {
  const given = await client(context);
  cloudOf(context.app)?.closed(context.params.id ?? "", given.client);
  return sorted({ ok: true });
}

/**
 * For tests elsewhere (`cloud_media`): cloud projects as this machine sees
 * them, each held here (null) or by someone else; nothing global touched.
 */
export function testCloud(home: string, projects: [string, string | null][]): Cloud {
  const made = new Cloud(home, "test");
  for (const [id, holder] of projects) {
    let entry: Entry;
    if (holder === null) {
      entry = new Entry({ rev: 1, dirty: false, token: "lock" });
    } else {
      entry = new Entry({ rev: 0, dirty: false });
      entry.elsewhere(holder, now());
    }
    made.projects.set(id, entry);
  }
  return made;
}
