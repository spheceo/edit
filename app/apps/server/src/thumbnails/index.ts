// Thumbnails, started with the server: a turn this Mac had going when Edit
// stopped is marked stopped once someone who makes them is signed in.

import * as accounts from "../accounts.ts";
import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { mayIdeas } from "../ideas/routes.ts";
import { markInterrupted } from "./run.ts";

export function start(app: App): void {
  let done = false;
  const look = () => {
    if (done || accounts.creator() === null || !mayIdeas()) return;
    done = true;
    const holder = (process.env.EDIT_CLOUD_HOLDER ?? "").trim() || app.machine;
    void markInterrupted(holder).catch((error: unknown) => {
      done = false;
      diag.warn("thumbnails", `marking turns stopped by the restart: ${diag.messageOf(error)}`);
    });
  };
  accounts.onSessionChange(look);
  setTimeout(look, 15_000).unref?.();
}
