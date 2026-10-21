// subtitles.ts: an edit's subtitles are locked to the bottom middle.

import { expect, test } from "bun:test";

import type { Clip } from "../src/model.ts";
import { newProject } from "../src/project.ts";
import { lockSubtitles, movedSubtitles } from "../src/subtitles.ts";

test("subtitles moved to a face or a corner go back to the bottom middle; captions stay where they are", () => {
  const p = newProject("p", "bodycam", { width: 1920, height: 1080, fps: 30 });
  const text = (id: string, name: string, x: number, y: number, keys = false): Clip =>
    ({
      id, track: "v1", start: 0, duration: 30, color: "blue", fade_in: 0, fade_out: 0, type: "text", name, text: "Nader? Yeah,",
      style: { font: "Geist", weight: 600, size: 40, color: [1, 1, 1, 1] }, transform: { x, y, scale: 1, rotation: 0 }, opacity: 1,
      ...(keys ? { keyframes: { x: [{ frame: 0, value: x, ease: "linear" }] } } : {}),
    }) as unknown as Clip;
  p.clips.push(text("kept", "Subtitle · Officer", 0, 432), text("top", "Subtitle · Officer", 0, -331), text("side", "Subtitle · Kenya", 390, 432, true), text("cap", "Caption · Officer", 300, 200));
  expect(movedSubtitles(p)).toEqual(["top", "side"]);
  expect(lockSubtitles(p)).toBe(2);
  expect(movedSubtitles(p)).toEqual([]);
  const side = p.clips.find((clip) => clip.id === "side") as Extract<Clip, { type: "text" }>;
  expect([side.transform.x, side.transform.y, side.keyframes?.x]).toEqual([0, 432, undefined]);
  expect((p.clips.find((clip) => clip.id === "cap") as Extract<Clip, { type: "text" }>).transform.x).toBe(300);
});
