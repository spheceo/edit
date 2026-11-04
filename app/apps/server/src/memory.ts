// Whether this Mac is short of memory, as macOS judges it (Nov 4: JJ's Mac,
// "0.1 GB free"; the free-pages count says that on any Mac, so it's never the
// measure). macOS's own pressure level is the one Activity Monitor colours:
// normal, warn (yellow), critical (red). The window shows a quiet "Low memory"
// chip in its top bar while it's low, naming the app (other than Edit) using
// the most, so the person can quit it themselves.
//
// Low once the pressure has been yellow for 30 s, or at once when it's red;
// over after a minute back at normal, so a passing spike doesn't flicker it.
// Read every 5 s, only once a window has asked (and only on macOS).
//
//   GET /api/memory   { low: false } | { low: true, critical, app: { name, bytes } | null }

import * as fs from "node:fs";

import type { App } from "./app.ts";
import { json } from "./http/errors.ts";
import type { Router } from "./http/router.ts";
import { appBundle } from "./update.ts";

/** macOS's `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export type Pressure = 1 | 2 | 4;

export interface MemoryState {
  low: boolean;
  critical: boolean;
  /** When the pressure last went above normal (null while normal). */
  raisedAt: number | null;
  /** When it came back to normal while low (null otherwise). */
  calmAt: number | null;
}

export const WARN_FOR_MS = 30_000;
export const CALM_FOR_MS = 60_000;
const READ_EVERY_MS = 5_000;
/** The biggest app is looked up again at most this often while low (`top` takes about half a second). */
const APP_EVERY_MS = 30_000;

export const calm: MemoryState = { low: false, critical: false, raisedAt: null, calmAt: null };

/** The state after reading `pressure` at `now`. */
export function judge(state: MemoryState, pressure: Pressure, now: number): MemoryState {
  if (pressure === 1) {
    if (!state.low) return calm;
    const calmAt = state.calmAt ?? now;
    return now - calmAt >= CALM_FOR_MS ? calm : { low: true, critical: false, raisedAt: null, calmAt };
  }
  const raisedAt = state.raisedAt ?? now;
  const critical = pressure === 4;
  return { low: state.low || critical || now - raisedAt >= WARN_FOR_MS, critical, raisedAt, calmAt: null };
}

export interface BigApp {
  name: string;
  bytes: number;
}

/**
 * The app using the most memory, other than Edit: each process's footprint
 * (`top`'s MEM, what Activity Monitor shows) summed by the outermost `.app` its
 * executable is in (`ps`), so Chrome's helpers count as Chrome. Processes
 * outside an app (Edit's server, Claude Code) aren't named.
 */
export function biggestApp(footprints: string, paths: string, edit: string | null): BigApp | null {
  const used = new Map<number, number>();
  for (const line of footprints.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMG])\+?-?\s*$/.exec(line);
    if (match === null) continue;
    const unit = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[3] as "B" | "K" | "M" | "G"];
    used.set(Number(match[1]), Number(match[2]) * unit);
  }
  const apps = new Map<string, number>();
  for (const line of paths.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match === null) continue;
    const bundle = /^(.*?\.app)(?:\/|$)/.exec(match[2]!)?.[1];
    if (bundle === undefined || bundle === edit) continue;
    apps.set(bundle, (apps.get(bundle) ?? 0) + (used.get(Number(match[1])) ?? 0));
  }
  let best: BigApp | null = null;
  for (const [bundle, bytes] of apps) {
    if (best === null || bytes > best.bytes) best = { name: bundle.slice(bundle.lastIndexOf("/") + 1, -".app".length), bytes };
  }
  return best !== null && best.bytes > 0 ? best : null;
}

async function output(command: string[]): Promise<string> {
  try {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(child.stdout).text();
    await child.exited;
    return text;
  } catch {
    return "";
  }
}

async function readPressure(): Promise<Pressure> {
  const level = Number.parseInt(await output(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"]), 10);
  return level === 4 ? 4 : level === 2 ? 2 : 1;
}

function editBundle(): string | null {
  try {
    return appBundle(fs.realpathSync(process.execPath));
  } catch {
    return null;
  }
}

async function readBiggestApp(): Promise<BigApp | null> {
  const [footprints, paths] = await Promise.all([output(["top", "-l", "1", "-stats", "pid,mem"]), output(["ps", "-axo", "pid=,comm="])]);
  return biggestApp(footprints, paths, editBundle());
}

let state = calm;
let app: BigApp | null = null;
let appAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let reading = false;

async function read(): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    const now = Date.now();
    state = judge(state, await readPressure(), now);
    if (!state.low) {
      app = null;
      appAt = 0;
    } else if (now - appAt >= APP_EVERY_MS) {
      appAt = now;
      app = await readBiggestApp();
    }
  } finally {
    reading = false;
  }
}

export function routes(router: Router<App>): void {
  router.get("/api/memory", async () => {
    if (process.platform !== "darwin") return json({ low: false });
    if (timer === null) {
      await read();
      timer = setInterval(() => void read(), READ_EVERY_MS);
      timer.unref?.();
    }
    return json(state.low ? { low: true, critical: state.critical, app } : { low: false });
  });
}
