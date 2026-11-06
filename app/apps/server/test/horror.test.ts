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
  p.clips.push(clip({ id: "under", type: "video", media: "wide", track: "v1", start: 0, duration: 400 }));
  const shown = card(p, { media: "shot", start: 30, end: 150, full: false }, { shot: "aged" });
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

test("a page fills the frame close, framed on the words read, its torn edges off screen; a strip stays a card", () => {
  const p = horror();
  const page = card(p, { media: "shot", start: 0, end: 120, focus: [585, 450] }, { shot: "aged" });
  expect(page.full).toBe(true);
  const clip = p.clips.find((c) => c.id === page.photo) as { media: string; transform: { scale: number; x: number; y: number } };
  expect(clip.media).toBe("aged");
  // 1170 px wide: shown at 1.3 frame widths, its middle on the focus.
  const fit = Math.min(1920 / 1170, 1080 / 900);
  expect(1170 * fit * clip.transform.scale).toBeCloseTo(1920 * 1.3, 0);
  expect(Math.abs(clip.transform.x)).toBeLessThan(1);
  p.media.push(media({ id: "strip", name: "headline.png", kind: "image", path: "/h.png", duration: 0, width: 900, height: 80 }));
  expect(card(p, { media: "strip", start: 130, end: 250 }).full).toBeUndefined();
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
  for (const word of ["die", "died", "death", "dead", "killed", "murder", "shooting", "torture", "tortured", "gun", "molest", "robbed"]) expect(HORROR_TERMS as readonly string[]).toContain(word);
});

test("a horror script pasted as plain text: its posts are footage where they're linked, never voiced; its recording is noted; a range with no link is said, not bound", async () => {
  const { pastedScript } = await import("../src/compilation_input.ts");
  const { RECORDING_NOTE } = await import("../src/script.ts");
  const pasted = [
    "Intro:",
    "(0:00-0:01) + (0:58-1:03)",
    "If you're not living under a rock, you should know by now that Instagram Reels are weird and getting weirder every day. Take a look at this:",
    "https://www.instagram.com/p/DU6q9WeEjRX/",
    "But it gets even worse, let me explain to you really quick what your eyes are looking at right now.",
    "https://x.com/ephraimwindex/status/2020035205374017941?s=20",
    "Voice-over: https://drive.google.com/file/d/13i0819vUB7tQ8VHdd388rz_bHKQ8nuCi/view?usp=sharing",
  ].join("\n");
  const parsed = pastedScript(pasted)!;
  expect(parsed.blocks.map((b) => b.kind)).toEqual(["narration", "footage", "narration", "footage"]);
  const [first, reel, , post] = parsed.blocks as Record<string, unknown>[];
  expect(first!.text).not.toContain("https://");
  expect(first!.notes).toEqual([`${RECORDING_NOTE}https://drive.google.com/file/d/13i0819vUB7tQ8VHdd388rz_bHKQ8nuCi/view?usp=sharing`, "No link given for (0:00-0:01) + (0:58-1:03): choose those moments from the story's own footage"]);
  const posts = await import("../src/posts.ts");
  expect(reel).toMatchObject({ start: 0, label: "Source (the whole video)" });
  expect(posts.urlOf(reel!.file as string)).toBe("https://www.instagram.com/p/DU6q9WeEjRX/");
  // A path-safe word, as edit-core holds script files; tracking dropped.
  expect(post!.file).toMatch(/^post:[A-Za-z0-9_-]+$/u);
  expect(posts.urlOf(post!.file as string)).toBe("https://x.com/ephraimwindex/status/2020035205374017941");
});

