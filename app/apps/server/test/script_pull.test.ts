import { expect, test } from "bun:test";

import type { ScriptBlock } from "../src/model.ts";
import { compare } from "../src/script_pull.ts";

const footage = (label: string, start: number, end: number, more: Partial<ScriptBlock> = {}): ScriptBlock =>
  ({ kind: "footage", url: "https://youtu.be/abc", file: "youtube:abc", start, end, label, ...more }) as ScriptBlock;
const say = (text: string, clip?: string): ScriptBlock => ({ kind: "narration", text, ...(clip ? { clip } : {}) }) as ScriptBlock;

// Oct 31, CORRUPT Cops: the team added start and end words to ranges typed by
// hand and made some longer; pulling the Doc again finds exactly those.
test("a Doc pulled again finds the ranges whose times or words changed, and what was rewritten, added or taken out", () => {
  const was = [
    footage("41:21-41:32", 2481, 2492, { clip: "c23" }),
    say("A group of cop watchers in Livingston, Texas, filmed police answering a call.", "c35"),
    footage("7:20-7:31", 440, 451, { clip: "c59" }),
    footage("16:19‑16:28", 979, 988, { clip: "c29", words: ["i", "away"] }),
    say("This paragraph is cut from the Doc.", "c40"),
  ];
  const now = [
    footage("41:21-41:32", 2481, 2492, { words: ["Rankin", "yeah"] }),
    say("A group of cop watchers in Livingston, Texas, filmed the police answering a call about a gun."),
    footage("7:20-7:32", 440, 452, { words: ["the", "kids"] }),
    footage("16:19-16:28", 979, 988, { words: ["i", "away"] }),
    footage("9:12-9:18", 552, 558),
  ];
  const report = compare(was, now, "doc");
  expect(report.ranges.map((range) => [range.clip, range.now, range.words])).toEqual([
    ["c23", "41:21-41:32", ["Rankin", "yeah"]],
    ["c59", "7:20-7:32", ["the", "kids"]],
  ]);
  expect(report.narration.map((one) => one.clip)).toEqual(["c35"]);
  expect(report.removed).toEqual([{ clip: "c40", block: '"This paragraph is cut from the Doc."' }]);
  expect(report.added).toEqual([{ after: "footage 16:19‑16:28", block: "footage 9:12-9:18" }]);
});
