// Shapes the flat chat into phi-style turns: your message, the work (tool
// calls grouped, interim notes), then the answer.

import type { ThumbRun } from "@edit/types/thumbnails";

import type { AgentEntry } from "./agent";
import { argsOf, joinPhrases, kindPhrase, stepKind, stepTitle, type StepKind } from "./steps";

export type TurnPart =
  | { kind: "group"; id: string; calls: AgentEntry[] }
  | { kind: "entry"; entry: AgentEntry }
  | { kind: "thinking"; id: string; text: string; active: boolean };

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
  /** When it began (its message, else its first entry). */
  startedAt: number;
  live: boolean;
}

/** A picture given with a message is shown above it; a client that writes it into the words as "[Image: image.png; ref=…]" has that text dropped. */
export function shownText(text: string): string {
  return text
    .replace(/\[Image:[^\]]*\]/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
      // A sub-agent's card (the fresh-eyes pass) and a compaction's line stay in view with the answer, never folded into the work.
      if (part.kind === "entry" && (index === lastAssistant || part.entry.kind === "error" || part.entry.kind === "subagent" || part.entry.kind === "compact")) answer.push(part.entry);
      else work.push(part);
    });
    const all = [current.user, ...parts.flatMap((part) => (part.kind === "group" ? part.calls : part.kind === "entry" ? [part.entry] : []))].filter(Boolean) as AgentEntry[];
    const start = current.user?.at ?? all[0]?.at ?? 0;
    const end = Math.max(...all.map((entry) => entry.updated || entry.at || 0));
    turns.push({ id: current.user?.id ?? all[0]?.id ?? String(turns.length), user: current.user, parts, work, answer, workedMs: Math.max(0, end - start), startedAt: start, live: false });
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
    } else if (entry.kind === "thinking") {
      current.parts.push({ kind: "thinking", id: entry.id, text: entry.text, active: entry.status === "running" });
    } else {
      current.parts.push({ kind: "entry", entry });
    }
  }
  close();
  if (running && turns.length) turns[turns.length - 1].live = true;
  return turns;
}

const samePart = (a: TurnPart, b: TurnPart): boolean =>
  a.kind === "group" ? b.kind === "group" && a.id === b.id && a.calls.length === b.calls.length && a.calls.every((call, index) => call === b.calls[index])
  : a.kind === "entry" ? b.kind === "entry" && a.entry === b.entry
  : b.kind === "thinking" && a.id === b.id && a.text === b.text && a.active === b.active;

/**
 * The turns, with each one that's made of the same entries as before kept as
 * the same object: a word streaming into the live turn re-renders that turn
 * alone, not every turn of a long chat (Nov 8 audit, item G).
 */
export function keepUnchanged(before: Turn[], after: Turn[]): Turn[] {
  let changed = before.length !== after.length;
  const turns = after.map((turn, index) => {
    const old = before[index];
    if (old !== undefined && old.live === turn.live && old.user === turn.user && old.parts.length === turn.parts.length && old.parts.every((part, at) => samePart(part, turn.parts[at]!))) return old;
    changed = true;
    return turn;
  });
  return changed ? turns : before;
}

const args = (entry: AgentEntry): Record<string, unknown> => {
  try {
    return JSON.parse(entry.detail ?? "{}") ?? {};
  } catch {
    return {};
  }
};

/** A tool argument as words: a string or number as itself, anything else (missing, an object) as `fallback`. */
const word = (value: unknown, fallback: string): string => (typeof value === "string" || typeof value === "number" ? String(value) : fallback);
const plural = (count: number, one: string, many = `${one}s`) => `${count === 1 ? "a" : count} ${count === 1 ? one : many}`;

/** What the idea page's tools did, when they said nothing of themselves. */
const IDEA_TOOLS: Record<string, string> = {
  save_titles: "Saved titles",
  remove_titles: "Removed titles",
  rename_title: "Renamed a title",
  set_main_title: "Chose the main title",
  save_thumbnail_guide: "Wrote the thumbnail guide",
  save_summary: "Wrote the summary",
};

