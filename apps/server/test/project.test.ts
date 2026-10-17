// The edit-core helpers ported to TS (project.ts), with edit-core's own tests
// (model.rs, eval.rs, sections.rs) and mcp.rs's for the edit primitives.

import { expect, test } from "bun:test";

import type { Clip, Ease, Keyframe, Media, Project } from "../src/model.ts";
import {
  addTrack,
  clipOf,
  ease,
  freshId,
  inOut,
  isDateCard,
  isSoundEffect,
  marksCut,
  merge,
  mergeClip,
  muteGain,
  newProject,
  presetHandles,
  sample,
  subtitledSpans,
  subtitlesTrack,
  tidyTracks,
  touchesPeople,
  trackLabel,
} from "../src/project.ts";

const SETTINGS = { width: 1920, height: 1080, fps: 30 };

function solid(id: string, track: string, start: number, duration: number): Clip {
  return { id, track, start, duration, color: "blue", fade_in: 0, fade_out: 0, type: "solid", fill: [0, 0, 0, 1], opacity: 1 };
}

test("fresh_ids_skip_existing_clips_and_links_and_wrap_safely", () => {
  const p = newProject("p", "t", SETTINGS);
  p.clips.push({ ...solid("c1", "v1", 0, 10), link: "l2" });
  p.next_id = 1;
  expect(freshId(p, "c")).toBe("c2");
  p.next_id = 2;
  expect(freshId(p, "l")).toBe("l3");
  p.next_id = 9_007_199_254_740_991;
  expect(freshId(p, "c")).toBe("c9007199254740991");
  expect(freshId(p, "c")).toBe("c2");
});

test("mutes_ramp_and_must_run_forwards", () => {
  const mutes = [{ from: 2.0, to: 2.5 }];
  expect(muteGain(mutes, 2.2)).toBe(0);
  expect(muteGain(mutes, 1.9)).toBe(1);
  expect(Math.abs(muteGain(mutes, 2.506) - 0.5)).toBeLessThan(1e-9);
});

test("date_cards", () => {
  expect(isDateCard("On July 13, 2024, Kent police officers were dispatched")).toBe(true);
  expect(isDateCard("In March 2021, a man called 911")).toBe(true);
  expect(isDateCard("on the night of Dec. 3rd")).toBe(true);
  expect(isDateCard("On 4 September, police")).toBe(true);
  expect(isDateCard("This mother had absolutely no idea")).toBe(false);
  expect(isDateCard("In a car crash, perhaps")).toBe(false);
  expect(isDateCard("On the way home")).toBe(false);
});

test("sound_effects", () => {
  const sound = (path: string, duration: number) =>
    ({ id: "s", name: "s", path, kind: "audio", duration, width: 0, height: 0, fps: 0, has_audio: true }) as Media;
  expect(isSoundEffect(sound("/Users/me/.edit/sfx/shutter-1a2b.wav", 0.17))).toBe(true);
  expect(isSoundEffect(sound("/Users/me/.edit/sfx/riser-9f.wav", 8.0))).toBe(true);
  expect(isSoundEffect(sound("/x/whoosh.wav", 1.2))).toBe(true);
  expect(isSoundEffect(sound("/Users/me/.edit/library/music/0a1b2c3d4e5f/Drone.wav", 240.0))).toBe(true);
  expect(isSoundEffect(sound("/x/library/voiceover.wav", 42.0))).toBe(false);
  expect(isSoundEffect(sound("/x/voiceover.wav", 42.0))).toBe(false);
});

function key(frame: number, value: number, kind: Ease): Keyframe {
  return { frame, value, ease: kind };
}

test("sample_eases_and_holds", () => {
  const keys = [key(0, 0, "hold"), key(10, 10, "linear"), key(20, 0, "linear")];
  expect(sample(keys, -5)).toBe(0);
  expect(sample(keys, 9)).toBe(0);
  expect(Math.abs(sample(keys, 15)! - 5)).toBeLessThan(1e-3);
  expect(sample(keys, 50)).toBe(0);
  expect(sample([], 3)).toBeNull();
});

test("presets_follow_their_curves", () => {
  const close = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const linear = [key(0, 0, "linear"), key(30, 90, "linear")];
  expect(close(sample(linear, 10)!, 30)).toBe(true);
  const inOut = [key(0, 0, "in_out"), key(30, 100, "linear")];
  expect(close(sample(inOut, 15)!, 50)).toBe(true);
  expect(sample(inOut, 3)!).toBeLessThan(3);
  const easeIn = [key(0, 0, "in"), key(10, 1, "linear")];
  expect(close(sample(easeIn, 5)!, ease("in", 0.5))).toBe(true);
});

