// Problem reports. This window keeps its own recent problems and timings; a
// report joins them with the server's log and timings (/api/diagnostics) into
// one text to copy and hand over when something goes wrong.

import { create } from "zustand";

type Level = "info" | "warn" | "error";

interface Line {
  at: number;
  level: Level;
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

interface ServerTiming {
  name: string;
  count: number;
  failed: number;
  total_ms: number;
  median_ms: number;
  max_ms: number;
}

interface ServerDiagnostics {
  version: string;
  machine: string;
  os: string;
  uptime: string;
  home: string;
  ffmpeg: string | null;
  lines: { at: number; level: Level; area: string; message: string }[];
  timings: ServerTiming[];
}

const KEEP = 300;
const lines: Line[] = [];
const timings = new Map<string, Stat>();
const contexts = new Map<string, () => unknown>();
let sentThisMinute = 0;
setInterval(() => (sentThisMinute = 0), 60_000);

/** The report dialog: open with what went wrong (if known). */
export const useReport = create<{ open: boolean; trigger: string | null }>(() => ({ open: false, trigger: null }));

export function openReport(trigger?: string) {
  useReport.setState({ open: true, trigger: trigger ?? null });
}

export const closeReport = () => useReport.setState({ open: false });

/** Notes something for the report; problems also go to the server's log. */
export function note(level: Level, area: string, message: string) {
  lines.push({ at: Date.now(), level, area, message: message.slice(0, 2000) });
  if (lines.length > KEEP) lines.shift();
  // Failed requests are already in the server's log; don't echo them back.
  if (level !== "info" && area !== "http" && sentThisMinute++ < 20) {
    void fetch("/api/diagnostics/client", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level, message: `${area}: ${message}`.slice(0, 2000) }),
    }).catch(() => {});
  }
}

/** Records how long something took here (requests include the network). */
export function recordTiming(name: string, ms: number, failed = false) {
  let stat = timings.get(name);
  if (!stat) timings.set(name, (stat = { count: 0, failed: 0, totalMs: 0, maxMs: 0, recent: [] }));
  stat.count++;
  if (failed) stat.failed++;
  stat.totalMs += ms;
  stat.maxMs = Math.max(stat.maxMs, ms);
  stat.recent.push(ms);
  if (stat.recent.length > 64) stat.recent.shift();
}

/** A request's route with ids replaced, so timings group: "GET /api/projects/:id/frame/:id". */
export function routeOf(method: string, url: string) {
  const path = url.split("?")[0].replace(/^https?:\/\/[^/]+/, "");
  const parts = path.split("/").map((part) => (/^[a-z]{0,2}\d[\w.-]*$/i.test(part) || part.length > 24 ? ":id" : part));
  return `${method.toUpperCase()} ${parts.join("/")}`;
}

/** Adds a section to every report: what's open, the preview's state, … */
export function addContext(name: string, read: () => unknown) {
  contexts.set(name, read);
}

let installed = false;

/** Catches this window's uncaught errors (once, at startup). */
export function installDiagnostics() {
  if (installed) return;
  installed = true;
  addEventListener("error", (event) => note("error", "ui", `${event.message} (${event.filename}:${event.lineno})`));
  addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { stack?: string } | undefined;
    note("error", "ui", `Unhandled: ${reason?.stack ?? String(event.reason)}`);
  });
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    note("error", "console", args.map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg))).join(" "));
    original(...args);
  };
}

const time = (at: number) => new Date(at).toTimeString().slice(0, 8);
const ms = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`);

function table(rows: { name: string; count: number; failed: number; median: number; max: number; total: number }[]) {
  return rows
    .slice(0, 40)
    .map((row) => `${row.name} | ${row.count}× | median ${ms(row.median)} | max ${ms(row.max)} | total ${ms(row.total)}${row.failed ? ` | ${row.failed} failed` : ""}`)
    .join("\n");
}

async function gpuSummary() {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ info?: Record<string, string> } | null> } }).gpu;
  if (!gpu) return "not available";
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return "no adapter";
    const info = adapter.info ?? {};
    return [info.vendor, info.architecture, info.description].filter(Boolean).join(" · ") || "available";
  } catch (error) {
    return `error: ${error}`;
  }
}

/** Everything needed to work out what went wrong, as text to paste. */
export async function buildReport(trigger: string | null, comment = ""): Promise<string> {
  let server: ServerDiagnostics | null = null;
  let serverProblem = "";
  try {
    const response = await fetch("/api/diagnostics");
    if (response.ok) server = (await response.json()) as ServerDiagnostics;
    else serverProblem = `HTTP ${response.status}`;
  } catch (error) {
    serverProblem = String(error);
  }
  const connection = (navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number; rtt?: number } }).connection;
  const sections: string[] = [];
  sections.push(
    [
      "# Edit problem report",
      `When: ${new Date().toISOString()}`,
      trigger && `What went wrong: ${trigger}`,
      comment.trim() && `What I was doing: ${comment.trim()}`,
      server ? `Edit ${server.version} on ${server.machine} (${server.os}), up ${server.uptime}, data in ${server.home}` : `Edit's server: unreachable (${serverProblem})`,
      server && `FFmpeg: ${server.ffmpeg ?? "not found"}`,
      `Page: ${location.href}`,
      `Browser: ${navigator.userAgent}`,
      `Screen: ${screen.width}×${screen.height} @${devicePixelRatio}x, window ${innerWidth}×${innerHeight}`,
      `WebGPU: ${await gpuSummary()}`,
      connection && `Network (browser's estimate): ${connection.effectiveType ?? "?"}, ${connection.downlink ?? "?"} Mbit/s, ${connection.rtt ?? "?"} ms round trip`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  for (const [name, read] of contexts) {
    let value: unknown;
    try {
      value = read();
    } catch (error) {
      value = `unavailable: ${error}`;
    }
    if (value !== undefined && value !== null) sections.push(`## ${name}\n${typeof value === "string" ? value : JSON.stringify(value, null, 1)}`);
  }
  sections.push(
    `## Problems in this window\n${
      lines.filter((line) => line.level !== "info").map((line) => `${time(line.at)} ${line.level.toUpperCase()} [${line.area}] ${line.message}`).join("\n") || "none"
    }`,
  );
  if (server) {
    sections.push(
      `## Server log (latest last)\n${server.lines.slice(-200).map((line) => `${time(line.at)} ${line.level.toUpperCase()} [${line.area}] ${line.message}`).join("\n") || "empty"}`,
    );
    sections.push(
      `## How long things took on the server\n${
        table(server.timings.map((t) => ({ name: t.name, count: t.count, failed: t.failed, median: t.median_ms, max: t.max_ms, total: t.total_ms }))) || "nothing yet"
      }`,
    );
  }
  const here = [...timings]
    .map(([name, stat]) => {
      const sorted = [...stat.recent].sort((a, b) => a - b);
      return { name, count: stat.count, failed: stat.failed, median: sorted[Math.floor(sorted.length / 2)] ?? 0, max: stat.maxMs, total: stat.totalMs };
    })
    .sort((a, b) => b.total - a.total);
  sections.push(`## How long things took in this window (requests include the network)\n${table(here) || "nothing yet"}`);
  return sections.join("\n\n");
}

/** Copies text, falling back to a selected textarea where the clipboard API isn't allowed. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}
