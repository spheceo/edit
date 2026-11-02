// When this Mac last had each project open (`<home>/opened.json`, project id
// to ms since 1970), so the cache keeps the footage of the projects worked on
// lately and lets the others' go first (cache_cleanup.ts). The editor says a
// project is open when it opens it and every 30 s after (cloud_projects.ts
// `postOpen`); a write at most once a minute a project.

import * as fs from "node:fs";

import { readState, writeAtomic } from "./files.ts";
import { join } from "./paths.ts";

/** Writes of the same project's time closer together than this are skipped. */
const EVERY_MS = 60_000;

const known = new Map<string, Record<string, number>>();

const file = (home: string) => join(home, "opened.json");

/** Every project's last open here (none: never, or before Nov 2). */
export function openedTimes(home: string): Record<string, number> {
  const cached = known.get(home);
  if (cached !== undefined) return cached;
  const saved = readState(file(home));
  const times: Record<string, number> = {};
  if (typeof saved === "object" && saved !== null) {
    for (const [id, at] of Object.entries(saved as Record<string, unknown>)) if (typeof at === "number" && Number.isFinite(at)) times[id] = at;
  }
  known.set(home, times);
  return times;
}

/** `id` is open in the editor now. */
export function markOpened(home: string, id: string, now = Date.now()): void {
  if (id === "" || home.trim() === "") return;
  const times = openedTimes(home);
  if (now - (times[id] ?? 0) < EVERY_MS) return;
  times[id] = now;
  try {
    fs.mkdirSync(home, { recursive: true });
    writeAtomic(file(home), JSON.stringify(times));
  } catch {
    // Kept in memory; written with the next one.
  }
}

/** For tests: forget what was read. */
export function forget(home: string): void {
  known.delete(home);
}
