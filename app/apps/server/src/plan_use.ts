// Where a person's Claude plan goes, and whether it's Edit that spends it
// (Sphe, Nov 5: "better track usage on others' Macs, to see how much is used
// by what, more precisely, and see if something isn't even from Edit"). Three
// sources, side by side:
//   - Anthropic's own meter, as Claude Code's /usage shows it: the 5-hour and
//     weekly windows, and the week's split between Claude Code, claude.ai's
//     chats, Cowork and the rest. Read every 15 minutes without asking a model
//     anything (claude.ts planMeter), so it costs the plan nothing;
//   - Edit's own calls (claude_usage.ts): what each kind cost, and when;
//   - every other Claude Code conversation on this Mac (Terminal, the Claude
//     app, an IDE, another app on the Agent SDK), from Claude Code's own
//     transcripts in ~/.claude/projects: when, which model, how many tokens and
//     the folder it ran in, never what was said.
// Lined up, each rise of the 5-hour meter between two readings goes to what
// spent in that stretch: Edit, other Claude Code here, or nothing on this Mac
// at all (claude.ai's chats, the Claude app's chats, or another computer
// signed in to the same account).

import * as fs from "node:fs";
import * as os from "node:os";

import * as claude from "./claude.ts";
import * as claudeUsage from "./claude_usage.ts";
import * as diag from "./diag.ts";
import { readState, writeAtomic } from "./files.ts";
import { join } from "./paths.ts";

const FILE = "claude-plan.json";
/** How often the meter is read. */
export const EVERY_MS = 15 * 60_000;
/** Readings, and other Claude Code's messages, kept this long. */
const KEEP_MS = 8 * 86_400_000;
/** Two readings further apart than this (the Mac asleep) aren't lined up. */
const GAP_MS = 2 * 60 * 60_000;

/** One reading of the meter. */
export interface Reading {
  at: number;
  /** The 5-hour window's use (0–100), null when no window is open. */
  five: number | null;
  fiveResets: string | null;
  week: number | null;
  weekResets: string | null;
  /** Anthropic's split of the week's use: "Claude Code" → percent, "Chats" → …. */
  split: Record<string, number> | null;
}

/** One message of a Claude Code conversation outside Edit. */
export interface Message {
  at: number;
  /** Where it came from: "Terminal in ~/code/foo". */
  source: string;
  model: string;
  usd: number;
  tokens: number;
}

// ---------------------------------------------------------------- prices

/** $ per million tokens: input, output, cache read (cache writes are 1.25× input for 5 minutes, 2× for an hour). */
const PRICES: [RegExp, number, number, number][] = [
  [/fable|mythos/, 10, 50, 0.25],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus-(?:5|4-[5-8])/, 5, 25, 0.5],
  [/opus/, 15, 75, 1.5],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet/, 3, 15, 0.3],
  [/haiku-5/, 0.1, 0.5, 0.01],
  [/haiku-4/, 1, 5, 0.1],
  [/haiku/, 0.25, 1.25, 0.03],
];

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** A message's cost at API prices; 0 for a model not in the table. */
export function priceOf(model: string, usage: Usage): number {
  const row = PRICES.find(([match]) => match.test(model));
  if (row === undefined) return 0;
  const [, input, output, read] = row;
  const written = n(usage.cache_creation_input_tokens);
  const hour = Math.min(written, n(usage.cache_creation?.ephemeral_1h_input_tokens));
  return (n(usage.input_tokens) * input + n(usage.output_tokens) * output + n(usage.cache_read_input_tokens) * read + (written - hour) * input * 1.25 + hour * input * 2) / 1e6;
}

// ---------------------------------------------------------------- the meter

let home: string | null = null;
let readings: Reading[] | null = null;

function kept(): Reading[] {
  if (readings !== null) return readings;
  const raw = home !== null && fs.existsSync(join(home, FILE)) ? readState(join(home, FILE)) : null;
  const list = typeof raw === "object" && raw !== null && Array.isArray((raw as { readings?: unknown }).readings) ? (raw as { readings: Reading[] }).readings : [];
  readings = list;
  return readings;
}

