// The one table of durable work (`<home>/jobs.json`; speed-plan 1.2, then the
// Nov 8 audit's item B): 95 restarts in three days of logs, each dropping the
// export, smoothing or watch under way, which nobody started again; and four
// ledgers beside this one (running agent turns, the retry after an update, the
// failed exports, the fixes under way), each with its own rules. Now there is
// this table and one resumer (serve.ts `resumeJobs`).
//
// A job is written down when it starts and as each step finishes, before the
// next begins; a job still running when the server starts was cut short and is
// started again from its last finished step. Each kind's resumer checks a
// step's output is there (the export listed, the R2 object there by HEAD, the
// version published) before doing it again, so nothing's done twice. A job
// that ends well is crossed off (`end`), or kept as `done` when what it did is
// shown (a share: "Up on the link"); one that fails is kept as `failed`, with
// its error and the build it failed on, so a new build tries it once more
// (retry_after_update.ts). A job stays listed while it's started again (a
// second crash during recovery, or a resumer that fails, never loses it). One
// cut short three times in a row that didn't get further (`progressed`) may be
// what brings the server down: it stays listed as given up, the diagnostics
// say so, and unstick starts it again.
//
// The file stays an array of plain objects, readable by hand. The ledgers it
// replaces are taken in, once, when it's first read (`migrate`).

import * as fs from "node:fs";

import { Effect } from "effect";

import * as diag from "./diag.ts";
import { inArea, runPromise } from "./effect/runtime.ts";
import { nowMs, readState, writeAtomic } from "./files.ts";
import { join } from "./paths.ts";

export type Kind =
  | "export"
  | "archive"
  | "drive"
  | "smooth"
  | "watch"
  | "upload"
  | "map"
  | "case"
  | "full"
  /** A share: export → review copy → copy check → upload → publish (reviews.ts), then its full-quality file as a `full` job. */
  | "share"
  /** Ready for changes: the agent fixing a review's notes, followed to its share (reviews.ts). */
  | "fix"
  /** An agent turn (agent.ts): carried on after a restart within `TURN_RESUME_MS`. */
  | "turn"
  /** Claude on an idea or a thumbnail: its lease while it runs, then its ending until the cloud has it. */
  | "idea"
  | "thumbnail"
  /** A smooth playback render (playback_render.ts): listed so `busyWith` sees it; not resumed. */
  | "playback";

export type State = "queued" | "running" | "waiting" | "done" | "failed" | "given_up";

export interface Job {
  /** One job per key: kind, project and what in it (a clip). */
  key: string;
  kind: Kind;
  project: string;
  args: Record<string, unknown>;
  state: State;
  /** Where it is, in a word or two, for the UI ("exporting", "review copy", "uploading", "publishing"…). */
  step?: string;
  /** How many times it was started again after a restart (raised as it's handed back, before it starts). */
  attempts: number;
  started_ms: number;
  updated_ms: number;
  /** Why it failed (state failed). */
  error?: string;
  /** The build it failed on (state failed): a new build tries it again once. */
  build?: string;
  /** The build it's queued to be tried again on (retry_after_update.ts), cleared as it's taken. */
  retry?: string;
  /** Why it isn't started again any more (state given_up); unstick clears it. */
  given_up?: string;
}

/** Thrown by a resumer when there's nothing left to start again (the project, clip or file is gone): the job is crossed off. */
export class Gone extends Error {}

/** Resumed this many times without ending or getting further: left alone. */
const MOST_RESUMES = 2;
/** Done jobs (a share's outcome) and failed ones nothing retries are kept this long, then dropped. */
const KEEP_ENDED_MS = 30 * 24 * 3_600_000;
/** A turn cut short is carried on when Edit is back this soon after it was last noted (a restart, not a quit). */
export const TURN_RESUME_MS = 10 * 60_000;

const LIVE: readonly State[] = ["queued", "running", "waiting"];

/** Whether a job is still to do (not done, failed or given up). */
export function live(job: Job): boolean {
  return LIVE.includes(job.state);
}

