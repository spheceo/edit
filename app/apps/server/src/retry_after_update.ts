// What failed on the old build, tried again once on the new one (the user,
// Nov 2: "could we make changes so that these failed stuff can restart when a
// new nightly comes on"; that day JJ's Mom Secretly had every note fixed, then
// its share's export failed, and nothing tried it again).
//
// The first time a build runs on this Mac (its tag differs from the one kept
// in `<home>/last-build.json`, or none was kept), it queues, in jobs.json
// (each failed job's `retry`, set to this build):
//   - each share that failed after its fixes went in (a failed `share` job
//     from Ready for changes, reviews' `unshared`): exported and shared as the
//     next version, as Share again does, which ends the failed request on the
//     review page;
//   - each export that failed and hasn't been exported since (a failed
//     `export` job), but a share's: exported again with the same settings,
//     through the normal queue.
// Then, while the Mac is idle (no export, import, share, agent turn or fix), one at a
// time: each is taken off the queue before it starts, so it's tried once on
// this build; failing again, it's a normal failure that waits for the next
// build. Never on a project another computer holds, a share never on an
// approved review, nor one a reviewer has asked of this Mac again (that
// request does it). The project's chunk cache goes first, so it renders fresh
// (a copy out of the last export that came out wrong fails the same way every
// time: JJ's, Nov 2). Each says "Trying again after the update" in the log and
// in the Exports panel.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as cloudProjects from "./cloud_projects.ts";
import * as diag from "./diag.ts";
import { chunkFolder, failedExports, type ExportFailure } from "./exports.ts";
import { writeAtomic } from "./files.ts";
import * as jobs from "./jobs.ts";
import { join } from "./paths.ts";
import * as reviews from "./reviews.ts";
import { BUILD } from "./version.ts";
import { THIS_MACHINE } from "./machine.ts";

export const NOTE = "Trying again after the update";
const LAST = "last-build.json";
/** How often the queue is looked at; the first look waits for what a start resumes (fixes at 60 s). */
const EVERY_MS = 60_000;
const FIRST_MS = 90_000;

export interface Item {
  kind: "share" | "export";
  project: string;
  name: string;
}

/** What's still to be tried again on this build: the failed jobs queued for it, oldest first. */
export function pending(home: string): Item[] {
  return queued(home, noted(home)).map(({ item }) => item);
}

/** The build last noted as running here. */
function noted(home: string): string | null {
  const build = (readJson(join(home, LAST)) as { build?: unknown } | null)?.build;
  return typeof build === "string" ? build : null;
}

/** Shares first (a reviewer waits on them), then the exports, each oldest first. */
function queued(home: string, build: string | null): { key: string; item: Item }[] {
  if (build === null) return [];
  return jobs
    .list(home)
    .filter((job) => job.state === "failed" && job.retry === build && (job.kind === "share" || job.kind === "export"))
    .sort((a, b) => Number(a.kind !== "share") - Number(b.kind !== "share") || a.updated_ms - b.updated_ms)
    .map((job) => ({ key: job.key, item: { kind: job.kind as Item["kind"], project: job.project, name: (job.args as { name?: string }).name ?? job.project } }));
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Notes `build` as the one running here. When it's new (another build ran
 * last, or none was noted), what failed is queued to be tried again; the
 * queue it made (empty for the same build).
 */
export function noteBuild(app: App, build = BUILD): Item[] {
  const home = app.store.home;
  const last = (readJson(join(home, LAST)) as { build?: unknown } | null)?.build;
  writeAtomic(join(home, LAST), JSON.stringify({ build, at: Date.now() }));
  if (last === build) return [];
  const from = typeof last === "string" ? last : null;
  const nameOf = (project: string, given?: string) => app.store.get(project)?.project.name ?? given ?? project;
  // The fixes a share couldn't put up (reviews.json's old `unshared` taken into jobs.json as it's read), then the exports.
  const shares = reviews.unsharedProjects(home);
  const failures = failedExports(home);
  const exports = Object.values(failures)
    .filter((failure) => failure.share !== true && !shares.includes(failure.project))
    .sort((a, b) => a.at - b.at);
  // A queue a build before left goes: this build's is what's tried.
  for (const job of jobs.list(home)) if (job.retry !== undefined) jobs.queueRetry(home, job.key, null);
  for (const project of shares) jobs.queueRetry(home, reviews.shareKey(project), build);
  for (const failure of exports) jobs.queueRetry(home, jobs.keyOf("export", failure.project), build);
  const items: Item[] = [
    ...shares.map((project): Item => ({ kind: "share", project, name: nameOf(project) })),
    ...exports.map((failure): Item => ({ kind: "export", project: failure.project, name: nameOf(failure.project, failure.name) })),
  ];
  if (items.length > 0) {
    diag.info("update", `${build}, after ${from ?? "an older build"}: ${items.length} thing(s) that failed will be tried again once ${THIS_MACHINE} is idle: ${items.map((one) => `${one.kind === "share" ? "sharing" : "exporting"} ${one.name}`).join("; ")}`);
  }
  return items;
}

