// Script mode (Writer, merged into Edit on Oct 29 2026): starting it with the
// server. The first start copies this Mac's Writer scripts in (Writer's own
// folder stays as it was, so Writer still opens them); every start carries on
// the imports and Claude's jobs that died with the server (an update, a crash),
// and before Edit restarts itself the jobs are stopped where they are, to
// carry on after it.

import * as fs from "node:fs";

import type { ImportProgress } from "@edit/types/writer";

import * as accounts from "../accounts.ts";
import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import * as paid from "../paid.ts";
import * as service from "../effect/service.ts";
import * as update from "../update.ts";
import * as scriptSync from "../script_sync.ts";
import * as archive from "./archive.ts";
import * as build from "./build.ts";
import * as cloud from "./cloud.ts";
import { readSettings } from "../cloud_projects.ts";
import * as machine from "../machine.ts";
import { holderFor } from "../sync_core.ts";
import * as reviews from "./reviews.ts";
import * as drive from "./drive.ts";
import * as handoff from "./handoff.ts";
import { isFile, join, userHome } from "../paths.ts";
import * as jobs from "./jobs.ts";
import * as storage from "./storage.ts";
import * as store from "./store.ts";
import { THIS_MACHINE } from "../machine.ts";

/** Where Writer kept its scripts on this Mac. */
export const WRITER_FOLDER = (): string => join(userHome(), "Library", "Application Support", "com.spheceo.writer");

/** Background work Script mode's parts start with the server (the cloud, review polling…). */
export const starters: ((app: App) => void)[] = [];

export function start(app: App, options: { trials?: boolean } = {}): void {
  const data = store.dataDir(app.store.home);
  drive.hooks.accessToken = () => app.library.accessToken();
  build.usePort(app.port);
  // Every save names a Drive folder case's master in Edit's originals, so Start the edit finds it on any Mac;
  // scripts saved before that (Nov 4) are named once now, before anything else writes them.
  store.hooks.withSharedKeys = handoff.withSharedKeys;
  handoff.stampAll(data);
  // Claude's jobs are written down in Edit's job table, so a restart carries them on (work.ts), and stopped where they are before Edit restarts itself.
  jobs.useHome(app.store.home);
  holdBeforeRestart();
  // A trial server (EDIT_TRIALS=1) writes and builds scripts as any Edit does, but takes
  // none of the team's work: no Writer folder adopted, no review notes fixed, no archives
  // acted on (Oct 31: with Script mode off there, a script's builds called the tools on :7700
  // and its Drive reads had no token).
  if (options.trials === true) {
    carryOn(app, data, store.markInterrupted(data));
    for (const id of store.ids(data)) jobs.markInterrupted(data, id);
    cloud.start(data, holderFor(app.store.home, readSettings(app.store.home).holder ?? machine.name()));
    storage.start(data, join(app.store.home, "projects"), app.store.cacheDir());
    scriptSync.start(app);
    return;
  }
  // Writer's folder is another app's data: macOS warns the person each time
  // Edit reads it ("Data Access Blocked", Oct 30), so it's read once per Mac.
  const once = join(data, "writer-folder-read");
  if (!fs.existsSync(once)) adoptWriter(data);
  try {
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(once, new Date().toISOString());
  } catch (error) {
    diag.warn("writer", `noting Writer's folder as read: ${diag.messageOf(error)}`);
  }
  carryOn(app, data, store.markInterrupted(data));
  for (const id of store.ids(data)) jobs.markInterrupted(data, id);
  cloud.start(data, holderFor(app.store.home, readSettings(app.store.home).holder ?? machine.name()));
  reviews.start(app, data);
  // Idle scripts' footage left to the cloud as room runs short.
  storage.start(data, join(app.store.home, "projects"), app.store.cacheDir());
  // Each script and the edit made from it kept in step.
  scriptSync.start(app);
  // Archives and restores heard from the cloud, acted on every 20 s.
  setInterval(() => archive.react(app, data), 20_000);
  for (const begin of starters) {
    try {
      begin(app);
    } catch (error) {
      diag.warn("writer", diag.messageOf(error));
    }
  }
}

/** How long paid requests in flight get to be answered before the jobs are stopped for a restart (serve.ts waits as long). */
const PAID_WAIT_MS = 120_000;

let holding = false;

/**
 * Before Edit restarts itself (an update, remote support's restart): once the
 * paid requests in flight are answered and kept, Claude's jobs on scripts are
 * stopped where they are, each left running in the job table and on its
 * script, so the next run carries it on (work.ts) and none says it failed.
 * Runs before serve.ts's own preparing, which stops the imports and every
 * program Edit started.
 */
