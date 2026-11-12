// What a step of an agent's work is, to say it and show it (Sphe, Nov 12: a
// group of steps should say what they did, "Ran 1 command and changed 1 file",
// with an icon to match, and each step a line of its own that opens to its
// details). Bodycam HQ's agent and Claude Code's own tools mostly; the house
// agents' tools keep their titles (agentTurns.ts).

import type { AgentEntry } from "./agent";

export type StepKind = "command" | "read" | "search" | "change" | "reference" | "graphic" | "web" | "edit" | "notes" | "picture" | "wait" | "other";

const KINDS: Record<string, StepKind> = {
  Bash: "command",
  Read: "read",
  Glob: "search",
  Grep: "search",
  Write: "change",
  Edit: "change",
  MultiEdit: "change",
  look_at_media: "reference",
  media_transcript: "reference",
  listen: "reference",
  find_in_footage: "reference",
  look_at_effect: "graphic",
  review_motion: "graphic",
  search_web: "web",
  read_page: "web",
  WebSearch: "web",
  WebFetch: "web",
  case_articles: "web",
  add_effect: "edit",
  add_clip: "edit",
  update_clip: "edit",
  update_clips: "edit",
  delete_clips: "edit",
  apply_edit_plan: "edit",
  extend_clip: "edit",
  cover_cut_in: "edit",
  add_cut_in: "edit",
  remove_time: "edit",
  set_ranges: "edit",
  set_in_out: "edit",
  undo_changes: "edit",
  get_edit_context: "notes",
  get_project: "notes",
  read_skill: "notes",
  skill: "notes",
  read_transcript: "notes",
  edit_history: "notes",
  library: "notes",
  list_library: "notes",
  effect_picture: "picture",
  effect_footage: "picture",
  effect_beneath: "picture",
  use_found: "picture",
  look_at_found: "picture",
  collect_images: "picture",
  wait: "wait",
};

export const stepKind = (tool?: string): StepKind => KINDS[tool ?? ""] ?? "other";

export const argsOf = (entry: AgentEntry): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(entry.detail ?? "{}") as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
const base = (path: string) => path.split(/[\\/]/u).filter(Boolean).slice(-2).join("/") || path;
const secs = (value: number) => `${Math.round(value * 10) / 10}s`;
const span = (a: Record<string, unknown>) => {
  const start = num(a.start);
  const end = num(a.end);
  if (start !== null && end !== null) return ` ${secs(start).slice(0, -1)}–${secs(end)}`;
  if (start !== null) return ` from ${secs(start)}`;
  const times = count(a.times);
  return times > 1 ? ` at ${times} moments` : times === 1 ? ` at ${secs(Number((a.times as unknown[])[0]))}` : "";
};
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
};
const many = (n: number, one: string, more = `${one}s`) => (n === 1 ? `a ${one}` : `${n} ${more}`);

