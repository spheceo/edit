// Ideas, started with the server: a run this Mac had going when Edit stopped
// is marked stopped in the cloud once someone who works on ideas is signed in
// (as Script mode marks its jobs), so nobody waits on it; asking again starts
// it over. Nothing else runs in the background.

import * as accounts from "../accounts.ts";
import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { holderOf, mayIdeas } from "./routes.ts";
import type * as jobs from "../jobs.ts";
import { markInterrupted, resumeRun as resumeOne } from "./run.ts";

export function start(app: App): void {
  let done = false;
  const look = () => {
    if (done || accounts.creator() === null || !mayIdeas()) return;
    done = true;
    void markInterrupted(holderOf(app), app.store.home).catch((error: unknown) => {
      done = false;
      diag.warn("ideas", `marking runs stopped by the restart: ${diag.messageOf(error)}`);
    });
  };
  accounts.onSessionChange(look);
  setTimeout(look, 15_000).unref?.();
}

/** A run a restart cut short: its ending saved, or marked stopped (serve.ts's resumer for `idea`). */
export function resumeRun(app: App, job: jobs.Job): void {
  resumeOne(app.store.home, job);
}
