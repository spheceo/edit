import { expect, test } from "bun:test";

import { PREP, prepLine, shareLine, shownProgress } from "../src/export_prep.ts";

test("the prep line names whichever part has more left", () => {
  expect(prepLine({ done: 3, total: 225 }, { done: 59, total: 59 })).toEqual({ phase: "cutting the footage, 3 of 225", ratio: 62 / 284 });
  expect(prepLine({ done: 225, total: 225 }, { done: 10, total: 59 })).toEqual({ phase: "copying the sound, 10 of 59", ratio: 235 / 284 });
  expect(prepLine(null, null)).toBeNull();
  expect(prepLine({ done: 0, total: 0 }, { done: 1, total: 4 })).toEqual({ phase: "copying the sound, 1 of 4", ratio: 0.25 });
  // A count past its total doesn't push the ratio over 1.
  expect(prepLine({ done: 30, total: 10 }, null)?.ratio).toBe(1);
});

test("prep fills the first slice and the encode still ends at 100%", () => {
  expect(PREP).toBe(0.2);
  expect(shownProgress(null, 0.4)).toBe(0.4);
  expect(shownProgress(null, null)).toBe(0);
  expect(shownProgress(0, null)).toBe(0);
  expect(shownProgress(1, null)).toBe(0.2);
  expect(shownProgress(1, 0)).toBe(0.2);
  expect(shownProgress(1, 1)).toBe(1);
  expect(shownProgress(0.5, 0.5)).toBeCloseTo(0.1 + 0.4);
  // Left at the footage's 0.85, the encode would stop short of the end. Callers pass 1 once prep is over.
  expect(shownProgress(0.85, 1)).toBeCloseTo(0.97);
  expect(shownProgress(2, -1)).toBe(0.2);
  expect(shownProgress(null, Number.NaN)).toBe(0);
});

test("a share's row takes the export's queue and its prep, and leaves a cancel", () => {
  expect(shareLine("exporting", { state: "queued", waiting: "waiting for smooth playback's render to finish" })).toBe("waiting for smooth playback's render to finish");
  expect(shareLine("exporting", { state: "queued" })).toBe("queued for export");
  expect(shareLine("exporting", { state: "running", phase: "cutting the footage, 40 of 225", progress: 0.12 })).toBe("cutting the footage, 40 of 225");
  expect(shareLine("cutting the footage, 1 of 2", { state: "running", progress: 0.2 })).toBe("exporting 20%");
  expect(shareLine("cancelling", { state: "running", phase: "starting the export", progress: 0.2 })).toBeNull();
  expect(shareLine("exporting", { state: "done", progress: 1 })).toBeNull();
});
