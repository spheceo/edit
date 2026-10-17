// faces.rs's tests (the placement half that's TS now), same names, same cases;
// then the TS side's own.

import { expect, test } from "bun:test";

import { captionSize } from "../src/captions_core.ts";
import {
  clearlyVisible,
  follow,
  grown,
  LABEL,
  overlap,
  pick,
  place,
  placedByEdit,
  placeSubtitles,
  rect,
  spots,
  subtitleSize,
  textOnFaces,
  type Face,
  type Faces,
} from "../src/faces.ts";
import type { Clip, Project, TextStyle, Transform } from "../src/model.ts";
import { newProject } from "../src/project.ts";
import { f32 } from "../src/rust.ts";
import { fixtureHome } from "./helpers/home.ts";

const FRAME: [number, number] = [1920.0, 1080.0];

test("a_face_is_followed_not_a_hand", () => {
  // A face walking right, a hand that pops up beside it at sample 3.
  const found: Faces = new Map();
  for (let i = 0; i < 8; i++) {
    const x = f32(f32(0.3) + f32(f32(0.01) * i));
    const faces: Face[] = [[x, f32(0.2), f32(x + f32(0.08)), f32(0.35)]];
    if (i === 3) faces.push([0.0, 0.0, f32(0.2), f32(0.3)]);
    found.set(i, faces);
  }
  found.set(5, []);
  const indexes = [0, 1, 2, 3, 4, 5, 6, 7];
  const start = pick(found.get(4)!, [f32(0.33), f32(0.18), f32(0.4), f32(0.36)])!;
  const track = follow(found, indexes, 4, start);
  expect(track.length, "every sample but the missed one").toBe(7);
  expect(track.every(([, face]) => face[0] >= f32(0.3))).toBe(true);
  expect(clearlyVisible(track, indexes.length)).toBe(true);
  // A box around a hand, with no face there: nobody.
  expect(pick(found.get(4)!, [f32(0.8), f32(0.7), f32(0.95), f32(0.95)])).toBeNull();
  // A face far away is not clearly visible.
  const far: [number, Face][] = Array.from({ length: 8 }, () => [0, [f32(0.5), f32(0.5), f32(0.52), f32(0.53)]]);
  expect(clearlyVisible(far, 8)).toBe(false);
});

/** captions.rs `subtitle_style(1920, 1080)`: what subtitle_size reads of it (48 px, wrapped at 1512). */
function subtitleStyle(): TextStyle {
  return {
    font: "Montserrat",
    weight: 600,
    size: 48,
    color: [1, 1, 1, 1],
    tracking: 0,
    line_height: 1.15,
    glow: { enabled: false, color: null, radius: 46, strength: 0.5 },
    max_width: 1512,
    background: { color: [0, 0, 0, 1], opacity: 1, pad_x: 12, pad_y: 8 },
  };
}

function size(): [number, number] {
  const style: TextStyle = { ...subtitleStyle(), label: { text: "Sister:", color: [1, 1, 1, 1], size: 26.0 } };
  return subtitleSize("her to stop.", style, 1080);
}

test("no_face_keeps_the_house_place", () => {
  const spot = place(size(), FRAME, LABEL, [], null);
  expect(spot).toEqual({ x: 0.0, y: 432.0 });
  // A face high in the frame is no matter.
  const high: Face[] = [[-100.0, -300.0, 100.0, -100.0]];
  expect(place(size(), FRAME, LABEL, high, null).y).toBe(432.0);
});

test("a_low_face_moves_the_subtitle_off_it", () => {
  // The camera looks down at someone: their face bottom middle.
  const face: Face = [-90.0, 300.0, 90.0, 480.0];
  let spot = place(size(), FRAME, LABEL, [face], null);
  expect(spot).not.toEqual({ x: 0.0, y: 432.0 });
  expect(overlap(rect(spot, size(), LABEL), grown(face))).toBe(0.0);
  // Still at the bottom, to the side.
  expect(spot.y).toBe(432.0);
  // Faces across the whole bottom: to the top, under the stamp.
  const row: Face[] = [
    [-900.0, 300.0, -500.0, 520.0],
    [-200.0, 300.0, 200.0, 520.0],
    [500.0, 300.0, 900.0, 520.0],
  ];
  spot = place(size(), FRAME, LABEL, row, null);
  expect(spot.y).toBeLessThan(0.0);
  const [, top] = rect(spot, size(), LABEL);
  expect(top).toBeGreaterThanOrEqual(-540.0 + 0.11 * 1080.0);
});

test("a_conversation_does_not_jump_about", () => {
  const face: Face = [-90.0, 300.0, 90.0, 480.0];
  const first = place(size(), FRAME, LABEL, [face], null);
  // The face drifts up a little: the next line could go back to the
  // middle, but it stays beside them while they're that close.
  const drifted: Face = [-90.0, 220.0, 90.0, 330.0];
  const next = place(size(), FRAME, LABEL, [drifted], first);
  expect(next).toEqual(first);
  // Once they're gone it comes back.
  expect(place(size(), FRAME, LABEL, [], first)).toEqual({ x: 0.0, y: 432.0 });
});

