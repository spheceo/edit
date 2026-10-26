import { afterAll, beforeAll, expect, test } from "bun:test";

import { apply, applyWith, audit, BOARD_MARKER, BOARD_SHUTTER, hooks, needs, type Assets } from "../src/edit_plan.ts";
import { frameKey } from "../src/desktop_screen.ts";
import { frames } from "../src/markers.ts";
import type { Project, TextClip, VideoClip } from "../src/model.ts";
import { native } from "../src/native/index.ts";
import { sample, trackOf } from "../src/project.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip, clipNamed, media, project, stubNative } from "./helpers/model.ts";

// People and faces aren't here: the plan's hooks into them do nothing.
const saved = { ...hooks };
beforeAll(() => {
  stubNative();
  hooks.oneColourPerPerson = () => [];
  hooks.textOnFaces = () => [];
  hooks.picturesOnFaces = () => [];
});
afterAll(() => Object.assign(hooks, saved));

const issuesOf = (p: Project) => audit(p).issues as Record<string, unknown>[];
const kinds = (p: Project, kind: string) => issuesOf(p).filter((issue) => issue.kind === kind);
const valid = (p: Project) => expect(native().projectValidate(JSON.stringify(p))).toBeNull();

test("named_references_and_intermediate_overlaps", () => {
  const p = project("plan");
  const result = apply(p, [
    { op: "add", as: "first", clip: { type: "solid", track: "v1", start: 0, duration: 30, fill: [0, 0, 0, 1] } },
    { op: "add", as: "next", clip: { type: "solid", track: "v1", start: 0, duration: 30, fill: [1, 1, 1, 1] } },
    { op: "update", select: { ids: [{ $ref: "next" }] }, patch: { start: 30 } },
  ]);
  expect(p.clips.length).toBe(2);
  expect(result.results.length).toBe(3);
  expect(p.clips[1]!.start).toBe(30);
  expect(issuesOf(p)).toEqual([]);
});

test("a_clip_left_over_another_goes_onto_its_own_track_above", () => {
  const p = project("plan");
  apply(p, [
    { op: "add", clip: { type: "solid", track: "v1", start: 0, duration: 30, fill: [0, 0, 0, 1] } },
    { op: "add", clip: { type: "solid", track: "v1", start: 30, duration: 30, fill: [1, 1, 1, 1] } },
  ]);
  const [first, second] = p.clips.map((one) => one.id);
  // Lengthened over its neighbour: kept, on a track just above v1.
  const result = apply(p, [{ op: "update", select: { ids: [first!] }, patch: { duration: 45 } }]);
  expect(result.separated).toEqual([first!]);
  const moved = p.clips.find((one) => one.id === first)!;
  expect(moved.duration).toBe(45);
  expect(moved.track).not.toBe("v1");
  const order = p.tracks.map((track) => track.id);
  expect(order.indexOf(moved.track)).toBe(order.indexOf("v1") + 1);
  expect(p.clips.find((one) => one.id === second)!.track).toBe("v1");
  valid(p);
});

test("a_pause_holds_the_frame_before_with_its_words_typed_small", () => {
  const p = project("plan");
  p.media.push(media({ id: "m1", name: "room", path: "/r.mp4", kind: "video", duration: 600, width: 720, height: 480, has_audio: false }));
  apply(p, [{ op: "add", clip: { type: "video", track: "v1", start: 0, duration: 300, media: "m1", source_in: 10, transform: { x: 0, y: 0, scale: 1.3, rotation: 0 } } }]);
  apply(p, [{ op: "pause", start: 120, end: 210, text: "June 2013" }]);
  const held = p.clips.find((one) => one.name === "Pause") as VideoClip;
  // The frame before 120 (119): 10 s in + 119 frames at 30 fps.
  expect(held.source_in).toBeCloseTo(10 + 119 / 30, 3);
  expect(held.speed).toBe(0.05);
  expect(held.keyframes!.scale!.at(-1)!.value).toBeCloseTo(1.3 * 1.08, 3);
  const words = p.clips.find((one) => one.name === "Pause · words") as TextClip;
  expect(words.text).toBe("June 2013");
  expect(words.transform.x).toBeLessThan(0);
  expect(words.transform.y).toBeGreaterThan(0);
  valid(p);
  expect(() => apply(p, [{ op: "pause", start: 400, end: 480 }])).toThrow("no footage on the timeline at frame 399");
});

test("a_picture_popping_up_without_a_sound_is_flagged", () => {
  const p = project("plan");
  p.media.push(media({ id: "m1", name: "photo", path: "/p.jpg", kind: "image", duration: 5, width: 800, height: 800, has_audio: false }));
  p.media.push(media({ id: "s1", name: "click", path: "/c.wav", kind: "audio", duration: 0.2, has_audio: true }));
  apply(p, [
    { op: "add", clip: { type: "solid", track: "v1", start: 0, duration: 600, fill: [0, 0, 0, 1] } },
    { op: "add", clip: { type: "video", track: "new", start: 100, duration: 90, media: "m1", name: "File Viewer · Ava" } },
    { op: "add", clip: { type: "video", track: "new", start: 300, duration: 90, media: "m1", name: "File Viewer · Ava" } },
    { op: "add", clip: { type: "audio", track: "new", start: 290, duration: 6, media: "s1", name: "Click" } },
  ]);
  expect(kinds(p, "silent_popup").map((issue) => issue.at)).toEqual([100]);
});

test("linked_halves_move_and_go_together_and_add_needs_times", () => {
  const p = project("plan");
  apply(p, [
    { op: "add", as: "card", clip: { type: "solid", track: "v1", start: 0, duration: 30, fill: [0, 0, 0, 1], link: "l1" } },
    { op: "add", as: "words", clip: { type: "solid", track: "new", start: 0, duration: 30, fill: [1, 1, 1, 1], link: "l1" } },
  ]);
  const card = p.clips[0]!.id;
  apply(p, [{ op: "update", select: { ids: [card] }, patch: { start: 10, duration: 20 } }]);
  expect(p.clips.every((own) => own.start === 10 && own.duration === 20)).toBe(true);
  apply(p, [{ op: "delete", select: { ids: [p.clips[0]!.id] } }]);
  expect(p.clips).toEqual([]);
  expect(() => apply(p, [{ op: "add", clip: { type: "solid", fill: [0, 0, 0, 1] } }])).toThrow("clip.start is required");
});