function file(home: string): string {
  return join(home, "jobs.json");
}

/** An entry as written by any build: older ones had `resumes` and no state. */
function normal(raw: Record<string, unknown>): Job {
  const job = raw as unknown as Job & { resumes?: number };
  const attempts = typeof job.attempts === "number" ? job.attempts : typeof job.resumes === "number" ? job.resumes : 0;
  const state: State = typeof job.state === "string" ? job.state : job.given_up !== undefined ? "given_up" : "running";
  const started = typeof job.started_ms === "number" ? job.started_ms : 0;
  const { resumes: _old, ...rest } = job;
  return { ...rest, args: typeof rest.args === "object" && rest.args !== null ? rest.args : {}, state, attempts, started_ms: started, updated_ms: typeof job.updated_ms === "number" ? job.updated_ms : started };
}

function load(home: string): Job[] {
  // A file that won't read is set aside, never read as empty and written over (files.readState).
  const value = readState(file(home), (message) => diag.warn("jobs", message));
  return Array.isArray(value) ? (value as Record<string, unknown>[]).filter((job) => typeof job?.key === "string").map(normal) : [];
}

function read(home: string): Job[] {
  migrate(home);
  return load(home);
}

function write(home: string, jobs: Job[]): void {
  const now = nowMs();
  // Failed exports and shares stay until they're done again (a new build retries them); other ended jobs go after a while.
  const kept = jobs.filter((job) => live(job) || job.state === "given_up" || (job.state === "failed" && (job.kind === "export" || job.kind === "share")) || now - job.updated_ms < KEEP_ENDED_MS);
  try {
    writeAtomic(file(home), JSON.stringify(kept, null, 1));
  } catch (error) {
    diag.warn("jobs", `couldn't note the running jobs: ${diag.messageOf(error)}`);
  }
}

/** Reads the table, changes it, and writes it back when `change` says so (returns true or a value other than false). */
function change<T>(home: string, edit: (jobs: Job[]) => T): T {
  const jobs = read(home);
  const result = edit(jobs);
  if (result !== (false as unknown)) write(home, jobs);
  return result;
}

export function keyOf(kind: Kind, project: string, part = ""): string {
  return part === "" ? `${kind}:${project}` : `${kind}:${project}:${part}`;
}

function fresh(kind: Kind, project: string, args: Record<string, unknown>, part: string, listed: Job | undefined, step?: string): Job {
  const now = nowMs();
  // One listed and still to do (a resumer starting it again, or a repeat) keeps its count; one that ended, failed or was given up starts over.
  const attempts = listed !== undefined && live(listed) ? listed.attempts : 0;
  return { key: keyOf(kind, project, part), kind, project, args, state: "running", ...(step === undefined ? {} : { step }), attempts, started_ms: listed !== undefined && live(listed) ? listed.started_ms : now, updated_ms: now };
}

/**
 * Notes a job as running; returns its key. One already listed under its key
 * is replaced in place: a live one keeps its count, one that ended or was
 * given up starts its count over.
 */
export function begin(home: string | null, kind: Kind, project: string, args: Record<string, unknown>, part = "", step?: string): string {
  const key = keyOf(kind, project, part);
  if (home === null) return key;
  change(home, (jobs) => {
    const at = jobs.findIndex((job) => job.key === key);
    const job = fresh(kind, project, args, part, jobs[at], step);
    if (at < 0) jobs.push(job);
    else jobs[at] = job;
  });
  return key;
}

/** Crosses a job off: it ended (done with nothing to show, or cancelled). */
export function end(home: string | null, key: string): void {
  if (home === null) return;
  change(home, (jobs) => {
    const at = jobs.findIndex((job) => job.key === key);
    if (at < 0) return false;
    jobs.splice(at, 1);
  });
}

/**
 * One step of a job finished and the next begins: its `step` and what it
 * made (`args`, merged) written before that next step starts, so a restart
 * picks it up from there. Nothing when the job isn't listed (it was cancelled).
 */
