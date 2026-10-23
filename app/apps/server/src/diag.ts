// Diagnostics: what Edit did, what went wrong and how long things took, so a
// user can hand over one report when something breaks (the UI's "Report a
// problem"). Recent lines stay in memory; everything also goes to
// `~/.edit/logs/edit.log` (rotated), so it survives a crash.

import * as fs from "node:fs";

import { join } from "./paths.ts";
import { BUILD } from "./version.ts";

/** Lines kept in memory for the report. */
const KEEP = 2000;
/** The log file is set aside (as edit.log.1) when it grows past this. */
const ROTATE_BYTES = 8 << 20;
/** Durations kept per operation, for its median. */
const RECENT = 64;
/** Finished work slower than this is logged even when it went fine. */
const SLOW_MS = 2000;

export type Level = "info" | "warn" | "error";

export interface Line {
  /** Milliseconds since the Unix epoch. */
  at: number;
  level: Level;
  /** What it's about: "http", "media", "export", "agent", "ui", … */
  area: string;
  message: string;
}

interface Stat {
  count: number;
  failed: number;
  totalMs: number;
  maxMs: number;
  recent: number[];
}

/** One operation's timings, for the report. */
export interface Timing {
  name: string;
  count: number;
  failed: number;
  total_ms: number;
  median_ms: number;
  max_ms: number;
}

const state = {
  lines: [] as Line[],
  timings: new Map<string, Stat>(),
  file: null as { path: string; fd: number } | null,
  started: performance.now(),
};

/** Starts writing to `<home>/logs/edit.log`. */
export function open(home: string): void {
  const dir = join(home, "logs");
  const path = join(dir, "edit.log");
  try {
    // Private to this user: the log names projects, people and what they said (the audit, Oct 23).
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const fd = fs.openSync(path, "a", 0o600);
    fs.chmodSync(path, 0o600);
    if (state.file !== null) fs.closeSync(state.file.fd);
    state.file = { path, fd };
  } catch (error) {
    console.error(`edit: can't write ${path}: ${(error as Error).message}`);
  }
  info("edit", `started ${BUILD} (${osName()} ${archName()})`);
}

/** Rust's names for the OS and architecture (std::env::consts), so reports read the same. */
export function osName(): string {
  return process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
}

export function archName(): string {
  return process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
}

export function log(level: Level, area: string, message: string): void {
  const line: Line = { at: Date.now(), level, area, message };
  // Problems still show in the terminal running Edit.
  if (level !== "info") console.error(`${stamp(line.at)} edit: ${line.area}: ${line.message}`);
  writeFile(line);
  if (state.lines.length >= KEEP) state.lines.shift();
  state.lines.push(line);
}

export function info(area: string, message: string): void {
  log("info", area, message);
}

export function warn(area: string, message: string): void {
  log("warn", area, message);
}

export function error(area: string, message: string): void {
  log("error", area, message);
}

