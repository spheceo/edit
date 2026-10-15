import { freeze } from "immer";
import { describe, expect, it } from "vitest";
import { shareProject } from "./project-sharing";
import type { Project } from "./types";

const fixture = (): Project => ({
  version: 1, id: "p", name: "test", settings: { width: 1920, height: 1080, fps: 30 }, next_id: 10,
  media: [], tracks: [{ id: "v", kind: "video", hidden: false, muted: false, locked: false }],
  clips: ["first", "second"].map((id, i) => ({ id, track: "v", start: i * 30, duration: 30,
    color: "blue", fade_in: 0, fade_out: 0, keyframes: {}, type: "solid", fill: [0, 0, 0, 1], opacity: 1 })),
});

describe("server project snapshots", () => {
  it("shares unchanged clips and nested data while preserving frozen undo history", () => {
    const before = freeze(fixture(), true);
    const received: Project = JSON.parse(JSON.stringify(before));
    received.clips[1].name = "revision";
    const next = shareProject(before, received);
    expect(next).not.toBe(before);
    expect(next.clips[0]).toBe(before.clips[0]);
    expect(next.clips[1]).not.toBe(before.clips[1]);
    expect(next.clips[1].keyframes).toBe(before.clips[1].keyframes);
    expect(next.settings).toBe(before.settings);
    expect(next.tracks).toBe(before.tracks);
    expect(before.clips[1].name).toBeUndefined();
    expect(next.clips[1].name).toBe("revision");
  });

  it("keeps sharing by id across insertions and preserves unchanged roots", () => {
    const before = freeze(fixture(), true);
    expect(shareProject(before, JSON.parse(JSON.stringify(before)))).toBe(before);
    const received: Project = JSON.parse(JSON.stringify(before));
    received.clips.reverse();
    const next = shareProject(before, received);
    expect(next.clips[0]).toBe(before.clips[1]);
    expect(next.clips[1]).toBe(before.clips[0]);
    expect(before.clips[0].id).toBe("first");
  });
});