test("update_can_move_clips_to_a_new_track", () => {
  const p = project("plan");
  apply(p, [
    { op: "add", as: "a", clip: { type: "solid", track: "v1", start: 0, duration: 30, fill: [0, 0, 0, 1] } },
    { op: "update", select: { ids: [{ $ref: "a" }] }, patch: { track: "new" } },
  ]);
  expect(p.clips[0]!.track).not.toBe("v1");
  expect(trackOf(p, p.clips[0]!.track)).toBeDefined();
});

const footage = () =>
  media({ id: "m1", name: "f", path: "/f.mp4", kind: "video", duration: 600, width: 1920, height: 1080, has_audio: false });

test("the_same_broll_moment_twice_is_flagged", () => {
  const p = project("plan");
  p.media.push(footage());
  apply(p, [
    { op: "add", clip: { type: "solid", track: "v1", start: 0, duration: 900, fill: [0, 0, 0, 1] } },
    // Two cuts of one moment, butted: one shot.
    { op: "add", clip: { type: "video", track: "new", media: "m1", source_in: 10, start: 0, duration: 60 } },
    { op: "add", clip: { type: "video", track: "v2", media: "m1", source_in: 11, start: 60, duration: 60 } },
    // The same moment again, later.
    { op: "add", clip: { type: "video", track: "v2", media: "m1", source_in: 10.5, start: 600, duration: 90 } },
  ]);
  expect(kinds(p, "repeated_broll").length).toBe(2);
});

test("a_transition_without_a_sound_is_flagged", () => {
  const p = project("plan");
  p.media.push(media({ id: "s1", name: "whoosh", path: "/w.wav", kind: "audio", duration: 1 }));
  apply(p, [
    { op: "add", clip: { type: "solid", track: "v1", start: 0, duration: 300, fill: [0, 0, 0, 1] } },
    { op: "transition", kind: "drop", at: 100 },
    { op: "transition", kind: "flash", at: 200 },
    { op: "add", clip: { type: "audio", media: "s1", source_in: 0, start: 98, duration: 30 } },
  ]);
  const silent = kinds(p, "silent_transition");
  expect(silent.length).toBe(1);
  expect(silent[0]!.at).toBe(200);
});

test("long_broll_shots_and_music_that_outstays_its_song_are_flagged", () => {
  const p = project("plan");
  p.media.push(footage());
  p.media.push(media({ id: "song", name: "Song.wav", path: "/home/library/music/abc/Song.wav", kind: "audio", duration: 120 }));
  p.media.push(media({ id: "vo", name: "vo.mp3", path: "/vo.mp3", kind: "audio", duration: 30 }));
  apply(p, [
    { op: "add", clip: { type: "solid", track: "v1", start: 0, duration: 3000, fill: [0, 0, 0, 1] } },
    { op: "add", clip: { type: "video", track: "new", name: "Cut-in 1 · B-roll: a", media: "m1", source_in: 10, start: 0, duration: 120 } },
    { op: "add", clip: { type: "video", track: "v2", name: "Cut-in 1 · B-roll: b", media: "m1", source_in: 100, start: 120, duration: 150 } },
    { op: "add", clip: { type: "audio", track: "new", name: "Voice-over", media: "vo", source_in: 0, start: 0, duration: 600 } },
    // Thirty seconds of one song, stopping with ten seconds of narration left.
    { op: "add", clip: { type: "audio", track: "new", media: "song", source_in: 0, start: 0, duration: 300 } },
    { op: "add", clip: { type: "audio", track: "new", media: "song", source_in: 0, start: 1000, duration: 300 } },
    { op: "add", clip: { type: "audio", track: "new", media: "song", source_in: 0, start: 2000, duration: 900 } },
  ]);
  expect(kinds(p, "long_broll_shot").map((issue) => issue.seconds)).toEqual([5]);
  expect(kinds(p, "music_bed_long").map((issue) => issue.seconds)).toEqual([30]);
  expect(kinds(p, "music_repeated")[0]!.starts).toEqual([0, 1000, 2000]);
  expect(kinds(p, "music_stops_mid_narration").map((issue) => issue.narration_left)).toEqual([10]);
});

test("the_same_transitions_over_and_over_are_flagged", () => {
  const repeated = (list: string[]) => {
    const p = project("plan");
    const plan: unknown[] = [{ op: "add", clip: { type: "solid", track: "v1", start: 0, duration: 3000, fill: [0, 0, 0, 1] } }];
    list.forEach((kind, index) => plan.push({ op: "transition", kind, at: 100 + index * 200 }));
    apply(p, plan);
    return kinds(p, "repetitive_transitions");
  };
  // Drop in, dip out, cut-in after cut-in.
  const template = repeated(["drop", "dip", "drop", "dip", "drop", "dip", "drop", "dip"]);
  expect(template.length).toBe(1);
  expect(template[0]!.count).toBe(8);
  expect(repeated(["dip", "dip", "dip", "dip"]).length).toBe(1);
  // Varied for their moments: nothing to say.
  expect(repeated(["drop", "dip", "flash", "drop", "dip", "dip", "flash", "drop"])).toEqual([]);
});

test("a_subtitle_past_its_cut_is_flagged", () => {
  const p = project("plan");
  p.media.push(footage());
  apply(p, [
    // A cut: 0–100 from 10 s, then 100–200 from 50 s.
    { op: "add", clip: { type: "video", track: "v1", media: "m1", source_in: 10, start: 0, duration: 100 } },
    { op: "add", clip: { type: "video", track: "v1", media: "m1", source_in: 50, start: 100, duration: 100 } },
    // A split: 200–300 carries straight on from 300 (50 s + 100 frames).
    { op: "add", clip: { type: "video", track: "v1", media: "m1", source_in: 53.333333, start: 200, duration: 100 } },
    { op: "add", clip: { type: "text", track: "new", name: "Subtitle · A", start: 80, duration: 30, text: "over the cut" } },
    { op: "add", clip: { type: "text", track: "new", name: "Subtitle · A", start: 180, duration: 30, text: "over the split" } },
  ]);
  const past = kinds(p, "subtitle_past_cut");
  expect(past.length).toBe(1);
  expect(past[0]!.start).toBe(80);
});

