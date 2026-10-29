// What an admin can ask a teammate's Edit to do besides updating
// (remote_support.ts): send its diagnostics, and pick up a stopped import.
// Both are bounded: no agent turn, so nothing spends beyond what the import
// itself would (the user, Oct 29: "if anything goes wrong … we're able to do
// things on our end, and they reflect on someone else's computer").

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloudProjects from "./cloud_projects.ts";
import * as diag from "./diag.ts";
import { join } from "./paths.ts";
import * as problemReports from "./problem_reports.ts";
import * as script from "./script.ts";
import { BUILD } from "./version.ts";

/** The kinds this build carries out (Convex sends an older build only updates). */
export const KINDS = ["update", "diagnostics", "resume"] as const;
export type Kind = (typeof KINDS)[number];

/** Each project here: its name, cloud state and import, one line each. */
function projectLines(app: App): string[] {
  const cloud = cloudProjects.cloudOf(app);
  return app.store.list().map((summary) => {
    const id = summary.id;
    const status = (cloud?.status(id) ?? { cloud: false }) as { cloud?: boolean; sync?: string; message?: string | null };
    const job = app.scripts.get(id);
    const where = status.cloud ? `cloud ${status.sync ?? "?"}${status.message ? ` (${status.message})` : ""}` : "only on this Mac";
    const importing = job ? ` · import ${job.state}${job.error ? `: ${job.error}` : ""}` : "";
    return `${id} "${summary.name}" · ${where}${importing}`;
  });
}

/** The log's last `count` lines: the file's (from before a restart too), else what's in memory. */
function logTail(app: App, count: number): string[] {
  try {
    const text = fs.readFileSync(join(app.store.home, "logs", "edit.log"), "utf8");
    return text.split("\n").filter((line) => line !== "").slice(-count);
  } catch {
    return diag.lines(count).map((line) => `${diag.stamp(line.at)} ${line.level.toUpperCase()} [${line.area}] ${line.message}`);
  }
}

/** Sends this Mac's report (projects, log, timings) to the team's reports; where it went. */
export async function diagnostics(app: App): Promise<string> {
  const log = logTail(app, 3000);
  const slow = diag.timings().slice(0, 30).map((timing) => JSON.stringify(timing));
  const report = [
    "Diagnostics asked for by an admin (edit remote diagnostics).",
    `Edit ${BUILD} · ${diag.osName()} ${diag.archName()} · up ${diag.human(diag.uptime())}`,
    "",
    "Projects:",
    ...projectLines(app),
    "",
    "Timings:",
    ...slow,
    "",
    "Log:",
    ...log,
  ].join("\n");
  const { key } = await problemReports.send(app.store.home, app.machine, diag.scrub(report));
  return key;
}

/**
 * Picks up `projectId`'s import: a project only on this Mac goes to the
 * cloud first (so the team can open it), then an unfinished import starts
 * again. What happened, in a line.
 */
export async function resume(app: App, projectId: string): Promise<string> {
  const live = app.store.get(projectId);
  if (live === null) throw new Error(`There's no project ${projectId} on this Mac.`);
  const done: string[] = [];
  const cloud = cloudProjects.cloudOf(app);
  if (cloud?.on() && (cloud.status(projectId) as { cloud?: boolean }).cloud !== true) {
    await cloudProjects.moveToCloud(app, projectId, true);
    done.push("moved to the cloud");
  }
  if (script.unfinished(live.project)) {
    const running = app.scripts.get(projectId);
    if (running && ["downloading", "transcribing", "placing", "voicing"].includes(running.state)) done.push(`import already ${running.state}`);
    else if (script.start(app, projectId, false) !== null) done.push("import started again");
  } else {
    done.push("its import had finished (laid out): open it and Resume edit to finish the rest");
  }
  const status = (cloud?.status(projectId) ?? {}) as { sync?: string; message?: string | null };
  if (status.message) done.push(`cloud: ${status.message}`);
  diag.info("remote", `resume ${projectId}: ${done.join("; ")}`);
  return `"${live.project.name}": ${done.join("; ")}`;
}