/** A reading from what Claude Code said. */
export function readingOf(meter: claude.PlanMeter, at: number): Reading {
  const window = (key: string) => (meter as Record<string, unknown>)[key] as { utilization?: number | null; resets_at?: string | null } | null | undefined;
  const five = window("five_hour");
  const week = window("seven_day");
  const breakdown = (meter as { seven_day_breakdown?: { rows?: { display_name?: string; percent?: number }[] } | null }).seven_day_breakdown;
  const rows = (breakdown?.rows ?? []).filter((row) => typeof row.display_name === "string" && typeof row.percent === "number");
  return {
    at,
    five: typeof five?.utilization === "number" ? five.utilization : null,
    fiveResets: five?.resets_at ?? null,
    week: typeof week?.utilization === "number" ? week.utilization : null,
    weekResets: week?.resets_at ?? null,
    split: rows.length > 0 ? Object.fromEntries(rows.map((row) => [row.display_name!, row.percent!])) : null,
  };
}

/** Keeps a reading (the last 8 days of them). */
export function keep(reading: Reading): void {
  const list = kept().filter((one) => one.at > reading.at - KEEP_MS && one.at !== reading.at);
  list.push(reading);
  list.sort((a, b) => a.at - b.at);
  readings = list;
  if (home === null) return;
  try {
    writeAtomic(join(home, FILE), JSON.stringify({ readings: list }));
  } catch {
    // Only a tally.
  }
}

/** Reads the meter now and keeps it; false when there's no meter to read. */
export async function read(now = Date.now()): Promise<boolean> {
  if (home === null) return false;
  const binary = await claude.findClaude();
  if (binary === null) return false;
  const dir = join(home, "claude-meter");
  fs.mkdirSync(dir, { recursive: true });
  const meter = await claude.planMeter(binary, dir);
  if (meter === null) return false;
  keep(readingOf(meter, now));
  return true;
}

let started = false;

/** Keeps the meter's readings in `dir` (Edit's data folder), from a minute after start, every 15 minutes. */
export function start(dir: string): void {
  use(dir);
  if (started) return;
  started = true;
  let quiet = false;
  const look = async () => {
    try {
      await read();
      quiet = false;
    } catch (error) {
      // Said once until it works again: a signed-out Claude Code would say it every 15 minutes.
      if (!quiet) diag.warn("claude", `reading the Claude plan's meter: ${diag.messageOf(error)}`);
      quiet = true;
    }
  };
  setTimeout(() => void look(), 60_000).unref?.();
  setInterval(() => void look(), EVERY_MS).unref?.();
}

/** Where the readings are kept; tests point it at a temporary folder. */
export function use(dir: string, transcripts = join(os.homedir(), ".claude", "projects")): void {
  if (home !== dir) readings = null;
  home = dir;
  projects = transcripts;
}

// ---------------------------------------------------------------- Claude Code outside Edit

let projects = join(os.homedir(), ".claude", "projects");

/** Claude Code's folder name for a working folder: every character but letters and digits a dash. */
const slugOf = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");

/** Conversations Edit ran (its agent, Writer's scripts, the trials): in its own data folders. */
function editFolders(): string[] {
  const own = [slugOf(join(os.homedir(), ".edit"))];
  if (home !== null) own.push(slugOf(home));
  return own;
}

/** Where a conversation ran, as the report says it. */
export function sourceOf(entrypoint: string, cwd: string): string {
  const app =
    entrypoint === "cli" ? "Terminal"
    : entrypoint === "claude-desktop" || entrypoint === "desktop" ? "the Claude app"
    : entrypoint === "claude-vscode" ? "VS Code"
    : entrypoint.startsWith("sdk") ? "an app on the Agent SDK"
    : entrypoint || "Claude Code";
  const mine = os.homedir();
  const temporary = /^(?:\/private)?\/(?:var\/folders|tmp)\//.test(cwd);
  const place = temporary
    ? `a temporary folder (${(cwd.split("/").pop() ?? "").replace(/-[A-Za-z0-9]{6}$/, "")})`
    : cwd.startsWith(mine) ? `~${cwd.slice(mine.length)}` : cwd || "?";
  return `${app} in ${place}`;
}