function boardProject(photos: number): Project {
  const p = project("plan");
  for (let index = 1; index <= photos; index++) {
    p.media.push(media({ id: `m${index}`, name: "photo", path: "/p.jpg", kind: "image", duration: 30, width: 1200, height: 900 }));
  }
  return p;
}




test("an_evidence_boards_title_is_written_over_the_board_and_moves_with_it", () => {
  const p = boardProject(2);
  apply(p, [{ op: "evidence_board", start: 0, end: 200, title: "Nevaeh's account", items: [{ media: "m1", label: "the bed", at: 60 }, { media: "m2", label: "the window", at: 140 }] }]);
  const title = clipNamed(p, "Evidence board · title") as TextClip;
  const photo = clipNamed(p, "Evidence board · photo 1");
  expect([title.text, title.start, title.duration, title.style.font]).toEqual(["Nevaeh's account", 0, 200, "Reenie Beanie"]);
  // Above the photos, keeping its place on the board as the board drifts.
  const gap = (frame: number) => sample(photo.keyframes!.y!, frame - photo.start)! - sample(title.keyframes!.y!, frame)!;
  for (const frame of [photo.start, 100, 199]) expect(gap(frame)).toBeCloseTo(gap(photo.start), 0);
  expect(gap(photo.start)).toBeGreaterThan(0.3 * 1080);
});

test("an_evidence_board_shows_at_most_four_photos_side_by_side_each_a_beat_before_its_word_drifting_slowly", () => {
  // JJ, Mom & Teen v7: "far, far, far too rehearsed… a lot smoother"; Mom Leaves v5: "slower so we can actually see what is going on".
  const p = boardProject(4);
  const ats = [139, 165, 207, 243];
  const items = ats.map((at, index) => ({ media: `m${index + 1}`, label: "zip ties", at }));
  const result = apply(p, [{ op: "evidence_board", start: 100, end: 346, illustrative: true, items }]);
  // Paper, four photos and notes, the vignette, "Illustrative images".
  expect(p.clips.length).toBe(11);
  const report = result.results[0] as Record<string, unknown>;
  expect(report.end).toBe(346);
  expect(report.centred).toEqual(ats);
  const where: [number, number][] = [];
  ats.forEach((at, index) => {
    const photo = clipNamed(p, `Evidence board · photo ${index + 1}`);
    // In 20 frames before its word, fading in, held to the end.
    expect([photo.start, photo.start + photo.duration, photo.fade_in]).toEqual([at - 20, 346, 10]);
    const at0 = (param: string) => sample(photo.keyframes![param]!, 0)!;
    const atEnd = (param: string) => sample(photo.keyframes![param]!, photo.duration - 1)!;
    // On screen the whole time, and moving slowly (about a pixel a frame at most).
    for (const value of [at0("x"), atEnd("x")]) expect(Math.abs(value)).toBeLessThan(0.5 * 1920);
    for (const value of [at0("y"), atEnd("y")]) expect(Math.abs(value)).toBeLessThan(0.5 * 1080);
    expect(Math.abs(atEnd("y") - at0("y")) / photo.duration).toBeLessThan(1.2);
    expect(Math.abs(atEnd("x") - at0("x"))).toBeLessThan(0.5);
    where.push([at0("x"), at0("y")]);
  });
  // Two by two: left and right, top and bottom.
  expect(where[0]![0]).toBeLessThan(0);
  expect(where[1]![0]).toBeGreaterThan(0);
  expect(where[2]![1]).toBeGreaterThan(where[0]![1]);
  // Notes write on as their photo comes in.
  expect(clipNamed(p, "Evidence board · note 2").start).toBe(165 - 8);
  // Five is too many to read.
  expect(() => apply(boardProject(5), [{ op: "evidence_board", start: 0, items: [1, 2, 3, 4, 5].map((n) => ({ media: `m${n}`, at: n * 30 })) }])).toThrow("1 to 4 photos");
  // Every item needs at once one has it, in order, inside the board.
  const bad = boardProject(2);
  expect(() => apply(bad, [{ op: "evidence_board", start: 0, items: [{ media: "m1", at: 10 }, { media: "m2" }] }])).toThrow();
  expect(() => apply(bad, [{ op: "evidence_board", start: 0, items: [{ media: "m1", at: 30 }, { media: "m2", at: 20 }] }])).toThrow();
  expect(() => apply(bad, [{ op: "evidence_board", start: 0, end: 20, items: [{ media: "m1", at: 10 }, { media: "m2", at: 30 }] }])).toThrow();
});

test("an_evidence_board_keeps_the_old_frames_timing", () => {
  const p = boardProject(3);
  const result = apply(p, [
    {
      op: "evidence_board",
      start: 0,
      items: [
        { media: "m1", label: "accident?", frames: 60 },
        { media: "m2", label: "arson?", frames: 60 },
        { media: "m3", frames: 60 },
      ],
    },
  ]);
  // Same length as before; each photo centred in the middle of its frames.
  const report = result.results[0] as Record<string, unknown>;
  expect(report.end).toBe(60 * 3 + 30 * 2);
  expect(report.centred).toEqual([30, 120, 210]);
  expect(p.clips.length).toBe(7);
  expect(clipNamed(p, "Evidence board · photo 2").start).toBe(120 - 20);
  expect(clipNamed(p, "Evidence board · note 2").start).toBe(120 - 12);
  expect(issuesOf(p)).toEqual([]);
});

