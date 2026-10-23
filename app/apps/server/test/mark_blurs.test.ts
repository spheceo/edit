// mark_blurs.ts's tests: a logo's blur sticks to its shot (Marius, Judge EXPLODES).

import { expect, test } from "bun:test";

import { blursFor, boxAt, offShot } from "../src/mark_blurs.ts";
import type { AdjustmentClip, Clip, Media, Project, VideoClip } from "../src/model.ts";
import { addTrack, newProject, sample } from "../src/project.ts";

const SETTINGS = { width: 1920, height: 1080, fps: 30 };
const LOGO = { text: "fox8", box: [0.85, 0.05, 0.95, 0.12] as [number, number, number, number] };

function media(id: string): Media {
  return { id, name: `${id}.mp4`, path: `/${id}.mp4`, kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true };
}

function shot(id: string, track: string, start: number, duration: number, extra: Partial<VideoClip> = {}): VideoClip {
  return {
    id, track, start, duration, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m1",
    source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1, ...extra,
  } as VideoClip;
}

function project(): Project {
  const p = newProject("p", "blurs", SETTINGS, "courtroom");
  p.media.push(media("m1"), media("m2"));
  return p;
}

test("a mark's blur follows its shot's push-in and ends with the shot", () => {
  const p = project();
  const v1 = p.tracks.find((track) => track.kind === "video")!.id;
  // Pushed in from 1.0 to 1.5 over 90 frames.
  const clip = shot("c1", v1, 100, 90, { keyframes: { scale: [{ frame: 0, value: 1, ease: "linear" }, { frame: 89, value: 1.5, ease: "linear" }] } });
  p.clips.push(clip);
  const [blur] = blursFor(p, clip, p.media[0]!, LOGO);
  expect(blur).toBeDefined();
  expect([blur!.start, blur!.duration]).toEqual([100, 90]);
  // The logo is right of centre: as the shot pushes in it moves out and grows, and the blur with it.
  const last = boxAt(p, clip, p.media[0]!, LOGO.box, 89);
  expect(sample(blur!.keyframes!["blur.x"]!, 89)).toBeCloseTo(last[0], 0);
  expect(sample(blur!.keyframes!["blur.width"]!, 89)).toBeCloseTo(last[2], 0);
  expect(last[0]).toBeGreaterThan(blur!.blur!.x! + 100);
});

test("a mark's blur fades as the next shot dissolves in over it, and is gone under it", () => {
  const p = project();
  const v1 = p.tracks.find((track) => track.kind === "video")!.id;
  const v2 = addTrack(p, "video");
  const first = shot("c1", v1, 0, 100);
  // The next shot fades in over the first's last 12 frames, then covers it.
  p.clips.push(first, shot("c2", v2, 88, 100, { media: "m2", fade_in: 12 }));
  const [blur] = blursFor(p, first, p.media[0]!, LOGO);
  expect(blur!.start).toBe(0);
  expect(blur!.duration).toBeLessThanOrEqual(100);
  const opacity = blur!.keyframes!.opacity!;
  expect(sample(opacity, 0)).toBe(1);
  expect(sample(opacity, 94)).toBeLessThan(0.6);
  expect(sample(opacity, 94)).toBeGreaterThan(0.4);
});

test("a still rectangle over a run of shots, or over a push-in, is blur_off_shot", () => {
  const p = project();
  const v1 = p.tracks.find((track) => track.kind === "video")!.id;
  const v2 = addTrack(p, "video");
  p.clips.push(shot("c1", v1, 0, 100), shot("c2", v1, 100, 100, { media: "m2" }));
  const still: AdjustmentClip = {
    id: "b1", track: v2, start: 0, duration: 200, color: "blue", name: "Logo blur", fade_in: 0, fade_out: 0, type: "adjustment",
    grade: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 },
    blur: { radius: 35, x: 700, y: -400, width: 300, height: 200, feather: 10, shape: "rect" }, opacity: 1,
  } as AdjustmentClip;
  p.clips.push(still as Clip);
  expect((offShot(p) as Record<string, unknown>[]).map((issue) => [issue.kind, issue.shots])).toEqual([["blur_off_shot", ["c1", "c2"]]]);
  // Only over its own shot, which doesn't move: nothing to say.
  still.duration = 100;
  expect(offShot(p)).toEqual([]);
  // Its shot pushes in: the still rectangle doesn't follow the logo.
  (p.clips[0] as VideoClip).keyframes = { scale: [{ frame: 0, value: 1, ease: "linear" }, { frame: 99, value: 1.3, ease: "linear" }] };
  expect((offShot(p) as Record<string, unknown>[]).map((issue) => issue.moving)).toEqual(["c1"]);
});
