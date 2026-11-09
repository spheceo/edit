// What cloud projects (cloud_projects.ts) and Writer's scripts (writer/cloud.ts)
// share, so both sync one way (Nov 8 audit, item C): one lock per project or
// script, held by presence (someone has it open here, or an agent turn, an
// import or Claude works on it here) and never by writes alone; one holder id
// per data folder; a push's attempt written down before it's sent, so an
// answer lost at quit or under load is recognised later and never becomes a
// conflicted copy; and the timings that have to agree with each other, in one
// place with the relations they keep (`timingProblems`, tested).

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { join } from "./paths.ts";

/**
 * The timings the lock and the pushes run on, in ms. They depend on each
 * other; `timingProblems` says which relation one breaks:
 *
 * - The editor says it's open every HEARTBEAT (Editor.tsx, the script page);
 *   it's gone once it hasn't for VIEWER_TTL, which outlasts two heartbeats and
 *   a slow request between, so one late heartbeat never lets the lock go.
 * - A held lock is renewed every RENEW_EVERY; Convex's lease (LEASE, Repack's
 *   convex/edit.ts) outlasts two missed renewals with a QUICK call each, so a
 *   blip never loses it, and a take-over elsewhere is heard within one renewal
 *   (an agent turn here stops then, cloud_projects `lost`).
 * - Quitting gives the cloud QUIT_BUDGET (serve.ts) before Edit exits, inside
 *   the window's WINDOW_KILL (crates/edit-window); each call on the way out
 *   may take QUIT_CALL, so one call fits; what doesn't finish is pushed by the
 *   next start, its attempt already written down.
 * - A write made with nobody here (a background job) keeps the lock LINGER,
 *   so a run of them takes it once; a QUICK call fits in it.
 */
export const TIMING = {
  HEARTBEAT: 30_000,
  VIEWER_TTL: 75_000,
  RENEW_EVERY: 15_000,
  LEASE: 120_000,
  QUICK: 15_000,
  /** How long a body upload may take. */
  SLOW: 180_000,
  QUIT_BUDGET: 5_000,
  QUIT_CALL: 4_000,
  WINDOW_KILL: 6_000,
  LINGER: 15_000,
  /** A push waits this long after the last change. */
  DEBOUNCE: 2_000,
  /** How often a project someone else holds is looked at while it's open here. */
  CHECK_EVERY: 10_000,
} as const;

export type Timing = { readonly [K in keyof typeof TIMING]: number };

/** The relations `TIMING` must keep, each one broken said in words (none: all kept). */
export function timingProblems(t: Timing = TIMING): string[] {
  const out: string[] = [];
  if (t.VIEWER_TTL <= 2 * t.HEARTBEAT) out.push("an editor must be able to miss a heartbeat: VIEWER_TTL > 2 × HEARTBEAT");
  if (t.VIEWER_TTL - 2 * t.HEARTBEAT < t.QUICK / 2) out.push("a late heartbeat needs slack: VIEWER_TTL − 2 × HEARTBEAT ≥ QUICK / 2");
  if (2 * (t.RENEW_EVERY + t.QUICK) >= t.LEASE) out.push("the lease must outlast two failed renewals: 2 × (RENEW_EVERY + QUICK) < LEASE");
  if (t.RENEW_EVERY > t.HEARTBEAT) out.push("a take-over must be heard within a heartbeat: RENEW_EVERY ≤ HEARTBEAT");
  if (t.QUIT_CALL >= t.QUIT_BUDGET) out.push("one call must fit in the quit budget: QUIT_CALL < QUIT_BUDGET");
  if (t.QUIT_BUDGET >= t.WINDOW_KILL) out.push("the quit budget must end before the window kills Edit: QUIT_BUDGET < WINDOW_KILL");
  if (t.LINGER < t.QUICK) out.push("a background write's lock must outlast taking it: LINGER ≥ QUICK");
  if (t.LINGER >= t.VIEWER_TTL) out.push("nobody here holds a lock shorter than an editor does: LINGER < VIEWER_TTL");
  if (t.DEBOUNCE >= t.RENEW_EVERY) out.push("a push goes before the next renewal: DEBOUNCE < RENEW_EVERY");
  if (t.CHECK_EVERY > t.HEARTBEAT) out.push("someone else's lock is looked at within a heartbeat: CHECK_EVERY ≤ HEARTBEAT");
  return out;
}

