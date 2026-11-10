// Beta: what's being tried before everyone has it, switched on per computer
// in Settings → Beta and kept in `<home>/beta.json`, as the update channel is
// in update.json. The one now is Edit V2 (Sphe, Nov 10): with it on, New
// project offers Bodycam HQ, whose graphics the agent writes as code.
//
//   GET /api/beta        {v2}: whether each beta is on (off unless set)
//   PUT /api/beta {v2}   switched on or off; answers as GET

import fs from "node:fs";
import { join } from "node:path";

import type { App } from "./app.ts";
import { writeAtomic } from "./files.ts";
import { bad, json } from "./http/errors.ts";
import { readJson, type RouteContext, type Router } from "./http/router.ts";

export interface Beta {
  /** Edit V2: Bodycam HQ in New project, its graphics written as code by the agent. */
  v2: boolean;
}

const FILE = "beta.json";

/** This computer's betas: each off unless `<home>/beta.json` says on. */
export function read(home: string): Beta {
  try {
    const saved = JSON.parse(fs.readFileSync(join(home, FILE), "utf8")) as Partial<Record<keyof Beta, unknown>> | null;
    return { v2: saved?.v2 === true };
  } catch {
    return { v2: false };
  }
}

export function routes(router: Router<App>): void {
  router
    .get("/api/beta", ({ app }: RouteContext<App>) => json(read(app.store.home)))
    .put("/api/beta", async (context: RouteContext<App>) => {
      const body = await readJson<{ v2?: unknown }>(context);
      if (typeof body.v2 !== "boolean") throw bad("v2 is true or false.");
      const beta: Beta = { ...read(context.app.store.home), v2: body.v2 };
      writeAtomic(join(context.app.store.home, FILE), `${JSON.stringify(beta)}\n`);
      return json(beta);
    });
}