test("an_evidence_board_marks_each_photo_and_lands_a_shutter_on_it", () => {
  const p = boardProject(2);
  p.media.push(
    media({ id: "s1", name: "shutter-1.wav", path: "/s.wav", kind: "audio", duration: 0.17, markers: [{ time: 0.085, name: "hit" }] }),
  );
  // The cut's own shutter (with its flash) just before the first photo.
  p.clips.push(clip({ id: "cut", track: "a5", type: "audio", media: "s1", name: "Shutter", start: 97, duration: 5 }));
  const assets: Assets = { shutter: { media: "s1", hit: 0.085, volume_db: -12 }, desktops: [] };
  const board = {
    op: "evidence_board",
    start: 96,
    end: 250,
    items: [
      { media: "m1", label: "Stripped mattress", at: 104 },
      { media: "m2", label: "Bagged bedding", at: 138 },
    ],
  };
  const result = applyWith(p, [structuredClone(board)], assets);
  // The first photo's shutter is the cut's (8 frames or less away); the second gets its own.
  expect((result.results[0] as Record<string, unknown>).shutters).toEqual([138]);
  const own = p.clips.filter((own) => own.name === BOARD_SHUTTER);
  expect(own.length).toBe(1);
  // Its click (0.085 s = 3 frames in) lands on the photo's frame.
  expect(own[0]!.start + 3).toBe(138);
  expect(own[0]!.track).not.toBe("a4");
  expect(frames(p, BOARD_MARKER)).toEqual([104, 138]);
  expect(p.markers![1]!.note).toBe("Bagged bedding");
  // Rebuilt, it replaces its own shutters and marks rather than doubling them.
  applyWith(p, [structuredClone(board)], assets);
  expect(p.clips.filter((own) => own.name === BOARD_SHUTTER).length).toBe(1);
  expect(p.markers!.length).toBe(2);
  // shutters: false places none.
  const quiet = boardProject(1);
  const none = applyWith(quiet, [{ op: "evidence_board", start: 0, shutters: false, items: [{ media: "m1", at: 20 }] }], assets);
  expect((none.results[0] as Record<string, unknown>).shutters).toEqual([]);
  expect(needs([{ op: "evidence_board", shutters: false }])).toEqual({ shutter: false, desktops: [] });
});

test("a desktop whose first note is said as it starts opens on its windows, not zooming out of the footage first", () => {
  // Mom & Teen's notes came up 1–3 s after their words while the camera zoomed out of the player.
  const p = project("plan");
  p.media.push(media({ id: "room", name: "room.mp4", path: "/room.mp4", kind: "video", duration: 600, width: 1280, height: 720, has_audio: true }));
  p.media.push(media({ id: "next", name: "next.mp4", path: "/next.mp4", kind: "video", duration: 600, width: 1280, height: 720, has_audio: true }));
  p.media.push(media({ id: "wall", name: "wall", path: "/wall.png", kind: "image", duration: 30, width: 1344, height: 752 }));
  p.clips.push(clip({ id: "foot", track: "v1", start: 0, duration: 300, type: "video", media: "room", source_in: 10 }));
  p.clips.push(clip({ id: "after", track: "v1", start: 600, duration: 300, type: "video", media: "next", source_in: 50 }));
  const op = { op: "desktop", start: 300, end: 600, windows: [{ app: "notepad", at: 300, lines: ["Mom lay on the mattress"], line_at: [306] }] };
  const frames: Record<string, string> = {};
  needs([op], p).screens!.forEach(([app, w, h], index) => {
    p.media.push(media({ id: `f${index}`, name: app, path: `/${app}${index}.png`, kind: "image", duration: 30, width: w, height: h }));
    frames[frameKey(app, w, h)] = `f${index}`;
  });
  const result = applyWith(p, [op], { shutter: null, desktops: [], screen: { wallpaper: "wall", frames } }).results[0] as Record<string, unknown>;
  expect((result.camera as Record<string, unknown>).opens_from_footage).toBe(false);
  expect(result.lines_at).toEqual([308]);
  expect(p.clips.some((own) => own.name?.startsWith("Desktop · Video Player") === true)).toBe(false);
});

