import { afterAll, beforeAll, expect, test } from "bun:test";

import { apply, applyWith, audit, BOARD_MARKER, BOARD_SHUTTER, hooks, needs, type Assets } from "../src/edit_plan.ts";
import { frames } from "../src/markers.ts";
import type { Clip, Project, TextClip, VideoClip } from "../src/model.ts";
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

const f = Math.fround;

/** The camera's speed (px a frame) at `frame` of a board element, from its x and y keyframes as the renderer samples them. */
function boardSpeed(own: Clip, frame: number): number {
  const at = (param: string, at: number) => sample(own.keyframes![param]!, at)!;
  const step = f(0.02);
  const dx = f(at("x", f(frame + step)) - at("x", f(frame - step)));
  const dy = f(at("y", f(frame + step)) - at("y", f(frame - step)));
  return f(f(Math.hypot(dx, dy)) / f(2 * step));
}

/**
 * One continuous movement: never a stop, the speed smooth through every key,
 * easing a little at each photo (`photos`: when each is centred) and picking
 * up between, within ~0.5x-1.5x its average from first to last.
 */
function assertGlides(own: Clip, photos: number[], end: number): void {
  const speed = (frame: number) => boardSpeed(own, frame);
  for (const key of own.keyframes!.x!) {
    if (key.frame > 0.5 && key.frame < end - 0.5) {
      const [before, here, after] = [speed(f(key.frame - 0.1)), speed(key.frame), speed(f(key.frame + 0.1))];
      const jump = Math.abs(after - here - (here - before));
      expect(jump, `jolt at ${key.frame}: ${before}, ${here}, ${after}`).toBeLessThan(0.05 + 0.01 * here);
    }
  }
  // From one photo to the next it only eases a little and picks up a little.
  for (let index = 0; index + 1 < photos.length; index++) {
    const [from, to] = [photos[index]!, photos[index + 1]!];
    const speeds = Array.from({ length: Math.trunc((to - from) * 4) + 1 }, (_, step) => speed(from + step * 0.25));
    const average = speeds.reduce((sum, value) => sum + value, 0) / speeds.length;
    const slowest = Math.min(...speeds);
    const fastest = Math.max(0, ...speeds);
    expect(slowest > 0.5 * average && fastest < 1.35 * average, `${from}-${to}: ${slowest} to ${fastest}, average ${average}`).toBe(
      true,
    );
  }
  // Slowest as it passes each photo between the first and the last.
  for (const at of photos.slice(1, -1)) {
    expect(speed(at) < speed(at - 3) && speed(at) < speed(at + 3), `not easing at the photo at ${at}`).toBe(true);
  }
  // Before the first photo and after the last it drifts, never stops.
  for (let step = 0; step < Math.trunc(end); step++) expect(speed(step + 0.5), `stopped at ${step}`).toBeGreaterThan(0.3);
}

