import { expect, test } from "bun:test";
import { toParsed, scriptStyle } from "../src/writer_handoff.ts";
import { issues } from "../src/commentary_audit.ts";
import { bumper, card, label, leak, narrationLook, profile, punch, text, youtube } from "../src/commentary_graphics.ts";
import { markerPng, rectOf } from "../src/evidence_highlight.ts";
import { compactCount, rangeOf } from "../src/commentary_sources.ts";
import { quoteCue } from "../src/script.ts";
import { clip, media, project } from "./helpers/model.ts";

test("commentary handoff preserves interleaved narration, reversed cold-open clips and anchored notes without voicing them", () => {
  const given = { id: "w", title: "Essay", sourceKind: "commentary", kind: "interrogation", commentary: { draft: {
    open: [{ link: "https://youtu.be/bMGh_YifEJY", startMs: 62000, endMs: 65000 }, { link: "https://youtu.be/bMGh_YifEJY", startMs: 60000, endMs: 62000 }],
    sections: [{ heading: "1. Origins", paragraphs: [{ id: "p1", note: "Show an early upload", marks: [{ on: "early", line: "show the original" }], pieces: [
      { kind: "say" as const, text: "His early work." }, { kind: "clip" as const, link: "https://youtu.be/LtmN4iw362k", startMs: 0, endMs: 9000, quote: "Hello", verify: "Check the speaker" }, { kind: "say" as const, text: "Then he changed." },
    ] }] }],
  } } };
  const parsed = toParsed(given);
  expect(scriptStyle(given)).toBe("commentary");
  expect(parsed.blocks.map((b) => b.kind)).toEqual(["footage", "footage", "narration", "footage", "narration"]);
  expect(parsed.blocks[0]).toMatchObject({ start: 62, end: 65 });
  expect(parsed.blocks[1]).toMatchObject({ start: 60, end: 62 });
  expect(parsed.blocks[2]).toMatchObject({ text: "His early work.", notes: expect.arrayContaining(["Chapter: 1. Origins", "At “early”: show the original"]) });
  expect(parsed.blocks[3]?.notes).toContain("Verify: Check the speaker");
  expect(() => toParsed({ ...given, commentary: { draft: { sections: [], open: [{ link: "https://youtu.be/bMGh_YifEJY", startMs: 200, endMs: 100 }] } } })).toThrow("invalid commentary excerpt");
});

test("visual source ranges reject non-finite clocks, unsupported links and unbounded downloads before importing", () => {
  const good = { url: "https://youtu.be/LtmN4iw362k", start: 10, end: 22, purpose: "the early channel" };
  expect(rangeOf(good)).toEqual(good);
  for (const patch of [{ start: NaN }, { end: Infinity }, { end: 500 }, { url: "file:///tmp/a" }, { purpose: "" }]) expect(() => rangeOf({ ...good, ...patch })).toThrow();
});

test("commentary audit catches music over source audio and uncovered narration, then clears after real coverage and a split bed", () => {
  const p = project("essay"); p.style = "commentary";
  p.media.push(media({ id: "vo", name: "VO", kind: "audio", path: "/vo.wav", duration: 10, has_audio: true }), media({ id: "source", name: "Source", kind: "video", path: "/source.mp4", duration: 10, width: 1920, height: 1080, has_audio: true }), media({ id: "song", kind: "audio", path: "/music.wav", name: "Music", duration: 20, has_audio: true }));
  p.clips.push(clip({ id: "narration", type: "audio", media: "vo", track: "a1", start: 0, duration: 150 }), clip({ id: "quote", type: "audio", media: "source", track: "a1", start: 150, duration: 90 }), clip({ id: "bed", type: "audio", media: "song", name: "Music bed", track: "a1", start: 0, duration: 240 }));
  p.script = { source: "writer:w", blocks: [{ kind: "narration", text: "Words", voiceover: "narration" }] };
  expect(issues(p).map((i) => i.kind)).toEqual(expect.arrayContaining(["commentary_uncovered_narration", "commentary_music_over_source"]));
  p.clips.find((c) => c.id === "bed")!.duration = 150;
  p.clips.push(clip({ id: "picture", type: "video", media: "source", track: "v1", start: 0, duration: 150 }));
  expect(issues(p)).toEqual([]);
});

test("blurred text backdrops over most of the narration are flagged; a few key phrases are not", () => {
  const p = project("essay"); p.style = "commentary";
  p.media.push(media({ id: "vo", name: "VO", kind: "audio", path: "/vo.wav", duration: 40, has_audio: true }), media({ id: "source", name: "Source", kind: "video", path: "/source.mp4", duration: 40, width: 1920, height: 1080, has_audio: false }));
  p.clips.push(clip({ id: "narration", type: "audio", media: "vo", track: "a1", start: 0, duration: 1200 }), clip({ id: "picture", type: "video", media: "source", track: "v1", start: 0, duration: 1200 }));
  p.script = { source: "writer:w", blocks: [{ kind: "narration", text: "Words", voiceover: "narration" }] };
  for (let at = 0; at < 1200; at += 240) text(p, { text: "KEY PHRASE", start: at, end: at + 150, blur: true });
  expect(issues(p).find((i) => i.kind === "commentary_text_heavy")).toMatchObject({ share: 0.63, backdrops: 5 });
  p.clips = p.clips.filter((c) => c.name !== "Janitor · text backdrop" || c.start < 240);
  expect(issues(p).map((i) => i.kind)).not.toContain("commentary_text_heavy");
  text(p, { text: "NO BLUR UNLESS ASKED", start: 300, end: 400 });
  expect(p.clips.filter((c) => c.name === "Janitor · text backdrop")).toHaveLength(1);
});