/** A moment as this Mac's local time, to the millisecond: 2026-10-22 21:23:05.123. */
export function stamp(at: number): string {
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function writeFile(line: Line): void {
  const file = state.file;
  if (file === null) return;
  const level = line.level === "info" ? "INFO" : line.level === "warn" ? "WARN" : "ERROR";
  try {
    fs.writeSync(file.fd, `${stamp(line.at)} ${level} [${line.area}] ${line.message}\n`);
    if (fs.fstatSync(file.fd).size > ROTATE_BYTES) {
      fs.renameSync(file.path, `${file.path}.1`);
      const fresh = fs.openSync(file.path, "a");
      fs.closeSync(file.fd);
      file.fd = fresh;
    }
  } catch {
    // A full disk mustn't take the server down with it.
  }
}

/** Records that `name` took `ms`, and logs it if it failed or was slow. */
export function record(area: string, name: string, ms: number, failure?: string | null): void {
  let stat = state.timings.get(name);
  if (stat === undefined) {
    stat = { count: 0, failed: 0, totalMs: 0, maxMs: 0, recent: [] };
    state.timings.set(name, stat);
  }
  stat.count += 1;
  stat.totalMs += ms;
  stat.maxMs = Math.max(stat.maxMs, ms);
  if (failure !== undefined && failure !== null) stat.failed += 1;
  if (stat.recent.length >= RECENT) stat.recent.shift();
  stat.recent.push(ms);
  if (failure !== undefined && failure !== null) error(area, `${name} failed after ${human(ms)}: ${failure}`);
  else if (ms >= SLOW_MS) info(area, `${name} took ${human(ms)}`);
}

/** The text an error shows: its message (a thrown string as it is). */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Times `work`, recording it under `name` (failed if it throws); the log line
 * names what it worked on (a file, a project).
 */
export function timeOn<T>(area: string, name: string, subject: string, work: () => T): T {
  const started = performance.now();
  try {
    const result = work();
    record(area, name, performance.now() - started, null);
    return result;
  } catch (thrown) {
    record(area, name, performance.now() - started, `${subject}: ${messageOf(thrown)}`);
    throw thrown;
  }
}

/** `timeOn` for async work. */
export async function timeOnAsync<T>(area: string, name: string, subject: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const result = await work();
    record(area, name, performance.now() - started, null);
    return result;
  } catch (thrown) {
    record(area, name, performance.now() - started, `${subject}: ${messageOf(thrown)}`);
    throw thrown;
  }
}

/** Times async work, recording it under `name`. */
export async function timeAsync<T>(area: string, name: string, work: Promise<T> | (() => Promise<T>)): Promise<T> {
  const started = performance.now();
  try {
    const result = await (typeof work === "function" ? work() : work);
    record(area, name, performance.now() - started, null);
    return result;
  } catch (thrown) {
    record(area, name, performance.now() - started, messageOf(thrown));
    throw thrown;
  }
}

/** "850 ms", "12.4 s", "3 min 05 s". */
export function human(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, "0")} s`;
}

/** The most recent lines (oldest first). */
export function lines(limit: number): Line[] {
  return state.lines.slice(Math.max(state.lines.length - limit, 0)).map((line) => ({ ...line }));
}

/** Every operation timed so far, the most time spent first. */
export function timings(): Timing[] {
  const out: Timing[] = [];
  for (const [name, stat] of state.timings) {
    const recent = [...stat.recent].sort((a, b) => a - b);
    out.push({
      name,
      count: stat.count,
      failed: stat.failed,
      total_ms: Math.round(stat.totalMs),
      median_ms: Math.round(recent[Math.floor(recent.length / 2)] ?? 0),
      max_ms: Math.round(stat.maxMs),
    });
  }
  return out.sort((a, b) => b.total_ms - a.total_ms);
}

/** Milliseconds since the server started. */
export function uptime(): number {
  return performance.now() - state.started;
}

/**
 * `text` with every URL replaced: presigned URLs are credentials, never shown
 * or logged (native lines and errors go through it).
 */
export function scrub(text: string): string {
  let out = "";
  let rest = text;
  for (;;) {
    const at = ["https://", "http://"]
      .map((scheme) => rest.indexOf(scheme))
      .filter((index) => index >= 0)
      .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
    if (at === Number.POSITIVE_INFINITY) break;
    out += `${rest.slice(0, at)}<url>`;
    const tail = rest.slice(at);
    const end = tail.search(/[\s'"<>]/u);
    rest = end < 0 ? "" : tail.slice(end);
  }
  return out + rest;
}

/** Where native log lines go (`native.init({log})`): logged, scrubbed, timings kept. */
export function nativeLog(
  line:
    | { level: Level; area: string; message: string }
    | { timing: true; area: string; name: string; ms: number; failure?: string },
): void {
  if ("timing" in line) {
    record(line.area, line.name, line.ms, line.failure === undefined ? null : scrub(line.failure));
  } else {
    log(line.level, line.area, scrub(line.message));
  }
}
