// Shapes the flat chat into phi-style turns: your message, the work (tool
// calls grouped, interim notes), then the answer.

import type { AgentEntry } from "./agent";

export type TurnPart = { kind: "group"; id: string; calls: AgentEntry[] } | { kind: "entry"; entry: AgentEntry };

export interface Turn {
  id: string;
  user?: AgentEntry;
  /** Everything after the message, in order (how a live turn is shown). */
  parts: TurnPart[];
  /** Tool groups and interim notes: shown live, folded once the turn ends. */
  work: TurnPart[];
  /** The reply that stays visible (last assistant message) and any errors. */
  answer: AgentEntry[];
  workedMs: number;
  live: boolean;
}

export function buildTurns(entries: AgentEntry[], running: boolean): Turn[] {
  const turns: Turn[] = [];
  let current: { user?: AgentEntry; parts: TurnPart[] } | null = null;
  const close = () => {
    if (!current) return;
    const parts = current.parts;
    // The last assistant message is the answer; errors always show.
    let lastAssistant = -1;
    parts.forEach((part, index) => {
      if (part.kind === "entry" && part.entry.kind === "assistant" && part.entry.text) lastAssistant = index;
    });
    const work: TurnPart[] = [];
    const answer: AgentEntry[] = [];
    parts.forEach((part, index) => {
      if (part.kind === "entry" && (index === lastAssistant || part.entry.kind === "error")) answer.push(part.entry);
      else work.push(part);
    });
    const all = [current.user, ...parts.flatMap((part) => (part.kind === "group" ? part.calls : [part.entry]))].filter(Boolean) as AgentEntry[];
    const start = current.user?.at ?? all[0]?.at ?? 0;
    const end = Math.max(...all.map((entry) => entry.updated || entry.at || 0));
    turns.push({ id: current.user?.id ?? all[0]?.id ?? String(turns.length), user: current.user, parts, work, answer, workedMs: Math.max(0, end - start), live: false });
    current = null;
  };
  for (const entry of entries) {
    if (entry.kind === "user") {
      close();
      current = { user: entry, parts: [] };
      continue;
    }
    current ??= { parts: [] };
    const last = current.parts.at(-1);
    if (entry.kind === "tool") {
      if (last?.kind === "group") last.calls.push(entry);
      else current.parts.push({ kind: "group", id: entry.id, calls: [entry] });
    } else {
      current.parts.push({ kind: "entry", entry });
    }
  }
  close();
  if (running && turns.length) turns[turns.length - 1].live = true;
  return turns;
}

const args = (entry: AgentEntry): Record<string, unknown> => {
  try {
    return JSON.parse(entry.detail ?? "{}") ?? {};
  } catch {
    return {};
  }
};

const plural = (count: number, one: string, many = `${one}s`) => `${count === 1 ? "a" : count} ${count === 1 ? one : many}`;

/** A short, human title for one call. */
export function callTitle(entry: AgentEntry): string {
  const a = args(entry);
  switch (entry.tool) {
    case "get_project":
      return "Read the project";
    case "list_projects":
      return "Listed projects";
    case "read_transcript":
      return "Read the transcript";
    case "add_text":
      return typeof a.text === "string" ? `Added “${a.text.split("\n")[0]}”` : "Added a title";
    case "add_clip": {
      const clip = a.clip as { type?: string } | undefined;
      return `Added ${clip?.type === "adjustment" ? "an adjustment layer" : clip?.type ? `a ${clip.type} clip` : "a clip"}`;
    }
    case "update_clip": {
      const keys = Object.keys((a.patch as object) ?? {});
      return `Changed ${a.clip_id ?? "a clip"}${keys.length ? ` · ${keys.slice(0, 3).join(", ")}` : ""}`;
    }
    case "delete_clips":
      return `Deleted ${plural(Array.isArray(a.clip_ids) ? a.clip_ids.length : 1, "clip")}`;
    case "set_keyframes":
      return `Animated ${a.param ?? "a value"}${a.clip_id ? ` on ${a.clip_id}` : ""}`;
    case "import_media":
      return `Imported ${plural(Array.isArray(a.paths) ? a.paths.length : 1, "file")}`;
    case "render_frame":
      return typeof a.time === "number" ? `Looked at ${a.time}s` : typeof a.frame === "number" ? `Looked at frame ${a.frame}` : "Looked at a frame";
    case "contact_sheet":
      return `Looked at ${a.count ?? 12} frames${typeof a.start === "number" ? ` from ${a.start}s` : ""}`;
    case "export":
      return "Started an export";
    case "transcribe":
      return "Started transcribing";
    default:
      return entry.tool ?? "Tool";
  }
}

/** "Read the project, added 2 titles, looked at a frame". */
export function groupSummary(calls: AgentEntry[]): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  const bucket = (tool?: string) =>
    ({
      get_project: "read the project",
      list_projects: "listed projects",
      read_transcript: "read the transcript",
      add_text: "title",
      add_clip: "clip",
      update_clip: "change",
      set_keyframes: "animation",
      delete_clips: "deletion",
      import_media: "import",
      render_frame: "frame",
      contact_sheet: "frame",
      export: "started an export",
      transcribe: "started transcribing",
    })[tool ?? ""] ?? "step";
  for (const call of calls) {
    const key = bucket(call.tool);
    if (!counts.has(key)) order.push(key);
    counts.set(key, (counts.get(key) ?? 0) + (call.tool === "contact_sheet" ? Number(args(call).count ?? 12) : 1));
  }
  const phrase = (key: string, count: number) => {
    switch (key) {
      case "title":
        return `added ${plural(count, "title")}`;
      case "clip":
        return `added ${plural(count, "clip")}`;
      case "change":
        return `made ${plural(count, "change")}`;
      case "animation":
        return `animated ${plural(count, "value")}`;
      case "deletion":
        return `deleted clips`;
      case "import":
        return `imported media`;
      case "frame":
        return `looked at ${plural(count, "frame")}`;
      case "step":
        return `ran ${plural(count, "step")}`;
      default:
        return key;
    }
  };
  const text = order.map((key) => phrase(key, counts.get(key) ?? 1)).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatWorked(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "Worked";
  if (seconds < 60) return `Worked for ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `Worked for ${minutes}m` : `Worked for ${Math.round(minutes / 60)}h`;
}