/** A script's tools carry their own human label in the entry's text (writer/chat/turn.ts). */
const SCRIPT_TOOLS = new Set(["build_script", "plan_part", "read_timeline", "read_passages", "find_words", "remove_words", "insert_words", "arrange_word_clips", "arrange_time_clips", "insert_cut_in", "set_reuse_link", "move_clips", "reorder_clip", "trim_clip", "split_clip", "delete_items", "close_gaps", "set_label", "correct_word", "history", "select_clips", "move_playhead", "start_export", "inspect_frames", "read_assets", "curate_assets", "read_doc_comments", "find_silences", "read_audio", "review_cuts", "polish_clips", "remove_silences", "load_writing_skill", "read_script", "write_cut_ins", "set_outline", "set_opening", "add_section", "finish_section", "read_plan", "review_plan", "replace_items", "remove_items", "finish"]);

/** A thumbnail tool, as what it is doing and what it did. */
const THUMB_TOOLS: Record<string, [string, string]> = {
  make_picture: ["Making a picture on OpenArt", "Made a picture"],
  picture_prompt: ["Reading the picture's prompt", "Read the picture's prompt"],
  new_version: ["Starting another version", "Started another version"],
  switch_version: ["Switching version", "Switched version"],
  take_final: ["Taking the final version", "Took the final version"],
  remove_version: ["Removing a version", "Removed a version"],
  compare: ["Comparing pictures", "Compared pictures"],
  cut_out: ["Cutting out the subject", "Cut out the subject"],
  flatten: ["Flattening the layout", "Flattened the layout"],
  comments: ["Checking the comments", "Checked the comments"],
  remove_comment: ["Removing a comment", "Removed a comment"],
  look_at_comment: ["Looking at a comment", "Looked at a comment"],
  reply_to_comment: ["Answering a comment", "Answered a comment"],
  settle_comment: ["Settling a comment", "Settled a comment"],
  openart_models: ["Checking OpenArt's models", "Checked OpenArt's models"],
  model_options: ["Reading a model's options", "Read a model's options"],
  set_layers: ["Laying out the thumbnail", "Laid out the thumbnail"],
  change_layers: ["Changing the layers", "Changed the layers"],
  undo: ["Undoing a change", "Undid a change"],
  redo: ["Redoing a change", "Redid a change"],
  look: ["Looking at the thumbnail", "Looked at the thumbnail"],
  rename: ["Renaming the thumbnail", "Renamed the thumbnail"],
  save_overlay: ["Saving the overlay", "Saved the overlay to the library"],
  Read: ["Looking closely at a picture", "Looked at a picture"],
};

/**
 * Words for Claude between its steps, in place of the same "Thinking" over and
 * over (Sphe, Nov 4: "have a bunch of other synonyms over just thinking… take
 * inspiration from the claude synonyms"): short, and moving on every few
 * seconds while it goes on.
 */
export const THINKING_WORDS = [
  "Thinking",
  "Considering",
  "Mulling it over",
  "Deliberating",
  "Weighing it up",
  "Pondering",
  "Puzzling it out",
  "Reasoning",
  "Sizing it up",
  "Chewing it over",
  "Working it out",
  "Reflecting",
  "Piecing it together",
  "Contemplating",
  "Ruminating",
  "Cogitating",
  "Musing",
  "Percolating",
];

/** The word for `elapsed` ms into a stretch of thinking that began at `since`: a fresh one every 3.5 s, each stretch starting somewhere of its own. */
export function thinkingWord(since: number, elapsed: number): string {
  const start = Math.abs(Math.floor(since / 1000)) % THINKING_WORDS.length;
  return THINKING_WORDS[(start + Math.floor(Math.max(0, elapsed) / 3500)) % THINKING_WORDS.length]!;
}

