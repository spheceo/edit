// The turn Claude is working on, as Repack's chat shows it: what it has said
// and the tools it ran, in order (the user, Oct 30: "have the EXACT chat
// viewer that repack has ... the tool icons"). A job's work runs inside its
// turn, so Claude's stream (claude.ts) records into it and the chat
// (chat.ts) saves it with the answer, without either being handed it.

import { AsyncLocalStorage } from "node:async_hooks";

import type { ToolCall, ToolGroup } from "@edit/types/writer";

export type Thought = { at: number; text: string };

/**
 * One turn. `thinking` is the reasoning block being written (empty once it
 * ends); `thinkingOn` stays set through a redacted block that sends no text.
 * Finished blocks sit in `thoughts`, at how long the answer was when they ended.
 */
export type Turn = {
  text: string;
  trace: ToolGroup[];
  startedAt: number;
  thinking?: string;
  thinkingOn?: boolean;
  thoughts?: Thought[];
};

/** The turn as it happened, for a chat that shows the trace while it runs. */
export type LivePart =
  | { kind: "thinking"; text: string; active: boolean }
  | { kind: "text"; text: string }
  | { kind: "tools"; calls: ToolCall[] };

const current = new AsyncLocalStorage<Turn>();

/** Runs `work` with `turn` as the turn being worked on. */
export const within = <T>(turn: Turn, work: () => Promise<T>): Promise<T> => current.run(turn, work);

/** The turn being worked on here, if any. */
export const turn = (): Turn | undefined => current.getStore();

/** Words Claude wrote, after what it said before. */
export function said(text: string): void {
  const at = current.getStore();
  const words = text.trim();
  if (at === undefined || words === "") return;
  at.text = at.text === "" ? words : `${at.text}\n\n${words}`;
}

/**
 * A tool starting or settling, as Repack's traceTool records it: tools with no
 * words between them share a group, so a run of reads shows as one block.
 */
export function tool(call: ToolCall): void {
  const at = current.getStore();
  if (at === undefined) return;
  const known = at.trace.find((group) => group.calls.some((one) => one.id === call.id));
  if (known !== undefined) {
    known.calls = known.calls.map((one) => (one.id === call.id ? { ...one, ...call, tool: call.tool ?? one.tool } : one));
    return;
  }
  const offset = at.text.trimEnd().length;
  const last = at.trace.at(-1);
  if (last !== undefined && last.at >= offset) last.calls.push(call);
  else at.trace.push({ at: offset, calls: [call] });
}

/** The model opened a reasoning block (a redacted one may never send text). */
export function thinkingBegan(): void {
  const at = current.getStore();
  if (at !== undefined) at.thinkingOn = true;
}

/** More of the reasoning block being written. */
export function thinkingMore(text: string): void {
  const at = current.getStore();
  if (at === undefined || text === "") return;
  at.thinkingOn = true;
  at.thinking = `${at.thinking ?? ""}${text}`.slice(-8000);
}

/** Drop the live reasoning block without keeping it (the reply carries the text). */
export function dropThinking(): void {
  const at = current.getStore();
  if (at === undefined) return;
  at.thinking = "";
  at.thinkingOn = false;
}

/** The live reasoning block ended. Keep its text in the trace, ahead of whatever is said next. */
export function endThinking(): void {
  const at = current.getStore();
  if (at === undefined) return;
  const text = at.thinking?.trim() ?? "";
  at.thinking = "";
  at.thinkingOn = false;
  if (text !== "") keepThought(text);
}

/** A finished reasoning block, where the answer had got to. The same text at the same spot is kept once. */
export function keepThought(text: string): void {
  const at = current.getStore();
  const words = text.trim();
  if (at === undefined || words === "") return;
  const offset = at.text.trimEnd().length;
  const thoughts = (at.thoughts ??= []);
  const kept = words.length > 4000 ? `${words.slice(0, 3997)}…` : words;
  const last = thoughts.at(-1);
  if (last !== undefined && last.at === offset && last.text === kept) return;
  thoughts.push({ at: offset, text: kept });
}

/**
 * Words, reasoning and tools in the order they happened. A reasoning block
 * still being written is last, so the chat can show it while it grows.
 */
export function partsOf(turn: Turn): LivePart[] {
  const marks: ({ at: number; order: number } & ({ kind: "thinking"; text: string } | { kind: "tools"; calls: ToolCall[] }))[] = [];
  (turn.thoughts ?? []).forEach((thought, index) => marks.push({ at: thought.at, order: index * 2, kind: "thinking", text: thought.text }));
  turn.trace.forEach((group, index) => marks.push({ at: group.at, order: index * 2 + 1, kind: "tools", calls: group.calls }));
  marks.sort((a, b) => a.at - b.at || a.order - b.order);
  const parts: LivePart[] = [];
  let from = 0;
  for (const mark of marks) {
    const at = Math.min(Math.max(mark.at, from), turn.text.length);
    const said = turn.text.slice(from, at).trim();
    if (said !== "") parts.push({ kind: "text", text: said });
    if (mark.kind === "thinking") parts.push({ kind: "thinking", text: mark.text, active: false });
    else parts.push({ kind: "tools", calls: mark.calls });
    from = at;
  }
  const rest = turn.text.slice(from).trim();
  if (rest !== "") parts.push({ kind: "text", text: rest });
  const pending = turn.thinking?.trim() ?? "";
  if (turn.thinkingOn === true || pending !== "") parts.push({ kind: "thinking", text: pending, active: true });
  return parts;
}

/**
 * A tool's own input, in one line, while it is still running: the prompt or
 * the words, not the whole argument object.
 */
export function inputDetail(input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const prompt = typeof record.prompt === "string" ? record.prompt : typeof record.text === "string" ? record.text : typeof record.title === "string" ? record.title : "";
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  if (line === "") return undefined;
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/**
 * What a tool's answer says of itself, for its row: its first sentence, short
 * ("Outline set: 6 sections."), not what it tells Claude next ("End your turn
 * now.") nor the list it goes on to; nothing for data.
 */
export function detailOf(result: string): string | undefined {
  const line = result.trim().split("\n")[0]?.trim() ?? "";
  if (line === "" || line.startsWith("{") || line.startsWith("[")) return undefined;
  const first = (line.split(/(?<=[.!?])\s+/)[0] ?? line).replace(/:$/, "").trim();
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}