test("commentary compositions keep the whole phrase stable, use strong Bezier arrival, and never create source sound", () => {
  const p = project("motion"); p.style = "commentary";
  p.media.push(media({ id: "photo", name: "Photo", kind: "image", path: "/photo.jpg", duration: 0, width: 1200, height: 800, has_audio: false }));
  const sweep = text(p, { text: "THE NETWORK", start: 0, end: 120, motion: "soft" });
  expect(p.clips.find((c) => c.id === sweep.text)).toMatchObject({ type: "text", text: "THE NETWORK", animation: { preset: "soft" } });
  const c = card(p, { media: "photo", start: 120, end: 270 });
  const picture = p.clips.find((clip) => clip.id === c.photo)!;
  expect(picture.keyframes?.y?.[0]?.handle_out).toBeDefined();
  expect(picture.keyframes?.y?.[1]?.handle_in?.speed).toBe(0);
  expect(p.clips.filter((c) => c.type === "audio")).toHaveLength(0);
});

test("portrait fact reveals retain one complete left-aligned layout and the producer's cue times", () => {
  const p = project("facts"); p.style = "commentary";
  p.media.push(media({ id: "person", name: "Person", kind: "image", path: "/person.jpg", duration: 0, width: 600, height: 900, has_audio: false }));
  const result = profile(p, { media: "person", name: "NAME", start: 100, end: 500, lines: [{ text: "FIRST FACT", at: 130 }, { text: "A LONGER SECOND FACT", at: 250 }] });
  const facts = p.clips.find((c) => c.id === result.facts)!;
  expect(facts).toMatchObject({ type: "text", text: "• FIRST FACT\n\n• A LONGER SECOND FACT", style: { align: "left" }, animation: { preset: "words" }, word_times: [30,32,34,150,152,154,156,158] });
  expect(() => profile(p, { media: "person", start: 100, end: 200, lines: [{ text: "Late", at: 250 }] })).toThrow("inside the graphic");
});

test("evidence marker validates actual image coordinates and writes a transparent PNG annotation", () => {
  const rect = { x: 5, y: 8, width: 40, height: 12 };
  expect(rectOf(rect, 100, 50)).toEqual(rect);
  expect(() => rectOf({ ...rect, x: 80 }, 100, 50)).toThrow("fit inside");
  expect(() => rectOf({ ...rect, width: Infinity }, 100, 50)).toThrow("fit inside");
  const png = markerPng(100, 50, rect);
  expect([...png.slice(0,8)]).toEqual([137,80,78,71,13,10,26,10]);
  expect(Buffer.from(png).readUInt32BE(16)).toBe(100);
  expect(Buffer.from(png).readUInt32BE(20)).toBe(50);
});

test("a requested narration look automatically avoids source excerpts and existing chapter texture", () => {
  const p = project("looks"); p.style = "commentary";
  p.clips.push(clip({ id: "vo1", type: "audio", media: "m1", track: "a1", start: 0, duration: 90 }), clip({ id: "vo2", type: "audio", media: "m1", track: "a1", start: 150, duration: 90 }), clip({ id: "chapter", type: "adjustment", name: "Janitor · chapter texture", track: "v1", start: 150, duration: 30 }));
  p.script = { source: "writer:w", blocks: [{ kind: "narration", text: "One", voiceover: "vo1" }, { kind: "narration", text: "Two", voiceover: "vo2" }] };
  narrationLook(p, { start: 0, end: 240 });
  expect(p.clips.filter((c) => c.name === "Janitor · narration look").map((c) => [c.start, c.duration])).toEqual([[0,90],[180,60]]);
  narrationLook(p, { start: 0, end: 240 });
  expect(p.clips.filter((c) => c.name === "Janitor · narration look")).toHaveLength(2);
});

test("a Writer quote becomes its excerpt's cue words, so the cut starts where the quote does", () => {
  expect(quoteCue("Something I have cool coming up… What? … Yeah. So, that's going to be sick.")).toEqual(["Something", "sick."]);
  expect(quoteCue("  ")).toBeNull();
  const parsed = toParsed({ id: "w", title: "E", sourceKind: "commentary", commentary: { draft: { sections: [{ heading: "1", paragraphs: [{ pieces: [
    { kind: "clip" as const, link: "https://youtu.be/LtmN4iw362k", startMs: 0, endMs: 9000, quote: "Hello there … goodbye" }] }] }] } } });
  expect(parsed.blocks[0]).toMatchObject({ words: ["Hello", "goodbye"] });
});

