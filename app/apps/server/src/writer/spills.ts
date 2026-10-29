// Words that spilled across a change of speaker, put back with who said them,
// by Edit's turns.ts (Repack's, ported): each recording's words on their own,
// or only the stretches asked about. Never fails: without an answer the
// words stay as they were.

import type { Script, Word } from "@edit/types/writer";

import * as diag from "../diag.ts";
import { join } from "../paths.ts";
import { fixTurns, type TurnWord } from "../turns.ts";
import { post } from "../watch.ts";
import { partAt } from "./tidy.ts";

/** How many words went to another speaker. */
export async function fix(script: Script, dir: string, within: [number, number][] | null = null): Promise<number> {
  const parts = script.parts ?? [];
  // Runs of words that never cross a recording (or a stretch asked about).
  const runs: Word[][] = [];
  let current: Word[] = [];
  let at: string | null = null;
  for (const word of script.words) {
    const stretch = within === null ? -1 : within.findIndex(([from, to]) => word.startMs >= from && word.startMs < to);
    if (within !== null && stretch < 0) {
      if (current.length > 0) runs.push(current);
      current = [];
      at = null;
      continue;
    }
    const key = `${partAt(parts, word.startMs)}:${stretch}`;
    if (key !== at && current.length > 0) {
      runs.push(current);
      current = [];
    }
    at = key;
    current.push(word);
  }
  if (current.length > 0) runs.push(current);
  const name = (speaker: string) => script.speakers?.[speaker] ?? speaker;
  let moved = 0;
  for (const run of runs) {
    if (new Set(run.map((word) => word.speaker ?? "")).size < 2) continue;
    const turns: TurnWord[] = run.map((word) => ({ text: script.corrections?.[word.id] ?? word.text, speaker: word.speaker ?? null, start_ms: word.startMs, end_ms: word.endMs }));
    try {
      moved += await fixTurns(turns, name, script.title, join(dir, "spills"), post);
    } catch (error) {
      diag.warn("writer", `${script.title}: spilled words not checked: ${diag.messageOf(error)}`);
      continue;
    }
    turns.forEach((turn, index) => {
      if (turn.speaker != null) run[index]!.speaker = turn.speaker;
    });
  }
  return moved;
}