test("a post link never claims another script's unlinked ranges", async () => {
  const { parse } = await import("../src/script.ts");
  const html = `<html><body><p>(0:10-0:20)</p><p>The officer walks up to the car and asks for the driver's licence and registration right away.</p><p><a href="https://drive.google.com/file/d/abcdefghijklmnopqrstuvwxyz1/view">bodycam</a> (0:30-0:40)</p><p>And then everything changes in a matter of seconds, as you're about to see here.</p><p><a href="https://www.instagram.com/p/DU6q9WeEjRX/">https://www.instagram.com/p/DU6q9WeEjRX/</a></p></body></html>`;
  const parsed = parse(html);
  const footage = parsed.blocks.filter((b) => b.kind === "footage");
  expect(footage[0]).toMatchObject({ file: "abcdefghijklmnopqrstuvwxyz1", start: 10 });
  expect(footage.at(-1)!.url).toBe("https://www.instagram.com/p/DU6q9WeEjRX/");
});

test("a post that can't be had says why plainly and isn't tried again by itself", async () => {
  const { passing } = await import("../src/script.ts");
  expect(passing("That post is pictures only, with no video to play. Go on without it (the edit can show it as a screenshot), or give another link.")).toBe(false);
  expect(passing("That post is only shown to someone signed in to instagram. Go on without it, or give another link to the same video.")).toBe(false);
  expect(passing("instagram DU6q9WeEjRX: Read timed out")).toBe(true);
});

test("horror's titles take the guide's looks: a chapter over a blur, a date at the bottom, a name tag typed in VHS capitals, words on the voice", async () => {
  const { chapter, label, title } = await import("../src/horror_graphics.ts");
  const p = horror();
  const made = chapter(p, { start: 0, end: 120, text: "Bye /R9K/", sub: "case 2:" });
  const names = (made.clips as string[]).map((id) => p.clips.find((c) => c.id === id)!.name);
  expect(names).toEqual(["Horror · title backdrop", "Horror · bold title", "Horror · title motion blur", "Horror · bold title line"]);
  // As written, not forced to capitals (Styks' "Bye /R9K/").
  expect((p.clips.find((c) => c.id === made.text) as { text: string }).text).toBe("Bye /R9K/");
  const date = title(p, { start: 130, end: 250, text: "March 14th, 2018", look: "sans", at: "bottom" });
  const dated = p.clips.find((c) => c.id === date.text) as { style: { font: string }; transform: { y: number } };
  expect(dated.style.font).toBe("Arimo");
  expect(dated.transform.y).toBeGreaterThan(300);
  const tag = label(p, { start: 260, end: 380, text: "Clifford\nWallach" });
  const tagged = p.clips.find((c) => c.id === tag.text) as { text: string; style: { font: string; background: unknown }; animation: { preset: string }; transform: { x: number } };
  expect(tagged.text).toBe("CLIFFORD\nWALLACH");
  expect(tagged.style.font).toBe("VT323");
  expect(tagged.style.background).toBeDefined();
  expect(tagged.animation.preset).toBe("typewriter");
  expect(tagged.transform.x).toBeLessThan(-500);
  // A short phrase at a time, each alone (Sirius' "go to the back of car", "open the door").
  const spoken = title(p, { start: 400, end: 560, text: "he would go to the back of the car, open the door", look: "caption", motion: "words", words_at: [400, 405, 410, 415, 420, 425, 430, 435, 440, 470, 475, 480] });
  const parts = p.clips.filter((c) => (spoken.clips as string[]).includes(c.id)) as { text: string; start: number; duration: number }[];
  expect(parts.map((c) => c.text)).toEqual(["he would go to", "the back of the", "car,", "open the door"]);
  expect(parts.every((c, i) => i === 0 || c.start === parts[i - 1]!.start + parts[i - 1]!.duration)).toBe(true);
  expect(() => title(p, { start: 400, end: 500, text: "two words", motion: "words", words_at: [400] })).toThrow("words_at");
});

