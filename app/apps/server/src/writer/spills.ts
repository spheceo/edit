// Words that spilled across a change of speaker, put back with who said them,
// by Edit's turns.ts (Repack's, ported): each recording's words on their own,
// or only the stretches asked about. Never fails: without an answer the
// words stay as they were.

import type { Script, Word } from "@edit/types/writer";

import * as diag from "../diag.ts";
import { join } from "../paths.ts";
import { fixTurns, type TurnWord } from "../turns.ts";
import { spills as post } from "../ai_claude.ts";
import { partAt } from "./tidy.ts";

/** How many words went to another speaker. */
export async function fix(script: Script, dir: string, within: [number, number][] | null = null, ask: (body: string) => Promise<unknown> = post): Promise<number> {
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
  // Every run at once (turns.ts asks six questions at a time between them): one after another, a
  // script's chosen footage, forty-odd short stretches of one question each, took 4 min 42 s of a
  // 17-minute build (JJ's Mac, Nov 5). Each run's words are its own.
  const each = await Promise.all(
    runs.map(async (run): Promise<number> => {
      if (new Set(run.map((word) => word.speaker ?? "")).size < 2) return 0;
      const turns: TurnWord[] = run.map((word) => ({ text: script.corrections?.[word.id] ?? word.text, speaker: word.speaker ?? null, start_ms: word.startMs, end_ms: word.endMs }));
      let moved: number;
      try {
        moved = await fixTurns(turns, name, script.title, join(dir, "spills"), ask);
      } catch (error) {
        diag.warn("writer", `${script.title}: spilled words not checked: ${diag.messageOf(error)}`);
        return 0;
      }
      turns.forEach((turn, index) => {
        if (turn.speaker != null) run[index]!.speaker = turn.speaker;
      });
      return moved;
    }),
  );
  return each.reduce((sum, moved) => sum + moved, 0);
}
