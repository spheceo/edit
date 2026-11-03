import { describe, expect, it } from "vitest";
import { soundSync } from "./smoothStream";

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