/** How long, briefly: "8s", "1m 12s", "1h 4m". */
export function shortSpan(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** What Claude is doing on a thumbnail right now, in a few words: the tool it's in, else writing, else a thinking word. */
export function thumbActivity(run: ThumbRun | null, now = Date.now()): string {
  if (run === null || run.state === "queued") return "Waiting for a turn";
  const calls = run.trace?.flatMap((part) => (part.kind === "tools" ? part.calls : [])) ?? run.tools ?? [];
  const live = [...calls].reverse().find((call) => call.state === "running");
  if (live !== undefined) return THUMB_TOOLS[live.name]?.[0] ?? "Working";
  if (run.trace?.at(-1)?.kind === "text") return "Writing";
  return thinkingWord(run.startedAt, now - run.startedAt);
}

/** What Bodycam HQ's agent (Edit V2) is doing, in the stage words its viewer shows while it works. */
const HQ_STAGES: Record<string, string> = {
  import_link: "Bringing the video in",
  wait: "Bringing the video in",
  get_edit_context: "Reading the edit",
  skill: "Reading its notes",
  look_at_media: "Studying the reference",
  media_transcript: "Studying the reference",
  listen: "Studying the reference",
  read_transcript: "Studying the reference",
  Read: "Reading its code",
  Glob: "Reading its code",
  Grep: "Reading its code",
  Write: "Writing the graphic",
  Edit: "Writing the graphic",
  effect_picture: "Bringing a picture in",
  look_at_effect: "Looking at what it made",
  add_effect: "Placing it",
  add_clip: "Placing it",
  apply_edit_plan: "Placing it",
  batch: "Working",
};

/** The stage an HQ turn is at, from its chat: the tool running, else writing its reply, else thinking. */
export function hqActivity(entries: readonly AgentEntry[], now = Date.now()): string {
  const live = [...entries].reverse().find((entry) => entry.status === "running");
  if (live?.kind === "tool" && live.tool !== undefined) return HQ_STAGES[live.tool] ?? "Working";
  if (live?.kind === "assistant") return "Writing to you";
  if (live?.kind === "compact") return "Compacting context";
  const asked = [...entries].reverse().find((entry) => entry.kind === "user");
  const since = asked?.at ?? now;
  return thinkingWord(since, now - since);
}

/** A short, human title for one call. */
export function callTitle(entry: AgentEntry): string {
  if (entry.tool !== undefined && SCRIPT_TOOLS.has(entry.tool) && entry.text) return entry.text;
  // Claude Code's Read is a picture to the thumbnail agent; a file of code to Bodycam HQ's.
  const thumb = entry.tool !== undefined && !(entry.tool === "Read" && readsCode(entry)) ? THUMB_TOOLS[entry.tool] : undefined;
  if (thumb !== undefined) return entry.status === "running" ? thumb[0] : thumb[1];
  const a = args(entry);
  switch (entry.tool) {
    // The idea page's run (ideas/run.ts): the tool's own first sentence says what it did.
    case "save_titles":
    case "remove_titles":
    case "rename_title":
    case "set_main_title":
    case "save_thumbnail_guide":
    case "save_summary":
      return entry.text || IDEA_TOOLS[entry.tool];
    case "skip_case":
      return "Skipped the case";
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
      return `Changed ${word(a.clip_id, "a clip")}${keys.length ? ` · ${keys.slice(0, 3).join(", ")}` : ""}`;
    }
    case "delete_clips":
      return `Deleted ${plural(Array.isArray(a.clip_ids) ? a.clip_ids.length : 1, "clip")}`;
    case "set_keyframes":
      return `Animated ${word(a.param, "a value")}${a.clip_id ? ` on ${word(a.clip_id, "a clip")}` : ""}`;
    case "add_sound_effect":
      return `Added ${plural(Array.isArray(a.times) ? a.times.length : 1, word(a.sound, "sound"))}`;
    case "import_media":
      return `Imported ${plural(Array.isArray(a.paths) ? a.paths.length : 1, "file")}`;
    case "render_frame":
      return typeof a.time === "number" ? `Looked at ${a.time}s` : typeof a.frame === "number" ? `Looked at frame ${a.frame}` : "Looked at a frame";
    case "contact_sheet":
      return `Looked at ${typeof a.count === "number" ? a.count : 12} frames${typeof a.start === "number" ? ` from ${a.start}s` : ""}`;
    case "export":
      return "Started an export";
    case "transcribe":
      return "Started transcribing";
    default:
      return stepTitle(entry);
  }
}