test("an_evidence_board_glides_continuously_past_photos_centred_on_their_words", () => {
  const p = boardProject(5);
  const ats = [139, 165, 185, 207, 243];
  const items = ats.map((at, index) => ({ media: `m${index + 1}`, label: "zip ties", at }));
  const result = apply(p, [{ op: "evidence_board", start: 100, end: 346, illustrative: true, items }]);
  // Paper, five photos and notes, the vignette, "Illustrative images".
  expect(p.clips.length).toBe(13);
  const report = result.results[0] as Record<string, unknown>;
  expect(report.end).toBe(346);
  expect(report.centred).toEqual(ats);
  ats.forEach((at, index) => {
    const photo = clipNamed(p, `Evidence board · photo ${index + 1}`);
    expect([photo.start, photo.duration]).toEqual([100, 246]);
    for (const param of ["x", "y"]) {
      const value = sample(photo.keyframes![param]!, at - 100)!;
      expect(Math.abs(value), `photo ${index} ${param} ${value} at its word`).toBeLessThan(0.5);
    }
    assertGlides(photo, [39, 65, 85, 107, 143], 246);
  });
  // Each note writes on as its photo comes in, moving with the board.
  const note = clipNamed(p, "Evidence board · note 2");
  expect(note.start).toBe(165 - 8);
  const photo = clipNamed(p, "Evidence board · photo 2");
  const offset = (frame: number, param: string) =>
    sample(note.keyframes![param]!, frame)! - sample(photo.keyframes![param]!, frame + 57)!;
  for (const frame of [5, 10, 40, 100, 188]) {
    for (const param of ["x", "y"]) {
      const [now, first] = [offset(frame, param), offset(0, param)];
      expect(Math.abs(now - first), `note drifts from its photo: ${now} vs ${first}`).toBeLessThan(0.5);
    }
  }
  // Nothing to flag but the empty timeline before the board.
  const issues = issuesOf(p);
  expect(issues.every((issue) => issue.kind === "picture_gap" && issue.end === 100)).toBe(true);
  // Every item needs at once one has it, in order.
  const bad = boardProject(2);
  expect(() => apply(bad, [{ op: "evidence_board", start: 0, items: [{ media: "m1", at: 10 }, { media: "m2" }] }])).toThrow();
  expect(() =>
    apply(bad, [
      {
        op: "evidence_board",
        start: 0,
        items: [
          { media: "m1", at: 30 },
          { media: "m2", at: 20 },
        ],
      },
    ]),
  ).toThrow();
  expect(() =>
    apply(bad, [
      {
        op: "evidence_board",
        start: 0,
        end: 20,
        items: [
          { media: "m1", at: 10 },
          { media: "m2", at: 30 },
        ],
      },
    ]),
  ).toThrow();
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
  const photo = clipNamed(p, "Evidence board · photo 2");
  const x = sample(photo.keyframes!.x!, 120)!;
  expect(Math.abs(x)).toBeLessThan(0.5);
  assertGlides(photo, [30, 120, 210], 240);
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

test("a_desktop_profile_builds_a_valid_animated_screen", () => {
  const p = project("plan");
  for (const [id, width, height] of [
    ["wall", 1920, 1080],
    ["pv", 575, 800],
    ["np", 972, 658],
    ["mug", 634, 730],
  ] as const) {
    p.media.push(media({ id, name: id, path: `/${id}.png`, kind: "image", duration: 30, width, height }));
  }
  const op = { op: "desktop_profile", start: 300, duration: 180, media: "mug", lines: ["36-year-old mother", "- Charged with murder"] };
  expect(needs([op]).desktops).toEqual([["Photo Viewer", "Notepad"]]);
  // Without its pictures prepared it says so.
  expect(() => apply(structuredClone(p), [op])).toThrow();
  const assets: Assets = {
    shutter: null,
    desktops: [{ photo_title: "Photo Viewer", notepad_title: "Notepad", wallpaper: "wall", photo_viewer: "pv", notepad: "np" }],
  };
  const result = applyWith(p, [op], assets);
  valid(p);
  const report = result.results[0] as Record<string, unknown>;
  expect(report.end).toBe(480);
  expect((report.clips as string[]).length).toBe(6);
  const named = (name: string) => clipNamed(p, `Desktop profile · ${name}`);
  // The Photo Viewer comes in first, the Notepad a few frames later, each from 96%.
  const [viewer, notepad] = [named("photo viewer"), named("notepad")];
  expect(viewer.start).toBeLessThan(notepad.start);
  const scale = (own: Clip, frame: number) => sample(own.keyframes!.scale!, frame)!;
  const opacity = (own: Clip, frame: number) => sample(own.keyframes!.opacity!, frame)!;
  expect(Math.abs(scale(viewer, 0) / scale(viewer, 12) - 0.96)).toBeLessThan(0.01);
  expect(opacity(viewer, 0) < 0.05 && opacity(viewer, 10) > 0.99).toBe(true);
  // Gone by the end, the Notepad first.
  const end = 480 - viewer.start - 1;
  expect(opacity(viewer, end)).toBeLessThan(0.05);
  const notepadEnd = 480 - notepad.start - 1;
  expect(opacity(notepad, notepadEnd - 3)).toBeLessThan(opacity(viewer, end - 3));
  // The photo fills the content area: cropped to its shape, centred in it.
  const photo = named("photo") as VideoClip;
  // (634 × 730 is wider than the 555 × 714 content area: its sides go.)
  const crop = photo.crop!;
  expect(crop.left! > 0 && Math.abs(crop.left! - crop.right!) < 1e-6 && (crop.top ?? 0) === 0).toBe(true);
  // The lines type on word by word, the second after the first; one "- " each.
  const notes = named("notes") as TextClip;
  expect(notes.text).toBe("- 36-year-old mother\n- Charged with murder");
  const times = notes.word_times!;
  expect(times.length).toBe(7);
  expect(times[2]! < times[3]! && times[0] === 0).toBe(true);
  // The whole screen pushes in.
  const wall = named("wallpaper");
  expect(scale(wall, 179)).toBeGreaterThan(scale(wall, 0) * 1.03);
  expect(frames(p, "desktop window opens").length).toBe(2);
  expect(issuesOf(p).every((issue) => issue.kind === "picture_gap")).toBe(true);
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