// ---------------------------------------------------------------------------
// Who holds a lock.

const HOLDER_FILE = "holder-id";

/**
 * This data folder's holder id: made once, kept in `<home>/holder-id`. One
 * per folder, never the computer's name: two Macs named alike both held the
 * lock as "MacBook Pro" and forked silently, and two servers on one Mac (two
 * `--home`s) must be two holders.
 */
export function holderId(home: string): string {
  const path = join(home, HOLDER_FILE);
  try {
    const kept = fs.readFileSync(path, "utf8").trim();
    if (/^[a-z0-9]{8,32}$/u.test(kept)) return kept;
  } catch {
    // Made below.
  }
  const made = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  try {
    fs.mkdirSync(home, { recursive: true });
    writeAtomic(path, `${made}\n`);
  } catch (error) {
    diag.warn("cloud", `keeping this folder's holder id: ${diag.messageOf(error)}`);
  }
  return made;
}

/** The holder as the cloud keeps it: the name teammates see, then this folder's id. */
export function holderLabel(name: string, id: string): string {
  return `${name.trim().slice(0, 120) || "Someone"} #${id}`;
}

const ID_TAIL = / #[a-z0-9]{8,32}$/u;

/** The name in a holder label, for people ("Sphe's MacBook" from "Sphe's MacBook #k3j2…"); a label from an older Edit as it is. */
export function displayName(holder: string): string {
  return holder.replace(ID_TAIL, "");
}

/** The holder this data folder is: `EDIT_CLOUD_HOLDER` as it is (tests), else `name` with its id. */
export function holderFor(home: string, name: string): string {
  const given = (process.env.EDIT_CLOUD_HOLDER ?? "").trim();
  if (given !== "") return given;
  return holderLabel(name, holderId(home));
}

// ---------------------------------------------------------------------------
// The lock, by presence.

/** What keeps a lock here: someone has it open, work runs on it, or a write was just made with nobody here. */
export interface Presence {
  /** An editor here said it's open within VIEWER_TTL. */
  watched: boolean;
  /** An agent turn, an import or Claude runs on it here. */
  working: boolean;
  /** A write landed here within LINGER. */
  lingering: boolean;
  /** The editor closed it (and nobody else here has it open). */
  closing: boolean;
}

/** Whether a held lock is kept (else it's let go once its changes are pushed). */
export function keepsLock(presence: Presence): boolean {
  if (presence.working) return true;
  if (presence.closing) return false;
  return presence.watched || presence.lingering;
}

// ---------------------------------------------------------------------------
// Pushes and conflicts.

/** A push sent: the cloud rev it was based on and its body's hash, written down before it goes. */
export interface Attempt {
  base: number;
  hash: string;
}

export function bodyHash(body: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(body).digest("hex");
}

/** Whether the cloud's rev is this machine's own push (sent on `attempt.base`, its body hashing to `attempt.hash`), whose answer was lost. */
export function isOwnSave(attempt: Attempt | undefined | null, cloud: { readonly rev: number; readonly bodyHash: string | null } | null): boolean {
  return attempt !== undefined && attempt !== null && cloud !== null && cloud.bodyHash !== null && cloud.rev === attempt.base + 1 && cloud.bodyHash === attempt.hash;
}

/** Someone else took the lock: what happens to this machine's copy (changes here are kept as a copy, theirs is taken). */
export function afterLost(hadChanges: boolean, cloudNewer: boolean): { readonly keepCopy: boolean; readonly pull: boolean } {
  return { keepCopy: hadChanges, pull: hadChanges || cloudNewer };
}

const CONFLICTED = "(conflicted copy)";

/** What a copy kept in a conflict is named. */
export function conflictedName(name: string): string {
  return `${name} ${CONFLICTED}`;
}

/** Whether a copy's name says it's one already. */
export function isConflictedName(name: string): boolean {
  return name.endsWith(CONFLICTED);
}

/** What a conflicted copy keeps about where it came from, listed for the team (`conflictedOf` in the cloud's summary). */
export interface CopyOf {
  /** The project or script it's a copy of. */
  id: string;
  /** Who kept it (their holder's name) and when (ms). */
  by: string;
  at: number;
}