test("a_desktop_opens_from_the_footage_types_its_notes_and_ends_back_in_that_player_on_the_next_footage", () => {
  const p = project("plan");
  p.media.push(media({ id: "room", name: "room.mp4", path: "/room.mp4", kind: "video", duration: 600, width: 1280, height: 720, has_audio: true }));
  p.media.push(media({ id: "next", name: "next.mp4", path: "/next.mp4", kind: "video", duration: 600, width: 1280, height: 720, has_audio: true }));
  p.media.push(media({ id: "mug", name: "mug", path: "/mug.png", kind: "image", duration: 30, width: 634, height: 730 }));
  p.media.push(media({ id: "wall", name: "wall", path: "/wall.png", kind: "image", duration: 30, width: 1344, height: 752 }));
  p.clips.push(clip({ id: "foot", track: "v1", start: 0, duration: 300, type: "video", media: "room", source_in: 10 }));
  p.clips.push(clip({ id: "after", track: "v1", start: 600, duration: 300, type: "video", media: "next", source_in: 50 }));
  const op = {
    op: "desktop",
    start: 300,
    end: 600,
    windows: [
      { app: "photo_viewer", media: "mug", at: 330, label: "actual image" },
      { app: "notepad", at: 380, lines: ["Charged with murder", "Held without bail"], line_at: [400, 450] },
    ],
  };
  const sizes = needs([op], p).screens!;
  expect(sizes.map(([app]) => app).sort()).toEqual(["notepad", "photo_viewer", "video_player"]);
  const frames: Record<string, string> = {};
  sizes.forEach(([app, w, h], index) => {
    p.media.push(media({ id: `f${index}`, name: app, path: `/${app}${index}.png`, kind: "image", duration: 30, width: w, height: h }));
    frames[frameKey(app, w, h)] = `f${index}`;
  });
  // The tape before carries an uploader's logo top right (watermarks.ts found it).
  const logos = { room: [{ text: "Code Blue Cam logo", box: [0.88, 0.02, 0.97, 0.12] as [number, number, number, number] }] };
  const applied = applyWith(p, [op], { shutter: null, desktops: [], screen: { wallpaper: "wall", frames, marks: logos } });
  const result = applied.results[0] as Record<string, unknown>;
  const camera = result.camera as Record<string, unknown>;
  expect([camera.opens_from_footage, camera.ends_in_footage]).toEqual([true, true]);
  // It's blurred where the player plays that tape, moving with the camera; the next tape has none.
  const blurs = p.clips.filter((own) => own.name === "Desktop · Video Player · mark blur");
  expect(blurs.length).toBe(1);
  const blur = blurs[0]!;
  expect(blur.type === "adjustment" && blur.blur?.shape).toBe("rect");
  expect(new Set((blur.keyframes?.["blur.x"] ?? []).map((key) => Math.round(key.value))).size).toBeGreaterThan(2);
  expect((blur.keyframes?.["blur.width"] ?? []).length).toBeGreaterThan(0);
  // One Video Player: the footage before (10 s + 300 frames = 20 s), then, while it's off screen, the footage after, ending where it starts (50 s).
  const before = p.clips.find((own) => own.name === "Desktop · Video Player · room.mp4") as VideoClip;
  const after = p.clips.find((own) => own.name === "Desktop · Video Player · next.mp4") as VideoClip;
  expect(Math.round(before.source_in)).toBe(20);
  expect(Math.abs(after.source_in + ((after.duration / 30) * after.speed) - 50)).toBeLessThan(0.05);
  expect(after.start + after.duration).toBe(600);
  // The photo waits for the zoom out of the footage (hurried for it: it's due a second in), then pops in.
  expect(p.clips.find((own) => own.name === "Desktop · Photo Viewer · mug")!.start).toBeGreaterThanOrEqual(330);
  expect(p.clips.find((own) => own.name === "Desktop · Photo Viewer · mug")!.start).toBeLessThan(340);
  expect(result.lines_at).toEqual([400, 450]);
  // The notes type on, and the windows and lines are marked for their sounds.
  const notes = p.clips.filter((own) => own.name?.startsWith("Desktop · Notepad note") === true) as TextClip[];
  expect(notes.map((own) => own.text)).toEqual(["- Charged with murder", "- Held without bail"]);
  expect(notes[0]!.animation.preset).toBe("typewriter");
  const marks = (p.markers ?? []).map((marker) => `${marker.name}@${marker.frame}`);
  expect(marks).toContain("desktop line@450");
  // No window overlaps another.
  const windows = result.windows as { centre: [number, number]; width: number }[];
  expect(windows.length).toBe(3);
  // Every clip moves against the camera: the wallpaper's scale changes.
  const wall = p.clips.find((own) => own.name === "Desktop · wallpaper")!;
  const scales = (wall.keyframes?.scale ?? []).map((key) => key.value);
  expect(Math.max(...scales) / Math.min(...scales)).toBeGreaterThan(1.3);
  // Only the keys the camera's curve needs.
  const keys = p.clips.filter((own) => own.name?.startsWith("Desktop ·") === true).reduce((sum, own) => sum + Object.values(own.keyframes ?? {}).reduce((n, list) => n + list.length, 0), 0);
  expect(keys).toBeLessThan(900);
  valid(p);
  // The same picture twice in one desktop is refused; the old picture graphics are retired.
  expect(() => applyWith(p, [{ ...op, windows: [op.windows[0], { ...op.windows[0], at: 400 }] }], { shutter: null, desktops: [], screen: { wallpaper: "wall", frames } })).toThrow(/two windows/);
  expect(() => applyWith(p, [{ op: "desktop_profile", start: 0, duration: 90, media: "mug", lines: ["x"] }], { shutter: null, desktops: [] })).toThrow(/retired/);
});

test("desktop windows named together open at least a second apart", () => {
  // JJ: "dangerous to have two things appear at the same time when they are across the screen".
  const p = project("plan");
  p.media.push(media({ id: "room", name: "room.mp4", path: "/room.mp4", kind: "video", duration: 600, width: 1280, height: 720, has_audio: true }));
  p.media.push(media({ id: "mug", name: "mug", path: "/mug.png", kind: "image", duration: 30, width: 634, height: 730 }));
  p.media.push(media({ id: "home", name: "home", path: "/home.png", kind: "image", duration: 30, width: 1200, height: 800 }));
  p.media.push(media({ id: "wall", name: "wall", path: "/wall.png", kind: "image", duration: 30, width: 1344, height: 752 }));
  p.clips.push(clip({ id: "foot", track: "v1", start: 0, duration: 300, type: "video", media: "room", source_in: 10 }));
  const op = {
    op: "desktop",
    start: 300,
    end: 600,
    windows: [
      { app: "photo_viewer", media: "mug", at: 310 },
      { app: "photo_viewer", media: "home", at: 312 },
      { app: "notepad", at: 315, lines: ["Charged with murder"] },
    ],
  };
  const frames: Record<string, string> = {};
  needs([op], p).screens!.forEach(([app, w, h], index) => {
    p.media.push(media({ id: `f${index}`, name: app, path: `/${app}${index}.png`, kind: "image", duration: 30, width: w, height: h }));
    frames[frameKey(app, w, h)] = `f${index}`;
  });
  applyWith(p, [op], { shutter: null, desktops: [], screen: { wallpaper: "wall", frames } });
  const opens = ["Desktop · Photo Viewer · mug", "Desktop · Photo Viewer · home", "Desktop · Notepad"].map((name) => p.clips.find((own) => own.name === name)!.start);
  expect(opens[1]! - opens[0]!).toBeGreaterThanOrEqual(30);
  expect(opens[2]! - opens[1]!).toBeGreaterThanOrEqual(30);
  valid(p);
});

test("review_notes_on_screen_are_flagged", () => {
  const p = project("plan");
  apply(p, [
    { op: "add", clip: { type: "solid", track: "v1", start: 0, duration: 60, fill: [0, 0, 0, 1] } },
    { op: "add", clip: { type: "text", track: "new", start: 0, duration: 30, text: "Go to the [unclear]" } },
    { op: "add", clip: { type: "text", track: "new", start: 30, duration: 30, text: "Go to the store" } },
  ]);
  const issues = issuesOf(p);
  expect(issues.length).toBe(1);
  expect(issues[0]!.kind).toBe("placeholder_text");
});

