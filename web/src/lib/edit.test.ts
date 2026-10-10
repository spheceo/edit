import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { clipEnd, duplicateClips, presetHandles, removeTrack, rippleDelete, sample, segmentSpeed, setDuration, setSpeed, splitAt, validateProject } from "./edit";
import type { Clip, Keyframe, Project } from "./types";

const video = (id: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip =>
  ({
    id,
    track: "v1",
    start,
    duration,
    color: "blue",
    fade_in: 0,
    fade_out: 0,
    type: "video",
    media: "m1",
    source_in: 0,
    speed: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    opacity: 1,
    ...extra,
  }) as Clip;

function project(clips: Clip[]): Project {
  return {
    version: 1,
    id: "p",
    name: "t",
    settings: { width: 1920, height: 1080, fps: 30 },
    media: [{ id: "m1", name: "a.mp4", path: "/a.mp4", kind: "video", duration: 100, width: 1920, height: 1080, fps: 30, has_audio: true }],
    tracks: [
      { id: "v1", kind: "video", hidden: false, muted: false, locked: false },
      { id: "v2", kind: "video", hidden: false, muted: false, locked: false },
      { id: "a1", kind: "audio", hidden: false, muted: false, locked: false },
    ],
    clips,
    next_id: 10,
  };
}

/** No two clips overlap on a track (edit-core's `validate` contract). */
function assertNoOverlaps(p: Project) {
  for (const a of p.clips)
    for (const b of p.clips)
      if (a !== b && a.track === b.track) expect(a.start >= clipEnd(b) || b.start >= clipEnd(a)).toBe(true);
}

describe("timeline operations", () => {
  it("duplicates after the selection, overwriting what's there", () => {
    const next = produce(project([video("a", 0, 30), video("b", 30, 30), video("c", 60, 60)]), (draft) => {
      duplicateClips(draft, ["a", "b"]);
    });
    const copies = next.clips.filter((clip) => !["a", "b", "c"].includes(clip.id));
    expect(copies.map((clip) => clip.start).sort()).toEqual([60, 90]);
    // "c" was overwritten from 60 to 120 by the copies.
    expect(next.clips.find((clip) => clip.id === "c")).toBeUndefined();
    assertNoOverlaps(next);
  });

  it("ripple delete closes the gap only on the affected track", () => {
    const next = produce(project([video("a", 0, 30), video("b", 30, 20), video("c", 50, 10), video("d", 40, 30, { track: "v2" })]), (draft) => {
      rippleDelete(draft, ["b"]);
    });
    expect(next.clips.find((clip) => clip.id === "c")!.start).toBe(30);
    expect(next.clips.find((clip) => clip.id === "d")!.start).toBe(40);
    assertNoOverlaps(next);
  });

  it("speed keeps the source span when there's room", () => {
    const next = produce(project([video("a", 0, 30), video("b", 90, 30)]), (draft) => {
      setSpeed(draft, ["a"], 0.5);
    });
    expect(next.clips.find((clip) => clip.id === "a")!.duration).toBe(60);
    assertNoOverlaps(next);
  });

  it("slowing a clip stops at its neighbour instead of covering it", () => {
    const next = produce(project([video("a", 0, 30), video("b", 30, 30)]), (draft) => {
      setSpeed(draft, ["a"], 0.5);
    });
    expect(next.clips.find((clip) => clip.id === "a")!.duration).toBe(30);
    expect(next.clips.find((clip) => clip.id === "b")!.start).toBe(30);
    assertNoOverlaps(next);
  });

  it("duration changes stop at the next clip and validation catches overlaps", () => {
    const base = project([video("a", 0, 30), video("b", 40, 30)]);
    const next = produce(base, (draft) => setDuration(draft, ["a"], 500));
    expect(next.clips.find((clip) => clip.id === "a")!.duration).toBe(40);
    expect(validateProject(next)).toBeNull();
    const broken = produce(base, (draft) => void (draft.clips[0].duration = 50));
    expect(validateProject(broken)).toMatch(/overlap/);
  });

  it("split keeps linked partners together", () => {
    const next = produce(project([video("a", 0, 60, { link: "l1" }), { ...video("b", 0, 60, { link: "l1" }), track: "a1", type: "audio", volume_db: 0 } as Clip]), (draft) => {
      splitAt(draft, 20, ["a"]);
    });
    expect(next.clips).toHaveLength(4);
    const rights = next.clips.filter((clip) => clip.start === 20);
    expect(new Set(rights.map((clip) => clip.link)).size).toBe(1);
    expect(rights[0].link).not.toBe("l1");
  });

  it("only removes empty tracks that aren't the last of their kind", () => {
    const base = project([video("a", 0, 30)]);
    expect(produce(base, (draft) => void expect(removeTrack(draft, "v1")).toBe(false)).tracks).toHaveLength(3);
    expect(produce(base, (draft) => void removeTrack(draft, "v2")).tracks).toHaveLength(2);
    expect(produce(base, (draft) => void expect(removeTrack(draft, "a1")).toBe(false)).tracks).toHaveLength(3);
  });
});

describe("keyframe curves (mirrors edit-core eval tests)", () => {
  const key = (frame: number, value: number, ease: Keyframe["ease"], extra: Partial<Keyframe> = {}): Keyframe => ({ frame, value, ease, ...extra });

  it("follows the presets", () => {
    expect(sample([key(0, 0, "linear"), key(30, 90, "linear")], 10)).toBeCloseTo(30, 2);
    expect(sample([key(0, 0, "in_out"), key(30, 100, "linear")], 15)).toBeCloseTo(50, 2);
    expect(sample([key(0, 0, "hold"), key(10, 10, "linear")], 9)).toBe(0);
    expect(segmentSpeed(key(0, 0, "linear"), key(20, 100, "linear"), 7)).toBeCloseTo(5, 3);
  });

  it("lets handles shape a segment", () => {
    const fast = [key(0, 0, "linear", { handle_out: { speed: 10, influence: 0.3 } }), key(20, 100, "linear", { handle_in: { speed: 0, influence: 0.5 } })];
    expect(sample(fast, 4)!).toBeGreaterThan(30);
    expect(segmentSpeed(fast[0], fast[1], 0.001)).toBeCloseTo(10, 1);
    expect(segmentSpeed(fast[0], fast[1], 19.999)).toBeCloseTo(0, 1);
    // Explicit handles equal to a preset's give the preset's curve.
    const [out, inn] = presetHandles("in_out", 5);
    const explicit = [key(0, 0, "in_out", { handle_out: out }), key(20, 100, "linear", { handle_in: inn })];
    const preset = [key(0, 0, "in_out"), key(20, 100, "linear")];
    for (const frame of [2, 7, 13, 18]) expect(sample(explicit, frame)).toBeCloseTo(sample(preset, frame)!, 4);
  });
});
