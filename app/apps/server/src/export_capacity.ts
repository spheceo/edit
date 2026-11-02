// How many exports this Mac renders at once (Sphe, Nov 2: "setup a system
// where if theres enough capacity, we export on the mac many if not we que";
// JJ's M4 Pro had refused Modal exports waiting in line behind each other).
// One at a time was the rule since Nov 2's stall: two whole renders started
// side by side on JJ's Mac with no check at all, and its encoder stalled. Now
// another starts beside the ones running only while the Mac has room for it:
//
//   - at most `mostAtOnce`: one per 12 GB of memory, one to three (an 8 or 16
//     GB Mac, one; JJ's 24 GB M4 Pro, two); EDIT_LOCAL_EXPORTS overrides;
//   - memory macOS calls available (`kern.memorystatus_level`, its own measure:
//     the free-pages count says "0.1 GB free" on a Mac with half its memory
//     to give) at least 35%, and at least 6 GB of it;
//   - the CPU not already busy (the minute's load under three quarters of the
//     cores).
//
// Otherwise it waits in line and is looked at again as the room changes. An
// export running alone has the Mac to itself: background FFmpeg (previews,
// smoothing) and smooth playback renders stop while any export runs.

import { spawnSync } from "node:child_process";
import * as os from "node:os";

const GB = 1024 ** 3;

export interface Machine {
  totalBytes: number;
  cores: number;
  /** The share of memory the system calls available, 0–100; null when it can't be read. */
  availablePercent(): number | null;
  /** The last minute's load average. */
  load(): number;
}

export const machine: Machine = {
  totalBytes: os.totalmem(),
  cores: os.cpus().length,
  availablePercent: () => {
    if (process.platform !== "darwin") return (os.freemem() / os.totalmem()) * 100;
    const read = spawnSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8", timeout: 2000 });
    const level = Number.parseInt(read.stdout ?? "", 10);
    return Number.isFinite(level) && level >= 0 && level <= 100 ? level : null;
  },
  load: () => os.loadavg()[0] ?? 0,
};

/** The most exports this Mac renders at once. */
export function mostAtOnce(given: Machine = machine, env: Record<string, string | undefined> = process.env): number {
  const set = Number.parseInt(env.EDIT_LOCAL_EXPORTS ?? "", 10);
  if (Number.isInteger(set) && set >= 1) return Math.min(set, 6);
  return Math.min(3, Math.max(1, Math.floor(given.totalBytes / (12 * GB))));
}

/** Why another export can't start beside the `running` ones now (null: it can). */
export function noRoom(running: number, given: Machine = machine, env: Record<string, string | undefined> = process.env): string | null {
  if (running === 0) return null;
  const most = mostAtOnce(given, env);
  if (running >= most) return most === 1 ? "this Mac exports one at a time" : `this Mac exports ${most} at a time`;
  const percent = given.availablePercent();
  if (percent === null) return "this Mac's free memory can't be read";
  const available = (percent / 100) * given.totalBytes;
  if (percent < 35 || available < 6 * GB) return `memory is short (${Math.round(percent)}% free, ${(available / GB).toFixed(1)} GB)`;
  const busy = given.load() / Math.max(1, given.cores);
  if (busy > 0.75) return `the Mac is busy (load ${given.load().toFixed(1)} on ${given.cores} cores)`;
  return null;
}

/** How the Mac stood when an export started beside others, for the log. */
export function standing(given: Machine = machine): string {
  const percent = given.availablePercent();
  return `${percent === null ? "?" : Math.round(percent)}% memory free, load ${given.load().toFixed(1)} on ${given.cores} cores`;
}
