// Every change to a project, kept so the agent can undo any of them (Sphe,
// Nov 11: "an overall ability for the agent to undo changes"; "it must be able
// to"). The editor's ⌘Z is the person's, in their browser; this is the
// server's: each saved revision with when, who made it (the agent and which
// tool, the person, Edit by itself) and the patch that takes it back
// (patch.ts: only what changed). Undoing is a new revision, so an undo is
// itself undone the same way. Kept for the last MOST changes of a project, on
// disk beside it, so a restart forgets nothing.

import fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import type { Project } from "./model.ts";
import * as patches from "./patch.ts";
import { join } from "./paths.ts";
import { registerTool, text, handlerFor } from "./mcp/registry.ts";
import { agentCalls } from "./store.ts";

/** Changes kept a project. */
const MOST = 300;

export interface Change {
  rev: number;
  at: number;
  /** Who: "agent" (with its tool), "person", or Edit's own name for what it did ("effects", "cloud"…). */
  by: string;
  tool?: string;
  /** What changed, in a line. */
  what: string;
  /** Takes this change back. */
  undo: patches.Patch;
  /** What it changed (the patch's ids and fields), to tell when a later change touched the same things. */
  touched: string[];
}

const kept = new Map<string, Change[]>();

function file(app: App, id: string): string {
  return join(app.store.home, "projects", "changes", `${id}.jsonl`);
}

/** A project's changes, oldest first (read from disk once). */
function changesOf(app: App, id: string): Change[] {
  let list = kept.get(id);
  if (list !== undefined) return list;
  list = [];
  try {
    for (const line of fs.readFileSync(file(app, id), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        list.push(JSON.parse(line) as Change);
      } catch {
        // A line cut short by a crash: the rest are kept.
      }
    }
  } catch {
    // None kept yet.
  }
  kept.set(id, list.slice(-MOST));
  return kept.get(id)!;
}

/** A change's patch as a line: what it added, changed and removed. */
function summary(forward: patches.Patch): string {
  const parts: string[] = [];
  for (const [name, list] of Object.entries(forward.lists)) {
    const bits = [list.put.length > 0 ? `${list.put.length} added or changed` : "", list.remove.length > 0 ? `${list.remove.length} removed` : "", list.order !== undefined && list.put.length === 0 && list.remove.length === 0 ? "reordered" : ""].filter(Boolean);
    if (bits.length > 0) parts.push(`${name}: ${bits.join(", ")}${list.put.length > 0 && list.put.length <= 3 ? ` (${list.put.map((item) => (item as { id?: string }).id).join(", ")})` : ""}`);
  }
  const fields = [...Object.keys(forward.set), ...forward.unset];
  if (fields.length > 0) parts.push(fields.join(", "));
  return parts.join("; ") || "nothing visible";
}

function record(app: App, id: string, before: Project, after: Project, rev: number, origin: string): void {
  const forward = patches.diff(before, after);
  if (patches.empty(forward)) return;
  const call = agentCalls.getStore();
  const agent = call?.active === true;
  const change: Change = {
    rev,
    at: Date.now(),
    // The editor's saves come as its connection ("ui-…"); Edit's own work as a word (effects, cloud, script…).
    by: agent ? "agent" : origin.startsWith("ui-") || origin === "" ? "person" : origin,
    ...(agent && call?.tool !== undefined ? { tool: call.tool } : {}),
    what: summary(forward),
    undo: patches.diff(after, before),
    touched: [...patches.touched(forward)],
  };
  const list = changesOf(app, id);
  list.push(change);
  if (list.length > MOST) list.splice(0, list.length - MOST);
  try {
    fs.mkdirSync(join(app.store.home, "projects", "changes"), { recursive: true });
    // Rewritten now and then to its last MOST, else one line added.
    if (list.length === MOST && rev % 50 === 0) fs.writeFileSync(file(app, id), list.map((one) => JSON.stringify(one)).join("\n") + "\n");
    else fs.appendFileSync(file(app, id), `${JSON.stringify(change)}\n`);
  } catch (error) {
    diag.warn("changes", `${id}: keeping a change: ${diag.messageOf(error)}`);
  }
}

let started = false;