test("transitions_are_built_the_house_way", () => {
  const p = project("plan");
  apply(p, [
    { op: "add", clip: { type: "solid", track: "v1", start: 0, duration: 300, fill: [0, 0, 0, 1] } },
    { op: "transition", kind: "open" },
    { op: "transition", kind: "dip", at: 100 },
    { op: "transition", kind: "drop", at: 200 },
    { op: "transition", kind: "flash", at: 2 },
  ]);
  const named = (name: string) => clipNamed(p, name);
  expect([named("Opening dip").start, named("Opening dip").duration]).toEqual([0, 15]);
  expect([named("Dip").start, named("Dip").duration]).toEqual([94, 12]);
  expect(named("Dip").keyframes!.opacity!.length).toBe(3);
  expect([named("Drop").start, named("Drop").duration]).toEqual([197, 6]);
  // Cut off at the start of the video.
  expect([named("Flash").start, named("Flash").duration]).toEqual([0, 5]);
  expect(() => apply(p, [{ op: "transition", kind: "dip" }])).toThrow();
});

test("a_style_s_own_transition_is_built_and_heard_but_never_called_repetitive", () => {
  const p = project("plan");
  const plan: unknown[] = [{ op: "add", clip: { type: "solid", track: "v1", start: 0, duration: 3000, fill: [0, 0, 0, 1] } }];
  for (let index = 0; index < 6; index++) plan.push({ op: "transition", kind: index % 2 === 0 ? "light_leak" : "burn", at: 100 + index * 200 });
  apply(p, plan);
  const leak = clipNamed(p, "Light leak");
  expect([leak.start, leak.duration, leak.type]).toEqual([92, 16, "adjustment"]);
  expect(Object.keys(leak.keyframes!)).toEqual(["exposure", "leak", "leak_x"]);
  expect(Math.max(...leak.keyframes!.leak!.map((key) => key.value))).toBe(3.2);
  const burn = clipNamed(p, "Bridge flash");
  expect([burn.start, burn.duration]).toEqual([294, 12]);
  expect(burn.keyframes!.exposure![1]).toMatchObject({ frame: 6, value: 2.6 });
  // On every bridge on purpose; but each one is heard.
  expect(kinds(p, "repetitive_transitions")).toEqual([]);
  expect(kinds(p, "silent_transition").length).toBe(6);
});

test("capitals_and_a_still_light_leak_survive_a_plan", () => {
  const p = project("plan");
  apply(p, [
    { op: "add", clip: { type: "solid", track: "v1", start: 0, duration: 60, fill: [0, 0, 0, 1] } },
    { op: "add", clip: { type: "text", track: "new", name: "Words", start: 0, duration: 60, text: "Is that clear?", style: { uppercase: true } } },
    { op: "add", clip: { type: "adjustment", track: "new", name: "Glow", start: 0, duration: 60, grade: { leak: 0.8, leak_x: -1 } } },
  ]);
  const words = clipNamed(p, "Words");
  expect(words.type === "text" && words.style.uppercase).toBe(true);
  const glow = clipNamed(p, "Glow");
  expect(glow.type === "adjustment" && [glow.grade.leak, glow.grade.leak_x]).toEqual([0.8, -1]);
});

test("words_go_above_every_blur_and_any_left_under_one_are_flagged", () => {
  const p = project("plan");
  apply(p, [
    { op: "add", clip: { type: "solid", track: "v1", start: 0, duration: 90, fill: [0.5, 0.5, 0.5, 1] } },
    { op: "add", clip: { type: "text", track: "new", name: "Tag", start: 0, duration: 60, text: "TERMINATION INTERVIEW", style: { size: 30 }, transform: { x: 0, y: -450 } } },
    { op: "add", clip: { type: "text", track: "new", name: "Clear", start: 0, duration: 60, text: "Elsewhere", transform: { x: 0, y: 400 } } },
    // A monitor's redaction on a track above both, over the first only.
    { op: "add", clip: { type: "adjustment", track: "new", name: "Redaction", start: 0, duration: 90, blur: { radius: 45, x: 450, y: -450, width: 1100, height: 180 } } },
  ]);
  // The plan puts every word above the blur, wherever the blur's box is.
  expect(kinds(p, "text_under_blur")).toEqual([]);
  const level = (name: string) => p.tracks.findIndex((track) => track.id === clipNamed(p, name).track);
  expect(level("Tag")).toBeGreaterThan(level("Redaction"));
  expect(level("Clear")).toBeGreaterThan(level("Redaction"));
  // A blur put over words some other way is flagged, box or not.
  const words = clipNamed(p, "Clear");
  const blur = clipNamed(p, "Redaction");
  [words.track, blur.track] = [blur.track, words.track];
  expect(kinds(p, "text_under_blur").map((issue) => issue.clip)).toEqual([words.id]);
});

test("a courtroom video's small callouts and tags are flagged; subtitles and other styles aren't", () => {
  const p = project("plan");
  apply(p, [
    { op: "add", clip: { type: "solid", track: "v1", start: 0, duration: 90, fill: [0.5, 0.5, 0.5, 1] } },
    { op: "add", clip: { type: "text", track: "new", name: "Reaction • Oath", start: 0, duration: 60, text: "*UNDER OATH*", style: { size: 44 } } },
    { op: "add", clip: { type: "text", track: "new", name: "Name • Joshua", start: 0, duration: 60, text: "JOSHUA MCCLUSKEY", style: { size: 64 } } },
    { op: "add", clip: { type: "text", track: "new", name: "Subtitle", start: 0, duration: 60, text: "Unintentionally, sir.", style: { size: 48 } } },
  ]);
  expect(kinds(p, "small_text")).toEqual([]);
  p.style = "courtroom";
  expect(kinds(p, "small_text").map((issue) => [issue.text, issue.size])).toEqual([["*UNDER OATH*", 44]]);
});

