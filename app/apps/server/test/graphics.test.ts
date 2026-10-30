import { beforeAll, expect, test } from "bun:test";

import * as cutin from "../src/cutin.ts";
import { frameKey } from "../src/desktop_screen.ts";
import { needs } from "../src/edit_plan.ts";
import { bareStills, dateDrift, dateTitle, placeLabel } from "../src/graphics.ts";
import type { Project, TextClip, VideoClip } from "../src/model.ts";
import { native } from "../src/native/index.ts";
import { clip, clipById, level, media, project as newProject, stubNative } from "./helpers/model.ts";

beforeAll(stubNative);

function project(): Project {
  const p = newProject();
  p.media.push(media({ id: "m1", name: "news.jpg", path: "/x/news.jpg", kind: "image", duration: 30, width: 895, height: 671 }));
  return p;
}

const valid = (p: Project) => expect(native().projectValidate(JSON.stringify(p))).toBeNull();

test("the_date_is_white_with_a_shadow_and_nothing_else", () => {
  const p = project();
  const made = dateTitle(p, { text: "July 22, 2023", start: 100, end: 181 });
  const date = clipById(p, made.date as string) as TextClip;
  expect(date.style.background).toBeUndefined();
  expect(date.style.glow.enabled).toBe(false);
  const shadow = date.style.shadow!;
  expect([shadow.distance, shadow.size, shadow.blur, shadow.opacity]).toEqual([6, 10, 20, 1]);
  expect(date.style.color).toEqual([1, 1, 1, 1]);
  expect(date.style.size).toBe(120);
  expect(date.animation.preset).toBe("rise");
  // The darkening sits beneath it.
  const darken = clipById(p, made.darken as string);
  expect(level(p, darken.track)).toBeLessThan(level(p, date.track));
  expect(dateDrift(p)).toEqual([]);
  valid(p);
});

test("the_place_label_is_the_references_monospace_label_pinned_above_the_building", () => {
  const p = project();
  p.media.push(media({ id: "map", name: "map.mp4", path: "/x/map.mp4", kind: "video", duration: 9, width: 1920, height: 1080 }));
  p.clips.push(clip({ id: "m", track: "v2", start: 2034, duration: 267, type: "video", media: "map" }));
  // The label comes in with the reveal, 81 frames into the map.
  const track = Array.from({ length: 18 }, (_, i) => ({ frame: i * 15, x: 90 + i, top: -60 - i }));
  const id = placeLabel(p, { text: "1091 Capitol Avenue", start: 2115, end: 2301, map: "m", building_track: track });
  const label = clipById(p, id) as TextClip;
  const background = label.style.background!;
  // White Geist Mono in a black box, no border, typed on (the team's map references).
  expect(label.style.font).toBe("Geist Mono");
  expect([background.pad_x, background.border ?? 0]).toEqual([14, 0]);
  expect(label.animation.preset).toBe("typewriter");
  // On its first frame: between the points at 75 and 90 frames into the map.
  expect(Math.abs(label.transform.x - 95.4)).toBeLessThan(0.01);
  expect(label.transform.y).toBeLessThan(-60 - 5.4 - 30);
  const xs = label.keyframes!.x!;
  expect(xs[0]!.frame).toBe(0);
  expect(xs[1]!.frame).toBe(9);
  valid(p);
});

test("a_boxed_or_glowing_date_is_flagged", () => {
  const p = project();
  const made = dateTitle(p, { text: "July 22, 2023", start: 0, duration: 81 });
  const date = clipById(p, made.date as string) as TextClip;
  date.style.glow.enabled = true;
  date.style.background = { color: [0, 0, 0, 1], opacity: 0.65, pad_x: 12, pad_y: 8, border_color: [1, 1, 1, 1] };
  const flagged = dateDrift(p);
  expect(flagged.length).toBe(1);
  expect(flagged[0]!.boxed).toBe(true);
});

