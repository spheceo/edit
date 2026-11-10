// A script's cut as the edit Edit.app's window player takes (@edit/types/script_cut):
// where each item lands on the frame grid, what a card and a missing recording
// leave, and that the engine's own rules take it as it is.

import { expect, test } from "bun:test";

import { auditionProject, CUT_FPS, cutProject, frameAt, msAt, type CutItem, type CutSource } from "@edit/types/script_cut";

import { isReal, native } from "../src/native/index.ts";
import { jsonForSerde } from "../src/rust.ts";

const proxy: CutSource = { path: "/scripts/s/proxy.mp4", width: 1280, height: 720, durationMs: 600_000, fps: 30, sound: true };
const src = "/api/writer/scripts/s/proxy?v=600000";
const footage = (startMs: number, endMs: number, from = src): CutItem => ({ startMs, endMs, card: false, src: from });
const card = (ms: number): CutItem => ({ startMs: 0, endMs: ms, card: true, src: "" });

test("each footage item is a linked picture and sound clip from its start, a card is a gap as long, and the cut is as long as its items", () => {
  const { project, starts } = cutProject("s", [footage(60_000, 80_000), card(4_000), footage(5_000, 15_000), card(3_000)], { [src]: proxy });
  expect(starts).toEqual([0, 600, 720, 1020, 1110]);
  const of = (id: string) => project.clips.find((clip) => clip.id === id)!;
  expect(of("v0")).toMatchObject({ type: "video", track: "v1", start: 0, duration: 600, source_in: 60, media: src, link: "l0" });
  expect(of("a0")).toMatchObject({ type: "audio", track: "a1", start: 0, duration: 600, source_in: 60, media: src, link: "l0" });
  expect(of("v2")).toMatchObject({ start: 720, duration: 300, source_in: 5 });
  // Nothing but black where the cards are, and to the end of the last one.
  expect(project.clips.filter((clip) => clip.type === "video" && clip.start < 720 && clip.start + clip.duration > 600)).toEqual([]);
  expect(of("base")).toMatchObject({ type: "solid", start: 0, duration: 1110 });
  expect(project.settings).toEqual({ width: 1280, height: 720, fps: CUT_FPS });
  expect(project.media).toHaveLength(1);
  expect(project.media[0]).toMatchObject({ id: src, path: proxy.path, kind: "video", duration: 600, has_audio: true });
});

test("boundaries land on the nearest frame of the edited clock, so lengths in odd milliseconds never drift", () => {
  // 1,234 ms each: 37.02 frames. Rounded one by one they'd fall a frame behind every fifty items.
  const items = Array.from({ length: 200 }, (_, at) => footage(at * 2_000, at * 2_000 + 1_234));
  const { project, starts } = cutProject("s", items, { [src]: proxy });
  expect(starts.at(-1)).toBe(Math.round((200 * 1_234 * CUT_FPS) / 1000));
  starts.forEach((start, at) => expect(Math.abs(msAt(start) - at * 1_234)).toBeLessThanOrEqual(1000 / CUT_FPS / 2 + 1e-6));
  // No clip runs into the next.
  const pictures = project.clips.filter((clip) => clip.type === "video");
  pictures.forEach((clip, at) => expect(clip.start + clip.duration).toBe(pictures[at + 1]?.start ?? starts.at(-1)!));
  // And a frame is the edited moment it starts at, wherever it is.
  expect(frameAt(msAt(4_321))).toBe(4_321);
  expect(frameAt(33.3)).toBe(0);
  expect(frameAt(33.4)).toBe(1);
});

test("an item shorter than a frame, or whose recording isn't here, leaves its length and no clip; a recording with no picture is only heard", () => {
  const sound: CutSource = { path: "/scripts/s/call.m4a", width: 0, height: 0, durationMs: 90_000, fps: 0, sound: true };
  const { project, starts } = cutProject("s", [footage(0, 10), footage(0, 2_000, "/api/writer/scripts/s/footage/gone.mp4"), footage(1_000, 3_000, "/api/writer/scripts/s/files/call.m4a")], { [src]: proxy, "/api/writer/scripts/s/files/call.m4a": sound });
  expect(starts).toEqual([0, 0, 60, 120]);
  expect(project.clips.map((clip) => clip.id)).toEqual(["base", "a2"]);
  expect(project.media.map((media) => media.kind)).toEqual(["audio"]);
  // No picture in it at all: the shape falls back to 1080p.
  expect(project.settings).toMatchObject({ width: 1920, height: 1080 });
});

test("a commentary's items each play from their own recording, the picture shaped as the first", () => {
  const other = "/api/writer/scripts/s/footage/yt-abc-0.mp4";
  const { project } = cutProject("s", [footage(0, 2_000, other), footage(0, 2_000), footage(4_000, 6_000, other)], { [src]: proxy, [other]: { ...proxy, path: "/scripts/s/footage/yt-abc-0.mp4", width: 640, height: 360 } });
  expect(project.media.map((media) => media.id)).toEqual([other, src]);
  expect(project.settings).toMatchObject({ width: 640, height: 360 });
});

test("an audition is the whole recording as one clip, a frame the footage's own moment", () => {
  const { project, starts } = auditionProject("s", src, proxy);
  expect(starts).toEqual([0, 18_000]);
  expect(project.clips.find((clip) => clip.id === "v0")).toMatchObject({ start: 0, duration: 18_000, source_in: 0 });
});

test("the engine takes the cut and the audition as they are (with the real addon)", () => {
  native();
  if (!isReal()) return;
  const cut = cutProject("p1793000000000-abc", [footage(60_000, 80_000), card(4_000), footage(5_000, 15_000), card(3_000)], { [src]: proxy }).project;
  expect(() => native().projectPrepare(cut.id, jsonForSerde(cut))).not.toThrow();
  const audition = auditionProject("p1793000000000-abc", src, proxy).project;
  expect(() => native().projectPrepare(audition.id, jsonForSerde(audition))).not.toThrow();
  // An empty cut too: a script before its first build.
  const empty = cutProject("p1793000000000-abc", [], {}).project;
  expect(() => native().projectPrepare(empty.id, jsonForSerde(empty))).not.toThrow();
});
