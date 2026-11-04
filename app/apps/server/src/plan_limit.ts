// The person's Claude plan running out (Nov 4: JJ's Max plan said "You've hit
// your 5-hour limit · resets 11:50pm (Asia/Dubai)" 155 times in an hour, the
// watcher and the script jobs each asking again into it). Every Claude Code
// call goes through here: once one hears the plan is used up, the rest wait
// for its reset instead of asking, then carry on by themselves. A reset days
// away (a weekly limit) isn't waited for: the work stops and says when.

import * as claudeUsage from "./claude_usage.ts";
import * as diag from "./diag.ts";

/** Waited for at most this long; a later reset fails the work instead. */
export const MAX_WAIT_MS = 6 * 60 * 60_000;
/** A limit whose reset couldn't be read: asked again after this. */
const UNKNOWN_WAIT_MS = 15 * 60_000;
/** After the reset, a moment for Anthropic's side to agree. */
const AFTER_RESET_MS = 60_000;

let limited: { until: number; said: string } | null = null;

/** Whether Claude Code said the plan is used up (not busy: a rate limit passes in a minute). */
export function isLimit(said: string): boolean {
  if (/rate.?limit|output (token|limit)|max.?turns|maximum number of turns/i.test(said)) return false;
  return /\bhit your\b[^.]*\blimit|usage limit|limit (?:will )?reset|limit reached|out of (?:extra )?usage/i.test(said);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A wall-clock time in `zone` as if it were UTC, for working out the zone's offset. */
function wallMs(at: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

/** When the plan comes back, from "resets 11:50pm (Asia/Dubai)" or "resets Nov 7, 9am (…)"; null when it doesn't say. */
export function resetOf(said: string, now: number = Date.now()): number | null {
  const found = /resets?\s+(?:at\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i.exec(said);
  if (found === null) return null;
  const [, month, day, hour, minute, half, named] = found;
  let zone = named?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  const offset = wallMs(now, zone) - now;
  const wallNow = new Date(now + offset);
  let h = Number(hour) % 12;
  if (half!.toLowerCase() === "pm") h += 12;
  const m = minute === undefined ? 0 : Number(minute);
  const monthIndex = month === undefined ? -1 : MONTHS.indexOf(month.toLowerCase());
  if (month !== undefined && monthIndex < 0) return null;
  let year = wallNow.getUTCFullYear();
  let wall = monthIndex < 0
    ? Date.UTC(year, wallNow.getUTCMonth(), wallNow.getUTCDate(), h, m)
    : Date.UTC(year, monthIndex, Number(day), h, m);
  // A time already past today is tomorrow's; a date already past is next year's.
  if (wall <= wallNow.getTime()) {
    if (monthIndex < 0) wall += 24 * 60 * 60_000;
    else wall = Date.UTC(++year, monthIndex, Number(day), h, m);
  }
  return wall - offset;
}

/** Notes what Claude Code said when the plan ran out; the other calls wait from now. */
export function note(said: string, now: number = Date.now()): void {
  claudeUsage.limitHit(now);
  const until = (resetOf(said, now) ?? now + UNKNOWN_WAIT_MS) + AFTER_RESET_MS;
  if (limited !== null && limited.until >= until) return;
  limited = { until, said };
  diag.warn("claude", `the Claude plan is used up ("${said.slice(0, 160)}"): Claude's work waits until ${new Date(until).toLocaleString()}, then carries on`);
}

/** The plan is used up until this time (ms), or null. */
export function until(now: number = Date.now()): number | null {
  if (limited !== null && limited.until <= now) limited = null;
  return limited?.until ?? null;
}

/** What the person sees when the work won't wait (a reset too far off). */
export function tooLong(until: number): string {
  return `Your Claude plan is used up until ${new Date(until).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}. Nothing was changed; start it again then.`;
}

/** Waits while the plan is used up (stopped by `signal`); throws `tooLong`'s words when the reset is too far off. */
export async function room(signal?: AbortSignal): Promise<void> {
  for (;;) {
    const now = Date.now();
    const at = until(now);
    if (at === null) return;
    if (at - now > MAX_WAIT_MS) throw new Error(tooLong(at));
    if (signal?.aborted) throw new Error("Stopped.");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, Math.min(at - now, 60_000));
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Stopped."));
      }, { once: true });
    });
  }
}

/** Tests start clear. */
export function reset(): void {
  limited = null;
}
