// Whether this Mac is short of memory, as macOS judges it (Nov 4: JJ's Mac,
// "0.1 GB free"; the free-pages count says that on any Mac, so it's never the
// measure). macOS's own pressure level is the one Activity Monitor colours:
// normal, warn (yellow), critical (red). The window shows a quiet "Low memory"
// chip in its top bar while it's low, naming the app (other than Edit) using
// the most, so the person can quit it themselves.
//
// Low once the pressure has been yellow for 30 s, or at once when it's red;
// over after a minute back at normal, so a passing spike doesn't flicker it.
// Read every 5 s, only once a window has asked (and only on macOS). Also
// here: what a report says of memory (Edit's part, the biggest apps), and the
// Claude Code questions held to three at once while memory is short.
//
//   GET /api/memory   { low: false } | { low: true, critical, app: { name, bytes } | null }

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
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

/** Each process's footprint (`top`'s MEM, what Activity Monitor shows) by pid. */
export function footprints(text: string): Map<number, number> {
  const used = new Map<number, number>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMG])\+?-?\s*$/.exec(line);
    if (match === null) continue;
    const unit = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[3] as "B" | "K" | "M" | "G"];
    used.set(Number(match[1]), Number(match[2]) * unit);
  }
  return used;
}

/**
 * The apps using the most memory, other than Edit, most first: footprints
 * summed by the outermost `.app` each executable is in (`ps -axo pid=,comm=`),
 * so Chrome's helpers count as Chrome. Processes outside an app (Edit's server,
 * Claude Code) aren't named.
 */
export function biggestApps(top: string, paths: string, edit: string | null, count = 3): BigApp[] {
  const used = footprints(top);
  const apps = new Map<string, number>();
  for (const line of paths.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match === null) continue;
    const bundle = /^(.*?\.app)(?:\/|$)/.exec(match[2]!)?.[1];
    if (bundle === undefined || bundle === edit) continue;
    apps.set(bundle, (apps.get(bundle) ?? 0) + (used.get(Number(match[1])) ?? 0));
  }
  return [...apps]
    .filter(([, bytes]) => bytes > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([bundle, bytes]) => ({ name: bundle.slice(bundle.lastIndexOf("/") + 1, -".app".length), bytes }));
}

/** The app using the most memory, other than Edit (`biggestApps`' first). */
export function biggestApp(top: string, paths: string, edit: string | null): BigApp | null {
  return biggestApps(top, paths, edit, 1)[0] ?? null;
}

/** What Edit's server and the work it runs (its child processes, by kind) use: footprints, from `ps -axo pid=,ppid=,comm=` and `top`. */
export function editUse(top: string, tree: string, server: number): { server: number; parts: { kind: string; count: number; bytes: number }[] } {
  const used = footprints(top);
  const rows = tree.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), comm: match[3]!.trim() }];
  });
  const mine = new Set([server]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) if (!mine.has(row.pid) && mine.has(row.ppid)) { mine.add(row.pid); grew = true; }
  }
  const kinds = new Map<string, { count: number; bytes: number }>();
  for (const row of rows) {
    if (row.pid === server || !mine.has(row.pid)) continue;
    const name = row.comm.slice(row.comm.lastIndexOf("/") + 1);
    const kind = /claude/i.test(row.comm) ? "Claude Code" : /^ff(mpeg|probe)$/.test(name) ? "FFmpeg" : "other";
    const one = kinds.get(kind) ?? { count: 0, bytes: 0 };
    one.count++;
    one.bytes += used.get(row.pid) ?? 0;
    kinds.set(kind, one);
  }
  // Under 50 MB says nothing a reader acts on (caffeinate, a `top`).
  return { server: used.get(server) ?? 0, parts: [...kinds].map(([kind, one]) => ({ kind, ...one })).filter((one) => one.bytes >= 50 * 1024 ** 2).sort((a, b) => b.bytes - a.bytes) };
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** A report's line: "Edit 1.4 GB (server 0.6 GB · Claude Code ×3 0.7 GB · FFmpeg ×2 0.1 GB) · biggest apps: Google Chrome 9.4 GB, Slack 1.1 GB". */
export function useLine(use: ReturnType<typeof editUse>, apps: BigApp[]): string {
  const total = use.server + use.parts.reduce((sum, one) => sum + one.bytes, 0);
  const parts = [`server ${gb(use.server)}`, ...use.parts.map((one) => `${one.kind}${one.count > 1 ? ` ×${one.count}` : ""} ${gb(one.bytes)}`)];
  const biggest = apps.length === 0 ? "" : ` · biggest apps: ${apps.map((app) => `${app.name} ${gb(app.bytes)}`).join(", ")}`;
  return `Edit ${gb(total)} (${parts.join(" · ")})${biggest}`;
}

/** This Mac's memory use for a report (macOS only; null elsewhere or when it can't be read). */
export async function useNow(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const [top, tree] = await Promise.all([output(["top", "-l", "1", "-stats", "pid,mem"]), output(["ps", "-axo", "pid=,ppid=,comm="])]);
  if (top === "" || tree === "") return null;
  const paths = tree.replace(/^(\s*\d+)\s+\d+/gm, "$1");
  return useLine(editUse(top, tree, process.pid), biggestApps(top, paths, editBundle()));
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
  const [top, paths] = await Promise.all([output(["top", "-l", "1", "-stats", "pid,mem"]), output(["ps", "-axo", "pid=,comm="])]);
  return biggestApp(top, paths, editBundle());
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

// ── Claude Code while memory is short ──
//
// Each Claude Code process takes 150–330 MB (measured Nov 4: 150 MB fresh,
// 200–330 MB after a long session), and a fast script build starts eight at
// once, beside the agent, Ideas and Thumbnails. On a Mac that macOS already
// calls short (yellow or red), that's what tips it into swapping, which
// slows everything on it, playback and exports too. So while it's short,
// Script mode's, Ideas' and Thumbnails' questions (writer/claude.ts `ask`)
// start at most three at a time; the rest start as those end. With memory to
// spare nothing waits. The edit agent's own turn never waits here.

/** Claude Code processes at once while memory is short. */
export const CLAUDE_WHEN_SHORT = 3;
/** How often a question waiting looks again (memory may have come back). */
const CLAUDE_LOOK_MS = 5_000;

export const claudeGate = { pressure: readPressure, lookMs: CLAUDE_LOOK_MS };
let claudes = 0;
let woken: (() => void)[] = [];

/** Running Claude Code questions (for tests and reports). */
export const claudesRunning = (): number => claudes;

/**
 * A place for one Claude Code question: at once when memory isn't short or
 * fewer than three run, else when one ends or memory comes back. Call the
 * release when the question ends (once). `label` names it in the log.
 */
export async function claudeTurn(label: string, signal?: AbortSignal): Promise<() => void> {
  let said = false;
  while (claudes >= CLAUDE_WHEN_SHORT && (await claudeGate.pressure()) !== 1) {
    if (signal?.aborted) throw new Error("stopped");
    if (!said) {
      said = true;
      diag.info("memory", `${label}: waiting to start, as ${claudes} Claude Code questions are running and macOS says memory is short`);
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, claudeGate.lookMs);
      woken.push(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
  if (signal?.aborted) throw new Error("stopped");
  claudes++;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    claudes--;
    const waiting = woken;
    woken = [];
    for (const wake of waiting) wake();
  };
}
