// The first message to a project's agent, given when the project is made and
// sent once its import is done, so a new project needs nothing more from
// anyone until it's ready to check (the user, Oct 30: "have the initial prompt
// be included in the importing stage so that once import is done the prompt is
// sent and it's out of your way"). Kept on disk, so a restart doesn't lose it.

import * as fs from "node:fs";
import { join } from "node:path";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { ApiError, bad } from "./http/errors.ts";
import { readJson, type Router } from "./http/router.ts";
import * as seams from "./seams.ts";

/** How often waiting prompts are looked at. */
const EVERY_MS = 5_000;

type Waiting = Record<string, { text: string; at: number }>;

const fileOf = (home: string) => join(home, "first-prompts.json");

function read(home: string): Waiting {
  try {
    return JSON.parse(fs.readFileSync(fileOf(home), "utf8")) as Waiting;
  } catch {
    return {};
  }
}

function write(home: string, waiting: Waiting): void {
  writeAtomic(fileOf(home), JSON.stringify(waiting));
}

/** Notes `text` as `project`'s first message, sent when its import is done (now, if there's none). */
export function give(app: App, project: string, text: string): void {
  write(app.store.home, { ...read(app.store.home), [project]: { text, at: Date.now() } });
  void sendReady(app);
}

/** The first message still waiting for `project`'s import, if any. */
export function waiting(app: App, project: string): string | null {
  return read(app.store.home)[project]?.text ?? null;
}

let sending = false;

/** Sends each waiting message whose project is ready: imported, and its agent not on a turn. */
export async function sendReady(app: App): Promise<void> {
  if (sending) return;
  sending = true;
  try {
    const waitingNow = read(app.store.home);
    for (const [project, { text }] of Object.entries(waitingNow)) {
      const live = app.store.get(project);
      if (live === null) {
        // The project went: its message goes with it.
        forget(app, project);
        continue;
      }
      const job = app.scripts.get(project);
      // Still importing, or waiting on the person (a file it couldn't get, a failure): not yet.
      if (job !== null && job.state !== "done") continue;
      if (live.project.script !== undefined && live.project.script !== null && !seams.script.laidOut(live.project)) continue;
      const panel = seams.agentPanel(app);
      if ((panel.chat(project) as { running?: boolean }).running === true) continue;
      try {
        await app.store.mayWrite(project);
        await panel.send(project, text, null, null);
        diag.info("agent", `${live.project.name}: its import is done, so its first message went to the agent`);
        forget(app, project);
      } catch (error) {
        diag.warn("agent", `${live.project.name}: sending its first message: ${diag.messageOf(error)}; trying again`);
      }
    }
  } finally {
    sending = false;
  }
}

function forget(app: App, project: string): void {
  const now = read(app.store.home);
  delete now[project];
  write(app.store.home, now);
}

export function start(app: App): void {
  const timer = setInterval(() => void sendReady(app), EVERY_MS);
  timer.unref?.();
}

export function routes(router: Router<App>): void {
  router.post("/api/projects/{id}/first-prompt", async (context) => {
    const id = context.params.id ?? "";
    if (context.app.store.get(id) === null) throw new ApiError(404, "no such project");
    const given = await readJson<unknown>(context);
    const text = typeof (given as { text?: unknown } | null)?.text === "string" ? (given as { text: string }).text.trim() : "";
    if (text === "") throw bad("say something");
    give(context.app, id, text);
    return Response.json({ ok: true });
  });
}
