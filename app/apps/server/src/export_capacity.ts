// How many exports this Mac renders at once (Sphe, Nov 2: "setup a system
// where if theres enough capacity, we export on the mac many if not we que").
// One at a time was the rule since Nov 2's stall: two whole renders started
// side by side on JJ's M4 Pro, and its encoder stalled. Measured the same day
// (off Modal, step 3): an Apple chip has one video encode engine (M1–M4 and
// their Pros), two on a Max, four on an Ultra, and two exports on one engine
// share it, each going half as fast: a slot for every 12 GB of memory, the
// rule until then, counted the wrong thing. Now one export per encode engine (`encodeEngines`,
// from the chip's name; EDIT_LOCAL_EXPORTS overrides), and another starts
// beside the ones running only while the Mac has room for it too:
//
//   - memory macOS calls available (`kern.memorystatus_level`, its own measure:
//     the free-pages count says "0.1 GB free" on a Mac with half its memory
//     to give) at least 35%, and at least 6 GB of it;
//   - the CPU not already busy (the minute's load under three quarters of the
//     cores).
//
// Otherwise it waits in line, saying what for ("waiting for the encoder"), and
// is looked at again as the room changes. An export running alone has the Mac
// to itself: background FFmpeg (previews, smoothing) and smooth playback
// renders stop while any export runs.

import { spawnSync } from "node:child_process";
import * as os from "node:os";

const GB = 1024 ** 3;

export interface Machine {
  /** The chip's name: "Apple M4 Pro". */
  chip: string;
  totalBytes: number;
  cores: number;
  /** The share of memory the system calls available, 0–100; null when it can't be read. */
  availablePercent(): number | null;
  /** The last minute's load average. */
  load(): number;
}

export const machine: Machine = {
  chip: chipName(),
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

function chipName(): string {
  if (process.platform === "darwin") {
    const read = spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8", timeout: 2000 });
    const name = (read.stdout ?? "").trim();
    if (name !== "") return name;
  }
  return os.cpus()[0]?.model ?? "";
}

/** The video encode engines of a chip by its name: an Ultra four, a Max two, any other one (Apple's M1–M4, their Pros, and any chip not Apple's). */
export function encodeEngines(chip: string): number {
  if (/\bUltra\b/i.test(chip)) return 4;
  if (/\bMax\b/i.test(chip)) return 2;
  return 1;
}

/** The most exports this Mac renders at once: one per encode engine. */
export function mostAtOnce(given: Machine = machine, env: Record<string, string | undefined> = process.env): number {
  const set = Number.parseInt(env.EDIT_LOCAL_EXPORTS ?? "", 10);
  if (Number.isInteger(set) && set >= 1) return Math.min(set, 6);
  return encodeEngines(given.chip);
}

/** Why another export can't start beside the `running` ones now (null: it can). */
export function noRoom(running: number, given: Machine = machine, env: Record<string, string | undefined> = process.env): string | null {
  if (running === 0) return null;
  const most = mostAtOnce(given, env);
  if (running >= most) return most === 1 ? "waiting for the encoder (this Mac has one)" : `waiting for an encoder (this Mac has ${most})`;
  const percent = given.availablePercent();
  if (percent === null) return "this Mac's free memory can't be read";
  const available = (percent / 100) * given.totalBytes;
  if (percent < 35 || available < 6 * GB) return `waiting for memory (${Math.round(percent)}% free, ${(available / GB).toFixed(1)} GB)`;
  const busy = given.load() / Math.max(1, given.cores);
  if (busy > 0.75) return `waiting for the Mac to be less busy (load ${given.load().toFixed(1)} on ${given.cores} cores)`;
  return null;
}

/** How the Mac stood when an export started beside others, for the log. */
export function standing(given: Machine = machine): string {
  const percent = given.availablePercent();
  return `${percent === null ? "?" : Math.round(percent)}% memory free, load ${given.load().toFixed(1)} on ${given.cores} cores`;
}
