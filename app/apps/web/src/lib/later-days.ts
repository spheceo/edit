// Later's days (Home's Later, lib/later.ts): when something set aside comes
// back, in words; apart from the hook so it's checked on its own.

import type { LaterEntry } from "@edit/types/later";

/** Midnight at the start of the day `days` after `from`'s, here. */
function dayStart(from: Date, days: number): number {
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + days);
  return day.getTime();
}

/** The times something can be set aside until, from `now`, each with its day: tomorrow, Monday (when that isn't tomorrow), a week, and until someone brings it back. */
export function asideChoices(now = new Date()): { label: string; day: string; until: number | null }[] {
  const tomorrow = dayStart(now, 1);
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  const monday = dayStart(now, toMonday);
  const week = dayStart(now, 7);
  const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return [
    { label: "Tomorrow", day: day(tomorrow), until: tomorrow },
    ...(toMonday > 1 ? [{ label: "Monday", day: day(monday), until: monday }] : []),
    { label: "In a week", day: day(week), until: week },
    { label: "Until I bring it back", day: "", until: null },
  ];
}

/** When something comes back, in a word or two: "Tomorrow", "Mon 2 Nov", "No date". */
export function backLabel(until: number | null, now = new Date()): string {
  if (until === null) return "No date";
  if (until <= dayStart(now, 1)) return "Tomorrow";
  return new Date(until).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** Set aside still (not back yet). */
export const asleep = (entry: LaterEntry, now = Date.now()) => entry.until === null || entry.until > now;