test("N3on v1's flashes, short cards, recycled sources and card-and-text-only graphics are flagged", () => {
  const p = project("essay"); p.style = "commentary";
  p.media.push(media({ id: "monkey", name: "N3on Returns To Monkey! [qXGbUquhQrE].mp4", kind: "video", path: "/m.mp4", duration: 300, width: 1920, height: 1080, has_audio: false }),
    media({ id: "photo", name: "Photo", kind: "image", path: "/p.jpg", duration: 0, width: 1200, height: 800, has_audio: false }));
  // Footage under two cards that leave a two-frame gap between them.
  p.clips.push(clip({ id: "under", type: "video", media: "monkey", name: "Cut-in 1 · B-roll: stream", track: "v1", start: 0, duration: 300 }));
  card(p, { media: "photo", start: 30, end: 100 });
  card(p, { media: "photo", start: 102, end: 250 });
  p.clips.push(clip({ id: "b2", type: "video", media: "monkey", name: "Cut-in 2 · B-roll: stream", track: "v1", start: 300, duration: 300, source_in: 20 }),
    clip({ id: "b3", type: "video", media: "monkey", name: "Cut-in 3 · B-roll: stream", track: "v1", start: 600, duration: 300, source_in: 40 }));
  const kinds = issues(p).map((i) => i.kind);
  expect(kinds).toEqual(expect.arrayContaining(["commentary_flash", "commentary_short_card", "commentary_source_overuse"]));
  expect(issues(p).find((i) => i.kind === "commentary_flash")).toMatchObject({ clip: "under", frames: 2 });
  for (let at = 1000; at < 4000; at += 300) text(p, { text: "PHRASE", start: at, end: at + 60 });
  expect(kinds.includes("commentary_graphics_monotony") || issues(p).some((i) => i.kind === "commentary_graphics_monotony")).toBe(true);
});

test("punch-ins jump and hold on the words, closing in on the point given", () => {
  const p = project("punch"); p.style = "commentary";
  p.media.push(media({ id: "v", name: "V", kind: "video", path: "/v.mp4", duration: 30, width: 1920, height: 1080, has_audio: false }));
  p.clips.push(clip({ id: "shot", type: "video", media: "v", track: "v1", start: 100, duration: 200 }));
  punch(p, { clip: "shot", at: [150, 220], x: 100, y: -50 });
  const c = p.clips.find((one) => one.id === "shot")!;
  expect(c.keyframes?.scale?.map((k) => [k.frame, Math.round(k.value * 100) / 100, k.ease])).toEqual([[0, 1, "hold"], [50, 1.12, "hold"], [120, 1.24, "hold"]]);
  expect(c.keyframes?.x?.[1]?.value).toBeCloseTo(-12);
  expect(() => punch(p, { clip: "shot", at: [150, 155] })).toThrow("12 frames");
  expect(() => punch(p, { clip: "shot", at: [400] })).toThrow("inside the clip");
});

test("the YouTube reference, corner label, bumper and light leak are editable layers in the house's places", () => {
  const p = project("refs"); p.style = "commentary";
  p.media.push(media({ id: "thumb", name: "T", kind: "image", path: "/t.jpg", duration: 0, width: 1280, height: 720, has_audio: false }),
    media({ id: "av", name: "A", kind: "image", path: "/a.png", duration: 0, width: 258, height: 258, has_audio: false }),
    media({ id: "leak", name: "Leak", kind: "video", path: "/l.mp4", duration: 6, width: 1080, height: 1920, has_audio: true }));
  const ref = youtube(p, { media: "thumb", avatar: "av", title: "THE TRUTH ABOUT EVERYTHING PART 2", channel: "Reggie", meta: "1.8M views • 6 days ago", duration: "9:53", start: 0, end: 120 });
  const frame = p.clips.find((c) => c.id === ref.frame)!;
  expect(frame.type === "video" && frame.transform.x).toBeLessThan(0);
  expect(p.clips.filter((c) => c.type === "text").map((c) => c.type === "text" && c.text)).toEqual(expect.arrayContaining(["9:53", "1.8M views • 6 days ago", "Reggie"]));
  label(p, { text: "*COMPLETE CRASHOUT*", start: 0, end: 60 });
  const tag = p.clips.find((c) => c.name === "Janitor · corner label")!;
  expect(tag.type === "text" && tag.transform.x < 0 && tag.transform.y < 0).toBe(true);
  bumper(p, { avatar: "av", line: "Cleaning up the biggest stream on Twitch", subline: "(among many other charges)", start: 200, end: 320 });
  expect(p.clips.some((c) => c.type === "text" && c.text === "CLEANING UP THE BIGGEST STREAM ON TWITCH")).toBe(true);
  leak(p, { at: 500, media: "leak" });
  expect(p.clips.find((c) => c.name === "Janitor · light leak")).toMatchObject({ start: 490, duration: 22, speed: 3.5, blend: "screen", transform: { rotation: 90 } });
  expect(compactCount(1_812_345)).toBe("1.8M");
  expect(compactCount(181_061)).toBe("181K");
});
