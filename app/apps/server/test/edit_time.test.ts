// edit_time.ts: how long the agent spent on an edit (JJ, Nov 3: "a tracker on how long each edit takes").

import { expect, test } from "bun:test";

import { editTime } from "../src/edit_time.ts";

test("an edit's agent time adds up its turns, not the waits between them, and says where the tools' time went", () => {
  const minute = 60_000;
  const time = editTime([
    { kind: "user", at: 0 },
    { kind: "tool", tool: "add_subtitles", at: minute, updated: 4 * minute },
    // Two at once (a batch): their time counted once in the tools' total.
    { kind: "tool", tool: "map_view", at: 5 * minute, updated: 7 * minute },
    { kind: "tool", tool: "map_view", at: 5 * minute, updated: 6 * minute },
    { kind: "assistant", at: 20 * minute },
    // An hour later: the automatic follow-up.
    { kind: "user", at: 80 * minute },
    { kind: "tool", tool: "add_subtitles", at: 81 * minute, updated: 83 * minute },
    { kind: "assistant", at: 90 * minute },
    // Asked, never answered: no time.
    { kind: "user", at: 200 * minute },
  ]);
  expect(time).toMatchObject({ workedMs: 30 * minute, turns: 2, longestMs: 20 * minute, toolMs: 7 * minute, lastAt: 80 * minute });
  expect(time.tools).toEqual([["add_subtitles", 5 * minute, 2], ["map_view", 3 * minute, 2]]);
});