function holdBeforeRestart(): void {
  if (holding) return;
  holding = true;
  update.onPrepare(async () => {
    await paid.settle(PAID_WAIT_MS);
    const held = await jobs.holdForRestart();
    if (held.length > 0) diag.info("update", `stopped Claude on ${held.length} script(s) before restarting: they carry on after it`);
  });
}

/** How long a carry-on waits for the sign-in to be back, and how long between its tries after a passing failure. */
export const carrying = { signInMs: 60_000, retryMs: [30_000, 120_000, 300_000] };

/** Imports cut off by the restart and not started again yet, as the page follows them (routes.ts `/api/writer/progress`). */
const waiting = new Map<string, ImportProgress>();

/** The imports about to carry on after a restart: still importing, and saying so. */
export const carryingOn = (): ImportProgress[] => [...waiting.values()];

/**
 * Imports a restart or an update cut off carry on by themselves, from what
 * they kept, as Retry would: they waited for someone to press it, and a dev
 * server reloaded by a saved file left the Kroger import stopped at its
 * transcription (Oct 31). Each stays importing meanwhile ("Carrying on after
 * the update"), starts once the sign-in is back (a Drive import asked for its
 * token before it, after a fixed 15 s, and stopped for a person to retry), and
 * a passing failure after it (the relay busy, a dropped connection) is tried
 * again a few times. Another failure stops it as any other would.
 */
export function carryOn(app: App, data: string, cut: string[]): void {
  if (cut.length === 0) return;
  for (const id of cut) {
    try {
      const script = store.read(store.scriptDir(data, id));
      waiting.set(id, { id, title: script.title, stage: script.stage, percent: script.progress, detail: jobs.CARRYING_ON });
    } catch {
      // Unreadable: its resume says why.
    }
  }
  void (async () => {
    await Promise.race([accounts.tokenWhenReady().catch(() => null), Bun.sleep(carrying.signInMs)]);
    const imports = await import("./imports.ts");
    // Side by side, as they were running: each resume lasts its whole import.
    await Promise.all(cut.map((id) => carryOnImport(app, data, id, imports)));
  })();
}

async function carryOnImport(app: App, data: string, id: string, imports: typeof import("./imports.ts")): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      diag.info("writer", `${id}: carrying on the import a restart cut off${tries > 0 ? ` (try ${tries + 1})` : ""}`);
      waiting.delete(id);
      await imports.resume(app, data, id, { kind: "retry" });
      return;
    } catch (error) {
      const wait = carrying.retryMs[tries];
      // Started by someone meanwhile, or stopped for Edit to restart (it stays importing, for the next run): not this carry-on's to say.
      if (imports.importing(id) || jobs.restartUnderWay()) return;
      if (wait === undefined || !service.isTemporary(error)) {
        // A failure the import said stays on the script; one before it started leaves it stopped, for Retry.
        store.markStopped(data, id);
        diag.warn("writer", `${id}: the import a restart cut off didn't carry on: ${diag.messageOf(error)}`);
        return;
      }
      // Still importing while it waits to try again, not stopped for a person.
      const dir = store.scriptDir(data, id);
      const script = store.update(dir, (one) => Object.assign(one, { status: "processing", error: null }), true);
      waiting.set(id, { id, title: script.title, stage: script.stage, percent: script.progress, detail: `Trying again in a moment: ${diag.messageOf(error)}` });
      diag.warn("writer", `${id}: the import a restart cut off failed for now (${diag.messageOf(error)}); trying again in ${Math.round(wait / 1000)} s`);
      await Bun.sleep(wait);
    }
  }
}

/** Writer's scripts, its cloud record and its review notes, taken into Script mode. */
function adoptWriter(data: string): void {
  try {
    const adopted = store.adoptWriterFolder(data, WRITER_FOLDER());
    if (adopted > 0) diag.info("writer", `brought ${adopted} scripts in from Writer's folder on ${THIS_MACHINE}`);
  } catch (error) {
    diag.warn("writer", `Writer's scripts weren't brought in: ${diag.messageOf(error)}`);
  }
  try {
    cloud.adoptLedger(data, WRITER_FOLDER());
    // What Writer knew of its review notes (where it had read them to, open counts, approvals), once.
    const notes = join(WRITER_FOLDER(), "reviews", "notes.json");
    const ours = join(data, "reviews", "notes.json");
    const empty = !isFile(ours) || ((JSON.parse(fs.readFileSync(ours, "utf8")) as { cursor?: number }).cursor ?? 0) === 0;
    if (isFile(notes) && empty) {
      fs.mkdirSync(join(data, "reviews"), { recursive: true });
      fs.copyFileSync(notes, ours);
    }
  } catch (error) {
    diag.warn("writer", `Writer's cloud record wasn't taken: ${diag.messageOf(error)}`);
  }
}