test("a line subtitled under a second of black is flagged; a fade to black and a line after it aren't", () => {
  const p = project("plan");
  apply(p, [
    { op: "add", clip: { type: "solid", track: "new", name: "One second of black", start: 100, duration: 30, fill: [0, 0, 0, 1] } },
    { op: "add", clip: { type: "solid", track: "new", name: "Dip", start: 200, duration: 30, fill: [0, 0, 0, 1], keyframes: { opacity: [{ frame: 0, value: 0 }, { frame: 29, value: 1 }] } } },
    { op: "add", clip: { type: "text", track: "new", name: "Subtitle (teaser)", start: 103, duration: 27, text: "Stephanie, here's the situation." } },
    { op: "add", clip: { type: "text", track: "new", name: "Subtitle", start: 205, duration: 20, text: "Fading out." } },
    { op: "add", clip: { type: "text", track: "new", name: "Subtitle", start: 127, duration: 40, text: "After it." } },
  ]);
  expect(kinds(p, "line_under_black").map((issue) => [issue.text, issue.start, issue.end])).toEqual([["Stephanie, here's the situation.", 103, 130]]);
});

test("a_compilation_title_card_frames_its_photos_in_two_rows_around_the_title", () => {
  const p = project("plan");
  for (let index = 1; index <= 5; index++) {
    // Portraits and landscapes alike: each cropped to the same box.
    const [width, height] = index % 2 === 0 ? [800, 1200] : [1920, 1080];
    p.media.push(media({ id: `m${index}`, name: "photo", path: `/p${index}.jpg`, kind: "image", duration: 30, width, height }));
  }
  apply(p, [{ op: "title_collage", title: "When cocky attorneys taunted judges…", photos: ["m1", "m2", "m3", "m4", "m5"], start: 0, end: 150 }]);
  const photos = p.clips.filter((clip) => (clip.name ?? "").startsWith("Title card · photo"));
  expect(photos.length).toBe(5);
  const ys = photos.map((clip) => (clip.type === "video" ? Math.round(clip.transform.y) : 0));
  expect(ys.filter((y) => y < 0).length).toBe(3);
  expect(ys.filter((y) => y > 0).length).toBe(2);
  for (const clip of photos) {
    if (clip.type !== "video") continue;
    expect(clip.frame).toBeTruthy();
    // Every photo shows the same box: its width at full scale is ~25% of the frame.
    const own = p.media.find((one) => one.id === clip.media)!;
    const fit = Math.min(1920 / own.width, 1080 / own.height);
    const shown = own.width * fit * clip.transform.scale * (1 - clip.crop!.left - clip.crop!.right);
    expect(Math.abs(shown - 0.245 * 1920)).toBeLessThan(1);
  }
  const title = clipNamed(p, "Title card · title");
  expect(title.type === "text" && title.style.uppercase).toBe(true);
  expect(() => apply(p, [{ op: "title_collage", title: "When…", photos: ["m1"], start: 0, end: 150 }])).toThrow("2 to 6");
});

test("unresolved_reference_and_bad_final_state_fail", () => {
  const p = project("plan");
  expect(() => apply(p, [{ op: "delete", select: { ids: [{ $ref: "missing" }] } }])).toThrow(
    "operation 1: unknown reference missing; use an earlier operation's alias; nothing saved",
  );
  expect(() => apply(p, [{ op: "add", clip: { type: "solid", start: 0, duration: 0, fill: [0, 0, 0, 1] } }])).toThrow(
    "final plan is invalid",
  );
});

test("rejected_plan_leaves_disk_revision_and_events_untouched", async () => {
  const { store, home, cleanup } = fixtureHome("plan-rejected");
  try {
    const live = store.create("atomic", { width: 1920, height: 1080, fps: 30 });
    const id = live.project.id;
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));
    const before = await Bun.file(`${home}/projects/${id}.json`).text();
    let error = "";
    try {
      await store.update(id, "test", (project) =>
        apply(project, [
          { op: "add", clip: { type: "solid", start: 0, duration: 30, fill: [0, 0, 0, 1] } },
          { op: "update", select: { track: 4 }, patch: { duration: 60 } },
        ]),
      );
    } catch (failed) {
      error = (failed as Error).message;
    }
    expect(error).toBe("operation 2: select: invalid type: integer `4`, expected a string; nothing saved");
    expect(store.get(id)!.rev).toBe(live.rev);
    expect(events).toEqual([]);
    expect(await Bun.file(`${home}/projects/${id}.json`).text()).toBe(before);
  } finally {
    cleanup();
  }
});

test("one_plan_commits_once_and_stale_retry_cannot_duplicate_it", async () => {
  const { store, cleanup } = fixtureHome("plan-retry");
  try {
    const live = store.create("atomic", { width: 1920, height: 1080, fps: 30 });
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));
    const project = structuredClone(live.project) as Project;
    apply(project, [
      { op: "add", clip: { type: "solid", start: 0, duration: 30, fill: [0, 0, 0, 1] } },
      { op: "add", clip: { type: "solid", start: 30, duration: 30, fill: [0, 0, 0, 1] } },
    ]);
    const saved = await store.replace(project.id, live.rev, structuredClone(project), "test");
    expect(saved.rev).toBe(live.rev + 1);
    expect(events.length).toBe(1);
    let kind = "";
    try {
      await store.replace(project.id, live.rev, structuredClone(project), "test");
    } catch (error) {
      kind = (error as { kind: string }).kind;
    }
    expect(kind).toBe("conflict");
    expect(store.get(project.id)!.project.clips.length).toBe(2);
  } finally {
    cleanup();
  }
});

