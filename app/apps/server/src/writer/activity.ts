// Everything long Script mode is doing now, for the progress panel every
// screen shows (`GET /api/writer/activity`): imports, Claude's jobs and the
// cloud's transfer, each with its step, how far (n of m, or bytes) and since
// when; and whether Claude Code is there to do them (`GET /api/writer/claude`).

import { findClaude } from "../claude.ts";
import * as cloud from "./cloud.ts";
import * as imports from "./imports.ts";
import * as jobs from "./jobs.ts";
import { run } from "./proc.ts";

export interface Work {
  key: string;
  /** The script it's on, to open it. */
  script: string | null;
  what: string;
  title: string;
  step: string;
  done: number;
  total: number;
  /** `count` (n of m), `bytes` or `percent`. */
  unit: "count" | "bytes" | "percent";
  started: number;
}

/** "Fixing note 2 of 5" → [2, 5]. */
export function nOfM(text: string): [number, number] | null {
  const found = /(\d+)\D*\s+of\s+(\d+)/.exec(text);
  return found === null ? null : [Number(found[1]), Number(found[2])];
}

const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

export function list(): Work[] {
  const out: Work[] = imports.progress().map((one) => ({ key: `import:${one.id}`, script: one.id, what: "Importing", title: one.title, step: one.detail === "" ? one.stage : one.detail, done: one.percent, total: 100, unit: "percent", started: 0 }));
  for (const [id, title, job] of jobs.runningList()) {
    const [done, total] = nOfM(job.stage) ?? [0, 0];
    out.push({ key: `job:${id}`, script: id, what: "Claude", title, step: job.stage, done, total, unit: "count", started: job.startedAt });
  }
  const moving = cloud.statusNow().transfer;
  if (moving !== null) out.push({ key: "cloud", script: moving.script, what: moving.up ? "Uploading to the cloud" : "Downloading from the cloud", title: moving.name, step: `${size(moving.done)} of ${size(moving.total)}`, done: moving.done, total: moving.total, unit: "bytes", started: 0 });
  return out;
}

/** Claude Code on this Mac, signed in: what Script mode's builds run on (the person's own plan, as Edit's agent). */
export async function claudeStatus(): Promise<{ installed: boolean; loggedIn: boolean; subscription: string | null; message: string }> {
  const binary = await findClaude();
  if (binary === null) return { installed: false, loggedIn: false, subscription: null, message: "Install Claude Code and sign in. Edit uses that login, not an API key." };
  let value: { loggedIn?: unknown; subscriptionType?: unknown } = {};
  try {
    value = JSON.parse((await run(binary, ["auth", "status"], { timeoutMs: 20_000 })).trim()) as typeof value;
  } catch (error) {
    // Not answering isn't signed out (Edit updating Claude Code, the first start of a nightly): Edit's own setup says when it's a real problem.
    return { installed: true, loggedIn: true, subscription: null, message: `Claude Code didn't answer: ${error instanceof Error ? error.message : String(error)}` };
  }
  // Only Claude saying so counts as signed out.
  const loggedIn = value.loggedIn !== false;
  const subscription = typeof value.subscriptionType === "string" && value.subscriptionType !== "" ? value.subscriptionType : null;
  return { installed: true, loggedIn, subscription, message: loggedIn ? (subscription ? `Claude · ${subscription}` : "Claude is signed in.") : "Claude Code isn't signed in. Open Terminal, run claude, and type /login." };
}
