import { expect, test } from "bun:test";

import type { Clip, Project } from "../src/model.ts";
import { playheadContext } from "../src/playhead.ts";
import { newProject } from "../src/project.ts";
import type { Transcript } from "../src/transcribe.ts";

test("a message carries where the playhead is, what's under it, what's said there and what's near", () => {
  const p: Project = newProject("p", "t", { width: 1920, height: 1080, fps: 30 });
  p.media.push({ id: "m1", name: "bodycam.mp4", path: "/b.mp4", kind: "video", duration: 600, width: 1920, height: 1080, fps: 30, has_audio: true });
  const [v1, a1] = [p.tracks.find((one) => one.kind === "video")!.id, p.tracks.find((one) => one.kind === "audio")!.id];
  const base = { color: "blue", fade_in: 0, fade_out: 0, keyframes: {} };
  p.clips.push(
    { ...base, id: "c1", track: v1, type: "video", start: 0, duration: 900, media: "m1", source_in: 100, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 } as unknown as Clip,
    { ...base, id: "c2", track: a1, type: "audio", start: 0, duration: 900, media: "m1", source_in: 100, speed: 1, volume_db: 0 } as unknown as Clip,
    { ...base, id: "c3", track: v1, type: "video", start: 900, duration: 300, media: "m1", source_in: 400, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 } as unknown as Clip,
    { ...base, id: "c4", track: v1, type: "video", start: 3000, duration: 30, media: "m1", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 } as unknown as Clip,
  );
  const heard = new Map([["m1", { words: [{ text: "Hands", start: 119.5, end: 119.8 }, { text: "up!", start: 119.9, end: 120.2 }, { text: "far", start: 200, end: 200.3 }] } as unknown as Transcript]]);
  const said = playheadContext(p, 600, heard);
  expect(said).toContain("The playhead is at 0:20.0 (frame 600)");
  expect(said).toContain("the change is HERE");
  expect(said).toContain("- c1 v1 video (bodycam.mp4 @ 100.0 s) frames 0–900");
  expect(said).toContain('Said around it: "Hands up!"');
  // Within 15 s: c3 (30–40 s), not c4 (100 s).
  expect(said).toContain("- c3 v1 video");
  expect(said).not.toContain("c4");
});
