import { describe, expect, test } from "vitest";

import { cutsAfter, mapFrame } from "./watching";
import type { Project } from "./types";

const project = (clips: { id: string; start: number; duration: number; source_in: number; track?: string }[]): Project =>
  ({ settings: { width: 1920, height: 1080, fps: 30 }, tracks: [{ id: "v1" }, { id: "v2" }], clips: clips.map((one) => ({ type: "video", media: `m-${one.id}`, speed: 1, track: one.track ?? "v1", ...one })) }) as unknown as Project;

describe("moving to the agent's new version", () => {
  test("the same moment of the same shot, wherever the edit moved it", () => {
    const before = project([{ id: "a", start: 0, duration: 300, source_in: 0 }, { id: "b", start: 300, duration: 300, source_in: 10 }]);
    // A 90-frame cut-in put in before b: b starts 90 frames later.
    const after = project([{ id: "a", start: 0, duration: 300, source_in: 0 }, { id: "x", start: 300, duration: 90, source_in: 0 }, { id: "b", start: 390, duration: 300, source_in: 10 }]);
    expect(mapFrame(before, after, 450)).toBe(540);
    expect(mapFrame(before, after, 100)).toBe(100);
  });

  test("a shot trimmed so the moment's gone, or gone itself: the same frame, inside the new edit", () => {
    const before = project([{ id: "a", start: 0, duration: 600, source_in: 0 }]);
    const after = project([{ id: "c", start: 0, duration: 200, source_in: 0 }]);
    expect(mapFrame(before, after, 500)).toBe(199);
    expect(mapFrame(before, after, 100)).toBe(100);
  });

  test("the cuts ahead, where a swap shows least", () => {
    const one = project([{ id: "a", start: 0, duration: 300, source_in: 0 }, { id: "b", start: 300, duration: 300, source_in: 0 }, { id: "c", start: 300, duration: 60, source_in: 0, track: "v2" }]);
    expect(cutsAfter(one, 120)).toEqual([300]);
  });
});
