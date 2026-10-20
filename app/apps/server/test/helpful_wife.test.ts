// Helpful Wife's round (Oct 20): the frame filled, teasers without dead air,
// music that changes only where what we hear changes, the tape's start felt,
// other outlets' marks found on photos.

import { afterAll, beforeAll, expect, test } from "bun:test";

import { apply, audit, hooks } from "../src/edit_plan.ts";
import { deadAir, offScript } from "../src/edit_review.ts";
import * as framing from "../src/framing.ts";
import { fill, letterboxed, parseCrop } from "../src/framing.ts";
import type { Project, VideoClip } from "../src/model.ts";
import type { Transcript } from "../src/transcribe.ts";
import { readMarks } from "../src/watermarks.ts";
import { clip, media, project, stubNative } from "./helpers/model.ts";

const saved = { ...hooks };
beforeAll(() => {
  stubNative();
  hooks.oneColourPerPerson = () => [];
  hooks.textOnFaces = () => [];
});
afterAll(() => Object.assign(hooks, saved));

const kinds = (p: Project, kind: string) => (audit(p).issues as Record<string, unknown>[]).filter((issue) => issue.kind === kind);

/** A 720×480 interrogation tape (3:2) on V1 at the renderer's fit. */
function tape(): Project {
  const p = project("tape");
  p.media.push(media({ id: "room", name: "Room.mp4", path: "/footage/room.mp4", kind: "video", duration: 600, width: 720, height: 480, has_audio: true }));
  p.clips.push(clip({ id: "c1", track: "v1", start: 0, duration: 300, type: "video", media: "room", source_in: 0, speed: 1 }));
  return p;
}

test("cropdetect_borders_are_shares_of_the_picture_and_noise_is_ignored", () => {
  expect(parseCrop("[Parsed_cropdetect] crop=710:480:10:0\n", 720, 480)).toEqual({ left: 0.0139, right: 0, top: 0, bottom: 0 });
  expect(parseCrop("crop=720:478:0:1", 720, 480)).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  expect(parseCrop("nothing", 720, 480)).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
});

test("a_3_2_tape_fills_a_16_9_frame_cropped_top_and_bottom_and_its_own_border_is_cropped_past", () => {
  const p = tape();
  const room = p.media[0]!;
  // 1920/720 ÷ 1080/480 = 1.1852, a hair over.
  expect(fill(p, room, null).scale).toBeCloseTo(1.19, 2);
  const bordered = fill(p, room, { left: 0.0139, right: 0, top: 0, bottom: 0 });
  expect(bordered.scale).toBeGreaterThan(1.2);
  expect(bordered.x).toBeLessThan(0);
});

test("footage_at_fit_is_letterboxed_and_fill_frame_fills_it_keeping_its_push_and_x_inside", () => {
  const p = tape();
  expect(letterboxed(p).map((one) => one.clip)).toEqual(["c1"]);
  expect(kinds(p, "letterboxed")[0]).toMatchObject({ media: "room", clips: 1, first: ["c1"] });
  // A punch-in moved too far to one side shows the picture's edge.
  p.clips.push(
    clip({
      id: "c2",
      track: "v1",
      start: 300,
      duration: 60,
      type: "video",
      media: "room",
      source_in: 10,
      speed: 1,
      transform: { x: 400, y: 0, scale: 1.35, rotation: 0 },
      keyframes: { scale: [{ frame: 0, value: 1.35 }, { frame: 59, value: 1.45 }] },
    }),
  );
  expect(letterboxed(p).map((one) => one.clip)).toEqual(["c1", "c2"]);
  apply(p, [{ op: "fill_frame" }]);
  expect(letterboxed(p)).toEqual([]);
  const pushed = p.clips.find((own) => own.id === "c2") as VideoClip;
  const keys = pushed.keyframes!.scale!;
  expect(keys[1]!.value / keys[0]!.value).toBeCloseTo(1.45 / 1.35, 3);
  expect(Math.abs(pushed.transform.x)).toBeLessThan(400);
});

test("a_photo_over_a_picture_that_fills_the_frame_isnt_letterboxed_but_one_on_a_black_backing_is", () => {
  const p = tape();
  p.media.push(media({ id: "photo", name: "Photo", path: "/found/photo.jpg", kind: "image", duration: 5, width: 600, height: 900 }));
  p.clips.push(clip({ id: "inset", track: "v2", start: 0, duration: 90, type: "video", media: "photo", source_in: 0, speed: 1 }));
  apply(p, [{ op: "fill_frame", clips: ["c1"] }]);
  expect(letterboxed(p)).toEqual([]);
  p.clips.push(clip({ id: "backing", track: "v1", start: 400, duration: 90, type: "solid", fill: [0, 0, 0, 1] }));
  p.clips.push(clip({ id: "bare", track: "v2", start: 400, duration: 90, type: "video", media: "photo", source_in: 0, speed: 1 }));
  expect(letterboxed(p).map((one) => one.clip)).toEqual(["bare"]);
});

