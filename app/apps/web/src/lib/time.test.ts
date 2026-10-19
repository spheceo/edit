import { describe, expect, it } from "vitest";
import { timecode } from "./time";
import { rate, rateText } from "./types";

describe("rates and timecode", () => {
  it("an NTSC project runs at ×1000/1001 and says so", () => {
    expect(rate({ width: 1920, height: 1080, fps: 24, ntsc: true })).toBeCloseTo(23.976, 3);
    expect(rate({ width: 1920, height: 1080, fps: 30 })).toBe(30);
    expect(rateText({ width: 1920, height: 1080, fps: 24, ntsc: true })).toBe("23.976");
    expect(rateText({ width: 1920, height: 1080, fps: 30, ntsc: true })).toBe("29.97");
  });

  it("counts NTSC frames at the whole rate, never a fraction of a frame", () => {
    expect(timecode(25, 24000 / 1001)).toBe("00:00:01:01");
    expect(timecode(24 * 3600, 24000 / 1001)).toBe("01:00:00:00");
    expect(timecode(31, 30)).toBe("00:00:01:01");
  });
});
