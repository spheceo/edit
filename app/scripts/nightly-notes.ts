// A nightly's notes for the team (Nov 8 audit, item I): two lines at the top
// of its GitHub pre-release saying what changed since the build before, then
// every change, grouped by the plan item its message names ("(Nov 8 audit,
// item G)") where it names one, each by its first clause. `just nightly`
// prints them before it tags; release.yml's prepare writes them as the body.
//
//   bun scripts/nightly-notes.ts <previous tag or ""> <ref> [why it was forced]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A commit message's first clause: up to its first colon, semicolon, bracket or full stop, at most 140 characters. */
export function firstClause(subject: string): string {
  const cut = subject.search(/: |; | \(| — |\. /);
  let clause = (cut > 0 ? subject.slice(0, cut) : subject).trim().replace(/[.:;,]$/, "");
  if (clause.length > 140) clause = `${clause.slice(0, clause.lastIndexOf(" ", 137))}…`;
  return clause;
}

/** The plan item a message ends by naming ("(Nov 8 audit, item G)"), or null. */
export function planItem(subject: string): { plan: string; item: string } | null {
  const found = /\(([^()]*?),? item ([A-Z])\)\s*$/.exec(subject);
  return found === null ? null : { plan: found[1]!.trim(), item: found[2]! };
}

/** An item's name from its plan in docs/plans ("Nov 8 audit" → 2026-11-08-audit.md, "G. Page hygiene: …" → "Page hygiene"). */
function itemName(plan: string, item: string): string | null {
  const date = /^(\w{3}) (\d{1,2}) audit$/.exec(plan);
  const month = date === null ? -1 : MONTHS.indexOf(date[1]!);
  if (date === null || month < 0) return null;
  const dir = join(ROOT, "docs/plans");
  if (!existsSync(dir)) return null;
  const suffix = `-${String(month + 1).padStart(2, "0")}-${date[2]!.padStart(2, "0")}-audit.md`;
  const file = readdirSync(dir).find((name) => name.endsWith(suffix));
  if (file === undefined) return null;
  const line = readFileSync(join(dir, file), "utf8").split("\n").find((one) => one.startsWith(`${item}. `));
  return line === undefined ? null : firstClause(line.slice(3).replace(/,.*$/, ""));
}

export interface Change {
  subject: string;
}

/** The notes: the two-line note, then the changes by group. */
export function notes(previous: string, changes: Change[], forced: string, name = itemName): string {
  const groups = new Map<string, { title: string; clauses: string[] }>();
  const others: string[] = [];
  for (const { subject } of changes) {
    const found = planItem(subject);
    if (found === null) {
      others.push(firstClause(subject));
      continue;
    }
    const key = `${found.plan}, item ${found.item}`;
    const named = name(found.plan, found.item);
    const group = groups.get(key) ?? { title: named === null ? `item ${found.item}` : `${named} (item ${found.item})`, clauses: [] };
    group.clauses.push(firstClause(subject.replace(/\s*\([^()]*item [A-Z]\)\s*$/, "")));
    groups.set(key, group);
  }
  const since = previous === "" ? "" : ` since ${previous}`;
  const count = `${changes.length} change${changes.length === 1 ? "" : "s"}${since}`;
  const parts = [...groups.values()].sort((a, b) => b.clauses.length - a.clauses.length).map((group) => `${group.title} ×${group.clauses.length}`);
  if (others.length > 0) parts.push(`${others.length} other${others.length === 1 ? "" : "s"}`);
  const first = changes.length === 0 ? "Nothing changed since the build before." : `**${count}:** ${parts.join(", ")}.`;
  // The second line: the newest change of each group, then the others, as far as a line goes.
  const picks = [...[...groups.values()].map((group) => group.clauses[0]!), ...others];
  let second = "";
  for (const [index, pick] of picks.entries()) {
    const next = second === "" ? pick : `${second}; ${pick}`;
    if (next.length > 320 && second !== "") {
      second += `; and ${picks.length - index} more`;
      break;
    }
    second = next;
  }
  const lines = [first];
  if (second !== "") lines.push(`${second}.`);
  if (forced !== "") lines.push("", `*Shipped within 20 hours of the nightly before: ${forced}*`);
  for (const group of groups.values()) lines.push("", `### ${group.title}`, ...group.clauses.map((clause) => `- ${clause}`));
  if (others.length > 0) lines.push("", groups.size > 0 ? "### Other changes" : "### Changes", ...others.map((clause) => `- ${clause}`));
  return lines.join("\n");
}

if (import.meta.main) {
  const [previous = "", ref = "HEAD", forced = ""] = process.argv.slice(2);
  const range = previous === "" ? ref : `${previous}..${ref}`;
  const log = Bun.spawnSync(["git", "log", "--no-merges", "--format=%s", range], { cwd: ROOT });
  if (log.exitCode !== 0) throw new Error(`git log ${range}: ${log.stderr.toString()}`);
  const subjects = log.stdout.toString().split("\n").filter((line) => line.trim() !== "");
  console.log(notes(previous, subjects.map((subject) => ({ subject })), forced));
}
