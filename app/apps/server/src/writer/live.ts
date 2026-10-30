// The turn Claude is working on, as Repack's chat shows it: what it has said
// and the tools it ran, in order (the user, Oct 30: "have the EXACT chat
// viewer that repack has ... the tool icons"). A job's work runs inside its
// turn, so Claude's stream (claude.ts) records into it and the chat
// (chat.ts) saves it with the answer, without either being handed it.

import { AsyncLocalStorage } from "node:async_hooks";

import type { ToolCall, ToolGroup } from "@edit/types/writer";

export type Turn = { text: string; trace: ToolGroup[]; startedAt: number };

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