export function step(home: string | null, key: string, step: string, args: Record<string, unknown> = {}): void {
  if (home === null) return;
  change(home, (jobs) => {
    const job = jobs.find((one) => one.key === key);
    if (job === undefined) return false;
    job.step = step;
    job.state = "running";
    Object.assign(job.args, args);
    job.updated_ms = nowMs();
  });
}

/** A job ends and is kept: `done` (what it did is shown), `failed` (its error and build kept for a retry), or `waiting` (it carries on later by itself). */
export function settle(home: string | null, key: string, state: "done" | "failed" | "waiting", fields: { error?: string; build?: string; step?: string; args?: Record<string, unknown> } = {}): void {
  if (home === null) return;
  change(home, (jobs) => {
    const job = jobs.find((one) => one.key === key);
    if (job === undefined) return false;
    settled(job, state, fields);
  });
}

function settled(job: Job, state: "done" | "failed" | "waiting", fields: { error?: string; build?: string; step?: string; args?: Record<string, unknown> }): void {
  job.state = state;
  if (fields.step !== undefined) job.step = fields.step;
  if (fields.args !== undefined) Object.assign(job.args, fields.args);
  if (state === "failed") {
    job.error = fields.error ?? job.error ?? "failed";
    if (fields.build !== undefined) job.build = fields.build;
  } else {
    delete job.error;
    delete job.build;
  }
  delete job.retry;
  job.updated_ms = nowMs();
}

/**
 * One job hands over to the next in one write, so no crash falls between
 * them (an export to its archive, a share to its full-quality upload): `from`
 * crossed off, or kept as `done` when `keep` says so; the next begun.
 */
export function handOff(home: string | null, from: string, next: { kind: Kind; project: string; args: Record<string, unknown>; part?: string; step?: string }, keep?: { state: "done"; step?: string; args?: Record<string, unknown> }): string {
  const key = keyOf(next.kind, next.project, next.part ?? "");
  if (home === null) return key;
  change(home, (jobs) => {
    const at = jobs.findIndex((job) => job.key === from);
    if (at >= 0) {
      if (keep === undefined) jobs.splice(at, 1);
      else settled(jobs[at]!, keep.state, keep);
    }
    const listed = jobs.findIndex((job) => job.key === key);
    const job = fresh(next.kind, next.project, next.args, next.part ?? "", jobs[listed], next.step);
    if (listed < 0) jobs.push(job);
    else jobs[listed] = job;
  });
  return key;
}

/** A job that got further this run than the last (a big upload sending parts past those already up): its restarts so far don't count against it. */
export function progressed(home: string | null, key: string): void {
  if (home === null) return;
  change(home, (jobs) => {
    const job = jobs.find((one) => one.key === key);
    if (job === undefined || !(job.attempts > 0)) return false;
    job.attempts = 0;
  });
}

/** Still going (a turn's minute, an idea's lease): its time noted, and as it got further, its restarts so far forgiven. */
export function touch(home: string | null, key: string): void {
  if (home === null) return;
  change(home, (jobs) => {
    const job = jobs.find((one) => one.key === key);
    if (job === undefined) return false;
    job.updated_ms = nowMs();
    job.attempts = 0;
  });
}

/** Adds what a job made to its args (a durable remote receipt), without touching its count. */
export function patch(home: string | null, key: string, args: Record<string, unknown>): void {
  if (home === null) return;
  change(home, (jobs) => {
    const job = jobs.find((one) => one.key === key);
    if (job === undefined) return false;
    Object.assign(job.args, args);
  });
}

/** Marks or clears a failed job's retry on `build` (retry_after_update.ts). */
export function queueRetry(home: string, key: string, build: string | null): void {
  change(home, (jobs) => {
    const job = jobs.find((one) => one.key === key);
    if (job === undefined || job.state !== "failed") return false;
    if (build === null) delete job.retry;
    else job.retry = build;
  });
}

/** One job, by key. */
export function get(home: string | null, key: string): Job | undefined {
  if (home === null) return undefined;
  return read(home).find((job) => job.key === key);
}