test("a_found_photo_shown_bare_is_flagged", () => {
  const p = project();
  // As the edit had it: the 4:3 news photo at scale 1, plain B-roll.
  p.clips.push(
    clip({
      id: "c9",
      track: "v1",
      start: 0,
      duration: 90,
      type: "video",
      media: "m1",
      keyframes: {
        scale: [
          { frame: 0, value: 1 },
          { frame: 89, value: 1.08 },
        ],
      },
    }),
  );
  const flagged = bareStills(p);
  expect(flagged.length).toBe(1);
  expect(flagged[0]!.letterboxed).toBe(true);
});

test("a_picture_picked_as_a_cut_in_shot_goes_on_a_desktop_the_footage_zooms_out_into", () => {
  const p = project();
  p.media.push(
    media({ id: "m2", name: "bodycam.mp4", path: "/x/b.mp4", kind: "video", duration: 600, width: 1920, height: 1080, has_audio: true }),
    media({ id: "wall", name: "wallpaper.png", path: "/x/w.png", kind: "image", duration: 30, width: 1344, height: 752 }),
  );
  p.clips.push(clip({ id: "card", track: "v1", start: 300, duration: 300, type: "solid", fill: [0, 0, 0, 1] }));
  p.script = { blocks: [{ kind: "narration", text: "The building.", clip: "card" }] };
  const shots = [
    { media: "m2", source_in: 10, push: [1, 1.06] },
    { media: "m2", source_in: 40, at: 13, push: [1, 1.06] },
    { media: "m1", source_in: 0, at: 15, label: "actual image" },
  ];
  // The frames the plan would have drawn: an opening Video Player and the Photo Viewer.
  const sizes = needs([{ op: "cover_cut_in", cut_in: 1, shots }], p).screens!;
  expect(sizes.map(([app]) => app).sort()).toEqual(["photo_viewer", "video_player"]);
  const frames: Record<string, string> = {};
  sizes.forEach(([app, w, h], index) => {
    p.media.push(media({ id: `f${index}`, name: `${app}.png`, path: `/x/${app}.png`, kind: "image", duration: 30, width: w, height: h }));
    frames[frameKey(app, w, h)] = `f${index}`;
  });
  const [report] = cutin.cover(p, { cut_in: 1, shots }, { wallpaper: "wall", frames });
  const placed = report.shots as Record<string, unknown>[];
  const desktop = placed[2]!.desktop as Record<string, unknown>;
  expect((desktop.windows as Record<string, unknown>[]).map((window) => window.app)).toEqual(["video_player", "photo_viewer"]);
  expect((desktop.camera as Record<string, unknown>).opens_from_footage).toBe(true);
  // The Video Player plays on from where the shot before it ended (40 s in, at 0.8, 2 s on: 41.6 s).
  const player = p.clips.find((own) => own.name === "Cut-in 1 · Desktop · Video Player · bodycam.mp4") as VideoClip;
  expect(Math.abs(player.source_in - 41.6)).toBeLessThan(1e-6);
  const photo = p.clips.find((own) => own.name === "Cut-in 1 · Desktop · Photo Viewer · news.jpg");
  // It opens once the slow zoom out of the footage is mostly done (55 frames in), never huge over the footage.
  expect(photo?.start).toBe(505);
  // "actual image" isn't for a picture in a window: the label is dropped.
  expect(p.clips.some((own) => own.type === "text" && /actual image/u.test(own.text))).toBe(false);
  expect(bareStills(p)).toEqual([]);
  // One zoom across the cut-in: the second shot starts where the first ended, never back at 1.
  const [one, two] = ["shot 1", "shot 2"].map((name) => p.clips.find((own) => own.name === `Cut-in 1 · B-roll: ${name}`) as VideoClip);
  const lastOfOne = one!.keyframes!.scale!.at(-1)!.value;
  const firstOfTwo = two!.keyframes!.scale![0]!.value;
  expect(firstOfTwo).toBeGreaterThan(1.015);
  expect(Math.abs(firstOfTwo - lastOfOne)).toBeLessThan(0.01);
  // The B-roll look stays off the desktop.
  const look = p.clips.find((own) => own.name === "Cut-in 1 · B-roll look")!;
  expect(look.start + look.duration).toBe(450);
  valid(p);
});
