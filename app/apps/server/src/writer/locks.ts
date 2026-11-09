// Writer scripts' cloud locks: the same lock as an edit's (sync_core.ts,
// cloud_projects.ts), so two Macs never both change one script. Until Nov 8
// scripts had none: each Mac pushed when it liked and the one overtaken kept a
// "(conflicted copy)" (nine on the team's Macs that day).
//
// A script's lock is Convex's project lease under `writer-<id>` (Edit's
// `edit:acquireLock` / `renewLock` / `releaseLock`), held by presence like an
// edit's: while the script page has it open here (its heartbeat), or an import
// or Claude works on it here (busy.ts), or for LINGER after a push with nobody
// looking. A save to a script another computer holds is refused (423, saying
// who), and the page offers Take over. Where the cloud has no lock for scripts
// (a Convex from before) or can't be reached, scripts sync as they did:
// pushed, the overtaken one kept as a copy.

import * as fs from "node:fs";

import * as cloud from "../cloud.ts";
import { ConvexFailure } from "../cloud.ts";
import * as diag from "../diag.ts";
import { ApiError } from "../http/errors.ts";
import { writeAtomic } from "../files.ts";
import { join, parent } from "../paths.ts";
import { displayName, keepsLock, TIMING } from "../sync_core.ts";

const { VIEWER_TTL, RENEW_EVERY, LINGER, CHECK_EVERY } = TIMING;
const QUICK = TIMING.QUICK / 1000;

/** One script's lock as this Mac knows it. */
interface Lock {
  /** unknown: not asked; held: ours (`token`); elsewhere: `holder`'s; none: the cloud keeps no lock for scripts, or isn't there. */
  state: "unknown" | "held" | "elsewhere" | "none";
  token?: string;
  holder?: string;
  renewedAt?: number;
  checkedAt?: number;
  /** When this Mac last pushed it, for LINGER. */
  pushedAt?: number;
  /** Script pages here with it open, and when they last said so. */
  viewers: Map<string, number>;
  closing: boolean;
}

const locks = new Map<string, Lock>();
let busyCheck: (id: string) => boolean = () => false;
let dataFolder: string | null = null;

const keyOf = (id: string): string => `writer-${id}`;
const tokensPath = (data: string): string => join(data, "cloud", "locks.json");

function lockOf(id: string): Lock {
  let lock = locks.get(id);
  if (lock === undefined) {
    lock = { state: "unknown", viewers: new Map(), closing: false };
    locks.set(id, lock);
  }
  return lock;
}

/** Starts the locks for `data`: the tokens held before a restart are taken back (renewed first), and `working` says what runs on a script here. */
export function start(data: string, working: (id: string) => boolean): void {
  dataFolder = data;
  busyCheck = working;
  try {
    const kept = JSON.parse(fs.readFileSync(tokensPath(data), "utf8")) as Record<string, string>;
    for (const [id, token] of Object.entries(kept)) if (typeof token === "string") Object.assign(lockOf(id), { state: "held", token });
  } catch {
    // None kept.
  }
}

function persist(): void {
  if (dataFolder === null) return;
  const tokens: Record<string, string> = {};
  for (const [id, lock] of locks) if (lock.state === "held" && lock.token !== undefined) tokens[id] = lock.token;
  try {
    fs.mkdirSync(parent(tokensPath(dataFolder)) ?? ".", { recursive: true });
    writeAtomic(tokensPath(dataFolder), JSON.stringify(tokens, null, 2));
  } catch (error) {
    diag.warn("writer", `keeping the scripts' locks: ${diag.messageOf(error)}`);
  }
}

/** A script page here has `id` open (it says so every HEARTBEAT). */
export function viewing(id: string, client: string): void {
  const lock = lockOf(id);
  lock.viewers.set(client, performance.now());
  lock.closing = false;
}

/** A script page here closed `id`. */
export function closed(id: string, client: string): void {
  const lock = lockOf(id);
  lock.viewers.delete(client);
  if (lock.viewers.size === 0) lock.closing = true;
}

function watched(lock: Lock, now: number): boolean {
  for (const seen of lock.viewers.values()) if (now - seen < VIEWER_TTL) return true;
  return false;
}

/** What the script page shows: who holds it when it's someone else, and whether this Mac may change it. */
export function status(id: string): { holder: string | null; writable: boolean } {
  const lock = locks.get(id);
  const holder = lock?.state === "elsewhere" ? displayName(lock.holder ?? "Someone") : null;
  return { holder, writable: holder === null };
}

/** Refuses a save to a script another computer holds (store.ts's write): 423, saying who. */
export function mayWrite(id: string): void {
  const lock = locks.get(id);
  if (lock?.state !== "elsewhere") return;
  throw new ApiError(423, `${displayName(lock.holder ?? "Someone")} is editing this script, so it's read-only here until they close it (or you take over).`);
}

/** Whether this Mac may push `id` now: its lock is ours, or the cloud keeps none (or can't be reached); asked for first when it isn't known yet. */
export async function mayPush(id: string, holder: string): Promise<boolean> {
  const lock = lockOf(id);
  if (lock.state === "unknown") await acquire(id, holder, false);
  return lock.state === "held" || lock.state === "none";
}

/** Work runs on `id` here (an import, Claude): its lock is taken and kept while it does (`round`). */
export function touch(id: string): void {
  lockOf(id);
}

/** A push of `id` landed. */
export function pushed(id: string): void {
  lockOf(id).pushedAt = performance.now();
}

/** Takes `id` from whoever has it (the page's Take over). */
export async function takeOver(id: string, holder: string): Promise<{ holder: string | null; writable: boolean }> {
  await acquire(id, holder, true);
  return status(id);
}

