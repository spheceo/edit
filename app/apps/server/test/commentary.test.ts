import { expect, test } from "bun:test";
import { toParsed, scriptStyle } from "../src/writer_handoff.ts";
import { issues } from "../src/commentary_audit.ts";
import { card, narrationLook, profile, text } from "../src/commentary_graphics.ts";
import { markerPng, rectOf } from "../src/evidence_highlight.ts";
import { rangeOf } from "../src/commentary_sources.ts";
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