test("the_reference_effects_build_valid_clips", () => {
  const p = project("plan");
  p.media.push(media({ id: "room", name: "room.mp4", path: "/room.mp4", kind: "video", duration: 600, width: 1280, height: 720, has_audio: true }));
  p.media.push(media({ id: "mug", name: "mug", path: "/mug.png", kind: "image", duration: 30, width: 634, height: 730 }));
  p.clips.push(clip({ id: "foot", track: "v1", start: 0, duration: 900, type: "video", media: "room", source_in: 10 }));
  p.clips.push(clip({ id: "sub", track: "v2", start: 620, duration: 60, type: "text", name: "Subtitle · Caller", text: "We're really concerned about him" }));
  const viewer = { op: "file_viewer", media: "mug", start: 500, end: 600, x: 300, y: -200, name: "Larry Scott" };
  const [, w, h] = needs([viewer], p).screens![0]!;
  p.media.push(media({ id: "fv", name: "fv", path: "/graphics/fv.png", kind: "image", duration: 30, width: w, height: h }));
  const applied = applyWith(
    p,
    [
      { op: "film_look", start: 0, end: 120, tag: "actual photo", soft_edges: true },
      { op: "red_quote", text: "Nobody's seen her", start: 150, end: 260, face: [-200, 100] },
      { op: "annotate", start: 300, end: 450, tag: "actual photo", notes: [{ text: "excess blood", at: 320, point: [0, 50] }, { text: "signs of trauma", at: 360, point: [100, 150] }] },
      viewer,
      { op: "call", start: 600, end: 720, color: "blue" },
    ],
    { shutter: null, desktops: [], screen: { wallpaper: "fv", frames: { [frameKey("file_viewer", w, h)]: "fv" } } },
  );
  expect(applied.results.length).toBe(5);
  expect(p.clips.some((own) => own.type === "text" && own.text === "[ACTUAL PHOTO]")).toBe(true);
  // The film look's grain and scan lines survive the clip reader.
  const look = p.clips.find((own) => own.name === "Film look");
  expect(look?.type === "adjustment" && (look.grade.grain ?? 0) > 0 && (look.grade.scanlines ?? 0) > 0).toBe(true);
  expect(p.clips.some((own) => own.type === "text" && own.text === "“Nobody's seen her”")).toBe(true);
  expect(p.clips.some((own) => own.type === "text" && own.text === "LARRY SCOTT")).toBe(true);
  expect(p.clips.some((own) => own.type === "waveform")).toBe(true);
  expect(p.clips.find((own) => own.id === "sub")!.name).toBe("Call words");
  valid(p);
});

test("a left-aligned text reworded keeps its left edge (a Notepad line never grows over its window's edge)", () => {
  const p = project("plan");
  apply(p, [
    {
      op: "add",
      as: "note",
      clip: {
        type: "text", track: "v1", start: 0, duration: 60, text: "- Nothing more?",
        style: { font: "Geist", weight: 400, size: 40, color: [1, 1, 1, 1], line_height: 1.4, align: "left" },
        transform: { x: 100, y: 0, scale: 0.5, rotation: 0 },
        keyframes: { x: [{ frame: 0, value: 100, ease: "linear" }], scale: [{ frame: 0, value: 0.5, ease: "linear" }] },
      },
    },
  ]);
  const id = p.clips[0]!.id;
  const width = (text: string) => native().textBlock(text, 40, 400, 1.4)[0];
  const left = (own: TextClip) => own.transform.x - (width(own.text) / 2) * own.transform.scale;
  const before = left(p.clips[0] as TextClip);
  apply(p, [{ op: "update", select: { ids: [id] }, patch: { text: "- Nothing more to add?" } }]);
  const after = p.clips[0] as TextClip;
  expect(Math.abs(left(after) - before)).toBeLessThan(0.01);
  expect(after.keyframes!.x![0]!.value).toBeCloseTo(after.transform.x, 3);
});

test("a courtroom video's subtitle whose words aren't white is flagged", () => {
  const p = project("plan");
  apply(p, [
    { op: "add", clip: { type: "text", track: "new", name: "Subtitle · Judge", start: 0, duration: 60, text: "Sit down.", style: { size: 48 } } },
    { op: "add", clip: { type: "text", track: "new", name: "Subtitle · Trooper", start: 60, duration: 60, text: "Yes, sir.", style: { size: 48, color: [0.4, 0.6, 1, 1] } } },
    { op: "add", clip: { type: "text", track: "new", name: "Reaction • Oath", start: 0, duration: 60, text: "*UNDER OATH*", style: { size: 64, color: [1, 0.2, 0.2, 1] } } },
  ]);
  // Unlabelled, it's a Repack-style line whose words carry its colour; in a courtroom video they're white.
  expect(kinds(p, "subtitle_coloured")).toEqual([]);
  p.style = "courtroom";
  expect(kinds(p, "subtitle_coloured").map((issue) => issue.text)).toEqual(["Yes, sir."]);
});

test("an actual-image label over a window is flagged; over a full-frame picture it isn't", () => {
  const p = project("plan");
  apply(p, [
    { op: "add", clip: { type: "solid", track: "new", name: "Desktop · Photo Viewer", start: 0, duration: 90, fill: [0.2, 0.2, 0.2, 1] } },
    { op: "add", clip: { type: "text", track: "new", name: "Tag", start: 10, duration: 60, text: "(actual image)", style: { size: 30 } } },
    { op: "add", clip: { type: "text", track: "new", name: "Tag 2", start: 200, duration: 60, text: "[ACTUAL PHOTO]", style: { size: 30 } } },
  ]);
  expect(kinds(p, "actual_label_in_window").map((issue) => issue.text)).toEqual(["(actual image)"]);
});

test("a dissolve fades the incoming shot's lead-in over the outgoing one, and the shot carries on from the same frame", () => {
  const p = project("plan");
  p.media.push(media({ id: "a", name: "A", path: "/a.mp4", kind: "video", duration: 60, width: 1920, height: 1080 }), media({ id: "b", name: "B", path: "/b.mp4", kind: "video", duration: 60, width: 1920, height: 1080 }));
  apply(p, [
    { op: "add", clip: { type: "video", media: "a", track: "v1", start: 0, duration: 100, source_in: 5 } },
    { op: "add", clip: { id: "in", type: "video", media: "b", track: "v1", start: 100, duration: 100, source_in: 10, speed: 0.8 } },
    { op: "transition", kind: "dissolve", at: 100 },
  ]);
  const lead = p.clips.find((c) => (c.name ?? "").startsWith("Dissolve"))!;
  expect(lead).toMatchObject({ start: 88, duration: 12, fade_in: 12, media: "b" });
  expect((lead as VideoClip).source_in).toBeCloseTo(10 - (12 / 30) * 0.8);
  expect(() => apply(p, [{ op: "transition", kind: "dissolve", at: 0 }])).toThrow();
});
