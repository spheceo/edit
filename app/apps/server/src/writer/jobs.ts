// Script mode's long work on a script (a build, a revision, fixing review
// notes, finding clips, a feedback round, a restore…) runs in the background;
// the page asks how it's going rather than holding a request open for ten
// minutes, so a dropped connection, a sleeping laptop or a reload loses
// nothing. Each job's state is kept beside its script (`build.json`), so one
// that finished while no page watched still says how it went, and one the
// server closed on says so instead of vanishing.
//
// And each is written down in Edit's job table while it runs (`<home>/jobs.json`,
// kind "writer", with everything it was started with), so one an update or a
// crash cuts off carries on by itself after the restart, from what it kept
// (`Job.keep`), where it said "Edit closed while Claude was writing this
// script… build again" for every kind (Sphe, Nov 10: "let Update go through at
// any time"). Before Edit restarts itself the jobs are stopped where they are
// (`holdForRestart`), so none ends as failed or tells anyone; until the next
// run starts it again (writer/work.ts `carryOn`), the script shows it running.

import * as fs from "node:fs";

import type { BuildStatus } from "@edit/types/writer";

import * as diag from "../diag.ts";
import { writeAtomic } from "../files.ts";
import * as durable from "../jobs.ts";
import * as notices from "../notices.ts";
import { join } from "../paths.ts";
import * as live from "./live.ts";
import { scriptDir } from "./store.ts";

/** What a job's work is handed: its stop signal and a way to say what it's doing. */
export interface Job {
  id: string;
  signal: AbortSignal;
  stage(text: string): void;
  /** Started again after Edit restarted: the producer's request is in the chat already, and `kept` says how far it got. */
  resumed?: boolean;
  /** What the run kept as it went (`keep`), handed back when it's started again after a restart. */
  kept?: Record<string, unknown>;
  /** Keeps what the run has finished (in the job table), so a restart carries on past it: a step done is getting further. */
  keep?(what: Record<string, unknown>): void;
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
  /** `review`: the fresh-eyes read after it (scripting.ts `scriptFreshEyes`); absent from builds started before it was kept, which had it. */
  | { kind: "build"; note: string; format?: import("@edit/types/writer").Kind; review?: boolean }
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
/** Each running job's end, so a delete can wait for a stopped one (`stopAndWait`). */
const endings = new Map<string, Promise<void>>();

/** What a job cut off by a restart says until the next run starts it again. */
export const CARRYING_ON = "Carrying on after the update";

/** Edit's data folder, whose job table (`jobs.json`) the jobs are written down in; none (tests) keeps them in memory alone. */
let home: string | null = null;
/** Set once Edit is about to restart itself: a job ending now was cut off by it, and carries on after it. */
let restarting = false;
/** Scripts whose job the last run left running, written down to carry on: shown running until it's started again. */
const carrying = new Set<string>();

/** Where the job table is (writer/index.ts, at start). */
export function useHome(given: string | null): void {
  home = given;
}

/** A script's job in the job table. */
export const durableKey = (id: string): string => durable.keyOf("writer", id);

/** Whether script `id`'s job, cut off by the last run, is still to be carried on (not given up, not crossed off). */
function carried(id: string): boolean {
  if (!carrying.has(id)) return false;
  const listed = home === null ? undefined : durable.get(home, durableKey(id));
  if (listed !== undefined && durable.live(listed)) return true;
  carrying.delete(id);
  return false;
}

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
    // The live turn is for the page while it runs; the chat keeps it once done.
    const { turn: _live, ...kept } = job;
    writeAtomic(path, JSON.stringify(kept));
  } catch {
    // The status on disk is for after a restart; this run still has it.
  }
}

function interrupted(job: BuildStatus): BuildStatus {
  return {
    ...job,
    running: false,
    finishedAt: job.finishedAt ?? Date.now(),
    // Only when it couldn't carry on (cut off by too many restarts in a row, or from before jobs were written down): said for any kind.
    error: "Edit closed while Claude was working on this script, so it stopped. What it saved is kept; start it again.",
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
    if (!job.running) return job;
    // Running on disk but not here: about to carry on, or Edit closed on it with nothing to carry on.
    return carried(id) ? { ...job, stage: CARRYING_ON } : interrupted(job);
  } catch {
    return null;
  }
}

/**
 * A job that died with the server is not still running, unless the job table
 * has it to carry on: then it shows running until it's started again. Run at
 * startup, before the job table's resumer.
 */
