// What an admin can ask a teammate's Edit from afar, beyond its fixed report
// (Sphe, Nov 4: "give yourself as MUCH control and info as needed to be able
// to diagnose issues that come up on other people's Macs"). Read-only: a
// question never changes their work, their settings or their projects. It
// rides a remote `resume` of `ask-<the question, base64url>` (the database
// takes `[A-Za-z0-9_-]{1,120}` there, so no deploy of it was needed, as
// probe- and unstick before it), and the answer, scrubbed of URLs and
// tokens, goes up with the problem reports (`edit/reports/remote/…`), which
// only an admin reads; the command's outcome says where. Asked with
// `just remote ask <mac> <question>` (scripts/remote.ts).
//
//   help                          what can be asked
//   report                        the full report (what diagnostics sends)
//   log [since=2h] [grep=re] [level=warn|error] [area=pieces] [lines=400]
//                                 the log (five rotations kept), filtered
//   system                        the Mac: macOS, model, memory, disks, power, tools
//   ps                            Edit's own processes (FFmpeg, claude…) and the busiest others
//   net                           how fast the relay and R2 answer
//   work                          what's under way: jobs, uploads, pieces, imports, turns
//   project <id>                  a project's media (and their state), clips, chat's end
//   ls [path] / file <path> [lines=N] [grep=re]
//                                 Edit's data folder (paths inside it; sign-in files refused)
//   get /api/…                    one of Edit's own GET routes, answered inside (no window touched)

import * as fs from "node:fs";
import * as os from "node:os";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { memorySummary } from "./export_capacity.ts";
import { useNow as memoryUse } from "./memory.ts";
import type { Router } from "./http/router.ts";
import { respond } from "./http/server.ts";
import { join } from "./paths.ts";
import * as pieces from "./proxy_pieces.ts";
import * as relay from "./relay.ts";
import { report, work } from "./remote_actions.ts";
import { redactSupport } from "./support_cli.ts";
import * as tools from "./tools.ts";
import { BUILD } from "./version.ts";

/** A remote resume of `ask-…` is a question. */
export const ASK = "ask-";
/** The database's limit on a resume's target. */
const TARGET_MAX = 120;
/** An answer longer than this is cut (its end kept: what's newest). */
const MAX_ANSWER = 2_000_000;
const REMOTE = "edit/reports/remote/";

/** `text` as a resume target; throws when it's too long to go. */
export function encodeAsk(text: string): string {
  const target = ASK + Buffer.from(text.trim(), "utf8").toString("base64url");
  if (target.length > TARGET_MAX) throw new Error(`that question is ${target.length - TARGET_MAX} characters too long to send (about 85 fit): shorten its pattern or path`);
  return target;
}

export function decodeAsk(target: string): string {
  return Buffer.from(target.slice(ASK.length), "base64url").toString("utf8");
}

let router: Router<App> | null = null;

/** The server's routes, for `get` (serve.ts hands them over as it starts). */
export function useRouter(given: Router<App>): void {
  router = given;
}

/** The words of a question: the verb, the positional words, and `name=value` options. */
export function parse(text: string): { verb: string; words: string[]; options: Map<string, string> } {
  const [verb = "help", ...rest] = text.trim().split(/\s+/);
  const words: string[] = [];
  const options = new Map<string, string>();
  for (const word of rest) {
    const at = word.indexOf("=");
    if (at > 0 && /^[a-z]+$/.test(word.slice(0, at))) options.set(word.slice(0, at), word.slice(at + 1));
    else words.push(word);
  }
  return { verb: verb.toLowerCase(), words, options };
}

/** `30m`, `2h`, `1d` (or seconds) in ms; null when it isn't one. */
export function duration(text: string | undefined): number | null {
  if (text === undefined) return null;
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(text.trim());
  if (match === null) return null;
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(match[2] ?? "s") as "s"];
}

/** Answers the question in `target` (a resume target), sends it up; the outcome's words (where it went). */
export async function answer(app: App, target: string): Promise<string> {
  const question = decodeAsk(target);
  const began = performance.now();
  let body: string;
  try {
    body = await respondTo(app, question);
  } catch (error) {
    body = `It couldn't be answered: ${diag.messageOf(error)}`;
  }
  const text = String(redactSupport(diag.scrub(body)));
  const cut = text.length > MAX_ANSWER ? `…(the first ${text.length - MAX_ANSWER} characters cut)\n${text.slice(-MAX_ANSWER)}` : text;
  const now = Date.now();
  const header = `Asked: ${question}\nMac: ${app.machine}\nEdit: ${BUILD}\nAnswered: ${new Date(now).toISOString()} in ${diag.human(performance.now() - began)}\n\n`;
  const key = `${REMOTE}${new Date(now).toISOString().slice(0, 10)}/${slug(app.machine)}-${now}.txt`;
  const dir = join(app.store.home, "reports-sent");
  fs.mkdirSync(dir, { recursive: true });
  const local = join(dir, "remote-answer.txt");
  fs.writeFileSync(local, header + cut);
  await cloud.uploadFile(local, key);
  diag.info("remote", `answered an admin's question (${question.split(/\s/)[0]}; ${cut.length} characters)`);
  return `Sent: ${key}`;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "mac";
}

