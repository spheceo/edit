import { expect, test } from "bun:test";

import type { Draft, Lesson } from "@edit/types/writer";

import { diff, leaks, locate, score } from "../../src/writer/feedback.ts";
import { merge, placedBlocks } from "../../src/writer/lessons.ts";

const draft = (paragraphs: string[]): Draft => ({
  open: [{ source: "S2", video: "Stream", startMs: 0, endMs: 4_000, quote: "Get him off the stage" }],
  sections: [{ heading: "1. The Rise", paragraphs: paragraphs.map((text) => ({ id: "", pieces: [{ kind: "say", text }] })) }],
  checks: ["Check the voice."],
  report: "",
  writtenAt: 0,
});

test("finds what changed, paragraph by paragraph", () => {
  const before = draft(["One.", "Two.", "Three."]);
  const changes = diff(before, draft(["One.", "Two, said better.", "Three.", "Four."]));
  expect(changes.length).toBe(2);
  expect([changes[0]!.before, changes[0]!.after]).toEqual(["Two.", "Two, said better."]);
  expect([changes[1]!.before, changes[1]!.after]).toEqual([undefined, "Four."]);
  expect(diff(before, before)).toEqual([]);
});

test("places a quote in the script", () => {
  const blocks = placedBlocks(draft(["Neon was everywhere that summer.", "Then Kanye called him up for a stream."]));
  expect(locate("Kanye called him up for a stream", blocks)).toBe("1. The Rise ¶2");
  expect(locate("get him off the stage", blocks)).toBe("Montage clip 1");
  expect(locate("Nothing like this is in it at all", blocks)).toBeNull();
});

test("a lesson that points at the script is caught", () => {
  // The guide says "mark" now (the team's "Only mark the part…"), so the name and the verb are Rob's.
  const script = draft(["Then Kanye called him up for a stream, and Kanye stayed for an hour. Same kid. Same chat. And Rob said hi to Rob."]);
  expect(leaks("## Clips that repeat\nWhen a point is made, cut the second clip that makes it again. A repeat would rob the point.", script)).toEqual([]);
  const found = leaks("Don't write lines like then kanye called him up for a stream. Kanye and Rob.", script);
  expect(found.some((leak) => leak.includes("called him up for a stream"))).toBe(true);
  expect(found).toContain('the name "Kanye"');
  expect(found).toContain('the name "Rob"');
});

test("scores fixed as one and partly as half", () => {
  const verdict = (grade: "fixed" | "partly" | "missed" | "wrong") => ({ item: "F1", grade, changes: [], why: "" });
  expect(score([verdict("fixed"), verdict("partly"), verdict("missed"), verdict("wrong")])).toBe(0.375);
});

test("merges kept lessons from two Macs", () => {
  const lesson = (id: string, at: number, text: string): Lesson => ({ id, title: id, text, script: "s", scriptTitle: "S", pulledAt: 1, keptAt: at });
  const merged = merge({ lessons: [lesson("L1", 1, "old"), lesson("L2", 2, "")], forgotten: ["L3"] }, { lessons: [lesson("L1", 5, "new"), lesson("L3", 3, ""), lesson("L4", 4, "")], forgotten: [] });
  expect(merged.lessons.map((one) => one.id)).toEqual(["L2", "L4", "L1"]);
  expect(merged.lessons[2]!.text).toBe("new");
  expect(merged.forgotten).toEqual(["L3"]);
});
