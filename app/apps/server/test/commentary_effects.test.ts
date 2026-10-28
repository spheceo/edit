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

test("the web takes the reference's places: around the middle first, an outer one beside the inner one before it, strings out of the middle and on out", () => {
  const p = project("web");
  const L = forTests.webLayout(p, [{ media: "a" }, { media: "b" }, { media: "c" }, { media: "d" }, { media: "e", ring: 2 }]);
  expect(L.nodes.map((n) => n.slot)).toEqual(["ul", "ur", "ll", "lr", "br"]);
  // Fewer pictures fill the frame: the board grows.
  const full = forTests.webLayout(p, Array.from({ length: 12 }, (_, i) => ({ media: `m${i}` })));
  expect(L.fit).toBeGreaterThan(full.fit * 1.2);
  // Lopsided (one outer picture, lower right), it's framed on what's there: the middle sits up and to the left.
  expect(L.offset[0]).toBeLessThan(0);
  expect(L.offset[1]).toBeLessThan(0);
  // Four strings out of the middle, one from the lower right out to its outer picture.
  expect(L.edges.filter((e) => e.from === -1).length).toBe(4);
  expect(L.edges.some((e) => e.from === 3 && e.to === 4)).toBe(true);
  // A string out of the middle leaves its side's middle and lands on the picture's nearest corner.
  const toUpperLeft = L.edges.find((e) => e.from === -1 && e.to === 0)!;
  expect(toUpperLeft.a[1]).toBeCloseTo(0);
  expect(toUpperLeft.b[0]).toBeCloseTo(L.nodes[0]!.x + L.nodes[0]!.w / 2);
  expect(toUpperLeft.b[1]).toBeCloseTo(L.nodes[0]!.y + L.nodes[0]!.h / 2);
});

test("the full-screen video pulls back into the YouTube page as one camera, still playing", () => {
  const p = project("player");
  p.media.push(media({ id: "v", name: "V", kind: "video", path: "/v.mp4", duration: 60, width: 1920, height: 1080, has_audio: false }));
  p.clips.push(clip({ id: "full", type: "video", media: "v", track: "v1", start: 0, duration: 200 }));
  const made = player(p, { clip: "full", at: 30, title: "N3ON X YE - DONDA 2 RELEASE", channel: "N3ON", subscribers: "1.2M" });
  const v = p.clips.find((c) => c.id === "full")!;
  const scale = v.keyframes!.scale!;
  // Full frame until the pull-back, down to the player's size, and smoothly back to full frame by its end.
  expect(scale[0]!.value).toBeCloseTo(1);
  expect(Math.min(...scale.map((k) => k.value))).toBeLessThan(0.7);
  expect(scale.at(-1)!.value).toBeCloseTo(1);
  expect(scale.at(-1)!.frame).toBe(199);
  // back: false holds the page to the cut.
  const held = project("held");
  held.media.push(media({ id: "v", name: "V", kind: "video", path: "/v.mp4", duration: 60, width: 1920, height: 1080, has_audio: false }));
  held.clips.push(clip({ id: "full", type: "video", media: "v", track: "v1", start: 0, duration: 200 }));
  player(held, { clip: "full", at: 30, title: "t", channel: "c", back: false });
  expect(held.clips.find((c) => c.id === "full")!.keyframes!.scale!.at(-1)!.value).toBeLessThan(0.7);
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