export async function respondTo(app: App, question: string): Promise<string> {
  const { verb, words, options } = parse(question);
  switch (verb) {
    case "help":
      return HELP;
    case "report":
      return report(app, "Asked for by an admin (edit remote ask report).");
    case "log":
      return logLines(app.store.home, options);
    case "system":
      return system(app);
    case "ps":
      return processes();
    case "net":
      return net();
    case "work":
      return workNow(app);
    case "project":
      return project(app, words[0]);
    case "ls":
      return list(app.store.home, words[0] ?? ".");
    case "file":
      return file(app.store.home, words[0], options);
    case "get":
      return get(app, words[0]);
    default:
      return `"${verb}" isn't something Edit answers.\n\n${HELP}`;
  }
}

const HELP = `Questions (read-only):
  report                        the full report
  log [since=2h] [grep=re] [level=warn|error] [area=pieces] [lines=400]
  system                        macOS, model, memory, disks, power, tools
  ps                            Edit's processes and the busiest others
  net                           how fast the relay and R2 answer
  work                          jobs, uploads, pieces, imports, agent turns
  project <id>                  its media and their state, clips, the chat's end
  ls [path]                     a folder in Edit's data folder
  file <path> [lines=N] [grep=re]   a file there (sign-in files refused)
  get /api/…                    one of Edit's own GET routes`;

// ---------------------------------------------------------------- the log

/** The log's files, oldest first (diag.ts keeps five set aside). */
function logFiles(home: string): string[] {
  const base = join(home, "logs", "edit.log");
  return [5, 4, 3, 2, 1].map((n) => `${base}.${n}`).concat(base).filter((path) => fs.existsSync(path));
}

/** A log line's time (ms), or null for one that isn't stamped (a continuation). */
function stampOf(line: string): number | null {
  const match = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3}) /.exec(line);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s, ms] = match.map(Number);
  return new Date(y!, mo! - 1, d!, h!, mi!, s!, ms!).getTime();
}

export function logLines(home: string, options: Map<string, string>, now = Date.now()): string {
  const since = duration(options.get("since"));
  const from = since === null ? null : now - since;
  const limit = Math.min(Math.max(Number(options.get("lines") ?? 400) || 400, 1), 20_000);
  const pattern = options.get("grep");
  const grep = pattern === undefined ? null : new RegExp(pattern, "i");
  const level = options.get("level")?.toLowerCase();
  const levels = level === "error" ? ["ERROR"] : level === "warn" ? ["WARN", "ERROR"] : null;
  const area = options.get("area");
  const kept: string[] = [];
  let seen = 0;
  for (const path of logFiles(home)) {
    let at: number | null = null;
    for (const line of fs.readFileSync(path, "utf8").split("\n")) {
      if (line === "") continue;
      at = stampOf(line) ?? at;
      if (from !== null && (at === null || at < from)) continue;
      if (levels !== null && !levels.some((one) => line.includes(` ${one} [`))) continue;
      if (area !== undefined && !line.includes(` [${area}] `)) continue;
      if (grep !== null && !grep.test(line)) continue;
      seen++;
      kept.push(line);
      if (kept.length > limit) kept.shift();
    }
  }
  const files = logFiles(home).map((path) => `${path.slice(path.lastIndexOf("/") + 1)} ${(fs.statSync(path).size / 1e6).toFixed(1)} MB`);
  return `${seen} line(s) matched, the last ${kept.length} shown (log: ${files.join(", ") || "none"})\n\n${kept.join("\n")}`;
}

// ---------------------------------------------------------------- the Mac

async function run(command: string[], ms = 10_000): Promise<string> {
  try {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => child.kill(), ms);
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    clearTimeout(timer);
    await child.exited;
    return (out || err).trim();
  } catch (error) {
    return `(${command[0]}: ${diag.messageOf(error)})`;
  }
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

