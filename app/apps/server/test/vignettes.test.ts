// vignettes.ts: a vignette that snaps on or off is flagged and eased; one carried on by the next isn't.

import { expect, test } from "bun:test";

import type { Clip, Project } from "../src/model.ts";
import { newProject } from "../src/project.ts";
import { ease, issues, snaps } from "../src/vignettes.ts";

function project(clips: Clip[]): Project {
  const p = newProject("p", "interrogation", { width: 1920, height: 1080, fps: 30 });
  p.tracks.push({ id: "v2", kind: "video", name: "V2", hidden: false, muted: false, locked: false } as unknown as Project["tracks"][number]);
  p.media.push({ id: "m1", name: "tape.mp4", path: "/t.mp4", kind: "video", duration: 600, width: 1920, height: 1080, fps: 30, has_audio: true });
  p.clips.push(
    { id: "c1", track: "v1", start: 0, duration: 900, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m1", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 } as Clip,
    ...clips,
  );
  return p;
}

const look = (id: string, start: number, duration: number, vignette = 0.7, fades: [number, number] = [0, 0]): Clip =>
  ({ id, track: "v2", start, duration, color: "blue", fade_in: fades[0], fade_out: fades[1], type: "adjustment", grade: { exposure: 0, contrast: 0.1, saturation: 0, temperature: 0, vignette }, opacity: 1 }) as Clip;

test("a vignette ending mid-shot with nothing after it snaps; its neighbour carrying on, a faded edge, a weak vignette or a flash don't", () => {
  // The teaser's vignette 0–157 runs into the next one (157–300), which then just stops.
  const p = project([look("a", 0, 157), look("b", 157, 143), look("faded", 400, 100, 0.7, [10, 10]), look("weak", 600, 100, 0.1), look("flash", 750, 6)]);
  expect(snaps(p)).toEqual([{ clip: "b", side: "out", at: 300 }]);
  expect(issues(p)).toMatchObject([{ kind: "vignette_snaps", count: 1, at: [300] }]);
  expect(ease(p, {})).toEqual({ eased: 1 });
  expect((p.clips.find((clip) => clip.id === "b") as { fade_out: number }).fade_out).toBe(12);
  expect(snaps(p)).toEqual([]);
});