/** A narration (voice-over 0–300) with music on another track. */
function narrated(style: Project["style"] = "bodycam"): Project {
  const p = project("music");
  p.style = style;
  p.media.push(media({ id: "vo", name: "Story (voice-over) - Cut-in 1.mp3", path: "/voice/vo.mp3", kind: "audio", duration: 20 }));
  p.media.push(media({ id: "a", name: "Bed A.wav", path: "/home/library/music/a/Bed A.wav", kind: "audio", duration: 120 }));
  p.media.push(media({ id: "b", name: "Bed B.wav", path: "/home/library/music/b/Bed B.wav", kind: "audio", duration: 120 }));
  p.tracks.push({ id: "a6", kind: "audio", hidden: false, muted: false, locked: false });
  p.clips.push(clip({ id: "vo1", name: "Voice-over", track: "a4", start: 0, duration: 300, type: "audio", media: "vo", source_in: 0, speed: 1 }));
  return p;
}

test("music_that_changes_in_the_middle_of_a_narration_is_flagged_and_on_its_first_frame_it_isnt", () => {
  const p = narrated();
  p.clips.push(clip({ id: "m1", track: "a5", start: 0, duration: 150, type: "audio", media: "a", source_in: 0, speed: 1, volume_db: -20 }));
  p.clips.push(clip({ id: "m2", track: "a5", start: 150, duration: 160, type: "audio", media: "b", source_in: 0, speed: 1, volume_db: -20 }));
  expect(kinds(p, "music_change_mid_narration").map((issue) => issue.clip)).toEqual(["m2"]);
  p.clips = p.clips.filter((own) => own.id !== "m2");
  p.clips.find((own) => own.id === "m1")!.duration = 310;
  expect(kinds(p, "music_change_mid_narration")).toEqual([]);
});

test("an_interrogation_bed_may_run_its_whole_section", () => {
  const long = (style: Project["style"]) => {
    const p = narrated(style);
    p.clips.push(clip({ id: "m1", track: "a5", start: 0, duration: 1500, type: "audio", media: "a", source_in: 0, speed: 1, volume_db: -20 }));
    return kinds(p, "music_bed_long").length;
  };
  expect(long("bodycam")).toBe(1);
  expect(long("interrogation")).toBe(0);
});

test("the_tape_rolling_wants_a_riser_a_hit_and_the_prologue_music_cut_on_it", () => {
  const p = narrated("interrogation");
  p.clips.push(clip({ id: "count", name: "Countdown", track: "v2", start: 270, duration: 30, type: "text", text: "INTERROGATION STARTS IN 00:01" }));
  p.clips.push(clip({ id: "m1", track: "a5", start: 0, duration: 400, type: "audio", media: "a", source_in: 0, speed: 1, volume_db: -20 }));
  expect(kinds(p, "tape_start_unmarked")[0]).toMatchObject({ at: 300 });
  expect((kinds(p, "tape_start_unmarked")[0]!.missing as string[]).length).toBe(3);
  p.clips.find((own) => own.id === "m1")!.duration = 300;
  p.media.push(media({ id: "boom", name: "Designed, Boom, Impact, Thud", path: "/home/library/sfx/x/boom.wav", kind: "audio", duration: 3 }));
  p.media.push(media({ id: "riser", name: "Riser_1sec.mp3", path: "/home/library/sfx/y/riser.mp3", kind: "audio", duration: 1.5 }));
  p.clips.push(clip({ id: "hit", track: "a6", start: 298, duration: 60, type: "audio", media: "boom", source_in: 0, speed: 1 }));
  p.clips.push(clip({ id: "rise", track: "a6", start: 255, duration: 43, type: "audio", media: "riser", source_in: 0, speed: 1 }));
  expect(kinds(p, "tape_start_unmarked")).toEqual([]);
});

test("a_pause_inside_a_teaser_is_dead_air_to_cut_out", () => {
  const p = tape();
  p.clips.push(clip({ id: "s1", track: "a4", start: 0, duration: 150, type: "audio", media: "room", source_in: 10, speed: 1 }));
  const words = (pairs: [number, number][]) => pairs.map(([start, end]) => ({ text: "word", start, end, speaker: null }));
  const heard = new Map<string, Transcript>([["room", { model: "test", words: words([[10.1, 10.5], [10.6, 11], [13, 13.4], [14.6, 14.9]]) } as unknown as Transcript]]);
  const found = deadAir(p, heard, [[0, 150]]) as Record<string, unknown>[];
  // Two seconds between the second and third words, 1.2 between the last two.
  expect(found.map((issue) => issue.seconds)).toEqual([2, 1.2]);
  expect(found[0]).toMatchObject({ kind: "dead_air", clip: "s1", from: 34, to: 86 });
  expect(deadAir(p, heard, [[200, 300]])).toEqual([]);
});

