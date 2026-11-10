// Thumbnails, started with the server: a turn this Mac had going when Edit
// stopped is carried on (serve.ts's resumer, `resumeRun`) when Edit is back
// soon, and one from before jobs.json listed turns is marked stopped once
// someone who makes them is signed in. Before Edit restarts itself, its turns
// stop without an ending, to be carried on after it.

import * as accounts from "../accounts.ts";
import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { mayIdeas } from "../ideas/routes.ts";
import * as openart from "./openart.ts";
import type * as jobs from "../jobs.ts";
import * as update from "../update.ts";
import { contextOf } from "./routes.ts";
import { markInterrupted, prepareRestart, resumeRun as resumeOne } from "./run.ts";

export function start(app: App): void {
  openart.useHome(app.store.home);
  let done = false;
  const look = () => {
    if (done || accounts.creator() === null || !mayIdeas()) return;
    done = true;
    const holder = (process.env.EDIT_CLOUD_HOLDER ?? "").trim() || app.machine;
    void markInterrupted(holder, app.store.home).catch((error: unknown) => {
      done = false;
      diag.warn("thumbnails", `marking turns stopped by the restart: ${diag.messageOf(error)}`);
    });
  };
  accounts.onSessionChange(look);
  setTimeout(look, 15_000).unref?.();
  // Registered before serve.ts's own, which stops every program Edit started (Claude Code among them) after it.
  update.onPrepare(() => prepareRestart());
}

/** A run a restart cut short: carried on, its ending saved, or marked stopped (serve.ts's resumer for `thumbnail`); who holds it and who asked are its job's. */
export function resumeRun(app: App, job: jobs.Job): Promise<void> {
  return resumeOne(contextOf(app), job);
}
