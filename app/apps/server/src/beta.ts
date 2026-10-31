// Beta (Oct 31 2026): what's being tried before everyone has it, switched on
// per Mac in Settings → Beta and kept in `<home>/beta.json`, as the update
// channel is in update.json. The first is the sidebar Home (Home.tsx; off,
// HomeClassic.tsx): the user, Oct 31, "put the new Home … behind a beta option
// in Settings that can easily be toggled on and off".
//
//   GET /api/beta          {home}: whether each beta is on (off unless set)
//   PUT /api/beta {home}   switched on or off; answers as GET

import fs from "node:fs";
import { join } from "node:path";

import type { App } from "./app.ts";
import { writeAtomic } from "./files.ts";
import { bad, json } from "./http/errors.ts";
import { readJson, type RouteContext, type Router } from "./http/router.ts";

export interface Beta {
  /** Home as a sidebar and one list at a time, with Later and Done. */
  home: boolean;
}

const FILE = "beta.json";

/** This Mac's betas: each off unless `<home>/beta.json` says on. */
export function read(home: string): Beta {
  try {
    const saved = JSON.parse(fs.readFileSync(join(home, FILE), "utf8")) as Partial<Record<keyof Beta, unknown>> | null;
    return { home: saved?.home === true };
  } catch {
    return { home: false };
  }
}

export function routes(router: Router<App>): void {
  router
    .get("/api/beta", ({ app }: RouteContext<App>) => json(read(app.store.home)))
    .put("/api/beta", async (context: RouteContext<App>) => {
      const body = await readJson<{ home?: unknown }>(context);
      if (typeof body.home !== "boolean") throw bad("home is true or false.");
      const beta: Beta = { ...read(context.app.store.home), home: body.home };
      writeAtomic(join(context.app.store.home, FILE), `${JSON.stringify(beta)}\n`);
      return json(beta);
    });
}
