// The conversation with the editor on a footage script: what the producer
// asked and what Claude answered, build and revision alike, kept beside the
// script (`chat.json`) so it survives a reload and goes back to Claude as
// context on the next request, as Repack keeps a script's chat.

import * as fs from "node:fs";

import type { ChatTurn } from "@edit/types/writer";

import { writeAtomic } from "../files.ts";
import { join } from "../paths.ts";

/** Turns kept, and how many recent ones go back to Claude. */
const KEPT = 80;
export const SENT = 20;

export function read(dir: string): ChatTurn[] {
  try {
    return JSON.parse(fs.readFileSync(join(dir, "chat.json"), "utf8")) as ChatTurn[];
  } catch {
    return [];
  }
}

function write(dir: string, turns: ChatTurn[]): void {
  writeAtomic(join(dir, "chat.json"), JSON.stringify(turns.slice(-KEPT), null, 2));
}

export function add(dir: string, role: ChatTurn["role"], text: string, costUsd: number | null = null, failed = false): void {
  const turns = read(dir);
  turns.push({ role, text: text.trim(), at: Date.now(), ...(costUsd === null ? {} : { costUsd }), ...(failed ? { failed } : {}) });
  try {
    write(dir, turns);
  } catch {
    // The conversation is a record; a failed write never fails the work.
  }
}

/** Claude's answer asking to start the script over, waiting for the producer; an earlier ask still waiting is declined. */
export function askReset(dir: string, text: string, costUsd: number | null): void {
  const turns = read(dir).map((turn): ChatTurn => (turn.reset === "pending" ? { ...turn, reset: "declined" } : turn));
  turns.push({ role: "editor", text: text.trim(), at: Date.now(), ...(costUsd === null ? {} : { costUsd }), reset: "pending" });
  write(dir, turns);
}

/** The producer's answer to the waiting ask. */
export function settleReset(dir: string, accepted: boolean): void {
  const turns = read(dir);
  const turn = turns.findLast((one) => one.reset === "pending");
  if (turn === undefined) throw new Error("Claude hasn't asked to start over.");
  turn.reset = accepted ? "accepted" : "declined";
  write(dir, turns);
}

/** Starts the conversation again; the script's edits stay. */
export function clear(dir: string): void {
  fs.rmSync(join(dir, "chat.json"), { force: true });
}

/** The recent conversation, as context for Claude. */
export function recent(dir: string): string {
  return read(dir)
    .slice(-SENT)
    .map((turn) => `${turn.role === "producer" ? "Producer" : "Editor"}: ${turn.text}`)
    .join("\n\n");
}
