// Ideas, started with the server: a run this Mac had going when Edit stopped
// is carried on (serve.ts's resumer, `resumeRun`) when Edit is back soon, and
// one from before jobs.json listed runs is marked stopped in the cloud once
// someone who works on ideas is signed in (as Script mode marks its jobs), so
// nobody waits on it. Before Edit restarts itself, its runs stop without an
// ending, to be carried on after it. Nothing else runs in the background.

import * as accounts from "../accounts.ts";
import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { holderOf, mayIdeas } from "./routes.ts";
import type * as jobs from "../jobs.ts";
import * as update from "../update.ts";
import { markInterrupted, prepareRestart, resumeRun as resumeOne } from "./run.ts";

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
  // Registered before serve.ts's own, which stops every program Edit started (Claude Code among them) after it.
  update.onPrepare(() => prepareRestart());
}

/** A run a restart cut short: carried on, its ending saved, or marked stopped (serve.ts's resumer for `idea`). */
export function resumeRun(app: App, job: jobs.Job): Promise<void> {
  return resumeOne({ home: app.store.home, port: app.port }, job);
}