async function system(app: App): Promise<string> {
  const [product, model, chip, disks, battery, thermal, ffmpeg, claude] = await Promise.all([
    run(["sw_vers"]),
    run(["sysctl", "-n", "hw.model"]),
    run(["sysctl", "-n", "machdep.cpu.brand_string"]),
    run(["df", "-H", "-l"]),
    run(["pmset", "-g", "batt"]),
    run(["pmset", "-g", "therm"]),
    run([tools.ffmpeg(), "-hide_banner", "-version"]).then((text) => text.split("\n")[0] ?? ""),
    run(["claude", "--version"]),
  ]);
  const use = await memoryUse();
  const memory = process.memoryUsage();
  return [
    `Edit ${BUILD} · up ${diag.human(diag.uptime())} · data in ${app.store.home} · cache in ${app.store.cacheDir()}`,
    `this server: ${gb(memory.rss)} resident, heap ${gb(memory.heapUsed)}`,
    `machine: ${model} · ${chip} · ${os.cpus().length} cores · load ${os.loadavg().map((n) => n.toFixed(2)).join(" ")} · up ${(os.uptime() / 86_400).toFixed(1)} days`,
    `memory: ${memorySummary()}${use === null ? "" : ` · ${use}`}`,
    "",
    product,
    "",
    "Disks:",
    disks,
    "",
    "Power:",
    battery,
    thermal,
    "",
    `FFmpeg: ${ffmpeg}`,
    `Claude Code: ${claude}`,
  ].join("\n");
}

async function processes(): Promise<string> {
  const table = await run(["ps", "-A", "-o", "pid=,ppid=,etime=,%cpu=,rss=,command="]);
  const rows = table.split("\n").map((line) => {
    const [pid, ppid, etime, cpu, rss, ...command] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), etime, cpu: Number(cpu), rss: Number(rss), command: command.join(" ") };
  });
  // Edit's own: everything under this server.
  const ours = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (ours.has(row.pid) || !ours.has(row.ppid)) continue;
      ours.add(row.pid);
      grew = true;
    }
  }
  const show = (row: (typeof rows)[number]) => `${String(row.pid).padStart(6)} ${row.etime?.padStart(11)} ${row.cpu.toFixed(1).padStart(5)}% ${(row.rss / 1024).toFixed(0).padStart(6)} MB  ${row.command.slice(0, 400)}`;
  const busiest = rows.filter((row) => !ours.has(row.pid)).sort((a, b) => b.cpu - a.cpu).slice(0, 12);
  return [`Edit's processes (pid, running for, CPU, memory, command):`, ...rows.filter((row) => ours.has(row.pid)).map(show), "", "The busiest others:", ...busiest.map(show)].join("\n");
}

async function timed(what: string, work: () => Promise<unknown>): Promise<string> {
  const began = performance.now();
  try {
    await work();
    return `${what}: ${Math.round(performance.now() - began)} ms`;
  } catch (error) {
    return `${what}: failed after ${Math.round(performance.now() - began)} ms (${diag.messageOf(error)})`;
  }
}

async function net(): Promise<string> {
  const out = [`relay: ${relay.url()}`];
  for (let n = 1; n <= 3; n++) out.push(await timed(`relay health ${n}`, () => fetch(`${relay.url()}/health`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.text())));
  for (let n = 1; n <= 3; n++) out.push(await timed(`R2 head ${n}`, () => cloud.head("edit/reports/latest/none")));
  return out.join("\n");
}

function workNow(app: App): string {
  const journals = cloud.uploadJournals().map((one) => `  ${one.key}: ${gb(one.up)} of ${gb(one.size)} up (${one.parts} parts)`);
  const uploads = cloudMedia.uploadsNow().map((one) => `  ${one.file} → ${one.uploadOriginal ? one.originalKey : "(original up already)"}${one.proxy ? ` + ${one.proxy}` : ""}`);
  const made = pieces.status();
  return [
    ...work(app),
    "",
    `uploads going on: ${uploads.length === 0 ? "none" : ""}`,
    ...uploads,
    `big uploads kept to resume: ${journals.length === 0 ? "none" : ""}`,
    ...journals,
    "",
    `pieced proxies: the fill's piece ${made.background ?? "none"}; waited on: ${made.waitedOn.join(", ") || "none"}; in flight: ${made.inFlight.join(", ") || "none"}`,
  ].join("\n");
}

