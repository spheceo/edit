import { describe, expect, test } from "vitest";

import type { Root } from "mdast";

import { inEdit, remarkTimes, seconds, shown, timeOf, timeHref, timesIn } from "./chatTimes";

describe("times in the agent's messages", () => {
  test("a time, an hour's, and a range in either dash or words", () => {
    expect(seconds("1:44:00")).toBe(6240);
    expect(timesIn("listen at 0:17 and 4:25").map((one) => [one.start, one.end])).toEqual([[17, null], [265, null]]);
    expect(timesIn("on cut-in 36, from about 19:40 to 20:10, so").map((one) => [one.start, one.end])).toEqual([[1180, 1210]]);
    expect(timesIn("Cut-in 58 (about 29:20–29:53)")[0]).toMatchObject({ start: 1760, end: 1793, length: "29:20–29:53".length });
    expect(timesIn("1:44:00 - 1:45:30")[0]).toMatchObject({ start: 6240, end: 6330 });
  });

  test("what isn't a time stays text: a ratio, a version, a clock with one digit after the colon", () => {
    expect(timesIn("16:9 frame, v1.2:30x, ratio 4:3")).toEqual([]);
    expect(timesIn("frame 35398:12")).toEqual([]);
  });

  test("a range is shown with a dash, however it was written", () => {
    expect(shown("29:19.8 to 29:52.9")).toBe("29:19.8 - 29:52.9");
    expect(shown("22:00–23:40")).toBe("22:00 - 23:40");
    expect(shown("4:25")).toBe("4:25");
  });

  test("a range backwards is two times", () => {
    expect(timesIn("20:10-19:40").map((one) => [one.start, one.end])).toEqual([[1210, null], [1180, null]]);
  });

  test("the link carries it there and back", () => {
    expect(timeOf(timeHref({ start: 1180, end: 1210 }))).toEqual({ start: 1180, end: 1210 });
    expect(timeOf(timeHref({ start: 17.5, end: null }))).toEqual({ start: 17.5, end: null });
    expect(timeOf("https://example.com")).toBeNull();
  });

  test("a time at or past the edit's end isn't one in it; a range's end is held to the edit", () => {
    expect(inEdit({ start: 6240, end: null }, 600)).toBeNull();
    expect(inEdit({ start: 600, end: null }, 600)).toBeNull();
    expect(inEdit({ start: 590, end: 700 }, 600)).toEqual({ start: 590, end: 600 });
    expect(inEdit({ start: 17, end: 30 }, 600)).toEqual({ start: 17, end: 30 });
  });

  test("only the times in the edit become links", () => {
    const tree: Root = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: "at 1:44:00 in the source, 4:25 here" }] }] };
    remarkTimes({ edit: 600 })(tree);
    const paragraph = tree.children[0] as { children: { type: string; url?: string }[] };
    expect(paragraph.children.filter((child) => child.type === "link").map((child) => child.url)).toEqual([timeHref({ start: 265, end: null })]);
  });
});
