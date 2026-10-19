import { describe, expect, it } from "vitest";
import { stretchAudio } from "./audio-stretch";

describe("pitch-preserving preview audio", () => {
  const rate = 48000;
  const tone = () => Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / rate));
  it("leaves normal-speed PCM unchanged", () => {
    const channels = [tone()];
    expect(stretchAudio(channels, rate, 1)).toBe(channels);
  });
  for (const speed of [0.125, 0.5, 2, 4]) it(`changes duration at ${speed}x while retaining the 440 Hz pitch`, () => {
    const input = tone();
    const [left, right] = stretchAudio([input, input.slice()], rate, speed);
    expect(left.length).toBe(Math.round(rate / speed));
    expect(right).toEqual(left);
    const from = Math.round(left.length * 0.2), to = Math.round(left.length * 0.8);
    let crossings = 0;
    for (let i = from + 1; i < to; i++) if (left[i - 1] <= 0 && left[i] > 0) crossings++;
    const frequency = crossings * rate / (to - from);
    expect(frequency).toBeGreaterThan(425);
    expect(frequency).toBeLessThan(455);
    // 0.125x makes 8 s of audio to analyse: well under a second alone, but
    // past vitest's 5 s default on a machine busy with a build or export.
  }, 30_000);
});
