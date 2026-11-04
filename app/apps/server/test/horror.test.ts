import { expect, test } from "bun:test";
import { issues } from "../src/commentary_audit.ts";
import { card, narrationLook } from "../src/commentary_graphics.ts";
import { isPost, rangeOf } from "../src/commentary_sources.ts";
import { fillReels, GRADE, LOOK_NAME, retroFilter } from "../src/horror_look.ts";
import { isEssay } from "../src/model.ts";
import { headerStyle } from "../src/script.ts";
import { HORROR_TERMS } from "../src/subtitles.ts";
import { clip, media, project } from "./helpers/model.ts";

function horror() {
  const p = project("horror");
  p.style = "horror";
  p.media.push(
    media({ id: "reel", name: "reel.mp4", kind: "video", path: "/reel.mp4", duration: 30, width: 720, height: 1280, has_audio: true }),
    media({ id: "wide", name: "news.mp4", kind: "video", path: "/news.mp4", duration: 30, width: 1920, height: 1080 }),
    media({ id: "shot", name: "bio.png", kind: "image", path: "/bio.png", duration: 0, width: 1170, height: 900 }),
    media({ id: "aged", name: "retro-shot-1170x900.png", kind: "image", path: "/aged.png", duration: 0, width: 1170, height: 900 }),
  );
  return p;
}

test("horror is a narrated essay of its own, named by a script's heading", () => {
  expect(isEssay("horror")).toBe(true);
  expect(isEssay("commentary")).toBe(true);
  expect(isEssay("bodycam")).toBe(false);
  expect(headerStyle("HORROR Instagram Reels With Disturbing Backstories")).toBe("horror");
});

test("the analog look covers every frame, clips included, and taking it again replaces it on top", () => {
  const p = horror();
  p.clips.push(clip({ id: "a", type: "video", media: "wide", track: "v1", start: 0, duration: 300 }));
  const first = narrationLook(p, { start: 0, end: 300 });
  const look = p.clips.find((c) => c.id === first.clip)!;
  expect(look).toMatchObject({ type: "adjustment", name: LOOK_NAME, start: 0, duration: 300 });
  expect((look as { grade: Record<string, number> }).grade).toMatchObject(GRADE);
  expect(issues(p).map((i) => i.kind)).not.toContain("horror_look_missing");
  // Footage added later on a higher track sits above the look: bare until the look is taken again.
  p.clips.push(clip({ id: "b", type: "video", media: "wide", track: "new-top", start: 100, duration: 150 }));
  p.tracks.push({ id: "new-top", kind: "video", hidden: false, muted: false, locked: false });
  expect(issues(p).map((i) => i.kind)).toContain("horror_look_missing");
  const again = narrationLook(p, { start: 0, end: 300 });
  expect(again.replaced).toEqual([look.id]);
  expect(p.clips.filter((c) => c.name === LOOK_NAME)).toHaveLength(1);
  expect(issues(p).map((i) => i.kind)).not.toContain("horror_look_missing");
});

test("a horror card shows a screenshot's retro copy over darkened footage, a photo in a white outline, both blurring in", () => {
  const p = horror();
  const shown = card(p, { media: "shot", start: 30, end: 150 }, { shot: "aged" });
  const photo = p.clips.find((c) => c.id === shown.photo) as { media: string; name: string; frame: { width: number } };
  expect(photo.media).toBe("aged");
  expect(photo.name).toBe("Horror · screenshot");
  expect(photo.frame.width).toBe(0);
  const names = (shown.clips as string[]).map((id) => p.clips.find((c) => c.id === id)!.name);
  expect(names).toEqual(["Horror · card backdrop", "Horror · screenshot", "Horror · card motion blur"]);
  const blur = p.clips.find((c) => c.name === "Horror · card motion blur")!;
  expect(blur.parent).toBe(shown.photo as string);
  expect(blur.keyframes?.blur?.[0]?.value).toBeGreaterThan(0);
  expect(blur.keyframes?.blur?.at(-1)?.value).toBe(0);
  const portrait = card(p, { media: "shot", start: 200, end: 300, photo: true }, { shot: "aged" });
  const framed = p.clips.find((c) => c.id === portrait.photo) as { media: string; frame: { width: number; glow: number } };
  expect(framed.media).toBe("shot");
  expect(framed.frame.width).toBeGreaterThan(0);
  expect(framed.frame.glow).toBeGreaterThan(0);
});

test("the retro filter keeps the screenshot's size and roughens its edges in alpha", () => {
  const filter = retroFilter(1170, 900);
  expect(filter).toContain("scale=1170:900");
  expect(filter).toContain("drawgrid");
  expect(filter).toContain("rgbashift");
  expect(filter).toMatch(/geq=.*a='if\(lt\(/u);
});

test("a tall reel full frame stands over its own blurred copy, rebuilt as it changes; a wide shot and a card don't", () => {
  const p = horror();
  p.clips.push(
    clip({ id: "r", type: "video", media: "reel", track: "v2", start: 0, duration: 120, source_in: 3 }),
    clip({ id: "w", type: "video", media: "wide", track: "v2", start: 120, duration: 60 }),
  );
  fillReels(p);
  const copies = p.clips.filter((c) => c.name === "Horror · reel backdrop");
  const blurs = p.clips.filter((c) => c.name === "Horror · reel blur");
  expect(copies).toHaveLength(1);
  expect(blurs).toHaveLength(1);
  expect(copies[0]).toMatchObject({ media: "reel", start: 0, duration: 120, source_in: 3 });
  expect((copies[0] as { transform: { scale: number } }).transform.scale).toBeGreaterThan(2);
  const order = p.tracks.map((t) => t.id);
  // The copy, then its blur, then the reel: bottom to top.
  expect(order.indexOf(copies[0]!.track)).toBeLessThan(order.indexOf(blurs[0]!.track));
  expect(order.indexOf(blurs[0]!.track)).toBeLessThan(order.indexOf("v2"));
  const tracks = p.tracks.length;
  p.clips.find((c) => c.id === "r")!.duration = 90;
  fillReels(p);
  expect(p.clips.filter((c) => c.name === "Horror · reel backdrop").map((c) => c.duration)).toEqual([90]);
  expect(p.tracks.length).toBe(tracks);
  // Not in other styles.
  const other = horror(); other.style = "commentary";
  other.clips.push(clip({ id: "r", type: "video", media: "reel", track: "v2", start: 0, duration: 120 }));
  fillReels(other);
  expect(other.clips).toHaveLength(1);
});

test("a post's link imports whole or by range; YouTube still needs its range", () => {
  expect(isPost("https://www.instagram.com/p/DU6q9WeEjRX/")).toBe(true);
  expect(isPost("https://youtu.be/LtmN4iw362k")).toBe(false);
  expect(isPost("http://example.com/a")).toBe(false);
  expect(rangeOf({ url: "https://www.instagram.com/p/DU6q9WeEjRX/", purpose: "the stung lips" })).toMatchObject({ start: 0, end: Infinity });
  expect(rangeOf({ url: "https://x.com/a/status/1", start: 2, end: 9, purpose: "the jump" })).toMatchObject({ start: 2, end: 9 });
  expect(() => rangeOf({ url: "https://www.instagram.com/p/x/" })).toThrow("purpose");
  expect(() => rangeOf({ url: "https://youtu.be/LtmN4iw362k", purpose: "x" })).toThrow();
});

test("horror's ban list is the guide's, with its other forms", () => {
  for (const word of ["die", "died", "death", "dead", "killed", "murder", "shooting", "torture", "tortured", "gun", "molest", "robbed"]) expect(HORROR_TERMS).toContain(word);
});