function project(app: App, id: string | undefined): string {
  if (id === undefined) return `Which project? Its id, from:\n${app.store.list().map((one) => `${one.id} "${one.name}"`).join("\n")}`;
  const live = app.store.get(id);
  if (live === null) return `There's no project ${id} on this Mac.`;
  const p = live.project;
  const counts = new Map<string, number>();
  for (const clip of p.clips) counts.set(clip.type, (counts.get(clip.type) ?? 0) + 1);
  const media = p.media.map((one) => {
    const status = app.media.status(one.path);
    return `  ${one.id} "${one.name}" · ${one.kind} · ${one.duration.toFixed(1)} s · ${one.path}${one.cloud ? ` · cloud ${JSON.stringify(one.cloud)}` : ""}\n      ${JSON.stringify(status)}`;
  });
  let chat = "";
  try {
    chat = fs.readFileSync(join(app.store.home, "projects", `${id}.chat.json`), "utf8").slice(-20_000);
  } catch {
    chat = "(no chat)";
  }
  return [`${id} "${p.name}" · ${p.settings.width}×${p.settings.height} at ${p.settings.fps} fps`, `clips: ${[...counts].map(([type, n]) => `${n} ${type}`).join(", ") || "none"}`, "", "Media:", ...media, "", "The chat's end:", chat].join("\n");
}

// ---------------------------------------------------------------- the data folder

/** Files that hold a sign-in or a key: never read from afar. */
const PRIVATE = /token|secret|credential|password|cookie|keychain|account|auth|remote-support|settings\.json|\.env/i;

/** `path` inside `home` (no way out of it); throws otherwise. */
export function inside(home: string, path: string): string {
  const full = fs.realpathSync(join(home, path));
  const root = fs.realpathSync(home);
  const cache = (() => {
    try {
      return fs.realpathSync(join(home, "cache"));
    } catch {
      return root;
    }
  })();
  if (!(full === root || full.startsWith(`${root}/`) || full === cache || full.startsWith(`${cache}/`))) throw new Error(`${path} isn't in Edit's data folder`);
  return full;
}

function list(home: string, path: string): string {
  const dir = inside(home, path);
  const entries = fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(join(dir, entry.name));
    } catch {
      stat = null;
    }
    return { name: entry.name, dir: stat?.isDirectory() ?? false, size: stat?.size ?? 0, at: stat?.mtimeMs ?? 0 };
  });
  entries.sort((a, b) => b.at - a.at);
  return [`${dir} (${entries.length} entries, newest first)`, ...entries.slice(0, 300).map((one) => `${diag.stamp(one.at)}  ${one.dir ? "     dir" : `${(one.size / 1e6).toFixed(2).padStart(8)} MB`}  ${one.name}${one.dir ? "/" : ""}`)].join("\n");
}

function file(home: string, path: string | undefined, options: Map<string, string>): string {
  if (path === undefined) return "Which file? A path inside Edit's data folder (ls shows them).";
  if (PRIVATE.test(path)) return `${path} may hold a sign-in or a key: it isn't read from afar.`;
  const full = inside(home, path);
  const size = fs.statSync(full).size;
  const fd = fs.openSync(full, "r");
  let text: string;
  try {
    const length = Math.min(size, 20_000_000);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    text = buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  if (text.includes("\u0000")) return `${path} isn't text (${size} bytes).`;
  const pattern = options.get("grep");
  let lines = text.split("\n");
  if (pattern !== undefined) lines = lines.filter((line) => new RegExp(pattern, "i").test(line));
  const count = Number(options.get("lines") ?? 0);
  if (count > 0) lines = lines.slice(-count);
  return `${full} (${size} bytes${size > 20_000_000 ? ", its last 20 MB" : ""})\n\n${lines.join("\n")}`;
}

/** Routes that do more than answer: opening a project moves the window to it. */
const NOT_ASKED = [/^\/api\/projects\/[^/]+$/];

async function get(app: App, path: string | undefined): Promise<string> {
  if (path === undefined || !path.startsWith("/api/")) return "Give one of Edit's GET routes: get /api/…";
  const url = new URL(path, "http://127.0.0.1");
  if (NOT_ASKED.some((pattern) => pattern.test(url.pathname))) return `${url.pathname} does more than answer (it opens the project in their window): ask project <id> instead.`;
  if (router === null) return "This Edit's routes aren't at hand.";
  const response = await respond(app, router, new Request(`http://127.0.0.1${url.pathname}${url.search}`, { headers: { host: "127.0.0.1" } }), null);
  if (response === undefined) return "No answer.";
  const text = await response.text();
  let shown = text;
  try {
    shown = JSON.stringify(JSON.parse(text), null, 1);
  } catch {
    // Not JSON: as it came.
  }
  return `${response.status} ${url.pathname}${url.search}\n\n${shown}`;
}