test("edit_places_are_known_from_hand_moves", () => {
  const style = subtitleStyle();
  const house: Transform = { x: 0, y: 432.0, scale: 1, rotation: 0 };
  expect(placedByEdit("her to stop.", style, house, [1920, 1080])).toBe(true);
  const spot = spots(subtitleSize("her to stop.", style, 1080), 0.0, FRAME)[4]!;
  const moved: Transform = { x: spot.x, y: spot.y, scale: 1, rotation: 0 };
  expect(placedByEdit("her to stop.", style, moved, [1920, 1080])).toBe(true);
  const byHand: Transform = { x: 0, y: -300.0, scale: 1, rotation: 0 };
  expect(placedByEdit("her to stop.", style, byHand, [1920, 1080])).toBe(false);
});

// The TS side's own: the whole of place_subtitles and the audit, on the stub's cache.

function footageProject(): Project {
  const project = newProject("p", "t", { width: 1920, height: 1080, fps: 30 });
  project.media = [
    { id: "m", name: "bodycam", path: "/footage/bodycam.mp4", kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true },
  ];
  const subtitles = { id: "v9", kind: "video" as const, hidden: false, muted: false, locked: false, subtitles: true };
  project.tracks.push(subtitles);
  const sub = (id: string, start: number, transform: Transform): Clip => ({
    id,
    track: "v9",
    start,
    duration: 30,
    color: "cyan",
    name: "Subtitle · Officer",
    fade_in: 0,
    fade_out: 0,
    type: "text",
    text: "her to stop.",
    style: { ...subtitleStyle(), label: { text: "Officer:", color: [0, 0.9, 0.78, 1], size: 26 } },
    transform,
    animation: { preset: "none", duration: 12, stagger: 1.5 },
    opacity: 1,
  });
  project.clips = [
    {
      id: "f",
      track: "v1",
      start: 0,
      duration: 900,
      color: "blue",
      fade_in: 0,
      fade_out: 0,
      type: "video",
      media: "m",
      source_in: 0,
      speed: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      opacity: 1,
    },
    sub("s1", 0, { x: 0, y: 432, scale: 1, rotation: 0 }),
    sub("s2", 300, { x: 0, y: 432, scale: 1, rotation: 0 }),
    sub("hand", 600, { x: 0, y: -300, scale: 1, rotation: 0 }),
  ];
  return project;
}

test("place_subtitles moves Edit's subtitles off the faces under them and leaves hand moves", async () => {
  const { app, store, native, cleanup } = fixtureHome("faces-place");
  try {
    const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    await store.replace(id, null, { ...footageProject(), id }, "test");
    // A face low in the middle while s1 is up (source 0–1 s), none later.
    const low: Face = [0.45, 0.75, 0.55, 0.95];
    native.facesDetect = async (_source, _size, indexes) =>
      Object.fromEntries(indexes.map((index) => [index, index <= 2 ? [low] : []]));
    const report = (await placeSubtitles(app, id, 0, 900)) as Record<string, unknown>;
    expect(report).toEqual({
      rev: 3,
      subtitles: 2,
      with_a_face_under_them: 1,
      moved: 1,
      off_bottom_middle_now: 2,
      moved_by_hand_left_alone: 1,
      footage_not_analysed: [],
    });
    const s1 = store.get(id)!.project.clips.find((clip) => clip.id === "s1")!;
    expect(s1.type === "text" && s1.transform.y).toBe(432);
    expect(s1.type === "text" && s1.transform.x).not.toBe(0);
    // The audit reads the same faces from the cache: s1 is clear of them now.
    native.facesCached = () => ({ 0: [low], 1: [low], 2: [low] });
    expect(textOnFaces(store.get(id)!.project)).toEqual([]);
    // Back over the face, it's reported.
    const back = store.checkout(id)!;
    const clip = back.project.clips.find((one) => one.id === "s1")!;
    if (clip.type === "text") clip.transform.x = 0;
    expect(textOnFaces(back.project)).toEqual([{ kind: "text_on_face", clip: "s1", start: 0, fix: "place_subtitles" }]);
    // Footage that can't be read is named.
    native.facesDetect = async () => {
      throw new Error("no light preview");
    };
    const failed = (await placeSubtitles(app, id, 0, 900)) as Record<string, unknown>;
    expect(failed.footage_not_analysed).toEqual(["/footage/bodycam.mp4"]);
  } finally {
    cleanup();
  }
});

test("a caption's rough size wraps at its style's width", () => {
  const style: TextStyle = { ...subtitleStyle(), size: 44, max_width: 806, background: { color: [0, 0, 0, 1], opacity: 0.45, pad_x: 12, pad_y: 8 } };
  const [w, h] = captionSize("x".repeat(10), style);
  expect(w).toBeCloseTo(10 * 44 * 0.56 + 24, 4);
  expect(h).toBeCloseTo(44 * f32(1.15) + 16, 4);
  const [, two] = captionSize("x".repeat(40), style);
  expect(two).toBeCloseTo(2 * 44 * f32(1.15) + 16, 4);
});
