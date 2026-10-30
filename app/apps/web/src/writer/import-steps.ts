import type { ImportProgress } from "./types";

/** An import's steps, in order, as imports.ts reports them (its stage, and the words of its detail). */
export const STEPS: { key: string; label: string; hint: string }[] = [
  { key: "download", label: "Download", hint: "The footage comes down from YouTube, Drive or this Mac." },
  { key: "preview", label: "Preview", hint: "Joined into one timeline and cut to a 480p preview the editors play." },
  { key: "research", label: "Research", hint: "The article and any case files are read for names and facts." },
  { key: "transcribe", label: "Transcribe", hint: "Every recording is heard and its words timed." },
  { key: "watch", label: "Check speakers", hint: "The footage is watched to check who says each line. Saved checks are reused after a restart." },
  { key: "speakers", label: "Name speakers", hint: "Each voice gets a name or a role." },
];

export function stepOf(item: Pick<ImportProgress, "stage" | "detail">): string {
  const said = `${item.stage} ${item.detail}`.toLowerCase();
  if (/who speaks|saved checks/.test(said)) return "watch";
  if (/naming the speakers|speaker/.test(said)) return "speakers";
  if (/transcrib|hearing|who speaks|heard/.test(said)) return "transcribe";
  if (/research|pdf|article|case file/.test(said)) return "research";
  if (/preview|joining|cutting|processing/.test(said)) return "preview";
  return "download";
}

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s` : `${seconds} s`;
}

/**
 * An import's percentage as shown: what the server says, crept forward while
 * it says the same thing (a long step, like joining a 10-hour preview, reports
 * no progress of its own), so it never sits still (the user, Oct 30: "we always
 * get stuck at 60% visually", then "now we're kinda stuck on 67"). It slows as
 * it goes but never stops: about 3 points in the first minute, 7 by five, 12 by
 * twenty, never past 99 and never back. A new number from the server carries on
 * from whichever is further.
 */
const CREEP = new Map<string, { said: number; from: number; since: number; shown: number }>();
const SCALE = 4;
const MINUTE = 60_000;
/** Kept on this browser, so a reload carries on rather than dropping back to the server's number. */
const KEPT = "edit.import.creep";
function kept(id: string): { said: number; from: number; since: number; shown: number } | undefined {
  try {
    const one = (JSON.parse(localStorage.getItem(KEPT) ?? "{}") as Record<string, { said: number; from: number; since: number }>)[id];
    return one === undefined ? undefined : { ...one, shown: one.from };
  } catch {
    return undefined;
  }
}
function keep(id: string, entry: { said: number; from: number; since: number }): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEPT) ?? "{}") as Record<string, { said: number; from: number; since: number }>;
    all[id] = entry;
    // Only the last few imports.
    const ids = Object.keys(all).slice(-12);
    localStorage.setItem(KEPT, JSON.stringify(Object.fromEntries(ids.map((key) => [key, all[key]]))));
  } catch {
    // Private mode or full: kept for this page only.
  }
}
export function creeping(id: string, said: number, now = Date.now()): number {
  let seen = CREEP.get(id);
  if (seen === undefined) {
    seen = kept(id);
    if (seen !== undefined) CREEP.set(id, seen);
  }
  if (seen === undefined || seen.said !== said) {
    const from = Math.max(said, seen?.shown ?? 0);
    CREEP.set(id, { said, from, since: now, shown: from });
    keep(id, { said, from, since: now });
    return from;
  }
  seen.shown = Math.min(99, Math.max(seen.shown, seen.from + SCALE * Math.log1p((now - seen.since) / MINUTE)));
  return seen.shown;
}