interface Seen { size: number; read: number; origin?: string }
/** Bytes read at once. */
const CHUNK = 16 * 1024 * 1024;
/** Transcripts read so far (each grows at its end), and each message once by its id (a message's blocks are lines of their own). */
const files = new Map<string, Seen>();
const messages = new Map<string, Message>();

/** One transcript line's message, when it's an assistant's reply; `origin` is where its conversation began (a session that moves between folders stays under the first). */
export function messageOf(line: string, origin?: string): [id: string, message: Message] | null {
  if (!line.includes('"assistant"') || !line.includes('"usage"')) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const message = entry.message as { id?: string; model?: string; usage?: Usage } | undefined;
  if (entry.type !== "assistant" || message?.usage === undefined || typeof message.model !== "string" || message.model.startsWith("<")) return null;
  const at = Date.parse(String(entry.timestamp ?? ""));
  if (!Number.isFinite(at)) return null;
  const usage = message.usage;
  return [
    String(message.id ?? entry.requestId ?? entry.uuid),
    {
      at,
      source: origin ?? sourceOf(String(entry.entrypoint ?? ""), String(entry.cwd ?? "")),
      model: message.model,
      usd: priceOf(message.model, usage),
      tokens: n(usage.input_tokens) + n(usage.output_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens),
    },
  ];
}

/** Each transcript under `dir` (and its subagents'), changed since `since`. */
function transcripts(dir: string, since: number): string[] {
  const out: string[] = [];
  const skip = editFolders();
  let folders: string[];
  try {
    folders = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const folder of folders) {
    if (skip.some((own) => folder.startsWith(own))) continue;
    const walk = (path: string, depth: number) => {
      let names: fs.Dirent[];
      try {
        names = fs.readdirSync(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const name of names) {
        const full = join(path, name.name);
        if (name.isDirectory() && depth < 3) walk(full, depth + 1);
        else if (name.isFile() && name.name.endsWith(".jsonl")) {
          try {
            if (fs.statSync(full).mtimeMs >= since) out.push(full);
          } catch {
            // Gone meanwhile.
          }
        }
      }
    };
    walk(join(dir, folder), 0);
  }
  return out;
}

/** Reads what's new in Claude Code's transcripts (a file at a time, from where it was last read). */
export async function scan(now = Date.now()): Promise<void> {
  const since = now - KEEP_MS;
  for (const path of transcripts(projects, since)) {
    let size: number;
    try {
      size = fs.statSync(path).size;
    } catch {
      continue;
    }
    const seen = files.get(path) ?? { size: 0, read: 0 };
    if (size < seen.read) seen.read = 0; // Written anew.
    // A piece at a time: a long conversation's transcript runs to hundreds of MB.
    while (seen.read < size) {
      const upto = Math.min(size, seen.read + CHUNK);
      const text = await Bun.file(path).slice(seen.read, upto).text();
      // Up to the last whole line: the rest is still being written (or comes with the next piece).
      const end = text.lastIndexOf("\n");
      if (end < 0) {
        // One line longer than a piece (a picture): never a reply's; skipped.
        if (upto === size) break;
        seen.read = upto;
        continue;
      }
      for (const line of text.slice(0, end).split("\n")) {
        const found = messageOf(line, seen.origin);
        if (found !== null) seen.origin ??= found[1].source;
        if (found !== null && found[1].at >= since) messages.set(found[0], found[1]);
      }
      seen.read += Buffer.byteLength(text.slice(0, end + 1));
      await new Promise((resolve) => setImmediate(resolve));
    }
    seen.size = size;
    files.set(path, seen);
    // Another request's turn between files.
    await new Promise((resolve) => setImmediate(resolve));
  }
  for (const [id, message] of messages) if (message.at < since) messages.delete(id);
}

/** Other Claude Code's messages in (from, to]. */
export function outsideBetween(from: number, to: number): Message[] {
  return [...messages.values()].filter((message) => message.at > from && message.at <= to);
}

/** Tests start clear. */
export function reset(): void {
  files.clear();
  messages.clear();
  readings = null;
}

// ---------------------------------------------------------------- lined up

/** A stretch between two readings: how far the 5-hour meter rose and what spent meanwhile. */
export interface Stretch {
  from: number;
  to: number;
  /** Points the 5-hour window rose (a new window counts from 0). */
  rose: number;
  edit: number;
  outside: number;
}

/** Reset times this close are one window's. */
const SAME_RESET_MS = 5 * 60_000;

export function stretches(since: number, now = Date.now()): Stretch[] {
  const list = kept().filter((reading) => reading.at >= since && reading.at <= now);
  const out: Stretch[] = [];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1]!;
    const b = list[i]!;
    if (b.at - a.at > GAP_MS || b.five === null) continue;
    // The reset time comes back a little different at each reading (Nov 5, JJ's Mac:
    // 15:20:00.179913, 15:20:00.070624, 15:19:59.887857): compared as text, every
    // reading was a new window and its whole level counted again (533% in a day).
    const sameWindow = a.five !== null && a.fiveResets !== null && b.fiveResets !== null && Math.abs(Date.parse(a.fiveResets) - Date.parse(b.fiveResets)) < SAME_RESET_MS;
    const rose = sameWindow ? Math.max(0, b.five - a.five!) : b.five;
    out.push({
      from: a.at,
      to: b.at,
      rose,
      edit: claudeUsage.spentBetween(a.at, b.at),
      outside: outsideBetween(a.at, b.at).reduce((sum, message) => sum + message.usd, 0),
    });
  }
  return out;
}