export function markInterrupted(data: string, id: string): void {
  const path = file(data, id);
  if (path === null) return;
  try {
    const kept = JSON.parse(fs.readFileSync(path, "utf8")) as BuildStatus;
    if (!kept.running) return;
    const listed = home === null ? undefined : durable.get(home, durableKey(id));
    if (listed !== undefined && durable.live(listed)) {
      carrying.add(id);
      keep(data, id, { ...kept, stage: CARRYING_ON });
    } else keep(data, id, interrupted(kept));
  } catch {
    // Nothing kept.
  }
}

/** Claude works on the script now, or will again in a moment (a job a restart cut off, about to carry on). */
export const running = (id: string): boolean => jobs.get(id)?.running === true || carried(id);

/** A job this run started is running on the script. */
export const workingHere = (id: string): boolean => jobs.get(id)?.running === true;

/** A job that was to carry on won't (its script is gone, or it couldn't start): said so on the script, as before. */
export function letGo(data: string, id: string, why?: string): void {
  carrying.delete(id);
  const path = file(data, id);
  if (path === null || jobs.has(id)) return;
  try {
    const kept = JSON.parse(fs.readFileSync(path, "utf8")) as BuildStatus;
    if (kept.running) keep(data, id, why === undefined ? interrupted(kept) : { ...interrupted(kept), error: why });
  } catch {
    // Nothing kept.
  }
}

/** The jobs running now, each with its script's title. */
export function runningList(): [id: string, title: string, job: BuildStatus][] {
  return [...jobs].filter(([, job]) => job.running).map(([id, job]) => [id, titles.get(id) ?? "", job]);
}

/** Says what a running job is doing (a new step goes in the log too; a percentage ticking over doesn't). */
export function stage(id: string, text: string): void {
  const job = jobs.get(id);
  // Cut off by the restart: it says it carries on, whatever it says on its way out.
  if (job === undefined || !job.running || restarting) return;
  const fresh = job.stage !== text && !text.includes("%");
  job.stage = text;
  if (!fresh) return;
  diag.info("writer", `${named(id, titles.get(id) ?? "")}: ${text}`);
  // Where it is, in the job table too: the log says what it carries on from.
  if (stops.has(id)) durable.step(home, durableKey(id), text);
}

/** A script as the log names it: its title and the start of its id. */
export const named = (id: string, title: string): string => (title ? `"${title}" (${id.slice(0, 8)})` : id.slice(0, 8));

export function stop(id: string, data?: string): void {
  if (!running(id)) return;
  // About to carry on after a restart: it won't now.
  if (jobs.get(id)?.running !== true) {
    durable.end(home, durableKey(id));
    if (data !== undefined) letGo(data, id, STOPPED);
    carrying.delete(id);
    return;
  }
  const controller = stops.get(id);
  if (controller === undefined) throw new Error("This job is already finishing.");
  controller.abort();
  stage(id, "Stopping…");
}

/**
 * Stops script `id`'s job, if one runs, and waits up to `ms` for it to end
 * (its last status written): false when it hadn't by then. A script is deleted
 * only once Claude has let go of it, or what it writes last would bring back
 * a folder the delete took away.
 */
