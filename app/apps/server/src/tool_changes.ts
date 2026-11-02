// What changed in Edit's tools since a Claude Code session last saw them. A
// resumed session keeps the tool schemas it already read, so a new argument
// on a tool it has used never reaches it (Nov 3: R2's chat said
// "look_at_media has no pick option" an hour after pick shipped). Starting
// the session afresh would lose the chat's context, which is worth more, so
// each session's schema is kept with the chat (its hash and its tools'
// arguments), and the first turn on a newer build is told in one line what
// changed ("Edit updated: look_at_media gained pick; new tools wait, listen").

import { createHash } from "node:crypto";

import { TOOLS } from "./mcp/registry.ts";
import { stableStringify } from "./stable.ts";
import { allSkillNames } from "./styles.ts";

/** The tools' arguments by tool, and the skills, as a session reads them. */
export interface ToolSchema {
  hash: string;
  tools: Record<string, string[]>;
  skills: string[];
}

/** The schema of the build that's running. */
export function current(): ToolSchema {
  const tools: Record<string, string[]> = {};
  for (const tool of TOOLS) tools[tool.name] = Object.keys(tool.inputSchema?.properties ?? {}).filter((arg) => arg !== "project_id").sort();
  return schemaOf(tools, [...allSkillNames()].sort());
}

export function schemaOf(tools: Record<string, string[]>, skills: string[]): ToolSchema {
  const hash = createHash("sha256").update(stableStringify({ tools, skills })).digest("hex").slice(0, 16);
  return { hash, tools, skills };
}

/** A schema as saved with a chat, or null when it isn't one. */
export function read(value: unknown): ToolSchema | null {
  if (typeof value !== "object" || value === null) return null;
  const given = value as Record<string, unknown>;
  if (typeof given.hash !== "string" || typeof given.tools !== "object" || given.tools === null || !Array.isArray(given.skills)) return null;
  const tools: Record<string, string[]> = {};
  for (const [name, args] of Object.entries(given.tools as Record<string, unknown>)) {
    if (Array.isArray(args)) tools[name] = args.filter((arg): arg is string => typeof arg === "string");
  }
  return { hash: given.hash, tools, skills: given.skills.filter((skill): skill is string => typeof skill === "string") };
}

const list = (names: string[]) => names.join(", ");

/** One line saying what changed from `before` to `after`; "" when nothing a session would notice did. */
export function changes(before: ToolSchema, after: ToolSchema): string {
  if (before.hash === after.hash) return "";
  const parts: string[] = [];
  const added = Object.keys(after.tools).filter((name) => !(name in before.tools)).sort();
  const removed = Object.keys(before.tools).filter((name) => !(name in after.tools)).sort();
  for (const name of Object.keys(after.tools).sort()) {
    const was = before.tools[name];
    if (was === undefined) continue;
    const gained = after.tools[name]!.filter((arg) => !was.includes(arg));
    const lost = was.filter((arg) => !after.tools[name]!.includes(arg));
    if (gained.length > 0) parts.push(`${name} gained ${list(gained)}`);
    if (lost.length > 0) parts.push(`${name} lost ${list(lost)}`);
  }
  if (added.length > 0) parts.push(`new tool${added.length === 1 ? "" : "s"} ${list(added)}`);
  if (removed.length > 0) parts.push(`gone: ${list(removed)}`);
  const skills = after.skills.filter((skill) => !before.skills.includes(skill));
  if (skills.length > 0) parts.push(`new skill${skills.length === 1 ? "" : "s"} ${list(skills)}`);
  if (parts.length === 0) return "";
  return `(Edit updated since this chat last looked at its tools: ${parts.join("; ")}. Use what's new where it fits; the tools' current descriptions say how.)`;
}