/** What a retry does: tests stand in for them. */
export interface Actions {
  share(app: App, item: Item): Promise<void>;
  export(app: App, failure: ExportFailure): Promise<void>;
}

const real: Actions = {
  // Ends in a failure said on the page and `unshared` set again, never thrown (reviews.shareFixes).
  share: (app, item) => reviews.shareFixes(app, item.project, null, item.name, NOTE),
  // Queued like any export; the next retry waits for it to end (the Mac isn't idle meanwhile).
  export: async (app, failure) => {
    const live = app.store.get(failure.project);
    if (live === null) throw new Error(`the project isn't on ${THIS_MACHINE}`);
    await app.exports.start(app.store, app.library, live.project, failure.options, failure.output, {
      note: NOTE,
      ...(failure.drive === true ? { drive: true } : {}),
      ...(failure.keepLocal === true ? { keepLocal: true } : {}),
    });
  },
};

/** Why `item` isn't tried again now (it's dropped, as tried), or null. */
async function skipped(app: App, item: Item): Promise<string | null> {
  const home = app.store.home;
  if (app.store.get(item.project) === null) return `the project isn't on ${THIS_MACHINE}`;
  if (item.kind === "share") {
    const state = reviews.read(home);
    if (!reviews.unshared(home, item.project)) return "it has been shared since";
    const shared = state.shared[item.project];
    if (shared === undefined) return "it has no review";
    if (shared.approved) return `v${shared.approved.version} of its review was approved`;
    if (reviews.askedFor(item.project)) return `a reviewer asked again on ${THIS_MACHINE}, and that request does it`;
  } else {
    if (failedExports(home)[item.project] === undefined) return "it has exported since";
    if (app.exports.runningFor?.(item.project) != null) return "an export of it is running";
  }
  try {
    await app.store.mayWrite(item.project);
  } catch (error) {
    const holder = cloudProjects.heldBy(diag.messageOf(error));
    return holder !== null ? `the project is open on ${holder}` : `who holds the project couldn't be told (${diag.messageOf(error)})`;
  }
  return null;
}

let stepping = false;

/**
 * Tries the next thing in the queue again, when the Mac is idle and the cloud
 * on: taken off the queue first, so it's tried once. What it did, for the
 * log and tests: null when it waited (or there was nothing).
 */
export async function step(app: App, actions: Actions = real): Promise<string | null> {
  if (stepping || !cloud.enabled()) return null;
  const home = app.store.home;
  const items = queued(home, noted(home));
  if (items.length === 0 || reviews.busyHere(app)) return null;
  stepping = true;
  try {
    const { key, item } = items[0]!;
    // Off the queue before it starts: tried once on this build.
    jobs.queueRetry(home, key, null);
    const why = await skipped(app, item);
    if (why !== null) {
      diag.info("update", `${item.name}: not tried again after the update: ${why}`);
      return `skipped: ${why}`;
    }
    // Rendered fresh, nothing copied out of the export before.
    fs.rmSync(chunkFolder(app.store.cacheDir(), item.project), { recursive: true, force: true });
    if (item.kind === "share") {
      diag.info("update", `${item.name}: ${NOTE}: sharing the fixes an earlier share failed on`);
      await actions.share(app, item);
      return "shared";
    }
    const failure = failedExports(home)[item.project]!;
    diag.info("update", `${item.name}: ${NOTE}: exporting it again as before (it failed on ${failure.build}: ${failure.error})`);
    await actions.export(app, failure);
    return "exported";
  } catch (error) {
    diag.warn("update", `trying again after the update: ${diag.messageOf(error)}`);
    return `failed: ${diag.messageOf(error)}`;
  } finally {
    stepping = false;
  }
}

/** On start: this build noted (and what failed queued, when it's new), then the queue looked at every minute. */
export function start(app: App): void {
  try {
    noteBuild(app);
  } catch (error) {
    diag.warn("update", `noting this build: ${diag.messageOf(error)}`);
    return;
  }
  const look = () => void step(app);
  setTimeout(() => {
    look();
    setInterval(look, EVERY_MS).unref?.();
  }, FIRST_MS).unref?.();
}
