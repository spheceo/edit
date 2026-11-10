// What each of Claude's jobs on a script runs, made from what it was started
// with (jobs.ts `Work`): the routes start it from here, and so does the next
// run when a restart cut it off (serve.ts's resumer, `carryOn`), from the
// same inputs kept in the job table, so the two never drift apart (Sphe,
// Nov 10: an update goes through at any time, and the work it cuts carries
// on by itself after it).

import type { BuildStatus } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import * as durable from "../jobs.ts";
import * as archive from "./archive.ts";
import * as feedback from "./feedback.ts";
import * as fixing from "./fixing.ts";
import * as footage from "./footage.ts";
import * as imports from "./imports.ts";
import * as jobs from "./jobs.ts";
import * as reuse from "./reuse.ts";
import * as scout from "./scout.ts";
import * as scripting from "./scripting.ts";
import * as store from "./store.ts";

/** The run that does `work` on script `id`. */
export function runFor(app: App, id: string, work: jobs.Work): (job: jobs.Job) => Promise<jobs.Outcome> {
  const data = store.dataDir(app.store.home);
  switch (work.kind) {
    case "build":
      return (job) => scripting.buildAndReview(app, data, id, work.note, work.format, work.review ?? scripting.scriptFreshEyes(undefined), job);
    case "revise":
      return (job) => scripting.reviseWith(data, id, work.request, work.request, work.focus, false, job);
    case "reuse":
      return (job) => reuse.importReused(app, data, id, work.urls, job);
    case "find":
      return (job) => scout.find(app, data, id, job);
    case "learn":
      return (job) => feedback.run(data, id, work.step, job);
    case "review":
      return (job) => fixing.run(app, data, id, work.notes, work.ready, job);
    case "restore":
      return (job) => archive.restoreAgain(app, data, id, job);
    case "speakers":
      return (job) => imports.retrySpeakers(app, data, id, job);
    case "exact":
      return (job) => scripting.exactOnce(app, data, id, job);
    case "transcribe":
      return (job) => imports.complete(app, data, id, job);
  }
}

/** Jobs that only bring footage or words back: nothing of a commentary's clips changes. */
const ONLY_FOOTAGE: readonly jobs.Work["kind"][] = ["restore", "speakers", "transcribe"];

/** Starts `work` on script `id` as a job (refused while one runs); a commentary's clip footage comes down after it. */
export function begin(app: App, id: string, title: string, work: jobs.Work, starting: jobs.Starting = {}): BuildStatus {
  const data = store.dataDir(app.store.home);
  const after = ONLY_FOOTAGE.includes(work.kind) ? undefined : () => void footage.now(app, data, id);
  return jobs.start(data, id, title, work, runFor(app, id, work), after, starting);
}

/**
 * Carries on a job the last run left running (a "writer" job in the job
 * table): started again from what it was started with and what it kept, so
 * the producer's request isn't said twice and the steps it finished aren't
 * done again. One started meanwhile on the script is left to it.
 */
export function carryOn(app: App, listed: durable.Job): void {
  const data = store.dataDir(app.store.home);
  const id = listed.project;
  if (!store.ids(data).includes(id)) throw new durable.Gone("the script is gone");
  const { work, title, kept } = listed.args as { work?: jobs.Work; title?: string; kept?: Record<string, unknown> };
  if (work === undefined || typeof work.kind !== "string") {
    jobs.letGo(data, id);
    throw new durable.Gone("it kept nothing to carry on from");
  }
  if (jobs.workingHere(id)) return;
  try {
    begin(app, id, title || store.read(store.scriptDir(data, id)).title, work, { resumed: true, kept: kept ?? {} });
  } catch (error) {
    const why = diag.messageOf(error);
    jobs.letGo(data, id, `Claude's work on this script didn't carry on after Edit restarted (${why}). Start it again.`);
    throw new durable.Gone(`it didn't start again: ${why}`);
  }
}