const readsCode = (entry: AgentEntry) => {
  const path = argsOf(entry).file_path;
  return typeof path === "string" && path !== "" && !/\.(png|jpe?g|webp|gif|avif)$/iu.test(path);
};

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
      add_sound_effect: "sound",
      render_frame: "frame",
      contact_sheet: "frame",
      export: "started an export",
      transcribe: "started transcribing",
      save_titles: "saved titles",
      remove_titles: "removed titles",
      rename_title: "renamed a title",
      set_main_title: "chose the main title",
      save_thumbnail_guide: "wrote the thumbnail guide",
      save_summary: "wrote the summary",
      skip_case: "skipped the case",
      Read: "picture",
      make_picture: "made",
      picture_prompt: "read a picture's prompt",
      new_version: "started another version",
      switch_version: "switched version",
      take_final: "took the final version",
      openart_models: "checked OpenArt's models",
      model_options: "read a model's options",
      set_layers: "laid out the thumbnail",
      change_layers: "changed the layers",
      undo: "undid a change",
      redo: "redid a change",
      look: "looked at the thumbnail",
      rename: "renamed the thumbnail",
    })[tool ?? ""];
  // Steps of no house bucket: by their kind (steps.ts), "edited 2 files".
  const kinds = new Map<StepKind, AgentEntry[]>();
  // Calls under each phrase, to keep the biggest when there are many.
  const steps = new Map<string, number>();
  for (const call of calls) {
    const key = call.tool === "Read" && readsCode(call) ? undefined : bucket(call.tool);
    if (key === undefined) {
      const kind = stepKind(call.tool);
      if (!kinds.has(kind)) order.push(`kind:${kind}`);
      kinds.set(kind, [...(kinds.get(kind) ?? []), call]);
      steps.set(`kind:${kind}`, (steps.get(`kind:${kind}`) ?? 0) + 1);
      continue;
    }
    if (!counts.has(key)) order.push(key);
    steps.set(key, (steps.get(key) ?? 0) + 1);
    counts.set(key, (counts.get(key) ?? 0) + (call.tool === "contact_sheet" ? Number(args(call).count ?? (Array.isArray(args(call).times) ? (args(call).times as unknown[]).length : 12)) : 1));
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
      case "sound":
        return `added ${plural(count, "sound effect")}`;
      case "frame":
        return `looked at ${plural(count, "frame")}`;
      case "picture":
        return `looked at ${plural(count, "picture")}`;
      case "made":
        return `made ${plural(count, "picture")}`;
      default:
        return key.startsWith("kind:") ? kindPhrase(key.slice(5) as StepKind, kinds.get(key.slice(5) as StepKind) ?? []) : key;
    }
  };
  // Past three kinds: the two with the most steps (in order), the rest as a count of steps.
  let keys = order;
  let rest = 0;
  if (order.length > 3) {
    const kept = new Set([...order].sort((a, b) => (steps.get(b) ?? 0) - (steps.get(a) ?? 0)).slice(0, 2));
    keys = order.filter((key) => kept.has(key));
    rest = order.filter((key) => !kept.has(key)).reduce((sum, key) => sum + (steps.get(key) ?? 0), 0);
  }
  const phrases = keys.map((key) => phrase(key, counts.get(key) ?? 1));
  const text = joinPhrases(rest > 0 ? [...phrases, rest === 1 ? "one more step" : `${rest} more steps`] : phrases);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A live turn's line once it's into real work (Sphe, Nov 2: "we should have a
 * \"Working for _\" when an agent is running long stuff like when it starts
 * calling tools"): after its first tool, or a few seconds in.
 */
export const WORKING_AFTER_MS = 5000;

export function isWorking(elapsedMs: number, usedTools: boolean): boolean {
  return usedTools || elapsedMs >= WORKING_AFTER_MS;
}

/** "Working for 8s", "Working for 1m 12s", "Working for 1h 4m": to the second while it runs. */
export function formatWorking(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `Working for ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Working for ${minutes}m ${seconds % 60}s`;
  return `Working for ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The agent's time on this edit so far: every turn's work added up (the
 * workflow, its automatic follow-ups, a turn carried on after a restart),
 * the live one to `now`; the waits between turns aren't in it. JJ, Nov 3: "Is
 * it possible to get some kind of tracker on how long each edit takes?"
 */
export function editWorked(turns: Turn[], now: number): { ms: number; turns: number } {
  let ms = 0;
  let counted = 0;
  for (const turn of turns) {
    const worked = turn.live && turn.startedAt > 0 ? Math.max(0, now - turn.startedAt) : turn.workedMs;
    if (worked <= 0 && !turn.live) continue;
    ms += worked;
    counted += 1;
  }
  return { ms, turns: counted };
}

/** "8s", "12m", "1h 4m": a total's length. */
export function formatSpan(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatWorked(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "Worked";
  if (seconds < 60) return `Worked for ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `Worked for ${minutes}m` : `Worked for ${Math.round(minutes / 60)}h`;
}

/** A tool as an idea's or a thumbnail's conversation keeps it. */
type KeptTool = { id?: string; name: string; state: "running" | "done" | "error"; detail?: string };

/** A turn of an idea's or a thumbnail's conversation, kept on the team's record. */
type KeptTurn = { role: "you" | "claude"; text: string; at: number; workedMs?: number; tools?: KeptTool[]; failed?: boolean };

/** The turn still running on this Mac: its words, reasoning and tools in order when it has them (`trace`), else its tools and words so far. */
type KeptRun = {
  startedAt: number;
  said?: string;
  tools?: KeptTool[];
  trace?: ({ kind: "thinking"; text: string; active: boolean } | { kind: "text"; text: string } | { kind: "tools"; calls: KeptTool[] })[];
};

const liveStatus = (state: KeptTool["state"]): AgentEntry["status"] => (state === "running" ? "running" : state === "error" ? "failed" : "done");

/**
 * An idea's or a thumbnail's conversation as the editor's chat entries: each
 * request (with the pictures given with it), the tools Claude ran for it
 * (folded behind "Worked for …" once it's done), its answer, a turn that
 * failed as the chat's problem; then the turn still running, when there is one.
 */
export function conversationEntries<T extends KeptTurn>(chat: T[], createdAt: number, run: KeptRun | null, attachments: (turn: T) => NonNullable<AgentEntry["attachments"]>): AgentEntry[] {
  const entries: AgentEntry[] = [];
  let asked = createdAt;
  chat.forEach((turn, index) => {
    if (turn.role === "you") {
      asked = turn.at;
      const files = attachments(turn);
      entries.push({ id: `turn-${index}`, kind: "user", text: turn.text, at: turn.at, ...(files.length > 0 ? { attachments: files } : {}) });
      return;
    }
    const began = turn.workedMs !== undefined ? turn.at - turn.workedMs : asked;
    (turn.tools ?? []).forEach((tool, at) =>
      entries.push({ id: `turn-${index}-${at}`, kind: "tool", tool: tool.name, text: tool.detail ?? "", status: tool.state === "error" ? "failed" : tool.state === "running" ? "stopped" : "done", at: began, updated: began }),
    );
    entries.push({ id: `turn-${index}`, kind: turn.failed ? "error" : "assistant", text: turn.text, at: turn.at, updated: turn.at });
  });
  if (run === null) return entries;
  const at = run.startedAt;
  if (run.trace !== undefined) {
    run.trace.forEach((part, index) => {
      if (part.kind === "text") entries.push({ id: `live-${at}-text-${index}`, kind: "assistant", text: part.text, at });
      else if (part.kind === "thinking") entries.push({ id: `live-${at}-think-${index}`, kind: "thinking", text: part.text, status: part.active ? "running" : "done", at });
      else part.calls.forEach((tool, call) => entries.push({ id: tool.id ? `live-${tool.id}` : `live-${at}-tool-${index}-${call}`, kind: "tool", tool: tool.name, text: tool.detail ?? "", ...(tool.detail ? { detail: tool.detail } : {}), status: liveStatus(tool.state), at }));
    });
    return entries;
  }
  (run.tools ?? []).forEach((tool, index) => entries.push({ id: `live-${at}-${index}`, kind: "tool", tool: tool.name, text: tool.detail ?? "", status: liveStatus(tool.state), at }));
  if (run.said) entries.push({ id: `live-${at}-said`, kind: "assistant", text: run.said, at });
  return entries;
}

/** How many of the person's messages a chat holds, and when the newest was sent. */
export function userMessages(entries: AgentEntry[]): { asked: number; newest: number } {
  const users = entries.filter((entry) => entry.kind === "user");
  return { asked: users.length, newest: users.reduce((latest, entry) => Math.max(latest, entry.at ?? 0), 0) };
}

/**
 * Whether a message held on screen since it was sent has come back in the
 * chat: there are more of the person's messages, or a newer one. A chat kept
 * to its last turns (a thumbnail's 80) drops its oldest as one lands, so the
 * count alone stays put and the message showed twice for good (Nov 5,
 * "Officers Traumatized…").
 */
export function sentLanded(entries: AgentEntry[], held: { asked: number; newest: number }): boolean {
  const now = userMessages(entries);
  return now.asked > held.asked || now.newest > held.newest;
}
