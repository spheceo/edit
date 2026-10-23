// typing_sounds.ts's tests: a typing sound plays exactly while its line types.

import { expect, test } from "bun:test";

import type { AudioClip, Project, TextClip } from "../src/model.ts";
import { addTrack, newProject } from "../src/project.ts";
import { fitTypingSounds, typedLines, typingSoundsOff } from "../src/typing_sounds.ts";

function project(): Project {
  const p = newProject("p", "typing", { width: 1920, height: 1080, fps: 30 }, "courtroom");
  p.media.push({ id: "tw", name: "Computers, Keyboard & Mouse, Typewriter, Typing, Keys, Vintage.wav", path: "/tw.wav", kind: "audio", duration: 3.6, width: 0, height: 0, fps: 0, has_audio: true });
  const v = addTrack(p, "video");
  const a = addTrack(p, "audio");
  p.clips.push({
    id: "line", track: v, start: 100, duration: 200, color: "blue", fade_in: 0, fade_out: 0, type: "text", text: "PLEA: JAN. 30",
    style: { font: "Geist", weight: 400, size: 40, color: [1, 1, 1, 1], tracking: 0, line_height: 1.2, glow: { enabled: false, color: null, radius: 0, strength: 0 } },
    transform: { x: 0, y: 0, scale: 1, rotation: 0 }, animation: { preset: "typewriter", duration: 1, stagger: 2 }, opacity: 1,
  } as TextClip);
  p.clips.push({ id: "snd", track: a, start: 94, duration: 108, color: "yellow", name: "Computers, Keyboard & Mouse, Typewriter, Typing, Keys, Vintage", fade_in: 0, fade_out: 0, type: "audio", media: "tw", source_in: 0.4, speed: 1, volume_db: -6 } as AudioClip);
  return p;
}

test("a typing sound starts on its line's first letter and stops on its last", () => {
  const p = project();
  // "PLEA: JAN. 30" is 11 letters (spaces aren't typed), two frames apart: the last at frame 20.
  expect(typedLines(p)).toEqual([[100, 121]]);
  expect((typingSoundsOff(p) as Record<string, unknown>[]).map((issue) => issue.kind)).toEqual(["typing_sound_off"]);
  expect(fitTypingSounds(p)).toBe(1);
  const sound = p.clips.find((clip) => clip.id === "snd") as AudioClip;
  expect([sound.start, sound.duration, sound.source_in, sound.fade_out]).toEqual([100, 21, 0, 2]);
  expect(typingSoundsOff(p)).toEqual([]);
  expect(fitTypingSounds(p)).toBe(0);
});

test("a typing sound far from its line is flagged with the line it plays over", () => {
  const p = project();
  const sound = p.clips.find((clip) => clip.id === "snd") as AudioClip;
  // Three seconds early (lined up on its loudest key), running into the line.
  Object.assign(sound, { start: 10, duration: 107 });
  expect(fitTypingSounds(p)).toBe(0);
  expect((typingSoundsOff(p) as Record<string, unknown>[]).map((issue) => issue.line)).toEqual([[100, 121]]);
});
