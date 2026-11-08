// Jobs that survive a restart (speed-plan 1.2): 95 restarts in three days of
// logs, each dropping the export, smoothing or watch under way, which nobody
// started again. Long background work is written down while it runs
// (`<home>/jobs.json`) and crossed off when it ends, however it ends; a job
// still listed when the server starts was cut short, and is started again.
// Each kind resumes cheaply: an export carries on from its finished chunks
// (the engine's chunks.rs), a watch from its cached windows, smoothing per
// shot, a Drive upload sends the finished file again, an import's cloud
// upload sends its files again, a moving map shot carries on from its
// frames, a review's full-quality file carries on from its parts already up.
// A job stays listed while it's started again (a second crash during
// recovery, or a resumer that fails, never loses it); only `end` crosses it
// off. One cut short twice that still didn't end (it may be what brings the
// server down) isn't started a third time, unless it got further each time
// (`progressed`): it stays listed as given up, the diagnostics say so, and
// unstick starts it again.


import { Effect } from "effect";

import * as diag from "./diag.ts";
import { inArea, runPromise } from "./effect/runtime.ts";
import { nowMs, readState, writeAtomic } from "./files.ts";
import { join } from "./paths.ts";

export type Kind = "export" | "archive" | "drive" | "smooth" | "watch" | "upload" | "map" | "case" | "full";

export interface Job {
  /** One job per key: kind, project and what in it (a clip). */
  key: string;
  kind: Kind;
  project: string;
  args: Record<string, unknown>;
  started_ms: number;
  /** How many times it was started again after a restart (counted as it's handed back, before it starts). */
  resumes: number;
  /** Why it isn't started again any more (cut short too often); unstick clears it. Absent on a job that's resumed. */
  given_up?: string;
}

/** Thrown by a resumer when there's nothing left to start again (the project, clip or file is gone): the job is crossed off. */
export class Gone extends Error {}

/** Resumed this many times without ending: left alone. */
const MOST_RESUMES = 2;

function file(home: string): string {
  return join(home, "jobs.json");
}

function read(home: string): Job[] {
  // A file that won't read is set aside, never read as empty and written over (files.readState).
  const value = readState(file(home), (message) => diag.warn("jobs", message));
  return Array.isArray(value) ? (value as Job[]).filter((job) => typeof job?.key === "string") : [];
}

function write(home: string, jobs: Job[]): void {
  try {
    writeAtomic(file(home), JSON.stringify(jobs, null, 1));
  } catch (error) {
    diag.warn("jobs", `couldn't note the running jobs: ${diag.messageOf(error)}`);
  }
}

export function keyOf(kind: Kind, project: string, part = ""): string {
  return part === "" ? `${kind}:${project}` : `${kind}:${project}:${part}`;
}

/**
 * Notes a job as running; returns its key. One already listed under its key
 * (a resumer starting it again, or a repeat) is updated in place and keeps
 * its resume count; one given up and started anew starts its count over.
 */
export function begin(home: string | null, kind: Kind, project: string, args: Record<string, unknown>, part = ""): string {
  const key = keyOf(kind, project, part);
  if (home === null) return key;
  const jobs = read(home);
  const listed = jobs.find((job) => job.key === key);
  const resumes = listed === undefined || listed.given_up !== undefined ? 0 : (listed.resumes ?? 0);
  const job: Job = { key, kind, project, args, started_ms: nowMs(), resumes };
  if (listed === undefined) jobs.push(job);
  else jobs[jobs.indexOf(listed)] = job;
  write(home, jobs);
  return key;
}

/** Crosses a job off: it ended (done, failed or cancelled). */
export function end(home: string | null, key: string): void {
  if (home === null) return;
  const jobs = read(home);
  const left = jobs.filter((job) => job.key !== key);
  if (left.length !== jobs.length) write(home, left);
}

/** A job that got further this run than the last (a big upload sending parts past those already up): its restarts so far don't count against it. */
export function progressed(home: string | null, key: string): void {
  if (home === null) return;
  const jobs = read(home);
  const job = jobs.find((one) => one.key === key);
  if (job === undefined || !(job.resumes > 0)) return;
  job.resumes = 0;
  write(home, jobs);
}

/** Add a durable remote receipt without resetting a job's resume counter. */
export function patch(home: string | null, key: string, args: Record<string, unknown>): void {
  if (home === null) return;
  const jobs = read(home);
  const job = jobs.find(job => job.key === key);
  if (job === undefined) return;
  Object.assign(job.args, args);
  write(home, jobs);
}

/**
 * The jobs the last run left unfinished, to start again: each stays listed,
 * its resume count raised and saved before it's handed back, so a crash while
 * they start counts too. One cut short too often is marked given up instead
 * (kept, said, not handed back); given-up ones stay as they are.
 */
export function takeOver(home: string): Job[] {
  const jobs = read(home);
  if (jobs.length === 0) return [];
  const out: Job[] = [];
  let changed = false;
  for (const job of jobs) {
    if (job.given_up !== undefined) continue;
    const resumes = job.resumes ?? 0;
    if (resumes >= MOST_RESUMES) {
      job.given_up = `cut short by ${resumes + 1} restarts in a row`;
      diag.warn("jobs", `${job.key} was cut short ${resumes + 1} times; not starting it again (kept; unstick starts it again)`);
    } else {
      job.resumes = resumes + 1;
      out.push(job);
    }
    changed = true;
  }
  if (changed) write(home, jobs);
  return out;
}

/** The jobs not started again any more (cut short too often), for the diagnostics. */
export function givenUp(home: string | null): Job[] {
  if (home === null) return [];
  return read(home).filter((job) => job.given_up !== undefined);
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
        return Effect.logInfo(`starting ${job.key} again (cut short by a restart)`).pipe(
          Effect.andThen(Effect.tryPromise(async () => run(job))),
          Effect.timeoutOrElse({ duration: RESUME_MS.value, orElse: () => Effect.logWarning(`${job.key} is still starting after ${Math.round(RESUME_MS.value / 1000)} s; the others go on`) }),
          Effect.catch((error) => {
            const cause = error instanceof Error && !(error instanceof Gone) && (error as { cause?: unknown }).cause !== undefined ? (error as { cause?: unknown }).cause : error;
            if (cause instanceof Gone) {
              return Effect.sync(() => end(home, job.key)).pipe(Effect.andThen(Effect.logInfo(`not starting ${job.key} again: ${cause.message}`)));
            }
            return Effect.logWarning(`couldn't start ${job.key} again (kept for the next start, ${job.resumes} of ${MOST_RESUMES}): ${diag.messageOf(cause)}`);
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
 * starting after `RESUME_MS` is left running and the next goes on.
 */
export function resume(home: string, resumers: Resumers): Promise<void> {
  registered.set(home, resumers);
  return startAll(home, takeOver(home), resumers);
}

/**
 * Unstick: the given-up jobs, their counts cleared and started again (now if
 * this run's resumers are in; otherwise the start-up resume picks them up).
 * Returns their keys.
 */
export function startGivenUp(home: string | null): { keys: string[]; started: Promise<void> } {
  if (home === null) return { keys: [], started: Promise.resolve() };
  const jobs = read(home);
  const revived = jobs.filter((job) => job.given_up !== undefined);
  if (revived.length === 0) return { keys: [], started: Promise.resolve() };
  for (const job of revived) {
    delete job.given_up;
    job.resumes = 0;
  }
  write(home, jobs);
  const resumers = registered.get(home);
  return { keys: revived.map((job) => job.key), started: resumers === undefined ? Promise.resolve() : startAll(home, revived, resumers) };
}