/** Someone else took a script this Mac held (tests listen too). */
export const hooks: { lost: (id: string, holder: string) => void } = { lost: () => {} };

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const value = await cloud.convexCall("mutation", `edit:${name}`, args, QUICK);
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Whether a failed lock call means the cloud keeps no lock for scripts (a Convex that refuses the key, or a relay from before) rather than a passing failure. */
function noLocks(error: unknown): boolean {
  return error instanceof ConvexFailure && error.kind !== "unreachable";
}

async function acquire(id: string, holder: string, force: boolean): Promise<void> {
  const lock = lockOf(id);
  const now = performance.now();
  lock.checkedAt = now;
  let answer: Record<string, unknown> | null;
  try {
    answer = await call("acquireLock", { projectId: keyOf(id), holder, force });
  } catch (error) {
    // Offline or no locks for scripts: scripts sync as they did (pushed; the overtaken one kept as a copy).
    if (noLocks(error) && lock.state !== "none") diag.info("writer", `the cloud keeps no lock for scripts (${diag.messageOf(error)}); they sync without one`);
    if (lock.state !== "elsewhere") lock.state = "none";
    return;
  }
  if (answer?.acquired === true && typeof answer.token === "string") {
    Object.assign(lock, { state: "held", token: answer.token, renewedAt: now, holder: undefined });
    persist();
    return;
  }
  const by = typeof answer?.heldBy === "string" ? answer.heldBy : "Someone";
  if (by === holder) {
    lock.state = "none";
    return;
  }
  const had = lock.state === "held";
  Object.assign(lock, { state: "elsewhere", holder: by, token: undefined });
  persist();
  if (had) hooks.lost(id, by);
}

async function renew(id: string, holder: string): Promise<void> {
  const lock = lockOf(id);
  if (lock.token === undefined) return acquire(id, holder, false);
  let answer: Record<string, unknown> | null;
  try {
    answer = await call("renewLock", { projectId: keyOf(id), lockToken: lock.token });
  } catch {
    // The lease outlasts a missed renewal or two (sync_core's relations).
    return;
  }
  if (answer?.renewed === true) {
    lock.renewedAt = performance.now();
    return;
  }
  const until = typeof answer?.until === "number" ? answer.until : 0;
  const by = typeof answer?.heldBy === "string" && until > Date.now() ? answer.heldBy : null;
  if (by !== null && by !== holder) {
    Object.assign(lock, { state: "elsewhere", holder: by, token: undefined, checkedAt: performance.now() });
    persist();
    diag.info("writer", `${id.slice(0, 8)}: ${displayName(by)} took over`);
    hooks.lost(id, by);
    return;
  }
  // Ran out with nobody else on it: taken again.
  Object.assign(lock, { state: "unknown", token: undefined });
  await acquire(id, holder, false);
}

async function release(id: string): Promise<void> {
  const lock = lockOf(id);
  const token = lock.token;
  Object.assign(lock, { state: "unknown", token: undefined, closing: false });
  persist();
  if (token === undefined) return;
  try {
    await call("releaseLock", { projectId: keyOf(id), lockToken: token });
  } catch {
    // The lease runs out by itself.
  }
}

/**
 * One round of the scripts' locks (writer/cloud.ts's tick, after its pushes):
 * taken for what's open or worked on here, renewed, let go once nobody here
 * needs them, and someone else's looked at while it's open here.
 * `changed(id)`: it has changes not pushed yet (kept until they go).
 */
export async function round(holder: string, changed: (id: string) => boolean): Promise<void> {
  const now = performance.now();
  for (const [id, lock] of [...locks]) {
    const presence = { watched: watched(lock, now), working: busyCheck(id), lingering: lock.pushedAt !== undefined && now - lock.pushedAt < LINGER, closing: lock.closing };
    const wanted = keepsLock(presence);
    try {
      if (lock.state === "held") {
        if (!wanted && !changed(id)) await release(id);
        else if (lock.renewedAt === undefined || now - lock.renewedAt >= RENEW_EVERY) await renew(id, holder);
      } else if (lock.state === "unknown" || lock.state === "none") {
        // "none" is asked again now and then: a Convex deployed since may keep them.
        const due = lock.state === "unknown" || lock.checkedAt === undefined || now - lock.checkedAt >= 10 * CHECK_EVERY;
        if (wanted && due) await acquire(id, holder, false);
      } else if (presence.watched && (lock.checkedAt === undefined || now - lock.checkedAt >= CHECK_EVERY)) {
        // Someone else's, open here: taken once they let go.
        await acquire(id, holder, false);
      }
    } catch (error) {
      diag.warn("writer", `${id.slice(0, 8)}'s lock: ${diag.messageOf(error)}`);
    }
    if (lock.state !== "held" && lock.viewers.size === 0 && !presence.working && lock.state !== "elsewhere") locks.delete(id);
  }
}

/** Lets every lock go (Edit quitting), each call within QUIT_CALL. */
export async function releaseAll(): Promise<void> {
  const held = [...locks].filter(([, lock]) => lock.state === "held" && lock.token !== undefined);
  await Promise.all(
    held.map(async ([id, lock]) => {
      const token = lock.token!;
      Object.assign(lock, { state: "unknown", token: undefined });
      try {
        await cloud.convexCall("mutation", "edit:releaseLock", { projectId: keyOf(id), lockToken: token }, TIMING.QUIT_CALL / 1000);
      } catch {
        // The lease runs out by itself.
      }
    }),
  );
  persist();
}

/** Tests: every lock forgotten. */
export function resetForTests(): void {
  locks.clear();
  busyCheck = () => false;
  dataFolder = null;
}
