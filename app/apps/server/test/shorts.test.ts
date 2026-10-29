// Shorts: the camera that keeps the subject in a 9:16 frame (reframe.ts) and
// the audit's checks for a Short (shorts.ts).

import { expect, test } from "bun:test";

import type { Face } from "../src/faces.ts";
import type { AudioClip, Media, Project, VideoClip } from "../src/model.ts";
import { newProject, SHORTS_SETTINGS } from "../src/project.ts";
import { cameraKeys, fillScale, subjectPath } from "../src/reframe.ts";
import { issues } from "../src/shorts.ts";
import { headerStyle } from "../src/script.ts";
import { linesOf, lineText } from "../src/captions.ts";

const FPS = 30;

test("16:9 footage fills a 9:16 frame at 3.16 times its fit", () => {
  expect(fillScale([1920, 1080], [1080, 1920])).toBeCloseTo(3.16, 2);
  expect(fillScale([1080, 1920], [1080, 1920])).toBe(1);
});

test("the subject is the biggest face, then the same person while they're there", () => {
  const face = (x: number, size: number): Face => [x - size / 2, 0.3, x + size / 2, 0.3 + size];
  const found = new Map<number, Face[]>([
    [0, [face(0.3, 0.2), face(0.8, 0.05)]],
    [1, []],
    // Someone else as big comes in on the right: the camera stays with the first.
    [2, [face(0.32, 0.2), face(0.75, 0.2)]],
  ]);
  expect(subjectPath(found, [0, 1, 2])).toEqual([0.3, null, 0.32]);
});

test("the camera holds while the subject stays in the middle and moves, eased, when they'd leave it", () => {
  const picture = 1920 * (1080 / 1920) * fillScale([1920, 1080], [1080, 1920]);
  const at = Array.from({ length: 12 }, (_, index) => index * 15);
  // Standing a little left of centre, drifting a touch, then walking to the right for good.
  const path = [0.48, 0.5, 0.49, 0.51, 0.5, 0.5, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8];
  const camera = cameraKeys(path, at, picture, 1080, FPS);
  expect(camera.moves).toBe(1);
  const keys = camera.keys!;
  expect(keys.map((key) => key.ease)).toEqual(["hold", "in_out", "hold"]);
  // Held near the middle until the walk, then on them: x moves the picture left.
  expect(Math.abs(keys[0]!.value)).toBeLessThan(60);
  expect(keys[2]!.value).toBeLessThan(-800);
  expect(keys[1]!.frame).toBeGreaterThan(60);
  // Never past the picture's edge.
  expect(Math.abs(keys[2]!.value)).toBeLessThanOrEqual((picture - 1080) / 2);
  // No face anywhere: centred, no keys.
  expect(cameraKeys([null, null], [0, 15], picture, 1080, FPS)).toEqual({ x: 0, keys: null, moves: 0 });
});

test("a Short's audit asks for its length, filling, subtitles and music", () => {
  const p: Project = newProject("p", "short", SHORTS_SETTINGS, "shorts");
  const media: Media = { id: "m1", name: "cam.mp4", path: "/nowhere/cam.mp4", kind: "video", duration: 600, width: 1920, height: 1080, fps: 30, has_audio: true };
  p.media.push(media);
  const v1 = p.tracks.find((track) => track.kind === "video")!.id;
  const clip: VideoClip = {
    id: "c1", track: v1, start: 0, duration: 20 * FPS, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m1",
    source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1,
  } as VideoClip;
  p.clips.push(clip);
  expect(issues(p).map((issue) => issue.kind)).toEqual(["short_length", "short_unfilled", "short_unsubtitled", "short_no_music"]);
  clip.duration = 50 * FPS;
  clip.transform.scale = fillScale([1920, 1080], [1080, 1920]);
  const a1 = p.tracks.find((track) => track.kind === "audio")!.id;
  p.media.push({ id: "m2", name: "song.m4a", path: "/nowhere/song.m4a", kind: "audio", duration: 200, width: 0, height: 0, fps: 0, has_audio: true });
  p.clips.push({ id: "a1", track: a1, start: 0, duration: 30 * FPS, color: "green", fade_in: 0, fade_out: 0, type: "audio", media: "m2", source_in: 0, speed: 1, volume_db: -24 } as AudioClip);
  expect(issues(p).map((issue) => issue.kind)).toEqual(["short_unsubtitled", "short_music_stops"]);
});

test("a script headed SHORTS is a Short", () => {
  expect(headerStyle("SHORTS Officer Helps Out Shoplifter")).toBe("shorts");
});

test("a Short's lines are a word or three, and never wider than its row", () => {
  const words = ["She", "was", "continually", "ramming", "it."].map((text, i) => ({ text, start: i * 0.3, end: i * 0.3 + 0.25, speaker: "s0" }));
  expect(linesOf("c1", words, 3, 16).map(lineText)).toEqual(["She was", "continually", "ramming it."]);
});
