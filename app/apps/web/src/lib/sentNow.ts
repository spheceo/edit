// A message shown the moment it's sent, before the chat it went to has it
// (Sphe, Nov 4: "when you send a prompt it should show up instantly"). One
// rule for every chat: the editor's, an idea's, a thumbnail's. It shows until
// the chat has one more of the person's messages than when it was sent (or a
// newer one), and goes if the send was refused.

import { useMemo } from "react";
import { create } from "zustand";

import type { AgentEntry } from "./agent";
import { sentLanded, userMessages } from "./agentTurns";

interface Held {
  text: string;
  at: number;
  asked: number;
  newest: number;
  attachments?: AgentEntry["attachments"];
}

const useHeld = create<Record<string, Held | undefined>>(() => ({}));

/** Shows `text` in `chat` now; `entries` is the chat as it is, so its landing can be told. */
export function holdSent(chat: string, entries: AgentEntry[], text: string, attachments?: AgentEntry["attachments"]): void {
  const { asked, newest } = userMessages(entries);
  useHeld.setState({ [chat]: { text, at: Date.now(), asked, newest, ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}) } });
}

export function dropSent(chat: string): void {
  if (useHeld.getState()[chat] !== undefined) useHeld.setState({ [chat]: undefined });
}

/** Whether `chat` has a message on screen its entries don't have yet. */
export function sending(chat: string, entries: AgentEntry[]): boolean {
  const held = useHeld.getState()[chat];
  return held !== undefined && !sentLanded(entries, held);
}

function withHeld(entries: AgentEntry[], held: Held | undefined): AgentEntry[] {
  if (held === undefined || sentLanded(entries, held)) return entries;
  return [...entries, { id: `sent-${held.at}`, kind: "user", text: held.text, at: held.at, updated: held.at, ...(held.attachments !== undefined ? { attachments: held.attachments } : {}) }];
}

/** The chat's entries with the message just sent, `sending` while it's only here; `hold` and `drop` for this chat. */
export function useSentNow(chat: string, entries: AgentEntry[]) {
  const held = useHeld((state) => state[chat]);
  const shown = useMemo(() => withHeld(entries, held), [entries, held]);
  return {
    entries: shown,
    sending: shown !== entries,
    hold: (text: string, attachments?: AgentEntry["attachments"]) => holdSent(chat, entries, text, attachments),
    drop: () => dropSent(chat),
  };
}
