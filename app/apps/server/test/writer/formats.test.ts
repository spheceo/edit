import { expect, test } from "bun:test";

import { extraGuides, formatOf, shapeLengthSequence, style } from "../../src/writer/formats.ts";

test("reads the style from the title", () => {
  expect(style("When Cops Realize")).toBe("when");
  expect(style('"When" a Cop Lies')).toBe("when");
  expect(style("Whenever it rains")).toBe("hidden");
  expect(style("12-Year-Old Realizes Police Know")).toBe("hidden");
});

test("every format is said without Repack's tools", () => {
  for (const [kind, compilation, title] of [
    ["interrogation", false, "A"],
    ["foia", false, "A"],
    ["courtroom", false, "A"],
    ["interrogation", true, "When A"],
    ["interrogation", true, "A"],
    ["courtroom", true, "When A"],
  ] as const) {
    for (const text of shapeLengthSequence(formatOf(kind, compilation, title), 3)) {
      expect(text).not.toContain("build_script");
      expect(text).not.toContain("read_script");
      expect(text).not.toContain("remove_silences");
    }
  }
});

test("a bodycam compilation reads both guides as Repack gives them", () => {
  const names = (kind: "foia" | "interrogation", compilation: boolean, title: string) => extraGuides(formatOf(kind, compilation, title)).map(([name]) => name);
  // Writer's house rules come after Repack's guides, which stay word for word.
  expect(names("foia", true, "When Cops")).toEqual(["PRODUCER'S COMPILATION GUIDE", "PRODUCER'S FOIA GUIDE", "WRITER'S HOUSE RULES"]);
  expect(names("interrogation", true, "When Cops")).toEqual(["PRODUCER'S COMPILATION GUIDE", "WRITER'S HOUSE RULES"]);
  expect(names("foia", false, "A case")).toEqual(["PRODUCER'S FOIA GUIDE", "WRITER'S HOUSE RULES"]);
  expect(names("interrogation", false, "A case")).toEqual([]);
  const [shape, length] = shapeLengthSequence(formatOf("foia", true, "When Cops"), 3);
  expect(shape).toContain("standard compilation");
  expect(length).toContain("6 to 7 Letter pages");
});

test("compilations carry Repack's reuse rules and length", () => {
  const [hidden, length] = shapeLengthSequence(formatOf("interrogation", true, "Cop Reports Dead Body"), 3);
  expect(hidden).toContain("Reuse cases: the producer may mark a case as a reuse");
  expect(hidden).toContain("If the first case of this hidden compilation is the reuse");
  const [when] = shapeLengthSequence(formatOf("interrogation", true, "When Cops"), 3);
  expect(when).toContain("Reuse cases:");
  expect(when).not.toContain("If the first case of this hidden compilation");
  expect(length).not.toContain("write_cut_ins");
  expect(length).toContain("The app counts the pages of the finished plan");
  expect(hidden).not.toContain("set_reuse_link");
});

test("a courtroom compilation's length scales with its cases", () => {
  const [, length] = shapeLengthSequence(formatOf("courtroom", true, "When Judges"), 3);
  expect(length).toContain("about 24-36 minutes for these 3 cases");
});