export async function stopAndWait(id: string, ms = 30_000): Promise<boolean> {
  // About to carry on after a restart: it won't now.
  if (jobs.get(id)?.running !== true && carried(id)) {
    durable.end(home, durableKey(id));
    carrying.delete(id);
    return true;
  }
  const ending = endings.get(id);
  if (!running(id) || ending === undefined) return true;
  stops.get(id)?.abort();
  stage(id, "Stopping…");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([ending.then(() => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** How a job is started: afresh (the person, a review), or carried on after a restart from what it kept. */
export interface Starting {
  resumed?: boolean;
  kept?: Record<string, unknown>;
}

/**
 * Starts `work` on a script in the background: refused while one runs.
 * `run` does it; its report and cost are kept as the job's outcome. `work`
 * is written down in the job table with it, so a restart carries it on
 * (writer/work.ts `runFor` makes `run` again from it).
 */
export function start(data: string, id: string, title: string, work: Work, run: (job: Job) => Promise<Outcome>, after?: () => void, starting: Starting = {}): BuildStatus {
  if (jobs.get(id)?.running === true || (!starting.resumed && carried(id))) throw new Error("Claude is already writing this script.");
  carrying.delete(id);
  const resumed = starting.resumed === true;
  const job: BuildStatus = { running: true, stage: resumed ? CARRYING_ON : FIRST_STAGE[work.kind], startedAt: Date.now(), finishedAt: null, report: null, costUsd: null, error: null };
  jobs.set(id, job);
  titles.set(id, title);
  keep(data, id, job);
  const key = durableKey(id);
  // Listed already when it carries on (its count kept); written down afresh otherwise.
  if (resumed) durable.step(home, key, job.stage);
  else durable.begin(home, "writer", id, { work, title }, "", job.stage);
  const what = described(work);
  const name = named(id, title);
  diag.info("writer", `${name}: ${resumed ? "carrying on after the restart" : "started"}: ${what}`);
  const began = Date.now();
  const controller = new AbortController();
  stops.set(id, controller);
  const kept: Record<string, unknown> = { ...(starting.kept ?? {}) };
  const context: Job = {
    id,
    signal: controller.signal,
    stage: (text) => stage(id, text),
    resumed,
    kept,
    keep: (more) => {
      Object.assign(kept, more);
      durable.patch(home, key, { kept: { ...kept } });
      durable.progressed(home, key);
    },
  };
  // What Claude says and the tools it runs, for the chat's live turn (live.ts).
  const turn: live.Turn = { text: "", trace: [], startedAt: job.startedAt };
  job.turn = turn;
  let ended = () => {};
  endings.set(id, new Promise<void>((resolve) => (ended = resolve)));
  // Whether `run` came back: a job that did is done, even if a restart's stop came after it.
  let ran = false;
  void live.within(turn, async () => {
    try {
      const [report, cost] = await run(context);
      ran = true;
      if (!restarting) checkStopped(context);
      const first = [...(report.split("\n")[0] ?? "")].slice(0, 200).join("");
      diag.info("writer", `${name}: done in ${seconds(began)} (${what}; $${cost.toFixed(2)} at API prices): ${first}`);
      job.report = report;
      job.costUsd = cost;
      after?.();
    } catch (error) {
      if (restarting) {
        diag.info("writer", `${name}: cut off by the restart after ${seconds(began)} (${what}); it carries on after it`);
      } else {
        const message = controller.signal.aborted ? STOPPED : diag.messageOf(error);
        diag.error("writer", `${name}: stopped after ${seconds(began)} (${what}): ${message}`);
        job.error = message;
      }
    } finally {
      stops.delete(id);
      endings.delete(id);
      if (restarting && !ran) {
        // Left running, on disk and in the job table: the next run carries it on.
        job.stage = CARRYING_ON;
        delete job.turn;
        keep(data, id, job);
      } else {
        job.running = false;
        job.finishedAt = Date.now();
        delete job.turn;
        keep(data, id, job);
        durable.end(home, key);
        tell(id, title, work, job);
      }
      ended();
    }
  });
  return job;
}

/**
 * Before Edit restarts itself (an update, remote support's restart; after
 * the paid requests in flight were answered): every job is stopped where it
 * is and left to carry on after the restart, none ending as failed or telling
 * anyone. Waits up to `ms` for them to let go. The scripts they were on.
 */
export async function holdForRestart(ms = 10_000): Promise<string[]> {
  restarting = true;
  const held = [...stops.keys()];
  for (const id of held) {
    stops.get(id)?.abort();
    const job = jobs.get(id);
    if (job !== undefined) job.stage = CARRYING_ON;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all([...endings.values()]), new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
  return held;
}

/** Whether Edit is about to restart itself: what ends now was cut off by it, and carries on after it. */
export const restartUnderWay = (): boolean => restarting;

/** Tests: as a fresh run, with no restart under way. */
export function resetForTests(): void {
  restarting = false;
  carrying.clear();
  jobs.clear();
  titles.clear();
}

/** What the person hears when a job they started ends (notices.ts); the background ones (speakers, exact hearing, transcription) say nothing. */
const DONE: Partial<Record<Work["kind"], string>> = {
  build: "First draft is ready",
  revise: "Revision is done",
  review: "Review notes are fixed",
  reuse: "Reused cases are in",
  find: "Clips are found",
  learn: "Feedback is learnt",
  restore: "Footage is back",
};

function tell(id: string, title: string, work: Work, job: BuildStatus): void {
  const done = DONE[work.kind];
  // A stop they pressed needs no telling.
  if (done === undefined || job.error === STOPPED) return;
  const name = title || "Untitled script";
  const detail = job.error ?? (work.kind === "revise" || work.kind === "review" ? (job.report ?? "") : "");
  const body = detail.trim() === "" ? name : `${name}: ${notices.line(detail)}`;
  notices.notify({ key: `script:${id}:${job.startedAt}`, title: job.error === null ? done : "Claude stopped on the script", body, path: `/scripts/${id}` });
}

const seconds = (since: number): string => `${Math.round((Date.now() - since) / 1000)} s`;
