import { describe, expect, it } from "vitest";

import { muteGain, mutePoints } from "./mutes";

describe("mutes", () => {
  const mutes = [{ from: 2, to: 2.5 }];
  it("silences inside, ramps over 12 ms outside, leaves the rest", () => {
    expect(muteGain(mutes, 2.2)).toBe(0);
    expect(muteGain(mutes, 1.9)).toBe(1);
    expect(muteGain(mutes, 2.506)).toBeCloseTo(0.5, 5);
    expect(muteGain(mutes, 1.994)).toBeCloseTo(0.5, 5);
  });
  it("gives ramp points only where a mute is near", () => {
    const points = mutePoints(mutes, 1, 3);
    expect(points[0]).toEqual([1, 1]);
    expect(points.find(([time]) => time === 2)?.[1]).toBe(0);
    expect(points.at(-1)?.[1]).toBe(1);
    expect(mutePoints(mutes, 3, 4)).toEqual([[3, 1]]);
    // Starting inside a mute starts silent.
    expect(mutePoints(mutes, 2.1, 3)[0]).toEqual([2.1, 0]);
  });
});