/** The jobs listed, of a kind when given. */
export function list(home: string | null, kind?: Kind): Job[] {
  if (home === null) return [];
  const all = read(home);
  return kind === undefined ? all : all.filter((job) => job.kind === kind);
}

/**
 * The jobs the last run left unfinished, to start again: each stays listed,
 * its count raised and saved before it's handed back, so a crash while they
 * start counts too. One cut short too often is marked given up instead
 * (kept, said, not handed back). Only `kinds`, when given.
 */
export function takeOver(home: string, kinds?: readonly Kind[]): Job[] {
  const out: Job[] = [];
  change(home, (jobs) => {
    let changed = false;
    for (const job of jobs) {
      if (!live(job) || (kinds !== undefined && !kinds.includes(job.kind))) continue;
      changed = true;
      if (job.attempts >= MOST_RESUMES) {
        job.state = "given_up";
        job.given_up = `cut short by ${job.attempts + 1} restarts in a row`;
        diag.warn("jobs", `${job.key} was cut short ${job.attempts + 1} times; not starting it again (kept; unstick starts it again)`);
      } else {
        job.attempts += 1;
        out.push(job);
      }
    }
    return changed;
  });
  return out;
}

/** The jobs not started again any more (cut short too often), for the diagnostics. */
export function givenUp(home: string | null): Job[] {
  if (home === null) return [];
  return read(home).filter((job) => job.state === "given_up");
}

/** What starts each kind again; a handler that throws is logged and skipped (the job stays listed), one that throws `Gone` crosses it off. */
export type Resumers = Partial<Record<Kind, (job: Job) => Promise<void> | void>>;

/** A resumer that hasn't come back in this long is left to it, and the next is started (one hanging used to hold up every other). */
export const RESUME_MS = { value: 60_000 };

/** The resumers this run was started with, by data folder, so unstick can start given-up jobs without a restart. */
const registered = new Map<string, Resumers>();

function startAll(home: string, list: Job[], resumers: Resumers): Promise<void> {
  return runPromise(
    Effect.forEach(
      list,
      (job) => {
        const run = resumers[job.kind];
        if (run === undefined) return Effect.void;
        return Effect.logInfo(`starting ${job.key} again${job.step ? ` from ${job.step}` : ""} (cut short by a restart)`).pipe(
          Effect.andThen(Effect.tryPromise(async () => run(job))),
          Effect.timeoutOrElse({ duration: RESUME_MS.value, orElse: () => Effect.logWarning(`${job.key} is still starting after ${Math.round(RESUME_MS.value / 1000)} s; the others go on`) }),
          Effect.catch((error) => {
            const cause = error instanceof Error && !(error instanceof Gone) && (error as { cause?: unknown }).cause !== undefined ? (error as { cause?: unknown }).cause : error;
            if (cause instanceof Gone) {
              return Effect.sync(() => end(home, job.key)).pipe(Effect.andThen(Effect.logInfo(`not starting ${job.key} again: ${cause.message}`)));
            }
            return Effect.logWarning(`couldn't start ${job.key} again (kept for the next start, ${job.attempts} of ${MOST_RESUMES}): ${diag.messageOf(cause)}`);
          }),
        );
      },
      { discard: true },
    ).pipe(inArea("jobs")),
  );
}

/**
 * Starts again what the last run left unfinished, one after another: a
 * handler that fails is logged and skipped (its job kept), one still
 * starting after `RESUME_MS` is left running and the next goes on. Only
 * `kinds`, when given (tests).
 */
export function resume(home: string, resumers: Resumers, kinds?: readonly Kind[]): Promise<void> {
  if (kinds === undefined) registered.set(home, resumers);
  return startAll(home, takeOver(home, kinds), resumers);
}

/**
 * Unstick: the given-up jobs, their counts cleared and started again (now if
 * this run's resumers are in; otherwise the start-up resume picks them up).
 * Returns their keys.
 */
