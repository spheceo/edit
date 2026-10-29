// Script mode's long work on a script (a build, a revision, fixing review
// notes, finding clips, a feedback round, a restore…) runs in the background;
// the page asks how it's going rather than holding a request open for ten
// minutes, so a dropped connection, a sleeping laptop or a reload loses
// nothing. Each job's state is kept beside its script (`build.json`), so one
// that finished while no page watched still says how it went, and one the
// server closed on says so instead of vanishing.

import * as fs from "node:fs";

import type { BuildStatus } from "@edit/types/writer";

import * as diag from "../diag.ts";
import { writeAtomic } from "../files.ts";
import { join } from "../paths.ts";
import { scriptDir } from "./store.ts";

/** What a job's work is handed: its stop signal and a way to say what it's doing. */
export interface Job {
  id: string;
  signal: AbortSignal;
  stage(text: string): void;
}

export const STOPPED = "Stopped by you. Completed work is saved.";

/** Throws when the job was stopped. */
export function checkStopped(job: Pick<Job, "signal">): void {
  if (job.signal.aborted) throw new Error(STOPPED);
}

/** Waits, ending early (with the stop) when the job is stopped. */
export async function wait(job: Pick<Job, "signal">, ms: number): Promise<void> {
  checkStopped(job);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    job.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
  checkStopped(job);
}

/** What a job does, said as its first stage and in the log. */
export type Work =
  | { kind: "build"; note: string; format?: import("@edit/types/writer").Kind }
  | { kind: "revise"; request: string; focus: import("@edit/types/writer").Focus }
  | { kind: "reuse"; urls: string[] }
  | { kind: "find" }
  | { kind: "learn"; step: import("@edit/types/writer").LearnStep }
  | { kind: "review"; notes: string[]; ready: string | null }
  | { kind: "restore" }
  | { kind: "speakers" }
  | { kind: "exact" }
  | { kind: "transcribe" };

const FIRST_STAGE: Record<Work["kind"], string> = {
  build: "Starting",
  revise: "Editing the script",
  reuse: "Bringing in the reused cases",
  find: "Finding clips",
  learn: "Learning from the feedback",
  review: "Fixing review notes",
  restore: "Bringing the footage back",
  speakers: "Checking speakers",
  exact: "Hearing the chosen footage exactly",
  transcribe: "Completing transcription",
};

function described(work: Work): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  switch (work.kind) {
    case "build":
      return "writing the script";
    case "revise":
      return `revising: "${[...work.request].slice(0, 80).join("")}"`;
    case "reuse":
      return `bringing in ${plural(work.urls.length, "reused case", "reused cases")}`;
    case "find":
      return "finding clips on YouTube";
    case "learn":
      return "learning from the feedback";
    case "review":
      return `fixing ${plural(work.notes.length, "review note", "review notes")}`;
    case "restore":
      return "bringing the footage back";
    case "speakers":
      return "retrying unfinished speaker checks";
    case "exact":
      return "hearing the chosen footage exactly";
    case "transcribe":
      return "completing transcription";
  }
}

/** A job's outcome: its report and what it cost at API prices. */
export type Outcome = [report: string, costUsd: number];

const jobs = new Map<string, BuildStatus>();
const titles = new Map<string, string>();
const stops = new Map<string, AbortController>();

const file = (data: string, id: string): string | null => {
  try {
    return join(scriptDir(data, id), "build.json");
  } catch {
    return null;
  }
};

function keep(data: string, id: string, job: BuildStatus): void {
  const path = file(data, id);
  if (path === null) return;
  try {
    writeAtomic(path, JSON.stringify(job));
  } catch {
    // The status on disk is for after a restart; this run still has it.
  }
}

function interrupted(job: BuildStatus): BuildStatus {
  return {
    ...job,
    running: false,
    finishedAt: job.finishedAt ?? Date.now(),
    error: "Edit closed while Claude was writing this script, so the build stopped. Nothing was changed; build again.",
  };
}

/** The latest job of a script, running or finished: this run's, else the one kept on disk. */
export function status(data: string, id: string): BuildStatus | null {
  const live = jobs.get(id);
  if (live !== undefined) return live;
  const path = file(data, id);
  if (path === null) return null;
  try {
    const job = JSON.parse(fs.readFileSync(path, "utf8")) as BuildStatus;
    // Running on disk but not here: Edit closed on it.
    return job.running ? interrupted(job) : job;
  } catch {
    return null;
  }
}

/** A job that died with the server is not still running. Run at startup. */
export function markInterrupted(data: string, id: string): void {
  const job = status(data, id);
  const path = file(data, id);
  if (job === null || path === null) return;
  try {
    const kept = JSON.parse(fs.readFileSync(path, "utf8")) as BuildStatus;
    if (kept.running) keep(data, id, interrupted(kept));
  } catch {
    // Nothing kept.
  }
}

export const running = (id: string): boolean => jobs.get(id)?.running === true;

/** The jobs running now, each with its script's title. */
export function runningList(): [id: string, title: string, job: BuildStatus][] {
  return [...jobs].filter(([, job]) => job.running).map(([id, job]) => [id, titles.get(id) ?? "", job]);
}

/** Says what a running job is doing (a new step goes in the log too; a percentage ticking over doesn't). */
export function stage(id: string, text: string): void {
  const job = jobs.get(id);
  if (job === undefined) return;
  const fresh = job.stage !== text && !text.includes("%");
  job.stage = text;
  if (fresh) diag.info("writer", `${named(id, titles.get(id) ?? "")}: ${text}`);
}

/** A script as the log names it: its title and the start of its id. */
export const named = (id: string, title: string): string => (title ? `"${title}" (${id.slice(0, 8)})` : id.slice(0, 8));

export function stop(id: string): void {
  if (!running(id)) return;
  const controller = stops.get(id);
  if (controller === undefined) throw new Error("This job is already finishing.");
  controller.abort();
  stage(id, "Stopping…");
}

/**
 * Starts `work` on a script in the background: refused while one runs.
 * `run` does it; its report and cost are kept as the job's outcome.
 */
export function start(data: string, id: string, title: string, work: Work, run: (job: Job) => Promise<Outcome>, after?: () => void): BuildStatus {
  if (running(id)) throw new Error("Claude is already writing this script.");
  const job: BuildStatus = { running: true, stage: FIRST_STAGE[work.kind], startedAt: Date.now(), finishedAt: null, report: null, costUsd: null, error: null };
  jobs.set(id, job);
  titles.set(id, title);
  keep(data, id, job);
  const what = described(work);
  const name = named(id, title);
  diag.info("writer", `${name}: started: ${what}`);
  const began = Date.now();
  const controller = new AbortController();
  stops.set(id, controller);
  const context: Job = { id, signal: controller.signal, stage: (text) => stage(id, text) };
  void (async () => {
    try {
      const [report, cost] = await run(context);
      checkStopped(context);
      const first = [...(report.split("\n")[0] ?? "")].slice(0, 200).join("");
      diag.info("writer", `${name}: done in ${seconds(began)} (${what}; $${cost.toFixed(2)} at API prices): ${first}`);
      job.report = report;
      job.costUsd = cost;
      after?.();
    } catch (error) {
      const message = controller.signal.aborted ? STOPPED : diag.messageOf(error);
      diag.error("writer", `${name}: stopped after ${seconds(began)} (${what}): ${message}`);
      job.error = message;
    } finally {
      job.running = false;
      job.finishedAt = Date.now();
      keep(data, id, job);
      stops.delete(id);
    }
  })();
  return job;
}

const seconds = (since: number): string => `${Math.round((Date.now() - since) / 1000)} s`;
