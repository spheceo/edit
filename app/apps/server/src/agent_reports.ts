// report_problem: the in-app agent files a bug the way a person does with
// Report a problem: what failed (the tool, what it asked, the error), with
// this Mac's diagnostics (remote_actions.report: the log, what's running, the
// setup checks), sent to the team's problem reports (problem_reports.ts) so
// it's fixed in Edit rather than worked around in silence (THE WHOLE FLOW;
// E1, Oct 31: told place_label needed the map's clip id, the agent dropped
// the label). Once per tool and error per project a day: an agent that hits
// the same wall again files nothing new. Sphe's Nov 2 list, item 7 (from
// Diffusion Studio's agent filing its own bugs).

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { registerTool, text, type ToolCall } from "./mcp/registry.ts";
import { join } from "./paths.ts";
import * as problemReports from "./problem_reports.ts";
import * as remote from "./remote_actions.ts";

/** What one report says, and why not when it can't. */
export function problemFrom(args: Record<string, unknown>): { tool: string; error: string; asked: string; instead: string; note: string } | string {
  const field = (name: string, most: number) => (typeof args[name] === "string" ? (args[name] as string).trim().slice(0, most) : "");
  const tool = field("tool", 80);
  const error = field("error", 4000);
  if (!/^[a-z][a-z0-9_]*$/u.test(tool)) return "tool: the name of the tool that failed (map_view, place_label…)";
  if (error === "") return "error: what the tool said, word for word";
  return { tool, error, asked: field("asked", 4000), instead: field("instead", 1000), note: field("note", 2000) };
}

/** Reports already filed today, by project, tool and error. */
const filed = new Map<string, string>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

registerTool("report_problem", async ({ app, args, projectId }: ToolCall) => {
  const given = problemFrom(args);
  if (typeof given === "string") throw new Error(given);
  const project = app.store.get(projectId)?.project;
  const key = `${today()}|${projectId}|${given.tool}|${given.error.slice(0, 200)}`;
  const before = filed.get(key);
  if (before !== undefined) return text(`already reported today (${before}): carry on, and say it's FAILED in your summary`);
  const head = [
    `Filed by the in-app agent on "${project?.name ?? projectId}" (${projectId}).`,
    `Tool: ${given.tool}`,
    `Error: ${given.error}`,
    ...(given.asked === "" ? [] : [`Asked: ${given.asked}`]),
    ...(given.instead === "" ? [] : [`Did instead: ${given.instead}`]),
    ...(given.note === "" ? [] : [`Note: ${given.note}`]),
    "",
  ].join("\n");
  const report = diag.scrub(`${head}\n${await reportBody(app)}`);
  try {
    const { key: where } = await problemReports.send(app.store.home, app.machine, report);
    filed.set(key, where);
    diag.info("reports", `the agent reported ${given.tool} failing on ${projectId}`);
    return text(`reported to the team (${where}), with this Mac's diagnostics: it gets fixed in Edit. Carry on with the rest, and say it's FAILED in your summary.`);
  } catch (error) {
    // Not signed in, or the cloud didn't answer: kept on this Mac for the next report.
    const dir = join(app.store.home, "reports-sent");
    fs.mkdirSync(dir, { recursive: true });
    const local = join(dir, `${today()}-agent-${Date.now()}.txt`);
    fs.writeFileSync(local, report);
    filed.set(key, local);
    diag.warn("reports", `the agent's report of ${given.tool} kept here only: ${diag.messageOf(error)}`);
    return text(`couldn't send it to the team (${diag.messageOf(error)}); kept on this Mac at ${local}. Tell the user in your summary, with the error, so they can pass it on.`);
  }
});

/** The diagnostics a report carries (tests stand in for it). */
export const hooks = {
  diagnostics: (app: App): Promise<string> => remote.report(app, "Diagnostics with the agent's report."),
};

async function reportBody(app: App): Promise<string> {
  try {
    return await hooks.diagnostics(app);
  } catch (error) {
    return `(the diagnostics couldn't be gathered: ${diag.messageOf(error)})`;
  }
}

/** For tests: forget what was filed. */
export function forgetFiled(): void {
  filed.clear();
}
