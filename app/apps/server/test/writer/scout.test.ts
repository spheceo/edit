import { expect, test } from "bun:test";

import { flatten } from "../../src/writer/commentary.ts";
import { captionLines, checked, givenLinks, sourceText, type Video } from "../../src/writer/scout.ts";

const video = (): Video => ({ id: "abcdefghijk", title: "Podcast", channel: "Show", durationMs: 3_600_000, needs: [], given: false, about: "", heard: false });
const timed = (lines: { ms: number; text: string }[]) => lines.map((line) => `[${Math.floor(line.ms / 60000)}:${String(Math.floor(line.ms / 1000) % 60).padStart(2, "0")}] ${line.text}`).join("\n");

test("makes lines from word-timed captions", () => {
  const lines = captionLines({ events: [
    { tStartMs: 0 },
    { tStartMs: 1000, segs: [{ utf8: "Something" }, { utf8: " I have cool", tOffsetMs: 300 }, { utf8: " coming up is Megan Fox.", tOffsetMs: 900 }] },
    { tStartMs: 2500, segs: [{ utf8: "\n" }] },
    { tStartMs: 3000, segs: [{ utf8: ">>" }, { utf8: " What?", tOffsetMs: 100 }, { utf8: " >>", tOffsetMs: 400 }, { utf8: " Yeah.", tOffsetMs: 600 }] },
  ] });
  // A new speaker's line starts at their first word.
  expect(lines).toEqual([{ ms: 1000, text: "Something I have cool coming up is Megan Fox." }, { ms: 3100, text: ">> What?" }, { ms: 3600, text: ">> Yeah." }]);
});

test("keeps a moment only where the captions say it", () => {
  const lines = [{ ms: 1_050_720, text: "Something I have cool coming up is going to be me, Iggy, and Megan Fox." }, { ms: 1_054_080, text: ">> What?" }];
  const [flat, marks] = flatten(timed(lines));
  const needs = new Set(["N1"]);
  const moment = (start: string, quote: string) => ({ need: "N1", start, end: "17:36", quote, why: "", strength: "strong" });
  expect(checked(moment("17:30", "going to be me, Iggy, and Megan Fox"), flat, marks, needs, video())).not.toBeNull();
  expect(checked(moment("17:30", "me… Megan Fox"), flat, marks, needs, video())).not.toBeNull();
  // Words the captions don't hold, or held far from the clip's time.
  expect(checked(moment("17:30", "me and Kylie Jenner"), flat, marks, needs, video())).toBeNull();
  expect(checked(moment("2:00", "Megan Fox"), flat, marks, needs, video())).toBeNull();
  expect(checked({ ...moment("17:30", "Megan Fox"), need: "N9" }, flat, marks, needs, video())).toBeNull();
});

test("reads the brief's YouTube links", () => {
  expect(givenLinks("17:30 Megan Fox: <https://youtu.be/SY8PZpeb1kQ?t=1050> and <https://www.youtube.com/watch?v=XaaEiMOBu4s&t=> again youtu.be/SY8PZpeb1kQ")).toEqual(["SY8PZpeb1kQ", "XaaEiMOBu4s"]);
});

test("a source keeps the captions around each moment", () => {
  const lines = Array.from({ length: 200 }, (_, at) => ({ ms: at * 10_000, text: `line ${at}.` }));
  const clip = { need: "N1", video: "abcdefghijk", startMs: 600_000, endMs: 620_000, quote: "line 60", why: "It says so.", strength: "strong" };
  const text = sourceText(video(), [{ id: "N1", chapter: "Intro", what: "Line sixty", visual: false, queries: [] }], [clip], lines);
  expect(text).toContain("[10:00] line 60.");
  expect(text.includes("[9:20] line 56.") && !text.includes("[9:10] line 55.")).toBe(true);
  expect(text).toContain("- 10:00-10:20 for Line sixty (strong): It says so.");
  // The build's checks read it as a timed transcript.
  const [flat, marks] = flatten(text);
  expect(flat).toContain(" line 60 ");
  expect(marks.some(([, ms]) => ms === 600_000)).toBe(true);
});
