import { afterAll, beforeAll, expect, test } from "bun:test";

import { channelLevels, liveSide, liveSideOf } from "../src/ears.ts";
import { applyWith, hooks, needs } from "../src/edit_plan.ts";
import type { AudioClip } from "../src/model.ts";
import { native } from "../src/native/index.ts";
import * as tools from "../src/tools.ts";
import { clip, media, project, stubNative } from "./helpers/model.ts";

const saved = { ...hooks };
beforeAll(() => {
  stubNative();
  hooks.oneColourPerPerson = () => [];
  hooks.textOnFaces = () => [];
  hooks.picturesOnFaces = () => [];
});
afterAll(() => Object.assign(hooks, saved));

test("astats_levels_are_read_per_channel", () => {
  const stderr = [
    "[Parsed_astats_0 @ 0x1] Channel: 1",
    "[Parsed_astats_0 @ 0x1] DC offset: 0.0",
    "[Parsed_astats_0 @ 0x1] RMS level dB: -21.5",
    "[Parsed_astats_0 @ 0x1] Channel: 2",
    "[Parsed_astats_0 @ 0x1] RMS level dB: -inf",
    "[Parsed_astats_0 @ 0x1] Overall",
    "[Parsed_astats_0 @ 0x1] RMS level dB: -24.5",
  ].join("\n");
  expect(channelLevels(stderr)).toEqual([-21.5, -Infinity]);
  expect(liveSideOf([-21.5, -Infinity])).toBe("left");
  expect(liveSideOf([-60, -20])).toBe("right");
  expect(liveSideOf([-20, -22])).toBeNull();
  expect(liveSideOf([-20])).toBeNull();
});

test("the_side_with_the_sound_is_measured_from_the_file", async () => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/edit-ears-${process.pid}`;
  await tools.run(["mkdir", "-p", dir]);
  const path = `${dir}/left.wav`;
  await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", "aevalsrc='0.3*sin(2*PI*440*t)|0':s=48000:d=3", path]);
  expect(await liveSide(path)).toBe("left");
  expect(await liveSide(path, [[1, 1]])).toBe("left");
  await tools.run(["rm", "-rf", dir]);
});

test("both_ears_sets_the_measured_side_on_a_sources_sound", () => {
  const p = project("ears");
  p.media.push(media({ id: "m1", name: "tape", path: "/t.mp4", kind: "video", duration: 600, width: 1920, height: 1080, has_audio: true }));
  p.media.push(media({ id: "m2", name: "other", path: "/o.mp4", kind: "video", duration: 600, width: 1920, height: 1080, has_audio: true }));
  p.clips.push(clip({ id: "c1", type: "video", track: "v1", start: 0, duration: 60, media: "m1", link: "l1" }));
  p.clips.push(clip({ id: "c2", type: "audio", track: "a4", start: 0, duration: 60, media: "m1", source_in: 4, link: "l1" }));
  p.clips.push(clip({ id: "c3", type: "audio", track: "a4", start: 60, duration: 30, media: "m2" }));
  const ops = [{ op: "both_ears", select: { ids: ["c1"] } }];
  expect(needs(ops, p).ears).toEqual({ m1: [[4, 2]] });
  const result = applyWith(p, ops, { shutter: null, sides: { m1: "left" } });
  expect((p.clips.find((one) => one.id === "c2") as AudioClip).channel).toBe("left");
  expect((p.clips.find((one) => one.id === "c3") as AudioClip).channel).toBeUndefined();
  expect(result.results[0]).toMatchObject({ clips: ["c2"], sound_on: { m1: "left" } });
  expect(native().projectValidate(JSON.stringify(p))).toBeNull();
  // A source heard on both sides is left alone; "both" puts the stereo back.
  applyWith(p, [{ op: "both_ears", select: { media: "m2" } }], { shutter: null, sides: { m2: null } });
  expect((p.clips.find((one) => one.id === "c3") as AudioClip).channel).toBeUndefined();
  applyWith(p, [{ op: "both_ears", select: { ids: ["c2"] }, side: "both" }], { shutter: null });
  expect((p.clips.find((one) => one.id === "c2") as AudioClip).channel).toBeUndefined();
});
