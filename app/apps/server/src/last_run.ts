// Whether the last run of this Edit quit, and if not, why it stopped (JJ's
// Mac, Nov 6: the server stopped twice in two hours with nothing in its log;
// Edit.app's window started it again and nobody could say why). A run marks
// itself running in `<home>/logs/running.json` and clears that when it quits;
// the next start finds a mark left by another process and says so in the log,
// with macOS's crash report for it when there is one (a native crash, a Bun
// panic, or the system stopping it for memory). An update's restart execs in
// place: the same process, so not a stop.

import * as fs from "node:fs";
import * as os from "node:os";

import * as diag from "./diag.ts";
import { join } from "./paths.ts";
import { BUILD } from "./version.ts";

type Mark = { pid: number; started: number; build: string };

const MARK = "running.json";

let marked: string | null = null;

/** Notes this run as running, after saying in the log how the one before it ended, if it didn't quit. */
export function begin(home: string, reports = join(os.homedir(), "Library", "Logs", "DiagnosticReports")): void {
  const path = join(home, "logs", MARK);
  let last: Mark | null = null;
  try {
    const value = JSON.parse(fs.readFileSync(path, "utf8")) as Partial<Mark>;
    if (typeof value.pid === "number" && typeof value.started === "number") last = { pid: value.pid, started: value.started, build: String(value.build ?? "") };
  } catch {
    // None: the last run quit (or this is the first).
  }
  if (last !== null && last.pid !== process.pid) {
    const crash = crashOf(reports, last.pid, last.started);
    diag.error(
      "edit",
      `the last run (${last.build}, started ${diag.stamp(last.started)}) stopped without quitting: ${crash ?? "macOS kept no crash report for it (stopped from outside, or the Mac restarted)"}`,
    );
  }
  try {
    fs.mkdirSync(join(home, "logs"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path, JSON.stringify({ pid: process.pid, started: Date.now(), build: BUILD } satisfies Mark), { mode: 0o600 });
    marked = path;
  } catch (error) {
    diag.warn("edit", `couldn't mark this run as running: ${diag.messageOf(error)}`);
  }
}

/** This run is quitting: not a stop to report next time. */
export function quitting(): void {
  if (marked === null) return;
  fs.rmSync(marked, { force: true });
  marked = null;
}

process.on("exit", quitting);

/**
 * What macOS's report for process `pid` (since `since`) says stopped it: the
 * exception, what raised it and the first frames of the thread that crashed,
 * or the reason it was stopped for memory. Null when there's none.
 */
export function crashOf(reports: string, pid: number, since: number): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(reports).filter((name) => name.endsWith(".ips"));
  } catch {
    return null;
  }
  for (const name of names.sort().reverse()) {
    const path = join(reports, name);
    try {
      if (fs.statSync(path).mtimeMs < since) continue;
      const text = fs.readFileSync(path, "utf8");
      const body = JSON.parse(text.slice(text.indexOf("\n") + 1)) as Report;
      const said = name.startsWith("JetsamEvent") ? jetsam(body, pid) : body.pid === pid ? crash(body) : null;
      if (said !== null) return `${said} (${name})`;
    } catch {
      // Not a report this can read.
    }
  }
  return null;
}

type Frame = { imageIndex?: number; imageOffset?: number; symbol?: string };
type Report = {
  pid?: number;
  exception?: { type?: string; signal?: string };
  termination?: { indicator?: string };
  asi?: Record<string, string[]>;
  faultingThread?: number;
  threads?: { frames?: Frame[] }[];
  usedImages?: { name?: string }[];
  processes?: { pid?: number; name?: string; reason?: string }[];
};

function crash(body: Report): string {
  const what = [body.exception?.type, body.exception?.signal].filter(Boolean).join(" ");
  const why = Object.values(body.asi ?? {}).flat().join("; ");
  const all = body.threads?.[body.faultingThread ?? 0]?.frames ?? [];
  // The frames of the crash itself: after the signal handler's (Bun's own, on an abort), none of the system's.
  const handled = all.findIndex((frame) => frame.symbol === "_sigtramp");
  const frames = all
    .slice(handled + 1)
    .map((frame) => ({ ...frame, image: frame.imageIndex === undefined ? undefined : body.usedImages?.[frame.imageIndex]?.name }))
    .filter((frame) => !/^libsystem_/u.test(frame.image ?? ""))
    .slice(0, 6)
    // A release build has no symbols: its offset, for atos against that build.
    .map((frame) => `${frame.symbol ?? (frame.imageOffset === undefined ? "?" : `+0x${frame.imageOffset.toString(16)}`)} in ${frame.image ?? "?"}`);
  return [what || (body.termination?.indicator ?? "crashed"), why, frames.length > 0 ? `at ${frames.join(" < ")}` : ""].filter(Boolean).join("; ");
}

function jetsam(body: Report, pid: number): string | null {
  // Every process is listed; the ones it stopped have a reason.
  const it = body.processes?.find((process) => process.pid === pid && process.reason !== undefined);
  return it === undefined ? null : `macOS stopped it for memory (${it.reason})`;
}
