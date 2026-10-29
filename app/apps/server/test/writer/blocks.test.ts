import { expect, test } from "bun:test";

import type { Cite, Paragraph, Part } from "@edit/types/writer";

import { changed, editorLines, marksOf, paragraphText, range, type Block } from "../../src/writer/blocks.ts";
import { findWords, parseTime } from "../../src/writer/paragraphs.ts";

const block = (id: string, text: string): Block => ({ id, kind: "narration", text });

test("marks the words that changed", () => {
  expect(changed([block("a", "He said he was home all night.")], [block("a", "He swore he was home all night.")])).toEqual([{ blockId: "a", start: 3, end: 8 }]);
});

test("marks a new block whole and a removed one where it was", () => {
  const ranges = changed([block("a", "One."), block("b", "Two."), block("c", "Three.")], [block("a", "One."), block("c", "Three."), block("d", "Four.")]);
  expect(ranges).toContainEqual({ blockId: "d", start: 0, end: 5 });
  expect(ranges).toContainEqual({ blockId: "c", start: 0, end: 0 });
  expect(ranges).toHaveLength(2);
});

test("marks words taken out with an empty range", () => {
  expect(changed([block("a", "He was at the old home.")], [block("a", "He was at home.")])).toEqual([{ blockId: "a", start: 10, end: 10 }]);
  // "was," became "was": that word changed.
  expect(changed([block("a", "He was, he said, at home.")], [block("a", "He was at home.")])).toEqual([{ blockId: "a", start: 3, end: 6 }]);
});

test("counts offsets as JavaScript does", () => {
  // "é" is one unit, "😀" two.
  expect(changed([block("a", "😀 café old")], [block("a", "😀 café new")])).toEqual([{ blockId: "a", start: 8, end: 11 }]);
});

const stream = (quote: string): Cite => ({ source: "S1", video: "Stream", startMs: 65_400, endMs: 70_900, quote });

test("writes a paragraph as the review page reads it", () => {
  const paragraph: Paragraph = {
    id: "p1",
    pieces: [{ kind: "say", text: "He lied." }, { kind: "clip", ...stream("no") }, { kind: "say", text: "Then this one." }],
  };
  expect(paragraphText(paragraph)).toBe('He lied.\n[Stream 1:05–1:10] "no"\nThen this one.');
});

test("marks each note on its words in the block text", () => {
  const said = stream("I lied");
  const paragraph: Paragraph = {
    id: "p1",
    pieces: [{ kind: "say", text: "He lied." }, { kind: "clip", ...said }, { kind: "say", text: "Then 😀 he said: I lied." }],
    note: "Show: the 😀 post.\nQuote it.\nFind: the stream.",
    marks: [
      { line: "Quote it.", on: "I lied", quote: { who: "Him", said } },
      { line: "Show: the 😀 post.", on: "He lied." },
      // Its words are gone from the paragraph: on the whole block.
      { line: "Find: the stream.", on: "gone words" },
    ],
  };
  const text = paragraphText(paragraph);
  const marks = marksOf(paragraph);
  expect(marks).toHaveLength(2);
  expect([marks[0]!.note, text.slice(marks[0]!.start, marks[0]!.end), marks[0]!.popup?.words]).toEqual([1, "I lied", "I lied"]);
  expect([marks[1]!.note, text.slice(marks[1]!.start, marks[1]!.end)]).toEqual([0, "He lied."]);
});

test("prints ranges as the Doc does", () => {
  const parts: Part[] = [
    { title: "One", startMs: 0, durationMs: 60_000, audio: false },
    { title: "Two", startMs: 60_000, durationMs: 60_000, audio: true },
  ];
  expect(range(5_400, 20_900, [])).toBe("0:05–0:20");
  expect(range(65_000, 90_000, parts)).toBe("Audio 0:05–0:30");
  expect(range(3_725_000, 3_730_000, [])).toBe("1:02:05–1:02:10");
});

test("every note for the editor goes to Edit", () => {
  const note = "Find, under 'streamed with Kanye West': clip of him introducing Kanye\nedit: a blue waveform under the call\n";
  expect(editorLines([note])).toEqual(["edit: Find, under 'streamed with Kanye West': clip of him introducing Kanye", "edit: a blue waveform under the call"]);
});

test("reads times", () => {
  expect(parseTime("1:43")).toBe(103_000);
  expect(parseTime("01:43.5")).toBe(103_500);
  expect(parseTime("1:00:00")).toBe(3_600_000);
  expect(parseTime("19.00")).toBeNull();
  expect(parseTime("1:7")).toBeNull();
  expect(parseTime("1:75")).toBeNull();
});

test("finds a note's words as the narration says them", () => {
  const text = "He said, “I didn’t   do it.” Then he left.";
  const at = findWords(text, '"I didn\'t do it."');
  expect(at).not.toBeNull();
  expect(text.slice(at![0], at![1])).toBe("I didn’t   do it.");
  // Whole words only.
  expect(findWords("He applied.", "lied")).toBeNull();
  // A stop copied at the end the narration doesn't have there.
  expect(findWords("He left, then came back", "He left.")).toEqual([0, 7]);
});