/** One step as a line: what it did, from its arguments. */
export function stepTitle(entry: AgentEntry): string {
  const a = argsOf(entry);
  switch (entry.tool) {
    case "Bash":
      return str(a.description) || str(a.command).split("\n")[0] || "Ran a command";
    case "Read":
      return `Read ${base(str(a.file_path)) || "a file"}`;
    case "Write":
      return `Wrote ${base(str(a.file_path)) || "a file"}`;
    case "Edit":
    case "MultiEdit":
      return `Edited ${base(str(a.file_path)) || "a file"}`;
    case "Grep":
      return `Searched for “${str(a.pattern)}”`;
    case "Glob":
      return `Listed ${str(a.pattern) || "files"}`;
    case "look_at_media":
      return `Studied the reference${span(a)}${a.every_frame === true ? ", frame by frame" : ""}${a.zoom !== undefined ? ", zoomed in" : ""}`;
    case "media_transcript":
      return "Read the reference's words";
    case "listen":
      return `Listened${span(a)}`;
    case "find_in_footage":
      return `Found ${many(count(a.phrases) || 1, "line")} in the footage`;
    case "look_at_effect":
      return `Looked at ${str(a.name) || "the graphic"}${span(a)}${a.every_frame === true ? ", frame by frame" : ""}${a.beside !== undefined ? ", beside the reference" : ""}${a.zoom !== undefined ? ", zoomed in" : ""}`;
    case "search_web":
    case "WebSearch":
      return `Searched “${str(a.query)}”`;
    case "read_page":
    case "WebFetch":
      return `Read ${host(str(a.url))}`;
    case "get_edit_context":
      return count(a.clip_ids) > 0 ? `Read ${many(count(a.clip_ids), "clip")} of the edit` : "Read the edit";
    case "read_skill":
    case "skill":
      return str(a.name) ? `Read the ${str(a.name)} notes` : "Read its notes";
    case "apply_edit_plan":
      return count(a.operations) > 1 ? `Changed the edit (${count(a.operations)} changes)` : "Changed the edit";
    case "batch":
      return `Ran ${many(count(a.calls) || 1, "step")} at once`;
    case "add_effect":
      return `Placed ${str(a.name) || "a graphic"}`;
    case "effect_picture":
      return `Gave ${str(a.name) || "the graphic"} a picture${str(a.as) ? ` (${str(a.as)})` : ""}`;
    case "effect_track":
      return `Tracked ${str(a.as) || "a region"} for ${str(a.name) || "the graphic"}`;
    case "effect_beneath":
    case "effect_footage":
      return `Gave ${str(a.name) || "the graphic"} its footage`;
    case "set_ranges":
      return a.cut_ins === true ? "Marked every cut-in to export" : count(a.ranges) === 0 ? "Cleared the marked stretches" : `Marked ${many(count(a.ranges), "stretch", "stretches")} to export`;
    case "fetch_font":
      return `Fetched the font ${str(a.family)}`.trim();
    case "save_to_library":
      return `Saved ${str(a.name) || "it"} to the library`;
    case "use_from_library":
      return `Used ${str(a.name) || "a graphic"} from the library`;
    case "wait":
      return "Waited for work to finish";
    case "import_link":
      return `Brought in ${host(str(a.url))}`;
    default: {
      const name = (entry.tool ?? "step").replace(/^mcp__\w+__/u, "").replace(/_/gu, " ");
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }
}

/** A kind's words for a group: "ran 2 commands", "changed a file", "looked at the graphic 4 times". */
export function kindPhrase(kind: StepKind, calls: AgentEntry[]): string {
  const n = calls.length;
  const times = (said: string) => (n === 1 ? said : `${said} ${n} times`);
  switch (kind) {
    case "command":
      return `ran ${many(n, "command")}`;
    case "read":
      return `read ${many(new Set(calls.map((call) => str(argsOf(call).file_path))).size, "file")}`;
    case "change":
      return `edited ${many(new Set(calls.map((call) => str(argsOf(call).file_path))).size, "file")}`;
    case "search":
      return times("searched the code");
    case "reference":
      return times("studied the reference");
    case "graphic":
      return times("looked at the graphic");
    case "web":
      return times("searched the web");
    case "edit":
      return `made ${many(n, "change")} to the edit`;
    case "notes":
      return times("read the notes");
    case "picture":
      return `brought in ${many(n, "picture")}`;
    case "wait":
      return times("waited");
    default:
      return `ran ${many(n, "step")}`;
  }
}

/** The kind most of a group's steps are (the first such, on a tie): its icon. */
export function groupKind(calls: AgentEntry[]): StepKind {
  const counts = new Map<StepKind, number>();
  for (const call of calls) counts.set(stepKind(call.tool), (counts.get(stepKind(call.tool)) ?? 0) + 1);
  let best: StepKind = "other";
  let most = 0;
  for (const [kind, n] of counts) {
    if (n > most) {
      best = kind;
      most = n;
    }
  }
  return best;
}

/** "a", "a and b", "a, b and c": the last joined by "and". */
export function joinPhrases(phrases: string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? "";
  return `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;
}

/** "967K", "22.7K", "1.2M": a count of tokens, short. */
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 100_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}K`;
  return String(Math.round(n));
}