export function startGivenUp(home: string | null): { keys: string[]; started: Promise<void> } {
  if (home === null) return { keys: [], started: Promise.resolve() };
  const revived: Job[] = [];
  change(home, (jobs) => {
    for (const job of jobs) {
      if (job.state !== "given_up") continue;
      delete job.given_up;
      job.state = "running";
      job.attempts = 0;
      revived.push(job);
    }
    return revived.length > 0;
  });
  if (revived.length === 0) return { keys: [], started: Promise.resolve() };
  const resumers = registered.get(home);
  return { keys: revived.map((job) => job.key), started: resumers === undefined ? Promise.resolve() : startAll(home, revived, resumers) };
}

// ---------------------------------------------------------------------------
// The ledgers this table replaced, taken in once when they're found.

const OLD = {
  /** ExportRegistry's failed exports, by project. */
  failures: "export-failures.json",
  /** agent.ts's running turns: {at, projects}. */
  turns: join("agent", "running-turns.json"),
  /** retry_after_update.ts's queue; this build queues its failures afresh. */
  retries: "retry-after-update.json",
  /** reviews.ts's fixes under way, by project. */
  fixes: "review-fixes.json",
} as const;

function oldJson(path: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * The old ledgers, taken into the table and removed (each only once the
 * table holds it): a failed export becomes a failed `export` job, a noted
 * turn a `turn` job, a fix under way a `fix` job, and the old retry queue
 * goes (a new build queues every failure again). Reviews' `unshared` is taken in by reviews.ts.
 */
export function migrate(home: string): void {
  const found = Object.values(OLD).filter((name) => fs.existsSync(join(home, name)));
  if (found.length === 0) return;
  const jobs = load(home);
  const has = (key: string) => jobs.some((job) => job.key === key);
  const failures = oldJson(join(home, OLD.failures)) as Record<string, Record<string, unknown>> | null;
  for (const [project, failure] of Object.entries(failures !== null && typeof failures === "object" ? failures : {})) {
    const key = keyOf("export", project);
    if (has(key) || typeof failure !== "object" || failure === null) continue;
    const { project: _p, error, at, build, ...args } = failure as { project?: unknown; error?: unknown; at?: unknown; build?: unknown };
    const when = typeof at === "number" ? at : nowMs();
    jobs.push({ key, kind: "export", project, args, state: "failed", attempts: 0, started_ms: when, updated_ms: when, error: typeof error === "string" ? error : "failed", ...(typeof build === "string" ? { build } : {}) });
  }
  const turns = oldJson(join(home, OLD.turns)) as { at?: unknown; projects?: unknown } | null;
  if (turns !== null && typeof turns.at === "number" && Array.isArray(turns.projects)) {
    for (const chat of turns.projects) {
      if (typeof chat !== "string") continue;
      const project = chat.split("~")[0] ?? chat;
      const key = keyOf("turn", project, chat === project ? "" : chat);
      if (!has(key)) jobs.push({ key, kind: "turn", project, args: { chat }, state: "running", attempts: 0, started_ms: turns.at, updated_ms: turns.at });
    }
  }
  const fixes = oldJson(join(home, OLD.fixes)) as Record<string, Record<string, unknown>> | null;
  for (const [project, taken] of Object.entries(fixes !== null && typeof fixes === "object" ? fixes : {})) {
    const key = keyOf("fix", project);
    if (has(key) || typeof taken !== "object" || taken === null) continue;
    const at = typeof taken.at === "number" ? taken.at : nowMs();
    jobs.push({ key, kind: "fix", project, args: taken, state: "running", step: "fixing", attempts: 0, started_ms: at, updated_ms: at });
  }
  // The old retry queue isn't taken in: this is a new build, so retry_after_update queues every failure again.
  try {
    writeAtomic(file(home), JSON.stringify(jobs, null, 1));
  } catch (error) {
    diag.warn("jobs", `couldn't take in the old ledgers (${found.join(", ")}): ${diag.messageOf(error)}`);
    return;
  }
  for (const name of found) fs.rmSync(join(home, name), { force: true });
  diag.info("jobs", `took ${found.join(", ")} into jobs.json`);
}
