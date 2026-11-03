// Jobs that survive a restart (speed-plan 1.2): 95 restarts in three days of
// logs, each dropping the export, smoothing or watch under way, which nobody
// started again. Long background work is written down while it runs
// (`<home>/jobs.json`) and crossed off when it ends, however it ends; a job
// still listed when the server starts was cut short, and is started again.
// Each kind resumes cheaply: an export carries on from its finished chunks
// (the engine's chunks.rs), a watch from its cached windows, smoothing per
// shot, a Drive upload sends the finished file again, an import's cloud
// upload sends its files again, a moving map shot carries on from its
// frames. A job that was resumed
// twice and still didn't end (it may be what brings the server down) isn't
// started a third time.


import { Effect } from "effect";

import * as diag from "./diag.ts";
import { inArea, runPromise } from "./effect/runtime.ts";
import { nowMs, readState, writeAtomic } from "./files.ts";
import { join } from "./paths.ts";

export type Kind = "export" | "archive" | "drive" | "smooth" | "watch" | "upload" | "map" | "case";

export interface Job {
  /** One job per key: kind, project and what in it (a clip). */
  key: string;
  kind: Kind;
  project: string;
  args: Record<string, unknown>;
  started_ms: number;
  /** How many times it was started again after a restart. */
  resumes: number;
}

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

/** Jobs cut short by the last run, by key: their resume counts carry over. */
const carried = new Map<string, Map<string, number>>();

export function keyOf(kind: Kind, project: string, part = ""): string {
  return part === "" ? `${kind}:${project}` : `${kind}:${project}:${part}`;
}

/** Notes a job as running (replacing one with its key); returns its key. */
export function begin(home: string | null, kind: Kind, project: string, args: Record<string, unknown>, part = ""): string {
  const key = keyOf(kind, project, part);
  if (home === null) return key;
  const resumes = carried.get(home)?.get(key) ?? 0;
  carried.get(home)?.delete(key);
  const jobs = read(home).filter((job) => job.key !== key);
  jobs.push({ key, kind, project, args, started_ms: nowMs(), resumes });
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
 * The jobs the last run left unfinished, to start again (each counted as a
 * resume), and the list emptied; those resumed too often are dropped, said.
 */
export function takeOver(home: string): Job[] {
  const jobs = read(home);
  if (jobs.length === 0) return [];
  write(home, []);
  const counts = new Map<string, number>();
  carried.set(home, counts);
  const out: Job[] = [];
  for (const job of jobs) {
    if ((job.resumes ?? 0) >= MOST_RESUMES) {
      diag.warn("jobs", `${job.key} was cut short ${job.resumes + 1} times; not starting it again`);
      continue;
    }
    counts.set(job.key, (job.resumes ?? 0) + 1);
    out.push(job);
  }
  return out;
}

/** What starts each kind again; a handler that throws is logged and skipped. */
export type Resumers = Partial<Record<Kind, (job: Job) => Promise<void> | void>>;

/** A resumer that hasn't come back in this long is left to it, and the next is started (one hanging used to hold up every other). */
export const RESUME_MS = { value: 60_000 };

/**
 * Starts again what the last run left unfinished, one after another: a
 * handler that fails is logged and skipped, one still starting after
 * `RESUME_MS` is left running and the next goes on.
 */
export function resume(home: string, resumers: Resumers): Promise<void> {
  return runPromise(
    Effect.forEach(
      takeOver(home),
      (job) => {
        const run = resumers[job.kind];
        if (run === undefined) return Effect.void;
        return Effect.logInfo(`starting ${job.key} again (cut short by a restart)`).pipe(
          Effect.andThen(Effect.tryPromise(async () => run(job))),
          Effect.timeoutOrElse({ duration: RESUME_MS.value, orElse: () => Effect.logWarning(`${job.key} is still starting after ${Math.round(RESUME_MS.value / 1000)} s; the others go on`) }),
          Effect.catch((error) =>
            Effect.sync(() => carried.get(home)?.delete(job.key)).pipe(
              Effect.andThen(Effect.logWarning(`couldn't start ${job.key} again: ${diag.messageOf(error instanceof Error ? error : ((error as { cause?: unknown })?.cause ?? error))}`)),
            ),
          ),
        );
      },
      { discard: true },
    ).pipe(inArea("jobs")),
  );
}