/** The meter's rise over `stretches`, split by what spent (each stretch by dollars); and the 5-hour window's size in dollars. */
export function attribute(list: Stretch[]): { rose: number; edit: number; outside: number; nothing: number; nothingStretches: number; window: number | null; from: number } {
  let edit = 0;
  let outside = 0;
  let nothing = 0;
  let nothingStretches = 0;
  let spent = 0;
  let explained = 0;
  // Under a cent is nothing: a title written, a probe.
  for (const stretch of list) {
    const local = stretch.edit + stretch.outside;
    if (local < 0.01) {
      nothing += stretch.rose;
      if (stretch.rose > 0) nothingStretches++;
      continue;
    }
    edit += (stretch.rose * stretch.edit) / local;
    outside += (stretch.rose * stretch.outside) / local;
    spent += local;
    explained += stretch.rose;
  }
  return {
    rose: edit + outside + nothing,
    edit,
    outside,
    nothing,
    nothingStretches,
    // The meter moves in whole points, so a window's size needs a few points of rise to mean anything.
    window: explained >= 5 ? (spent * 100) / explained : null,
    from: list.length,
  };
}

// ---------------------------------------------------------------- what the report says

const money = (usd: number): string => `$${usd.toFixed(2)}`;
const pct = (value: number): string => `${Math.round(value)}%`;

function when(iso: string | null, now: number): string {
  if (iso === null) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const days = (at - now) / 86_400_000;
  return ` (resets ${new Date(at).toLocaleString([], days > 1 ? { weekday: "short", hour: "numeric", minute: "2-digit" } : { hour: "numeric", minute: "2-digit" })})`;
}

