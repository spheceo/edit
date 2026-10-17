import { beforeAll, expect, test } from "bun:test";

import { addTimeline, edit, frames, listing, times } from "../src/markers.ts";
import type { Project } from "../src/model.ts";
import { findAddon, native, wrap, type Native } from "../src/native/index.ts";
import { clip, media, project as newProject, stubNative } from "./helpers/model.ts";

beforeAll(stubNative);

function project(): Project {
  const p = newProject("markers");
  p.media.push(media({ id: "m1", name: "bodycam", path: "/b.mp4", kind: "video", duration: 600, width: 1920, height: 1080, has_audio: true }));
  p.media.push(media({ id: "s1", name: "shutter", path: "/s.wav", kind: "audio", duration: 0.2, markers: [{ time: 0.08, name: "hit" }] }));
  // 10 s of the bodycam from 100 s, then the same file again from 200 s at half speed.
  p.clips.push(clip({ id: "c1", track: "v1", type: "video", media: "m1", source_in: 100, start: 0, duration: 300 }));
  p.clips.push(clip({ id: "c2", track: "v2", type: "video", media: "m1", source_in: 200, speed: 0.5, start: 600, duration: 300 }));
  return p;
}

test("markers_on_sources_follow_their_clips_and_timeline_ones_stay_put", () => {
  const p = project();
  edit(p, {
    add: [
      { name: "door slam", note: "the back door", clip: "c1", frame: 120 },
      { name: "camera flash", media: "m1", time: 202 },
      { name: "photo lands", frame: 700 },
    ],
  });
  expect(native().projectValidate(JSON.stringify(p))).toBeNull();
  // 100 s + 120 frames = 104 s of the source.
  expect(Math.abs(p.media[0]!.markers![0]!.time - 104)).toBeLessThan(1e-9);
  expect(frames(p, "Door Slam")).toEqual([120]);
  // 202 s is 2 s into c2, at half speed: 4 s = 120 frames after 600.
  expect(frames(p, "camera flash")).toEqual([720]);
  expect(times(p, ["photo lands"])).toEqual([700 / 30]);
  // Moving the clip moves the mark with it.
  p.clips[0]!.start = 30;
  expect(frames(p, "door slam")).toEqual([150]);
  const rows = listing(p, null);
  expect(rows.length).toBe(3);
  expect(rows[0]!.startsWith("door slam m1@104.00s → 150 (the back door)")).toBe(true);
  expect(() => times(p, ["nothing"])).toThrow("door slam");
  // A sound's own hit is never listed nor removed by name alone.
  edit(p, { remove: [{ name: "hit" }, { name: "door slam" }, { frame: 700 }] });
  expect(p.media[1]!.markers!.length).toBe(1);
  expect(listing(p, null).length).toBe(1);
  expect(p.markers ?? []).toEqual([]);
  expect(() => edit(p, { add: [{ name: "x", clip: "c1", frame: 5000 }] })).toThrow();
});

test("markers say what's wrong with what they were given", () => {
  const p = project();
  expect(() => edit(p, {})).toThrow("give add and/or remove");
  expect(() => edit(p, { remove: [{}] })).toThrow("remove 1: give name, media or frame");
  expect(() => edit(p, { add: [{ frame: 3 }] })).toThrow('add 1: name is required ("door slam")');
  expect(() => edit(p, { add: [{ name: "x", media: "m1" }] })).toThrow("add 1: time (source seconds) is required with media");
  expect(() => edit(p, { add: [{ name: "x", media: "m1", time: 700 }] })).toThrow(
    "add 1: time 700.00 is past the end of m1 (600.00 s)",
  );
  expect(() => edit(p, { add: [{ name: "x", clip: "c1", frame: 400 }] })).toThrow("add 1: frame 400 is outside clip c1 [0, 300)");
  // The same name within a frame is replaced; listing in a span only shows what's in it.
  addTimeline(p, 50, "Hit it", "");
  addTimeline(p, 51, "hit it", "again");
  expect(p.markers).toEqual([{ frame: 51, name: "hit it", note: "again" }]);
  expect(listing(p, [0, 40])).toEqual([]);
  expect(listing(p, [40, 60])).toEqual(["hit it@51 (again)"]);
  expect(() => times(project(), ["x"])).toThrow(
    'no marker named "x" on the timeline or shown by a clip; markers: none (set them with markers add)',
  );
});

// Ripples are the addon's (edit_core::remove_time): this runs against the real one when it's built.
test.skipIf(findAddon() === null)("ripples_carry_timeline_markers", () => {
  const p = project();
  addTimeline(p, 700, "photo lands", "");
  const real = wrap(require(findAddon()!) as Native);
  const cut = real.removeTime({ json: JSON.stringify(p) }, 0, 60);
  expect((JSON.parse(cut.json) as Project).markers![0]!.frame).toBe(640);
});
