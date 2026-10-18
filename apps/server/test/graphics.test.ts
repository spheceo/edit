import { beforeAll, expect, test } from "bun:test";

import * as cutin from "../src/cutin.ts";
import { bareStills, dateDrift, dateTitle, evidenceCard, placeLabel } from "../src/graphics.ts";
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

test("the_place_label_is_the_house_label_pinned_above_the_building", () => {
  const p = project();
  p.media.push(media({ id: "map", name: "map.mp4", path: "/x/map.mp4", kind: "video", duration: 9, width: 1920, height: 1080 }));
  p.clips.push(clip({ id: "m", track: "v2", start: 2034, duration: 267, type: "video", media: "map" }));
  // The label comes in with the reveal, 81 frames into the map.
  const track = Array.from({ length: 18 }, (_, i) => ({ frame: i * 15, x: 90 + i, top: -60 - i }));
  const id = placeLabel(p, { text: "1091 Capitol Avenue", start: 2115, end: 2301, map: "m", building_track: track });
  const label = clipById(p, id) as TextClip;
  const background = label.style.background!;
  expect([background.opacity, background.pad_x, background.border]).toEqual([1, 20, 2]);
  expect(label.style.glow.enabled).toBe(false);
  expect(label.style.shadow?.opacity).toBe(0.85);
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

test("a_found_photo_is_a_card_never_a_bare_still", () => {
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
  // As a card instead.
  p.clips = [];
  const made = evidenceCard(p, { media: "m1", start: 0, end: 120, label: "The building on Capitol Avenue" });
  expect((made.clips as string[]).length).toBe(4);
  expect(bareStills(p)).toEqual([]);
  // The photo fits inside the frame with its label under it, and the backdrop fills it.
  const photo = p.clips.find((own) => own.name === "Evidence card · photo") as VideoClip;
  expect(photo.frame).toBeDefined();
  const fit = Math.min(Math.fround(1920 / 895), Math.fround(1080 / 671));
  expect(671 * fit * photo.transform.scale * 1.04).toBeLessThan(1080 * 0.75);
  valid(p);
  // Footage is never an evidence card.
  expect(() => evidenceCard(p, { media: "m2", start: 0, end: 30 })).toThrow();
});

test("a_picture_picked_as_a_cut_in_shot_goes_on_as_a_card", () => {
  const p = project();
  p.media.push(
    media({ id: "m2", name: "bodycam.mp4", path: "/x/b.mp4", kind: "video", duration: 600, width: 1920, height: 1080, has_audio: true }),
  );
  p.clips.push(clip({ id: "card", track: "v1", start: 300, duration: 300, type: "solid", fill: [0, 0, 0, 1] }));
  p.script = { blocks: [{ kind: "narration", text: "The building.", clip: "card" }] };
  const [report] = cutin.cover(p, {
    cut_in: 1,
    shots: [
      { media: "m2", source_in: 10 },
      { media: "m1", source_in: 0, at: 15, label: "The building" },
    ],
  });
  const shots = report.shots as Record<string, unknown>[];
  expect((shots[1]!.evidence_card as string[]).length).toBe(4);
  expect(bareStills(p)).toEqual([]);
  // The B-roll look greys the footage and the card's backdrop, under the photo.
  const trackOf = (suffix: string) => level(p, p.clips.find((own) => own.name?.endsWith(suffix) === true)!.track);
  expect(trackOf("backdrop")).toBeLessThan(trackOf("B-roll look"));
  expect(trackOf("B-roll look")).toBeLessThan(trackOf("photo"));
  expect(trackOf("photo")).toBeLessThan(trackOf("label"));
  valid(p);
});