function dayOf(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Other Claude Code by day: [day, total, sources dearest first as [source, dollars, messages, models]]. */
function outsideByDay(since: number): Map<string, { total: number; sources: Map<string, { usd: number; count: number; models: Map<string, number> }> }> {
  const days = new Map<string, { total: number; sources: Map<string, { usd: number; count: number; models: Map<string, number> }> }>();
  for (const message of messages.values()) {
    if (message.at < since) continue;
    const day = days.get(dayOf(message.at)) ?? { total: 0, sources: new Map() };
    day.total += message.usd;
    const source = day.sources.get(message.source) ?? { usd: 0, count: 0, models: new Map() };
    source.usd += message.usd;
    source.count++;
    source.models.set(message.model, (source.models.get(message.model) ?? 0) + message.usd);
    day.sources.set(message.source, source);
    days.set(dayOf(message.at), day);
  }
  return days;
}

const modelWord = (model: string): string => model.replace(/^claude-/, "").replace(/-\d{8}$/, "");

/** The meter now, the day's rise split by what spent, and each day: Edit's calls and other Claude Code here. */
export async function reportLines(count = 8, now = Date.now(), full = false): Promise<string[]> {
  await scan(now).catch((error: unknown) => diag.warn("claude", `reading Claude Code's transcripts: ${diag.messageOf(error)}`));
  const lines: string[] = [];
  const last = kept().at(-1);
  if (last === undefined) lines.push("the meter: not read yet (Claude Code's /usage; read every 15 minutes)");
  else {
    const split = last.split === null ? "" : `; the week by Anthropic: ${Object.entries(last.split).map(([name, value]) => `${name} ${pct(value)}`).join(", ")}`;
    lines.push(`the meter at ${new Date(last.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: 5-hour ${last.five === null ? "not started" : pct(last.five)}${when(last.fiveResets, now)}, week ${last.week === null ? "?" : pct(last.week)}${when(last.weekResets, now)}${split}`);
  }
  for (const [label, span] of [["the last 24 h", 86_400_000], ["the last week", 7 * 86_400_000]] as const) {
    const split = attribute(stretches(now - span, now));
    if (split.from === 0) continue;
    const parts = [`Edit ${pct(split.edit)}`, `other Claude Code on this Mac ${pct(split.outside)}`, `nothing running on this Mac ${pct(split.nothing)}${split.nothingStretches > 0 ? ` in ${split.nothingStretches} stretch(es): claude.ai or the Claude app's chats, or another computer on this account` : ""}`];
    lines.push(`${label}: the 5-hour meter rose ${pct(split.rose)} in all; ${parts.join("; ")}${split.window === null ? "" : `. A 5-hour window held about ${money(split.window)} at API prices`}`);
  }
  const outside = outsideByDay(now - (count - 1) * 86_400_000);
  const edit = new Map(claudeUsage.daysKept().map((day) => [day.day, day]));
  const days = [...new Set([...outside.keys(), ...edit.keys()])].filter((day) => day >= dayOf(now - (count - 1) * 86_400_000)).sort().reverse();
  for (const day of days) {
    const ours = edit.get(day);
    const theirs = outside.get(day);
    const rows = ours?.rows ?? [];
    const total = rows.reduce((sum, [, usd]) => sum + usd, 0);
    const calls = rows.reduce((sum, [, , count]) => sum + count, 0);
    const top = (full ? rows : rows.slice(0, 6)).map(([label, usd, count]) => `${label} ${money(usd)} ×${count}`).join("; ");
    const sources = [...(theirs?.sources ?? new Map()).entries()].sort((a, b) => b[1].usd - a[1].usd);
    const others = (full ? sources : sources.slice(0, 4))
      .map(([source, { usd, count, models }]) => `${source} ${money(usd)} ×${count} (${[...models.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => modelWord(model)).join(", ")})`)
      .join("; ");
    lines.push(
      `${day}: Edit ${money(total)} over ${calls} calls${top === "" ? "" : ` (${top})`}` +
        `; other Claude Code on this Mac ${money(theirs?.total ?? 0)}${others === "" ? "" : ` (${others})`}` +
        `${(ours?.limits ?? 0) > 0 ? `; plan used up ${ours!.limits}×` : ""}`,
    );
  }
  return lines;
}

/** Every reading of the last `hours`, with what spent between it and the one before. */
export function timeline(hours = 24, now = Date.now()): string[] {
  const list = stretches(now - hours * 3_600_000, now);
  if (list.length === 0) return ["no readings to line up yet"];
  const at = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return list.map((stretch) => {
    const reading = kept().find((one) => one.at === stretch.to);
    const outside = outsideBetween(stretch.from, stretch.to);
    const sources = [...new Set(outside.map((message) => message.source))].join(", ");
    return `${at(stretch.from)}–${at(stretch.to)}: 5-hour ${reading?.five ?? "?"}% (+${stretch.rose}), week ${reading?.week ?? "?"}%; Edit ${money(stretch.edit)}, other Claude Code ${money(stretch.outside)}${sources === "" ? "" : ` (${sources})`}${stretch.rose > 0 && stretch.edit + stretch.outside < 0.01 ? "  ← nothing on this Mac" : ""}`;
  });
}
