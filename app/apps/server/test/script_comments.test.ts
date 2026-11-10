import { expect, test } from "bun:test";

import { heardAt, quoteStart, shareThrough } from "../src/script_comments.ts";

test("a comment's words are found where they're heard, whatever the punctuation or case", () => {
  const heard = ["A", "grandmother", "keeps", "other", "people's", "children,", "for", "the", "weekend."];
  expect(quoteStart(heard, "other people's children for")).toBe(3);
  expect(quoteStart(heard, "Children for the weekend")).toBe(5);
  // The longest run wins, at least three words of a longer quote.
  expect(quoteStart(heard, "keeps other people's kids")).toBe(2);
  expect(quoteStart(heard, "nothing like this was said")).toBeNull();
  expect(quoteStart(heard, "weekend")).toBe(8);
});

test("the frame a comment's words are said at, in the clip that plays them; else null", () => {
  const words = ["Then", "the", "call", "came", "in"].map((text, at) => ({ text, start: 10 + at * 0.5, end: 10.4 + at * 0.5 }));
  // The clip plays the media from 10 s, from frame 300, at 30 fps.
  const clip = { start: 300, end: 390, sourceIn: 10, speed: 1, fps: 30, words };
  expect(heardAt(clip, "the call came")).toBe(315);
  expect(heardAt({ ...clip, speed: 2 }, "call came in")).toBe(315);
  expect(heardAt(clip, "a different line entirely")).toBeNull();
  expect(shareThrough("Then the call came in.", "call came")).toBeCloseTo(9 / 22);
  expect(shareThrough("Then the call came in.", "never")).toBeNull();
});
