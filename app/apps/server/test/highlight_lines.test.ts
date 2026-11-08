// Marc, Nov 8: "We should have 4 individual highlighter effects here instead of one big one".
import { expect, test } from "bun:test";

import { perLine } from "../src/evidence_highlight.ts";

test("a highlight over four lines of text becomes four marks, each on its line; one line, or nothing read, stays as given", () => {
  // A 1000×1000 screenshot with four lines of a quote and a line outside the box.
  const line = (y: number, x1 = 0.8) => ({ b: [0.1, y, x1, y + 0.04] as [number, number, number, number], t: "words" });
  const lines = [line(0.2), line(0.26), line(0.32), line(0.38, 0.5), line(0.7)];
  const big = { x: 80, y: 180, width: 760, height: 260 };
  const marks = perLine([big], lines, 1000, 1000);
  expect(marks.length).toBe(4);
  expect(marks.map((m) => Math.round(m.y / 10))).toEqual([19, 25, 31, 37]);
  // The last line is shorter: its mark ends with its words.
  expect(marks[3]!.x + marks[3]!.width).toBeLessThan(520);
  // Inside the box given, never past it.
  for (const m of marks) expect(m.x >= big.x && m.x + m.width <= big.x + big.width).toBe(true);
  const one = { x: 80, y: 690, width: 760, height: 60 };
  expect(perLine([one], lines, 1000, 1000)).toEqual([one]);
  expect(perLine([big], [], 1000, 1000)).toEqual([big]);
});
