import { describe, expect, it } from "vitest";

import { graphicKey, graphicOf, holdGraphic, moveGraphic, resizeGraphic, shiftGraphic } from "./graphic";
import type { Clip, Project } from "./types";

const text = (id: string, name: string, start: number, duration: number, size = 120): Clip =>
  ({
    id,
    name,
    track: "v2",
    start,
    duration,
    color: "purple",
    fade_in: 0,
    fade_out: 0,
    type: "text",
    text: "July 22, 2023",
    style: { font: "Geist", weight: 600, size, color: [1, 1, 1, 1], tracking: 0, line_height: 1.2, glow: { enabled: false, color: null, radius: 0, strength: 0 } },
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    opacity: 1,
    keyframes: {},
  }) as unknown as Clip;

const darken = (id: string, name: string, start: number, duration: number): Clip =>
  ({ id, name, track: "v3", start, duration, color: "orange", fade_in: 0, fade_out: 0, type: "adjustment", grade: { exposure: -1, contrast: 0, saturation: 0, temperature: 0, vignette: 0 }, keyframes: {} }) as unknown as Clip;

const footage = (id: string, name: string, start: number, duration: number): Clip =>
  ({ id, name, track: "v1", start, duration, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m1", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 }) as unknown as Clip;

const project = (clips: Clip[]): Project =>
  ({ id: "p", name: "p", settings: { width: 1920, height: 1080, fps: 30 }, media: [{ id: "m1", name: "a.mp4", path: "/a.mp4", kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true }], tracks: [], clips }) as unknown as Project;

describe("a house graphic as one thing", () => {
  it("is named by its first part, a cut-in's after its number; footage and words never", () => {
    expect(graphicKey("Date · darken")).toBe("Date");
    expect(graphicKey("Cut-in 3 · Desktop · Notepad note 1")).toBe("Desktop");
    expect(graphicKey("Cut-in 1 · B-roll: the bedroom")).toBeNull();
    expect(graphicKey("Subtitle · Deputy")).toBeNull();
    expect(graphicKey(undefined)).toBeNull();
  });

  it("is the drawn clips under that name overlapping in time", () => {
    const date = text("t1", "Date", 100, 90);
    const p = project([date, darken("a1", "Date · darken", 95, 100), text("t2", "Date", 900, 90), footage("v9", "Cut-in 1 · B-roll: the house", 100, 90)]);
    expect(graphicOf(p, date)?.map((clip) => clip.id)).toEqual(["t1", "a1"]);
    // The second date title is another graphic, alone.
    expect(graphicOf(p, p.clips[2]!)).toBeNull();
  });

  it("moves, sizes and times together, keyframes too", () => {
    const words = text("t1", "Red quote", 100, 60, 80);
    const line = text("t2", "Red quote · line", 100, 60, 40);
    (words as { keyframes: Record<string, { frame: number; value: number; ease: string }[]> }).keyframes = { x: [{ frame: 0, value: 10, ease: "linear" }], size: [{ frame: 0, value: 80, ease: "linear" }] };
    const group = [words, line];
    moveGraphic(group, 30, -20);
    expect(words.type === "text" && [words.transform.x, words.transform.y]).toEqual([30, -20]);
    expect(words.keyframes?.x?.[0]?.value).toBe(40);
    resizeGraphic(group, 1.25);
    expect(group.map((clip) => (clip.type === "text" ? clip.style.size : 0))).toEqual([100, 50]);
    expect(words.keyframes?.size?.[0]?.value).toBe(100);
    // A full-frame picture under the graphic (a Pause's room) stays put; a window's footage moves.
    const room = footage("v1", "Pause", 100, 60);
    const player = footage("v2", "Desktop · Video Player · clip", 100, 60);
    if (player.type === "video") player.transform.scale = 0.4;
    moveGraphic([room, player], 5, 5);
    expect(room.type === "video" && [room.transform.x, player.type === "video" && player.transform.x]).toEqual([0, 5]);
    shiftGraphic(group, -500);
    expect(group.map((clip) => clip.start)).toEqual([0, 0]);
    holdGraphic(group, 15);
    expect(group.map((clip) => clip.duration)).toEqual([75, 75]);
  });
});
