// A channel's watermark (channel_marks.ts): the Watermarks folder's names,
// the DVD bounce's path, and the layer it adds to the exported timeline.

import { expect, test } from "bun:test";

import { bounce, channelOf, LOOK, withWatermark } from "../src/channel_marks.ts";
import type { Keyframe, Media } from "../src/model.ts";
import { isReal, native } from "../src/native/index.ts";
import { jsonForSerde } from "../src/rust.ts";
import { newProject } from "../src/project.ts";

const valueAt = (keys: Keyframe[], frame: number): number => {
  const after = keys.findIndex((key) => key.frame >= frame);
  if (after <= 0) return keys[Math.max(after, 0)]!.value;
  const [a, b] = [keys[after - 1]!, keys[after]!];
  return a.value + ((b.value - a.value) * (frame - a.frame)) / (b.frame - a.frame);
};

test("a channel is named from its picture in the Watermarks folder", () => {
  expect(channelOf({ id: "a", name: "SI_watermark.png" })).toEqual({ id: "a", code: "SI", name: "Sams Interrogations" });
  expect(channelOf({ id: "b", name: "SB_watermark.png", md5Checksum: "f00" })).toEqual({ id: "b", code: "SB", name: "SB", md5: "f00" });
  expect(channelOf({ id: "c", name: "InspectorTed_watermark_under.png" }).name).toBe("Inspector Ted");
});

test("the bounce goes wall to wall in straight lines at one speed, and never past a wall", () => {
  const keys = bounce(100, 1, 500, 4, 3000);
  expect(keys[0]).toEqual({ frame: 0, value: 100, ease: "linear" });
  expect(keys.at(-1)!.frame).toBe(3000);
  // The walls, in turn: 500 after 100 frames, then -500, 500…
  expect(keys[1]).toEqual({ frame: 100, value: 500, ease: "linear" });
  expect(keys[2]).toEqual({ frame: 350, value: -500, ease: "linear" });
  for (let i = 1; i < keys.length; i++) {
    const [a, b] = [keys[i - 1]!, keys[i]!];
    expect(Math.abs(b.value)).toBeLessThanOrEqual(500 + 1e-9);
    expect(Math.abs(b.value - a.value) / (b.frame - a.frame)).toBeCloseTo(4, 9);
  }
  for (let frame = 0; frame <= 3000; frame += 7) expect(Math.abs(valueAt(keys, frame))).toBeLessThanOrEqual(500 + 1e-9);
  // Nothing to travel: held where it is.
  expect(bounce(0, 1, 0, 4, 100)).toEqual([{ frame: 0, value: 0, ease: "linear" }]);
});

const logo: Media = { id: "watermark-si", name: "SI watermark", path: "/tmp/SI.png", kind: "image", duration: 0, width: 629, height: 801, fps: 0, has_audio: false };

test("the watermark is a locked top track over the export at 20%, the logo 14% of the frame's height, inside it all the way", () => {
  const project = newProject("p1793000000000-abc", "Case", { width: 1920, height: 1080, fps: 30 });
  const before = structuredClone(project);
  const marked = withWatermark(project, { start: 30, end: 30 + 30 * 60 }, logo);
  expect(project).toEqual(before);
  const track = marked.tracks.at(-1)!;
  expect(track).toMatchObject({ id: "watermark", kind: "video", locked: true, hidden: false });
  const clip = marked.clips.find((one) => one.track === track.id)!;
  expect(clip).toMatchObject({ type: "video", start: 30, duration: 1800, opacity: LOOK.opacity, media: "watermark-si" });
  if (clip.type !== "video") throw new Error("a picture clip");
  // Fitted to the frame's height (801 px tall), then scaled to 14% of it.
  const fit = 1080 / 801;
  const [w, h] = [629 * fit * clip.transform.scale, 801 * fit * clip.transform.scale];
  expect(h).toBeCloseTo(0.14 * 1080, 6);
  const margin = LOOK.margin * 1080;
  for (let frame = 0; frame <= 1800; frame += 5) {
    const x = valueAt(clip.keyframes!.x!, frame);
    const y = valueAt(clip.keyframes!.y!, frame);
    expect(Math.abs(x) + w / 2).toBeLessThanOrEqual(960 - margin + 1e-6);
    expect(Math.abs(y) + h / 2).toBeLessThanOrEqual(540 - margin + 1e-6);
  }
  // 108 px a second at 1080p: 3.6 px a frame at 30 fps.
  const [a, b] = clip.keyframes!.x!;
  expect(Math.abs(b!.value - a!.value) / (b!.frame - a!.frame)).toBeCloseTo((LOOK.speed * 1080) / 30, 9);
  // The same video starts it in the same place every time; another, elsewhere.
  expect(withWatermark(project, { start: 30, end: 1830 }, logo)).toEqual(marked);
  const other = withWatermark({ ...project, id: "p1793000000001-xyz" }, { start: 30, end: 1830 }, logo);
  expect(other.clips.at(-1)!.keyframes!.x![0]!.value).not.toBe(clip.keyframes!.x![0]!.value);
  // Ids already taken get a fresh one.
  const twice = withWatermark(marked, { start: 0, end: 10 }, logo);
  expect(new Set(twice.tracks.map((one) => one.id)).size).toBe(twice.tracks.length);
  expect(new Set(twice.media.map((one) => one.id)).size).toBe(twice.media.length);
});

test("the engine takes the watermarked timeline as it is (with the real addon)", () => {
  native();
  if (!isReal()) return;
  const project = newProject("p1793000000000-abc", "Case", { width: 1920, height: 1080, fps: 30 });
  const marked = withWatermark(project, { start: 0, end: 900 }, logo);
  expect(() => native().projectPrepare(marked.id, jsonForSerde(marked))).not.toThrow();
});
