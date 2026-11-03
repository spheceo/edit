// How long the agent has spent on each edit (JJ, Nov 3: "Is it possible to
// get some kind of tracker on how long each edit takes? … this one I'm doing
// right now is a interro compilation. I think it's been taking well over an
// hour so far."). Read from a project's chat (`<id>.chat.json`): every turn's
// work added up (the workflow, its automatic follow-ups, a turn carried on
// after a restart), never the waits between turns, and where the tools' time
// went. The page shows the total over the agent panel (AgentPanel's
// EditTime); each Mac's report lists its recent edits (remote_actions.ts), so
// the team's edit times can be compared without asking.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";

interface Entry {
  kind?: string;
  tool?: string;
  text?: string;
  at?: string | number;
  updated?: string | number;
}

export interface EditTime {
  /** Every turn's work added up (ms). */
  workedMs: number;
  turns: number;
  /** The longest turn (ms). */
  longestMs: number;
  /** Time in tools, overlapping calls counted once (ms); the rest is the model's. */
  toolMs: number;
  /** The tools that took longest in all: [name, ms, calls], longest first. */
  tools: [string, number, number][];
  /** When the last turn began (ms since 1970). */
  lastAt: number;
}

const ms = (value: string | number | undefined): number => (value === undefined ? 0 : Number(value) || 0);

/** Overlapping spans counted once. */
function covered(spans: [number, number][]): number {
  let total = 0;
  let [from, to] = [Number.NaN, Number.NaN];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (Number.isNaN(from) || start > to) {
      if (!Number.isNaN(from)) total += to - from;
      [from, to] = [start, end];
    } else to = Math.max(to, end);
  }
  return Number.isNaN(from) ? total : total + to - from;
}

/** The agent's time on a chat's entries. */
export function editTime(entries: Entry[]): EditTime {
  const turns: Entry[][] = [];
  for (const entry of entries) {
    if (entry.kind === "user" || turns.length === 0) turns.push([]);
    turns.at(-1)!.push(entry);
  }
  let workedMs = 0;
  let longestMs = 0;
  let counted = 0;
  let lastAt = 0;
  const spans: [number, number][] = [];
  const byTool = new Map<string, [number, number]>();
  for (const turn of turns) {
    const start = ms(turn[0]!.at);
    const end = Math.max(...turn.map((entry) => Math.max(ms(entry.updated), ms(entry.at))));
    if (turn.length < 2 || end <= start) continue;
    workedMs += end - start;
    longestMs = Math.max(longestMs, end - start);
    counted += 1;
    lastAt = Math.max(lastAt, start);
    for (const entry of turn) {
      if (entry.kind !== "tool" || entry.tool === undefined) continue;
      const [from, to] = [ms(entry.at), Math.max(ms(entry.updated), ms(entry.at))];
      spans.push([from, to]);
      const had = byTool.get(entry.tool) ?? [0, 0];
      byTool.set(entry.tool, [had[0] + (to - from), had[1] + 1]);
    }
  }
  const tools = [...byTool].map(([name, [spent, calls]]): [string, number, number] => [name, spent, calls]).sort((a, b) => b[1] - a[1]);
  return { workedMs, turns: counted, longestMs, toolMs: covered(spans), tools, lastAt };
}

/** A project's chat's agent time, or null without one. */
export function ofProject(app: App, id: string): EditTime | null {
  try {
    const chat = JSON.parse(fs.readFileSync(app.store.chatPath(id), "utf8")) as { entries?: Entry[] };
    return Array.isArray(chat.entries) ? editTime(chat.entries) : null;
  } catch {
    return null;
  }
}

/**
 * The report's lines: each project the agent worked on in the last `days`,
 * newest first: its agent time, turns, the longest, the model's share and
 * the tools that took longest.
 */
export function reportLines(app: App, days = 7, now = Date.now()): string[] {
  const out: [number, string][] = [];
  for (const { id, name } of app.store.list()) {
    const time = ofProject(app, id);
    if (time === null || time.turns === 0 || now - time.lastAt > days * 86_400_000) continue;
    const tools = time.tools.slice(0, 4).map(([tool, spent, calls]) => `${tool} ${diag.human(spent)} ×${calls}`).join(", ");
    out.push([
      time.lastAt,
      `${id} "${name}": ${diag.human(time.workedMs)} over ${time.turns} turn(s), the longest ${diag.human(time.longestMs)}; tools ${diag.human(time.toolMs)}, the model the rest${tools === "" ? "" : ` (${tools})`}`,
    ]);
  }
  return out.sort((a, b) => b[0] - a[0]).map(([, line]) => line);
}