test("handles_shape_the_segment", () => {
  // A fast start: leave at 10 units/frame, arrive flat.
  const keys: Keyframe[] = [key(0, 0, "linear"), key(20, 100, "linear")];
  keys[0]!.handle_out = { speed: 10, influence: 0.3 };
  keys[1]!.handle_in = { speed: 0, influence: 0.5 };
  expect(sample(keys, 4)!).toBeGreaterThan(30);
  let last = -Infinity;
  for (let frame = 0; frame <= 20; frame++) {
    const value = sample(keys, frame)!;
    expect(value).toBeGreaterThanOrEqual(last - 1e-3);
    last = value;
  }
  expect(Math.abs(sample(keys, 20)! - 100)).toBeLessThan(1e-3);
  // Explicit handles equal to the preset's give the preset's curve.
  const preset = [key(0, 0, "in_out"), key(20, 100, "linear")];
  const [out, inn] = presetHandles("in_out", 5);
  const explicit: Keyframe[] = [
    { ...preset[0]!, handle_out: out },
    { ...preset[1]!, handle_in: inn },
  ];
  for (const frame of [2, 7, 13, 18]) {
    expect(Math.abs(sample(preset, frame)! - sample(explicit, frame)!)).toBeLessThan(1e-4);
  }
});

test("values come out as edit-core's f32s", () => {
  const keys = [key(0, 0.1, "linear"), key(10, 0.7, "linear")];
  const value = sample(keys, 3)!;
  expect(Math.fround(value)).toBe(value);
});

test("tidy_tracks_drops_layers_into_gaps_and_keeps_their_order", () => {
  const project = newProject("p", "t", SETTINGS);
  project.tracks = [];
  const [v1, v2, v3, v4] = [0, 1, 2, 3].map(() => addTrack(project, "video")) as [string, string, string, string];
  addTrack(project, "audio");
  project.clips = [
    solid("footage", v1, 0, 100),
    // A caption alone on V3 with V2 empty under it: drops to V2.
    solid("caption", v3, 0, 20),
    // A flash on V4 over a title on V2: drops to V3 (still above the title), not onto it.
    solid("title", v2, 40, 30),
    solid("flash", v4, 50, 5),
  ];
  const [moved, removed] = tidyTracks(project);
  const trackOf = (id: string) => clipOf(project, id)!.track;
  expect(trackOf("footage")).toBe(v1);
  expect(trackOf("caption")).toBe(v2);
  expect(trackOf("title")).toBe(v2);
  expect(trackOf("flash")).toBe(v3);
  expect([moved, removed]).toEqual([2, 1]);
  expect(project.tracks.some((track) => track.id === v4)).toBe(false);
});

test("speaker_captions_never_take_a_label", () => {
  const label = { style: { label: { text: "Officer:", color: [1, 1, 1, 1], size: 26 } } };
  const caption = mergeClip({ name: "Caption · Sinclair (Officer)", style: { size: 40 } }, label);
  expect((caption.style as Record<string, unknown>).label).toBeUndefined();
  expect((caption.style as Record<string, unknown>).size).toBe(40);
  const subtitle = mergeClip({ name: "Subtitle · Sinclair (Officer)", style: {} }, label);
  expect(((subtitle.style as Record<string, unknown>).label as { text: string }).text).toBe("Officer:");
});

test("merge_patch_follows_rfc_7386", () => {
  const value = { a: 1, style: { size: 10, glow: { enabled: false } } };
  const merged = merge(value, { a: null, style: { glow: { enabled: true } }, b: [1] });
  expect(merged).toEqual({ style: { size: 10, glow: { enabled: true } }, b: [1] });
  expect(merge({ a: 1 }, "replaced")).toBe("replaced");
  expect(merge({ a: 1 }, null)).toEqual({ a: 1 });
});

test("a patch touches people when it can change a label, colour or name", () => {
  expect(touchesPeople({ name: null })).toBe(true);
  expect(touchesPeople({ style: { color: [1, 0, 0, 1] } })).toBe(true);
  expect(touchesPeople({ style: { size: 40 } })).toBe(false);
  expect(touchesPeople({ start: 3 })).toBe(false);
});

test("tracks, labels, in and out, subtitled spans and cuts", () => {
  const project: Project = newProject("p", "t", SETTINGS);
  const subtitles = subtitlesTrack(project);
  expect(project.tracks.map((track) => track.id)).toEqual(["v1", "v2", "v3", subtitles, "a4", "a5"]);
  expect(subtitlesTrack(project)).toBe(subtitles);
  // New video tracks go under the subtitles.
  const v7 = addTrack(project, "video");
  expect(project.tracks.findIndex((track) => track.id === v7)).toBe(3);
  expect(trackLabel(project, "a5")).toBe("A2");
  expect(trackLabel(project, subtitles)).toBe("V5");
  expect(trackLabel(project, "zz")).toBeNull();
  project.clips = [solid("a", "v1", 0, 100)];
  expect(inOut(project)).toBeNull();
  project.mark_in = 10;
  expect(inOut(project)).toEqual([10, 100]);
  project.mark_out = 19;
  expect(inOut(project)).toEqual([10, 20]);
  expect(subtitledSpans(project, 0, 50)).toEqual([[0, 50]]);
  project.segments = [
    { start: 0, end: 20, kind: "other" },
    { start: 20, end: 80, kind: "footage" },
  ];
  expect(subtitledSpans(project, 10, 50)).toEqual([[20, 50]]);
  const dip: Clip = { ...solid("dip", "v2", 40, 20), type: "adjustment", grade: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 } } as Clip;
  expect(marksCut(dip, 60)).toBe(true);
  expect(marksCut(dip, 50)).toBe(true);
  expect(marksCut(dip, 45)).toBe(false);
  expect(marksCut({ ...solid("t", "v2", 40, 20), type: "text" } as unknown as Clip, 60)).toBe(false);
});
