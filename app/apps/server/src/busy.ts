// What Edit is doing on this computer, and on which project or script: the
// one answer every "is this busy" reads (Nov 8 audit, item C: five answers
// had grown apart). `busyWith` is what a restart or an update would cut off
// (remote_actions, routes, reviews.busyHere); `workingOn` is whether work here
// holds a project's or a script's cloud lock (cloud_projects, writer/cloud).

import type { App } from "./app.ts";
import { importing } from "./drive_import.ts";
import * as ideaRuns from "./ideas/run.ts";
import * as jobs from "./jobs.ts";
import * as seams from "./seams.ts";
import * as thumbnailRuns from "./thumbnails/run.ts";
import * as writerImports from "./writer/imports.ts";
import * as writerJobs from "./writer/jobs.ts";

/** Work that holds a lock: its project (an edit's id) or script (`script:<id>`). */
export function scriptKey(id: string): string {
  return `script:${id}`;
}

/**
 * What an update would lose now: only work that doesn't yet carry on by
 * itself after Edit restarts (everything else in `busyWith` is a job that
 * picks up from what it kept, paid requests are answered first and the
 * programs Edit started are stopped before it: serve.ts's update.onPrepare).
 * An update waits for these alone (Sphe, Nov 10: "let Update go through at
 * any time"). A kind leaves this list once it carries on.
 */
export function wouldLose(_app: App): string[] {
  // Nothing, since Nov 10: an upload to Drive carries on from its kept session (drive.ts), footage from a Drive link
  // from its job (drive_import.ts), Claude on a script, an idea or a thumbnail from what its job kept (writer/work.ts,
  // ideas/run.ts, thumbnails/run.ts). A new kind of work that can't carry on is said here.
  return [];
}

/** Others' work this computer is doing (reviews' fixes): each says what runs, or nothing. */
const others = new Set<() => string | null>();

/** Adds work only its own module knows about (Ready for changes' fixes); undone by the function returned. */
export function register(what: () => string | null): () => void {
  others.add(what);
  return () => others.delete(what);
}

interface ScriptJobs {
  get?(project: string): { state: string } | null;
  running?(): boolean;
  working?(project: string): boolean;
}

const RUNNING_IMPORT = new Set(["downloading", "transcribing", "placing", "voicing"]);

/** Whether work here holds `key`'s lock: an agent turn or a script import on that edit, or an import or Claude on that script. */
export function workingOn(app: App, key: string): boolean {
  if (key.startsWith("script:")) {
    const id = key.slice("script:".length);
    return writerImports.importing(id) || writerJobs.running(id);
  }
  const agents = app.agents as { runningProjects?: () => string[] } | undefined;
  if (agents?.runningProjects?.().includes(key) === true) return true;
  const scripts = app.scripts as ScriptJobs | undefined;
  // Working here, not one read back after a restart that its resumer hasn't picked up yet.
  if (scripts?.working !== undefined) return scripts.working(key);
  const job = scripts?.get?.(key) ?? null;
  return job !== null && RUNNING_IMPORT.has(job.state);
}

/**
 * What a restart would cut off now: an export, a share (from jobs.json, so one
 * a restart cut short and that is about to carry on counts too), an import,
 * Claude on a script, an agent turn, a fix. One list for everything that
 * restarts Edit from afar (a restart, an update), so none of them cuts off
 * what another waits for (Nov 1: an update waited only for agent turns, and
 * would have stopped an export part-way).
 */
export function busyWith(app: App, agentTurns = true): string[] {
  let uploading = false;
  try {
    uploading = seams.drive.uploading();
  } catch (error) {
    if (!seams.isUnavailable(error)) throw error;
  }
  const shares = jobs.list(app.store.home ?? null, "share").filter(jobs.live).length;
  const agents = app.agents as { hasRunningTurns?: () => boolean; runningProjects?: () => string[] } | undefined;
  const turns = agents?.hasRunningTurns?.() ?? (agents?.runningProjects?.().length ?? 0) > 0;
  const said = [
    app.exports.running() ? "an export" : "",
    app.exports.archiving?.() ? "an export going up to the cloud" : "",
    shares > 0 ? (shares === 1 ? "a share" : `${shares} shares`) : "",
    uploading ? "an upload to Drive" : "",
    (app.scripts as ScriptJobs | undefined)?.running?.() || importing() ? "a footage import" : "",
    writerImports.anyImporting() ? "a script's import" : "",
    writerJobs.runningList().length > 0 ? "Claude on a script" : "",
    agentTurns && turns ? "an agent turn" : "",
    agentTurns && thumbnailRuns.anyRunning() ? "Claude on a thumbnail" : "",
    agentTurns && ideaRuns.anyRunning() ? "Claude on an idea" : "",
  ];
  for (const what of others) said.push(what() ?? "");
  return [...new Set(said.filter(Boolean))];
}