test("marks_on_a_photo_are_read_as_shares_of_the_picture", () => {
  expect(readMarks('```json\n{"marks": [{"text": "#DATELINE", "box": [900, 20, 960, 200]}, {"text": "bad", "box": [1, 2]}]}\n```')).toEqual([
    { text: "#DATELINE", box: [0.02, 0.9, 0.2, 0.96] },
  ]);
  expect(readMarks('{"marks": []}')).toEqual([]);
});

test("a_pause_cut_out_of_a_script_range_isnt_off_script_but_a_word_cut_out_is", () => {
  const p = tape();
  p.clips = [];
  // The range 10–15 s: words, a two-second pause (11–13), words.
  const heard = new Map<string, Transcript>([
    [
      "room",
      {
        model: "test",
        words: [
          { text: "first", start: 10.1, end: 10.5, speaker: null },
          { text: "words", start: 10.6, end: 11, speaker: null },
          { text: "later", start: 13, end: 13.4, speaker: null },
          { text: "ones", start: 14.6, end: 14.9, speaker: null },
        ],
      } as unknown as Transcript,
    ],
  ]);
  p.script = {
    source: "doc",
    blocks: [{ kind: "footage", url: "u", file: "f", start: 10, end: 15, label: "0:10-0:15", notes: ["first...ones"], media: "room", words: ["first", "ones"], clip: "a" }],
  } as Project["script"];
  // 10.0–11.1, then 12.9–15.0: the pause is gone.
  p.clips.push(clip({ id: "a", track: "v1", start: 0, duration: 33, type: "video", media: "room", source_in: 10, speed: 1 }));
  p.clips.push(clip({ id: "b", track: "v1", start: 33, duration: 63, type: "video", media: "room", source_in: 12.9, speed: 1 }));
  expect(offScript(p, heard)).toEqual([]);
  // Cutting "later" out with it is.
  (p.clips[1] as VideoClip).source_in = 13.5;
  (p.clips[1] as VideoClip).duration = 45;
  expect((offScript(p, heard) as Record<string, unknown>[]).map((issue) => issue.kind)).toEqual(["off_script"]);
});

test("a_portrait_photo_filled_keeps_its_top_where_the_face_is", () => {
  const p = tape();
  const photo = media({ id: "face", name: "Portrait", path: "/found/face.jpg", kind: "image", duration: 5, width: 600, height: 900 });
  const filled = fill(p, photo, null);
  // 600×900 filling 1920×1080: 2880 px tall shown, the window moved down to keep the top.
  expect(filled.y).toBeGreaterThan(400);
  expect(filled.y).toBeLessThanOrEqual((2880 * 1.004 - 1080) / 2 + 1);
});

test("the_person_questioned_is_introduced_by_a_boxed_name_not_big_faint_letters", () => {
  const p = tape();
  p.style = "interrogation";
  p.people = [{ id: "s", name: "Sabrina Limon", label: "Sabrina", role: "suspect", color: "#f5d90a", names: [] }] as Project["people"];
  const parts = [{ start: 0, end: 100, kind: "intro" }, { start: 100, end: 400, kind: "broll" }];
  const issues = () => (framing.interrogationIssues(p, parts, () => []) as Record<string, unknown>[]).filter((issue) => issue.kind === "name_not_introduced");
  p.clips.push(clip({ id: "faint", track: "v2", start: 120, duration: 60, type: "text", text: "SABRINA LIMON", opacity: 0.6, style: { font: "Geist", weight: 300, size: 90, color: [1, 1, 1, 1] } }));
  expect(issues()[0]).toMatchObject({ person: "Sabrina Limon", faint: ["faint"] });
  p.clips = p.clips.filter((own) => own.id !== "faint");
  p.clips.push(clip({ id: "callout", track: "v2", start: 120, duration: 90, type: "text", text: "Sabrina Limon, 34", style: { font: "Geist", weight: 500, size: 26, color: [1, 1, 1, 1], background: { color: [0, 0, 0, 1], opacity: 0.8 } } }));
  expect(issues()).toEqual([]);
});

test("a_long_room_shot_with_a_photo_over_part_of_it_counts_only_what_shows", () => {
  const p = narrated("interrogation");
  p.media.push(media({ id: "room", name: "Room.mp4", path: "/footage/room.mp4", kind: "video", duration: 600, width: 720, height: 480 }));
  p.media.push(media({ id: "photo", name: "Photo", path: "/found/photo.jpg", kind: "image", duration: 5, width: 1920, height: 1080 }));
  p.clips.push(clip({ id: "shot", name: "Cut-in 1 · B-roll: the room", track: "v2", start: 0, duration: 300, type: "video", media: "room", source_in: 0, speed: 1 }));
  expect(kinds(p, "long_broll_shot").map((issue) => issue.seconds)).toEqual([10]);
  p.clips.push(clip({ id: "over", track: "v3", start: 100, duration: 100, type: "video", media: "photo", source_in: 0, speed: 1 }));
  expect(kinds(p, "long_broll_shot").map((issue) => issue.seconds)).toEqual([]);
});
