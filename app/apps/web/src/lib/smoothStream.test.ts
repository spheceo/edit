import { describe, expect, it } from "vitest";
import { leadOf, soundSync } from "./smoothStream";

describe("the render's sound kept with its picture", () => {
  it("drifts back at a slightly off rate instead of seeking, and only seeks when far out", () => {
    // In step: played as it is.
    expect(soundSync(0)).toEqual({ seek: false, rate: 1 });
    expect(soundSync(0.03)).toEqual({ seek: false, rate: 1 });
    // A little behind the picture: hurried, not moved (a move is a bump).
    expect(soundSync(-0.2)).toEqual({ seek: false, rate: 1.06 });
    // A little ahead: held back.
    expect(soundSync(0.2)).toEqual({ seek: false, rate: 0.94 });
    // Far out either way (a seek, a chunk landing late): moved, at its own rate.
    expect(soundSync(-2)).toEqual({ seek: true, rate: 1 });
    expect(soundSync(2)).toEqual({ seek: true, rate: 1 });
  });
});

// Nov 10: the smooth render showed every picture two frames late (the cut at frame 90 at 92) and never its last frames.
describe("where a chunk's pictures land", () => {
  it("is measured from the first append, so each chunk goes in that much early", () => {
    // A Mac's encoder reorders two frames: a chunk appended at 3 s holds pictures from 3.0667 s.
    expect(leadOf([[3 + 2 / 30, 5 + 2 / 30]], 3)).toBeCloseTo(2 / 30, 6);
    expect(leadOf([[2 / 30, 9 + 2 / 30]], 0)).toBeCloseTo(2 / 30, 6);
    // An encoder that doesn't reorder: nothing to make up.
    expect(leadOf([[3, 5]], 3)).toBe(0);
    // Nothing landed near it (or nothing at all): no guess.
    expect(leadOf([], 3)).toBe(0);
    expect(leadOf([[40, 42]], 3)).toBe(0);
  });
});
