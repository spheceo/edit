import { describe, expect, it } from "vitest";
import { creeping } from "./import-steps";

describe("an import's percentage as shown", () => {
  it("creeps forward while the server says the same, and a clock read early never makes it NaN (JJ, Nov 10)", () => {
    const at = 1_800_000_000_000;
    expect(creeping("a", 58, at)).toBe(58);
    // A dialog's clock from before the number came: nothing crept, still a number.
    expect(creeping("a", 58, at - 5 * 60_000)).toBe(58);
    const later = creeping("a", 58, at + 5 * 60_000);
    expect(later).toBeGreaterThan(58);
    expect(later).toBeLessThan(99);
    // Never back, never past 99.
    expect(creeping("a", 58, at + 60_000)).toBe(later);
    expect(creeping("a", 58, at + 1_000_000 * 60_000)).toBe(99);
    // A NaN from the server reads as nothing yet, never NaN.
    expect(Number.isNaN(creeping("b", Number.NaN, at))).toBe(false);
  });
});