test("Animation 11's icons are drawn by Edit; the CC Lens swells in and out; a censor region is a mosaic", async () => {
  const { iconPng, lens } = await import("../src/horror_graphics.ts");
  const { mosaicCensors } = await import("../src/horror_look.ts");
  for (const icon of ["person", "phone", "folder", "document", "camera"] as const) expect(iconPng(icon, [0.86, 0, 0], 64).length).toBeGreaterThan(100);
  const p = horror();
  const made = lens(p, { start: 0, end: 90, strength: 0.7 });
  const keys = (p.clips.find((c) => c.id === made.clip)!.keyframes as Record<string, { value: number }[]>).lens!;
  expect(keys[0]!.value).toBe(0);
  expect(Math.max(...keys.map((k) => k.value))).toBe(0.7);
  expect(keys.at(-1)!.value).toBe(0);
  p.clips.push(clip({ id: "face", type: "adjustment", track: "v1", start: 0, duration: 60, blur: { radius: 30, x: 0, y: 0, width: 240, height: 300 } } as never));
  p.clips.push(clip({ id: "whole", type: "adjustment", track: "v1", start: 0, duration: 60, blur: { radius: 20 } } as never));
  mosaicCensors(p);
  expect((p.clips.find((c) => c.id === "face") as { blur: { mosaic: number } }).blur.mosaic).toBe(30);
  expect((p.clips.find((c) => c.id === "whole") as { blur: { mosaic?: number } }).blur.mosaic).toBeUndefined();
});

test("horror's marker is red with torn edges and a glow, inside the screenshot", async () => {
  const { roughMarkerPng } = await import("../src/evidence_highlight.ts");
  const png = roughMarkerPng(400, 200, { x: 50, y: 80, width: 200, height: 30 });
  expect(Buffer.from(png.slice(1, 4)).toString()).toBe("PNG");
  expect(() => roughMarkerPng(400, 200, { x: 300, y: 80, width: 200, height: 30 })).toThrow("fit inside");
});

test("horror's audit: the same clip never twice, a page not a strip, competitors' uploads left out", async () => {
  const { competitor } = await import("../src/commentary_sources.ts");
  const p = horror();
  p.clips.push(clip({ id: "a", type: "video", media: "wide", track: "v1", start: 0, duration: 90, source_in: 4 }));
  p.clips.push(clip({ id: "b", type: "video", media: "wide", track: "v1", start: 3000, duration: 60, source_in: 5 }));
  p.media.push(media({ id: "strip", name: "headline.png", kind: "image", path: "/h.png", duration: 0, width: 900, height: 80 }));
  p.clips.push(clip({ id: "s", type: "video", media: "strip", track: "v2", start: 100, duration: 90, name: "Horror · screenshot" }));
  p.tracks.push({ id: "v2", kind: "video", hidden: false, muted: false, locked: false });
  const kinds = issues(p).map((i) => i.kind);
  expect(kinds).toContain("horror_repeated_clip");
  expect(kinds).toContain("horror_screenshot_strip");
  expect(competitor("Nightmare Movies")).toBe(true);
  expect(competitor("Disturbing Files")).toBe(true);
  expect(competitor("KTLA 5", "Man rescued from flood")).toBe(false);
  expect(competitor("booge731", "My Stalker")).toBe(false);
  expect(competitor("Some Guy", "The Instagram Iceberg Explained")).toBe(true);
});

test("in horror a picture shot is Animation 5 over its own blurred copy, replaced when covered again", async () => {
  const { cover } = await import("../src/cutin.ts");
  const p = horror();
  p.media.push(media({ id: "vo", name: "vo.wav", kind: "audio", path: "/vo.wav", duration: 20, width: 0, height: 0 }));
  p.clips.push(clip({ id: "card", track: "v1", start: 300, duration: 300, type: "solid", fill: [0, 0, 0, 1], link: "l9" } as never));
  p.clips.push(clip({ id: "voice", track: "a1", start: 300, duration: 300, type: "audio", media: "vo", name: "Voice-over" }));
  p.script = { source: "", blocks: [{ kind: "narration", text: "The photo.", clip: "card", voiceover: "voice" }] } as never;
  const run = () => cover(p, { cut_in: 1, shots: [{ media: "shot", source_in: 0, name: "the photo" }] } as never, null);
  run();
  run();
  expect(p.clips.filter((c) => (c.name ?? "").endsWith("Horror · card ground"))).toHaveLength(1);
  const pictures = p.clips.filter((c) => /Horror · picture$/u.test(c.name ?? ""));
  expect(pictures).toHaveLength(1);
  expect((pictures[0] as { frame: { width: number } }).frame.width).toBeGreaterThan(0);
  expect(p.clips.some((c) => /Desktop/u.test(c.name ?? ""))).toBe(false);
});