/** Keeps every project's changes from now on, and gives the agent its tools for them (once). */
export function start(app: App): void {
  if (handlerFor("edit_history") === undefined) {
    registerTool("edit_history", ({ app, args, projectId }) => {
      const count = typeof args.count === "number" && Number.isInteger(args.count) ? Math.min(100, Math.max(1, args.count)) : 15;
      return text(history(app, projectId, count));
    });
    registerTool("undo_changes", async ({ app, args, projectId }) => {
      const revs = Array.isArray(args.revs) ? (args.revs as unknown[]).filter((one): one is number => typeof one === "number" && Number.isInteger(one)) : undefined;
      const backTo = typeof args.back_to === "number" && Number.isInteger(args.back_to) ? args.back_to : undefined;
      return text(await undo(app, projectId, { ...(revs !== undefined ? { revs } : {}), ...(backTo !== undefined ? { backTo } : {}) }));
    });
  }
  if (started) return;
  started = true;
  app.store.subscribe((event) => {
    if (event.type !== "project" || typeof event.id !== "string") return;
    const before = (event as unknown as { before?: { rev: number; project: Project } }).before;
    const project = (event as unknown as { project?: Project }).project;
    if (before === undefined || project === undefined) return;
    record(app, event.id, before.project, project, (event as unknown as { rev: number }).rev, String((event as unknown as { origin?: string }).origin ?? ""));
  });
}

function clock(at: number): string {
  return new Date(at).toTimeString().slice(0, 8);
}

/** The newest `count` changes, newest first, as the agent reads them. */
export function history(app: App, id: string, count: number): string {
  const list = changesOf(app, id);
  if (list.length === 0) return "No changes kept yet for this project.";
  const lines = list
    .slice(-count)
    .reverse()
    .map((one) => `- rev ${one.rev}, ${clock(one.at)}, ${one.by === "agent" ? `you (${one.tool ?? "a tool"})` : one.by === "person" ? "the person" : `Edit (${one.by})`}: ${one.what}`);
  return `The newest changes (undo_changes takes their revs):\n${lines.join("\n")}`;
}

/**
 * Takes changes back, as one new revision: `revs` those changes alone (newest
 * first; refused where a later change, not being undone, touched the same
 * thing, so nothing done since is lost), or `backTo` everything after that
 * revision. Answers what was undone.
 */
export async function undo(app: App, id: string, given: { revs?: number[]; backTo?: number }): Promise<string> {
  const live = app.store.get(id);
  if (live === null) throw new Error("no such project");
  const list = changesOf(app, id);
  let chosen: Change[];
  if (given.backTo !== undefined) {
    chosen = list.filter((one) => one.rev > given.backTo!);
    if (chosen.length === 0) throw new Error(`nothing changed after rev ${given.backTo}`);
    const oldest = list[0];
    if (oldest !== undefined && oldest.rev > given.backTo + 1) throw new Error(`changes before rev ${oldest.rev} aren't kept: the furthest back is ${oldest.rev - 1}`);
  } else {
    const wanted = new Set(given.revs ?? []);
    if (wanted.size === 0) throw new Error("give revs (the changes to undo) or back_to (a revision to go back to)");
    chosen = list.filter((one) => wanted.has(one.rev));
    const missing = [...wanted].filter((rev) => !chosen.some((one) => one.rev === rev));
    if (missing.length > 0) throw new Error(`no change kept at rev ${missing.join(", ")}: edit_history lists them`);
    // Each against what came after it and stays: undone over a later change to the same thing, that change would be lost.
    for (const one of chosen) {
      const later = list.filter((other) => other.rev > one.rev && !wanted.has(other.rev) && other.touched.some((name) => one.touched.includes(name)));
      if (later.length > 0) {
        throw new Error(`rev ${one.rev} can't be undone alone: rev ${later.map((other) => `${other.rev} (${other.by === "agent" ? "you" : other.by})`).join(", ")} changed the same ${later[0]!.touched.filter((name) => one.touched.includes(name)).slice(0, 4).join(", ")} since. Undo those with it, or go back_to ${one.rev - 1}`);
      }
    }
  }
  const newestFirst = [...chosen].sort((a, b) => b.rev - a.rev);
  await app.store.update(id, "agent", (project) => {
    let restored: Project = project;
    for (const one of newestFirst) restored = patches.apply(restored, one.undo);
    for (const key of Object.keys(project) as (keyof Project)[]) if (!(key in restored)) delete project[key];
    Object.assign(project, restored);
  }, app.store.get(id) ?? undefined);
  return `Undone: ${newestFirst.map((one) => `rev ${one.rev} (${one.what})`).join("; ")}. It's one new change: undo_changes takes it back too.`;
}

/** Tests: forget what's kept in memory (the files stay). */
export function forgetForTests(): void {
  kept.clear();
}
