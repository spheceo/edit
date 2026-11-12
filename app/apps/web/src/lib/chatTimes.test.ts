import { describe, expect, test } from "vitest";

import { seconds, timeOf, timeHref, timesIn } from "./chatTimes";

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

  test("a range backwards is two times", () => {
    expect(timesIn("20:10-19:40").map((one) => [one.start, one.end])).toEqual([[1210, null], [1180, null]]);
  });

  test("the link carries it there and back", () => {
    expect(timeOf(timeHref({ start: 1180, end: 1210 }))).toEqual({ start: 1180, end: 1210 });
    expect(timeOf(timeHref({ start: 17.5, end: null }))).toEqual({ start: 17.5, end: null });
    expect(timeOf("https://example.com")).toBeNull();
  });
});
