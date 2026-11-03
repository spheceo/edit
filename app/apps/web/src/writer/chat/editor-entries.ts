// A script's conversation as the editor chat's entries, so the script,
// ideas, thumbnails and editor chats all render through the same turns
// and composer (ChatTurns + ChatComposer). Only the words differ: a
// script tool's label is its entry text, named by toolLabel.

import type { AgentEntry } from "../../lib/agent";
import type { ChatTurn } from "../types";
import { toolLabel, turnParts } from "./turn";

type LiveTurn = { text: string; trace?: ChatTurn["trace"] };

function assistantEntries(prefix: string, text: string, trace: ChatTurn["trace"], at: number, failed?: boolean, workedMs?: number): AgentEntry[] {
  if (failed) return [...assistantEntries(prefix, "", trace, at, false, workedMs), { id: `${prefix}-error`, kind: "error", text, at }];
  const entries: AgentEntry[] = [];
  const updated = workedMs !== undefined ? at + workedMs : undefined;
  turnParts(text, trace ?? []).forEach((part, index) => {
    if (part.type === "text") {
      entries.push({ id: `${prefix}-text-${index}`, kind: "assistant", text: part.text, at, updated });
    } else {
      part.calls.forEach((call) => {
        entries.push({
          id: `${prefix}-tool-${call.id}`,
          kind: "tool",
          tool: call.tool,
          text: call.label || toolLabel(call.tool ?? "", call.state !== "running"),
          detail: call.detail,
          status: call.state === "error" ? "failed" : call.state === "running" ? "running" : "done",
          at,
          updated,
        });
      });
    }
  });
  return entries;
}

/**
 * Saved turns, the turn being written (`live`, with what was just asked
 * as `sent`), in the editor chat's shape. Reset asks are left out: the
 * caller shows them in the composer's tray, as the editor does.
 */
export function scriptEntries(chat: ChatTurn[], live?: LiveTurn | null, sent?: string | null): AgentEntry[] {
  const entries: AgentEntry[] = [];
  chat.forEach((turn, index) => {
    if (turn.reset) return;
    if (turn.role === "producer") {
      entries.push({ id: `saved-${index}-user`, kind: "user", text: turn.text, at: turn.at });
    } else {
      entries.push(...assistantEntries(`saved-${index}`, turn.text, turn.trace, turn.at, turn.failed, turn.workedMs));
    }
  });
  if (sent) entries.push({ id: "live-user", kind: "user", text: sent, at: Date.now() });
  if (live) entries.push(...assistantEntries("live", live.text, live.trace, Date.now()));
  return entries;
}

/** The ids already on disk, so only a live turn animates in. */
export function savedEntryIds(chat: ChatTurn[]): Set<string> {
  return new Set(scriptEntries(chat).map((entry) => entry.id));
}
