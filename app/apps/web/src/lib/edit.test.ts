import { produce } from "immer";
import { describe, expect, it } from "vitest";

import {
  addElement,
  clipEnd,
  duplicateClips,
  folderOf,
  isSoundEffect,
  freshId,
  mediaUses,
  presetHandles,
  removeTrack,
  removeUnusedMedia,
  rippleDelete,
  sample,
  segmentSpeed,
  setDuration,
  setSpeed,
  splitAt,
  validateProject,
} from "./edit";
import type { Clip, Keyframe, Media, Project } from "./types";

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
    style: "bodycam",
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

it("creates safe IDs even with an outdated counter and reserved links", () => {
  const p = project([video("c1", 0, 30, { link: "l2" })]);
  p.next_id = 1; expect(freshId(p, "c")).toBe("c2");
  p.next_id = 2; expect(freshId(p, "l")).toBe("l3");
  p.next_id = Number.MAX_SAFE_INTEGER; expect(freshId(p, "c")).toBe("c9007199254740991");
  expect(freshId(p, "c")).toBe("c2");
  expect(validateProject(p)).toBeNull();
});

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

describe("one colour per person (edit-core's validate_people)", () => {
  const cast = (color: string, clipColor: [number, number, number, number], role = "officer") =>
    ({
      ...project([{ id: "t1", track: "v1", type: "text", text: "Hi", start: 0, duration: 10, fade_in: 0, fade_out: 0, person: "p1", style: { color: clipColor } } as unknown as Clip]),
      people: [{ id: "p1", name: "Officer", label: "Officer", role, color, names: [] }],
    }) as unknown as Project;
  it("refuses a white person and a clip out of its person's colour", () => {
    expect(validateProject(cast("#3366ff", [0.2, 0.4, 1, 1]))).toBeNull();
    expect(validateProject(cast("#ffffff", [1, 1, 1, 1]))).toContain("can't be white");
    expect(validateProject(cast("#eeeeee", [0.933, 0.933, 0.933, 1]))).toContain("can't be white");
    expect(validateProject(cast("#3366ff", [1, 0, 0, 1]))).toContain("recolour the person");
    const nobody = cast("#3366ff", [0.2, 0.4, 1, 1]);
    nobody.people = [];
    expect(validateProject(nobody)).toContain("isn't in the cast");
  });
  it("lets a bystander, a witness or a source's narrator be white, as edit-core does (Mom Leaves 5 Kids' bystander, the Cop video's news reporter)", () => {
    expect(validateProject(cast("#f3ecdf", [0.953, 0.925, 0.875, 1], "bystander"))).toBeNull();
    expect(validateProject(cast("#ffffff", [1, 1, 1, 1], "witness"))).toBeNull();
    expect(validateProject(cast("#ffffff", [1, 1, 1, 1], "narrator"))).toBeNull();
    expect(validateProject(cast("#f3ecdf", [0.953, 0.925, 0.875, 1], "suspect"))).toContain("only a bystander's, a witness's or a narrator's");
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

describe("media bin", () => {
  const file = (id: string, kind: Media["kind"], path: string): Media => ({
    id,
    name: id,
    path,
    kind,
    duration: 10,
    width: 0,
    height: 0,
    fps: 0,
    has_audio: kind !== "image",
  });

  it("counts clips and script links as uses, and removes only what nothing plays", () => {
    const base = project([video("c1", 0, 30), video("c2", 30, 30)]);
    base.media.push(file("m2", "video", "/b.mp4"), file("m3", "audio", "/c.wav"));
    base.script = { blocks: [{ kind: "footage", url: "", file: "f", start: 0, end: 1, label: "", media: "m2" }] };
    const uses = mediaUses(base);
    expect(uses.get("m1")).toEqual({ clips: 2, script: false });
    expect(uses.get("m2")).toEqual({ clips: 0, script: true });
    expect(uses.get("m3")).toEqual({ clips: 0, script: false });
    let removed = 0;
    const next = produce(base, (draft) => {
      removed = removeUnusedMedia(draft);
    });
    expect(removed).toBe(1);
    expect(next.media.map((media) => media.id)).toEqual(["m1", "m2"]);
    expect(validateProject(next)).toBeNull();
  });

  it("sorts files into folders by kind, with library music and sounds apart", () => {
    expect(folderOf(file("a", "video", "/x/a.mov"))).toBe("footage");
    expect(folderOf(file("b", "audio", "/x/song.mp3"))).toBe("audio");
    expect(folderOf({ ...file("w", "audio", "/x/whoosh.wav"), duration: 1.2 })).toBe("sfx");
    expect(folderOf(file("c", "audio", "/Users/me/.edit/sfx/shutter-1a2b.wav"))).toBe("sfx");
    expect(folderOf(file("d", "audio", "/Users/me/.edit/library/sfx/0a1b2c3d4e5f/Riser.wav"))).toBe("sfx");
    expect(folderOf(file("e", "audio", "/Users/me/.edit/library/music/0a1b2c3d4e5f/Drone.wav"))).toBe("music");
    expect(folderOf(file("d", "image", "/x/logo.png"))).toBe("images");
    // A cloud copy on another machine: the cache's path, the media's tag says what it is.
    const cached = file("f", "audio", "/Users/them/.edit/cache/cloud/originals/sha256/ab12/Tension - Blue Saga.mp3");
    expect(folderOf(cached)).toBe("audio");
    expect(isSoundEffect(cached)).toBe(false);
    expect(folderOf({ ...cached, library: "music" })).toBe("music");
    expect(isSoundEffect({ ...cached, library: "music" })).toBe(true);
    expect(folderOf({ ...cached, library: "sfx" })).toBe("sfx");
  });
});


it("adds subtitles with glow and no name only in subtitle projects", () => {
  const edit = project([video("c1", 0, 300)]);
  const normalId = addElement(edit, "subtitle", 0);
  const normal = edit.clips.find((clip) => clip.id === normalId)!;
  if (normal.type !== "text") throw new Error("Expected subtitle text");
  expect(normal.style.glow.enabled).toBe(false);
  expect(normal.style.label?.text).toBe("Speaker:");

  const subs = project([video("c1", 0, 300), { ...normal, id: "c2", start: 0 }]);
  const subId = addElement(subs, "subtitle", 0);
  const subtitle = subs.clips.find((clip) => clip.id === subId)!;
  if (subtitle.type !== "text") throw new Error("Expected subtitle text");
  expect(subtitle.style.glow.enabled).toBe(true);
  expect(subtitle.style.label).toBeUndefined();
});
