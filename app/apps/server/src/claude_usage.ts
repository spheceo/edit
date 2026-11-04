// What Edit asked of the person's Claude plan, by day (Nov 4: the team's Max
// plans ran out in hours that week, and the log keeps about a day and a half,
// so there was no week to compare with). Each call's API-price cost goes under
// its label ("Claude opus watching footage", "edit chat claude-sonnet-5-5"),
// with the times the plan was used up; the report shows the last week's days.

import * as fs from "node:fs";

import { readState, writeAtomic } from "./files.ts";
import { join } from "./paths.ts";

const FILE = "claude-usage.json";
/** Days kept. */
const KEEP = 30;

interface Day {
  /** label → [dollars at API prices, calls] */
  calls: Record<string, [number, number]>;
  /** Times Claude Code said the plan was used up. */
  limits: number;
}

let home: string | null = null;
let days: Record<string, Day> | null = null;

/** Where the tally is kept (Edit's data folder); nothing is kept until it's given. */
export function use(dir: string): void {
  home = dir;
  days = null;
}

function loaded(): Record<string, Day> | null {
  if (home === null) return null;
  if (days === null) {
    const raw = fs.existsSync(join(home, FILE)) ? readState(join(home, FILE)) : null;
    days = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, Day>) : {};
  }
  return days;
}

/** The local day, as the log writes it. */
function dayOf(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** One label for the same kind of call: no repair turns, no "section 3 of 5". */
export function labelOf(label: string): string {
  return label.replace(/\s*\(repair turn\)/u, "").replace(/\b\d+ of \d+\b/u, "N of N").trim();
}

function save(all: Record<string, Day>): void {
  const kept = Object.keys(all).sort().slice(-KEEP);
  const out = Object.fromEntries(kept.map((day) => [day, all[day]!]));
  days = out;
  try {
    writeAtomic(join(home!, FILE), JSON.stringify(out));
  } catch {
    // Only a tally.
  }
}

function today(all: Record<string, Day>, now: number): Day {
  const key = dayOf(now);
  all[key] ??= { calls: {}, limits: 0 };
  return all[key]!;
}

/** One Claude call's cost (dollars at API prices) under `label`. */
export function record(label: string, usd: number, now: number = Date.now()): void {
  const all = loaded();
  if (all === null) return;
  const day = today(all, now);
  const key = labelOf(label);
  const [spent, calls] = day.calls[key] ?? [0, 0];
  day.calls[key] = [spent + (Number.isFinite(usd) ? usd : 0), calls + 1];
  save(all);
}

/** Claude Code said the plan was used up. */
export function limitHit(now: number = Date.now()): void {
  const all = loaded();
  if (all === null) return;
  today(all, now).limits++;
  save(all);
}

/** The report's lines: each of the last `count` days with use, newest first: its total, the biggest labels, and the limits hit. */
export function reportLines(count = 8, now: number = Date.now()): string[] {
  const all = loaded();
  if (all === null) return [];
  const since = dayOf(now - (count - 1) * 86_400_000);
  return Object.keys(all)
    .filter((day) => day >= since)
    .sort()
    .reverse()
    .map((day) => {
      const { calls, limits } = all[day]!;
      const rows = Object.entries(calls).sort((a, b) => b[1][0] - a[1][0]);
      const total = rows.reduce((sum, [, [usd]]) => sum + usd, 0);
      const top = rows.slice(0, 6).map(([label, [usd, n]]) => `${label} $${usd.toFixed(2)} ×${n}`).join("; ");
      return `${day}: $${total.toFixed(2)} at API prices over ${rows.reduce((sum, [, [, n]]) => sum + n, 0)} calls${top === "" ? "" : ` (${top})`}${limits > 0 ? `; plan used up ${limits}×` : ""}`;
    });
}
