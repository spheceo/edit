// The team's named effects on N3on's v1 (M, Oct 26): arrows to people, the web, the player pull-back, the counter, the clean text pop.

import { expect, test } from "bun:test";
import { counter, player, text } from "../src/commentary_graphics.ts";
import { forTests } from "../src/commentary_effects.ts";
import { clip, media, project } from "./helpers/model.ts";

test("an arrow ends on the person's point, its words beyond its tail on the side asked", () => {
  const p = project("arrow");
  const L = forTests.arrowLayout(p, { at: [-300, -40], side: "right", text: "Paramount CEO" });
  // The head, in the arrow picture's own pixels, lands on the point once the picture is centred at `centre`.
  expect(L.centre[0] - L.width / 2 + L.head[0]).toBeCloseTo(-300);
  expect(L.centre[1] - L.height / 2 + L.head[1]).toBeCloseTo(-40);
  expect(L.text[0]).toBeGreaterThan(-300);
  expect(() => forTests.arrowLayout(p, { text: "x" })).toThrow("needs at");
});

test("the web puts up to six around the middle and hangs the outer ring off the nearest of them", () => {
  const p = project("web");
  const L = forTests.webLayout(p, [{ media: "a" }, { media: "b" }, { media: "c" }, { media: "d", ring: 2 }]);
  expect(L.nodes.map((n) => n.ring)).toEqual([1, 1, 1, 2]);
  expect(L.nodes[0]!.y).toBeLessThan(0);
  expect(L.nodes[3]!.parent).toBeGreaterThanOrEqual(0);
});

test("the full-screen video pulls back into the YouTube page as one camera, still playing", () => {
  const p = project("player");
  p.media.push(media({ id: "v", name: "V", kind: "video", path: "/v.mp4", duration: 60, width: 1920, height: 1080, has_audio: false }));
  p.clips.push(clip({ id: "full", type: "video", media: "v", track: "v1", start: 0, duration: 200 }));
  const made = player(p, { clip: "full", at: 30, title: "N3ON X YE - DONDA 2 RELEASE", channel: "N3ON", subscribers: "1.2M" });
  const v = p.clips.find((c) => c.id === "full")!;
  const scale = v.keyframes!.scale!;
  // Full frame until the pull-back, then down to the player's size.
  expect(scale[0]!.value).toBeCloseTo(1);
  expect(scale.at(-1)!.value).toBeLessThan(0.7);
  expect((made.clips as string[]).length).toBeGreaterThan(3);
  expect(() => player(p, { clip: "full", at: 195, title: "t", channel: "c" })).toThrow("inside the clip");
});

test("a counter climbs fast and lands on its number", () => {
  const p = project("count");
  const made = counter(p, { start: 0, end: 90, from: 57, to: 35632, frames: 40 }).clips as string[];
  const texts = made.map((id) => p.clips.find((c) => c.id === id)!).map((c) => (c.type === "text" ? c.text : ""));
  expect(texts[0]).toBe("57");
  expect(texts.at(-1)).toBe("35,632");
});

test("a phrase pops up whole, after the blur behind it, its red piece scaling about the phrase's middle", () => {
  const p = project("pop");
  const made = text(p, { text: "MOST HATED", red: ["HATED"], blur: true, start: 0, end: 90 }).clips as string[];
  const words = made.map((id) => p.clips.find((c) => c.id === id)!).filter((c) => c.type === "text");
  expect(words.every((c) => c.start === 5)).toBe(true);
  const [most, hated] = words;
  // Both start pulled in toward the middle and spread to their places together.
  expect(most!.keyframes!.x![0]!.value).toBeGreaterThan(most!.type === "text" ? most!.transform.x : 0);
  expect(hated!.keyframes!.x![0]!.value).toBeLessThan(hated!.type === "text" ? hated!.transform.x : 0);
});
