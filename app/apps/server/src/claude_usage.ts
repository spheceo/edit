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
  /** Each call's [end (ms), dollars, how long it ran (ms)], to line Edit's spend up with the plan's meter (plan_use.ts). */
  times?: [number, number, number?][];
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

/** One Claude call's cost (dollars at API prices) under `label`, ending `now` after running `ms`. */
export function record(label: string, usd: number, now: number = Date.now(), ms = 0): void {
  const all = loaded();
  if (all === null) return;
  const day = today(all, now);
  const key = labelOf(label);
  const [spent, calls] = day.calls[key] ?? [0, 0];
  const dollars = Number.isFinite(usd) ? usd : 0;
  day.calls[key] = [spent + dollars, calls + 1];
  (day.times ??= []).push([now, dollars, Math.max(0, Math.round(n(ms)))]);
  save(all);
}

/** Claude Code said the plan was used up. */
export function limitHit(now: number = Date.now()): void {
  const all = loaded();
  if (all === null) return;
  today(all, now).limits++;
  save(all);
}

const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Edit's dollars (at API prices) spent in (from, to]: each call's spread over the time it ran (a 20-minute build spends all along, not at its end). */
export function spentBetween(from: number, to: number): number {
  const all = loaded();
  if (all === null) return 0;
  let sum = 0;
  for (const day of Object.values(all)) {
    for (const [end, usd, ran] of day.times ?? []) {
      const ms = n(ran);
      if (ms <= 0) {
        if (end > from && end <= to) sum += usd;
        continue;
      }
      const overlap = Math.min(end, to) - Math.max(end - ms, from);
      if (overlap > 0) sum += (usd * overlap) / ms;
    }
  }
  return sum;
}

/** The days kept, oldest first: each day's labels as [label, dollars, calls], dearest first, and its limits. */
export function daysKept(): { day: string; rows: [string, number, number][]; limits: number }[] {
  const all = loaded();
  if (all === null) return [];
  return Object.keys(all).sort().map((day) => ({
    day,
    rows: Object.entries(all[day]!.calls).map(([label, [usd, n]]): [string, number, number] => [label, usd, n]).sort((a, b) => b[1] - a[1]),
    limits: all[day]!.limits,
  }));
}
