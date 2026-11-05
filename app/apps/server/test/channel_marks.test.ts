// A channel's watermark (channel_marks.ts): the Watermarks folder's names,
// the DVD bounce's path, and the layer it adds to the exported timeline.

import { expect, test } from "bun:test";

import { bounce, channelOf, LOOK, storySpans, withWatermark } from "../src/channel_marks.ts";
import type { Clip, Keyframe, Media, Sections } from "../src/model.ts";
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
  // 43.2 px a second at 1080p: 1.44 px a frame at 30 fps.
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

test("the watermark shows only over the story's footage: not the intro, cut-ins, outro or a reused case, and the bounce carries on across the gaps", () => {
  const project = newProject("p1793000000000-abc", "Case", { width: 1920, height: 1080, fps: 30 });
  const part = (kind: Sections["parts"][number]["kind"], start: number, end: number) => ({ kind, start, end, label: kind });
  // Intro 0–300, a cut-in 300–390, story 390–1500, a case transition 1500–1590, story 1590–3000, the outro 3000–3300.
  const sections: Sections = {
    intro: [0, 390],
    intro_splits: 1,
    outro: [3000, 3300],
    parts: [part("intro", 0, 300), part("broll", 300, 390), part("story", 390, 1500), part("broll", 1500, 1590), part("story", 1590, 3000), part("outro", 3000, 3300)],
  };
  // A reused case's footage plays 2000–2600 (a reused script's block), and a stray 5 frames of story are left after it.
  const reused: Clip = { id: "c-reused", track: "v1", type: "video", name: "Reused", color: "blue", start: 2000, duration: 600, fade_in: 0, fade_out: 0, media: "m1", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 };
  const withReuse = { ...project, clips: [reused], script: { source: "doc", blocks: [{ kind: "footage", clip: "c-reused", notes: ["Reused script (preserve ranges and cut-in words): https://docs.google.com/document/d/x/edit"] }] } } as unknown as typeof project;
  const spans = storySpans(withReuse, sections, { start: 0, end: 3300 }, 30);
  expect(spans).toEqual([
    [390, 1500],
    [1590, 2000],
    [2600, 3000],
  ]);
  // Exported from 2995 on: only the story's last 5 frames, too short to show.
  expect(storySpans(withReuse, sections, { start: 2995, end: 3300 }, 30)).toEqual([]);
  // A script whose story wasn't found (all "Intro n/m"): its footage between the cut-ins, still not the outro.
  const allIntro: Sections = { intro: [0, 3000], intro_splits: 2, outro: [3000, 3300], parts: [part("intro", 0, 1500), part("broll", 1500, 1590), part("intro", 1590, 3000), part("outro", 3000, 3300)] };
  expect(storySpans(project, allIntro, { start: 0, end: 3300 }, 30)).toEqual([
    [0, 1500],
    [1590, 3000],
  ]);
  // No script (a subtitled video): all of it, as before.
  expect(storySpans(project, { intro: null, intro_splits: 1, outro: null, parts: [] }, { start: 0, end: 900 }, 30)).toEqual([[0, 900]]);

  const plan = { start: 0, end: 3300 };
  const whole = withWatermark(project, plan, logo).clips.at(-1)!;
  const marked = withWatermark(project, plan, logo, spans);
  const clips = marked.clips.filter((one) => one.track === marked.tracks.at(-1)!.id);
  expect(clips.map((one) => [one.start, one.start + one.duration])).toEqual(spans);
  expect(new Set(clips.map((one) => one.id)).size).toBe(3);
  // Each clip's logo is where the one bounce across the export has it, frame for frame.
  for (const clip of clips) {
    for (let frame = clip.start; frame <= clip.start + clip.duration; frame += 13) {
      expect(valueAt(clip.keyframes!.x!, frame - clip.start)).toBeCloseTo(valueAt(whole.keyframes!.x!, frame), 6);
      expect(valueAt(clip.keyframes!.y!, frame - clip.start)).toBeCloseTo(valueAt(whole.keyframes!.y!, frame), 6);
    }
    if (clip.type !== "video") throw new Error("a picture clip");
    expect(clip.transform.x).toBeCloseTo(valueAt(whole.keyframes!.x!, clip.start), 6);
  }
  // Nothing to show it over: no watermark at all.
  expect(withWatermark(project, plan, logo, [])).toBe(project);
});