test("horror's audit asks for the highlighter on a screenshot and for the story's own footage over stock", () => {
  const p = horror();
  p.clips.push(clip({ id: "s", type: "video", media: "shot", track: "v1", start: 0, duration: 120, name: "Horror · screenshot" }));
  p.media.push(media({ id: "stock", name: "Close-up of hands using smartphone - Stock Footage [abc].mp4", kind: "video", path: "/s.mp4", duration: 60, width: 1920, height: 1080 }));
  p.clips.push(clip({ id: "b1", type: "video", media: "stock", track: "v1", start: 200, duration: 200, name: "Cut-in 1 · B-roll: a phone" }));
  p.clips.push(clip({ id: "b2", type: "video", media: "wide", track: "v1", start: 400, duration: 100, name: "Cut-in 1 · B-roll: the news" }));
  const kinds = issues(p).map((i) => i.kind);
  expect(kinds).toContain("horror_unhighlighted_screenshot");
  expect(kinds).toContain("horror_stock_heavy");
  p.clips.push(clip({ id: "m", type: "video", media: "shot", track: "v2", start: 10, duration: 100, name: "Horror · marker" }));
  expect(issues(p).map((i) => i.kind)).not.toContain("horror_unhighlighted_screenshot");
});

test("a B-roll import in flight is background work wait knows about", async () => {
  const progress = await import("../src/progress.ts");
  progress.begin("import", "p-wait", "1", 6);
  expect(progress.summary("p-wait", ["import"])).toContain("a B-roll import downloading");
  progress.end("import", "p-wait", "1");
  expect(progress.summary("p-wait", ["import"])).toBeNull();
});

test("a YouTube range whose download came back a little short, or whose video ends first, imports what's there", async () => {
  const { excerptFor } = await import("../src/commentary_sources.ts");
  expect(excerptFor([{ from: 0, to: 22.93 }], { start: 0 })).toBe(0);
  expect(excerptFor([{ from: 0, to: 30 }, { from: 0, to: 95.4 }], { start: 0 })).toBe(1);
  expect(excerptFor([{ from: 10, to: 40 }], { start: 0 })).toBe(-1);
  expect(excerptFor([{ from: 0, to: 0.3 }], { start: 0 })).toBe(-1);
});

test("a horror card with nothing playing under it stands over a blurred copy of its picture, never black", () => {
  const p = horror();
  const shown = card(p, { media: "shot", start: 0, end: 120, photo: true });
  const names = (shown.clips as string[]).map((id) => p.clips.find((c) => c.id === id)!.name);
  expect(names.slice(0, 2)).toEqual(["Horror · card ground", "Horror · card ground blur"]);
});

test("an older smoothed render is traced to the source frame it began at; nothing close, nothing found", async () => {
  const { nearestFrame } = await import("../src/broll.ts");
  const frame = (v: number) => new Uint8Array(576).fill(v);
  const frames = [frame(10), frame(60), frame(120), frame(180)];
  expect(nearestFrame(frame(118), frames)).toBe(2);
  expect(nearestFrame(frame(250), frames)).toBeNull();
});

test("the team's notes on v2: titles white, words above pictures, a tall video whole, Edit's own ink never a watermark", async () => {
  const { title } = await import("../src/horror_graphics.ts");
  const { textOnTop } = await import("../src/horror_look.ts");
  const { looksForMarks } = await import("../src/watermarks.ts");
  const p = horror();
  const made = title(p, { start: 0, end: 90, text: "very weird territory", color: "red" });
  expect((p.clips.find((c) => c.id === made.text) as { style: { color: number[] } }).style.color).toEqual([1, 1, 1, 1]);
  // A quote placed first, a photo after on a higher track: the quote is lifted over it.
  p.clips.push(clip({ id: "photo", type: "video", media: "shot", track: "top", start: 0, duration: 90, name: "Horror · picture" }));
  p.tracks.push({ id: "top", kind: "video", hidden: false, muted: false, locked: false });
  textOnTop(p);
  const order = p.tracks.map((t) => t.id);
  expect(order.indexOf(p.clips.find((c) => c.id === made.text)!.track)).toBeGreaterThan(order.indexOf("top"));
  // A 9:16 reel zoomed to fill the frame is shown whole over its blurred copy.
  p.clips.push(clip({ id: "zoomed", type: "video", media: "reel", track: "v1", start: 200, duration: 60, transform: { scale: 3.16, x: 0, y: 0, rotation: 0 } } as never));
  fillReels(p);
  expect((p.clips.find((c) => c.id === "zoomed") as { transform: { scale: number } }).transform.scale).toBe(1);
  expect(p.clips.some((c) => c.name === "Horror · reel backdrop" && c.start === 200)).toBe(true);
  expect(looksForMarks(media({ id: "i", name: "ink-1793864105363-0.png", kind: "image", path: "/i.png", duration: 0, width: 100, height: 100 }))).toBe(false);
});

test("the audit catches a graphic arriving over a post's own sound, words across a cut, and words left up too long", () => {
  const p = horror();
  p.tracks.push({ id: "a1", kind: "audio", hidden: false, muted: false, locked: false }, { id: "t", kind: "video", hidden: false, muted: false, locked: false });
  p.clips.push(clip({ id: "post", type: "video", media: "wide", track: "v1", start: 0, duration: 100 }));
  p.clips.push(clip({ id: "postsound", type: "audio", media: "wide", track: "a1", start: 0, duration: 100, volume_db: 0 } as never));
  p.clips.push(clip({ id: "next", type: "video", media: "reel", track: "v1", start: 100, duration: 200 }));
  p.clips.push(clip({ id: "vo", type: "audio", media: "wide", track: "a1", start: 100, duration: 200, name: "Voice-over" } as never));
  p.clips.push(clip({ id: "early", type: "text", track: "t", start: 80, duration: 60, name: "Horror · bold title", text: "too soon" } as never));
  p.clips.push(clip({ id: "long", type: "text", track: "t", start: 150, duration: 300, name: "Horror · bold title", text: "on and on" } as never));
  const found = issues(p).map((i) => `${i.kind}:${String(i.clip)}`);
  expect(found).toContain("horror_graphic_over_source:early");
  expect(found).toContain("horror_text_across_cut:early");
  expect(found).toContain("horror_text_long:long");
});

test("the audit catches two cards up at once: a profile laid over the old card it replaced (Nov 6, \"the text is behind the image\")", () => {
  const p = horror();
  p.tracks.push({ id: "t2", kind: "video", hidden: false, muted: false, locked: false });
  p.clips.push(clip({ id: "old", type: "video", media: "shot", track: "v1", start: 0, duration: 178, name: "Horror · picture" }));
  p.clips.push(clip({ id: "profile", type: "video", media: "shot", track: "t2", start: 0, duration: 144, name: "Horror · picture" }));
  // One after the other, crossing for a few frames, is a cut, not a stack.
  p.clips.push(clip({ id: "after", type: "video", media: "shot", track: "t2", start: 172, duration: 90, name: "Horror · screenshot" }));
  const found = issues(p).filter((i) => i.kind === "horror_cards_stacked").map((i) => `${String(i.clip)}<${String(i.under)}`);
  expect(found).toEqual(["profile<old"]);
});
