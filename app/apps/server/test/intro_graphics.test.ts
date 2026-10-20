// intro_graphics.ts's tests: the interrogation intro's graphics, applied through a plan.

import { expect, test } from "bun:test";

import { apply } from "../src/edit_plan.ts";
import type { Clip, Project, TextClip } from "../src/model.ts";
import { clipNamed, media, project } from "./helpers/model.ts";

function room(): Project {
  const p = project("plan");
  p.media.push(media({ id: "room", name: "room", path: "/room.mp4", kind: "video", duration: 600, width: 1920, height: 1080 }));
  p.media.push(media({ id: "mug", name: "mug", path: "/mug.png", kind: "image", duration: 30, width: 600, height: 800 }));
  p.media.push(media({ id: "wife", name: "wife", path: "/wife.png", kind: "image", duration: 30, width: 1200, height: 800 }));
  apply(p, [{ op: "add", clip: { type: "video", track: "v1", start: 0, duration: 3000, media: "room", source_in: 0 } }]);
  return p;
}

const named = (p: Project, prefix: string) => p.clips.filter((clip) => (clip.name ?? "").startsWith(prefix));

test("the teasers' subtitles come up word by word in bodycam's glowing look, the lines that matter in red words, naming nobody", () => {
  const p = room();
  apply(p, [
    { op: "add", as: "a", clip: { type: "text", track: "new", name: "Subtitle · Detective", start: 30, duration: 60, text: "Greg's deceased." } },
    { op: "add", as: "b", clip: { type: "text", track: "new", name: "Subtitle · Detective", start: 100, duration: 60, text: "I'm so sorry for you" } },
  ]);
  const [a, b] = named(p, "Subtitle") as TextClip[];
  // The Detective's colour, as their subtitles are.
  const detective = [...b!.style.color];
  expect(detective).not.toEqual([1, 1, 1, 1]);
  const result = apply(p, [{ op: "intro_captions", start: 0, end: 300, emphasis: [a!.id], heard: [34, 44, 100, 104, 110, 116, 400] }]);
  expect(result.results[0]).toEqual({ restyled: [a!.id, b!.id], emphasised: [a!.id] });
  const [ra, rb] = p.clips.filter((clip) => clip.id === a!.id || clip.id === b!.id) as TextClip[];
  // Red text, not a red box ("it's not a red background, it's the red text"), both glowing over the see-through box and its shadow.
  expect([ra!.style.color, ra!.style.background?.color, ra!.style.background?.opacity]).toEqual([[1, 0.1, 0.1, 1], [0, 0, 0, 1], expect.closeTo(0.45, 5)]);
  // The rest in the speaker's colour (the team's subtitle guide).
  rb!.style.color.forEach((value, index) => expect(value).toBeCloseTo(detective[index]!, 5));
  for (const clip of [ra!, rb!]) {
    expect(clip.style.glow).toMatchObject({ enabled: true, radius: 46, strength: 0.5 });
    expect(clip.style.shadow?.blur).toBe(14);
    expect(clip.style.font).toBe("Montserrat");
  }
  expect([ra!.name, ra!.animation.preset, ra!.word_times]).toEqual(["Subtitle (teaser)", "words", [4, 14]]);
  // Five words but four heard in it: spread over the first 60% of the line instead.
  expect(rb!.word_times).toEqual([0, 7.2, 14.4, 21.6, 28.8]);
  expect((ra as Clip & { person?: string }).person).toBeUndefined();
});

test("a photo inset, a countdown, a split screen, a fast forward and a disclaimer build valid clips", () => {
  const p = room();
  const results = apply(p, [
    { op: "photo_inset", media: "mug", name: "Michelle Williams", start: 60, end: 180 },
    { op: "countdown", start: 300, end: 390 },
    { op: "split_screen", left: "mug", right: "wife", tags: ["MICHELLE", "GREG"], tag_colors: [[1, 1, 0, 1], [0.9, 0.5, 0, 1]], start: 400, end: 500 },
    { op: "fast_forward", start: 600, end: 700 },
    { op: "disclaimer", start: 800, end: 900 },
    { op: "text_slam", text: "Then the case goes cold", start: 1000, end: 1090 },
    { op: "timeline_bar", from: "1986", to: "2009", start: 1100, end: 1200 },
    { op: "transition", kind: "red_flash", at: 1300 },
  ]).results;
  expect(results.length).toBe(8);
  // Each op put its layers on new tracks; the plan packs them down to what's on screen at once (the split screen's four, over the footage).
  expect(p.tracks.filter((track) => track.kind === "video").length).toBeLessThanOrEqual(5);
  // The inset: black and white beneath, the photo in the top-left corner, the name above it.
  const photo = clipNamed(p, "Photo inset · Michelle Williams");
  expect(photo.type === "video" && photo.transform.x < 0 && photo.transform.y < 0).toBe(true);
  expect(clipNamed(p, "Photo inset · black and white").type).toBe("adjustment");
  // The countdown reads the time left each second, to the tape's frame.
  const ticks = named(p, "Countdown") as TextClip[];
  expect(ticks.map((tick) => tick.text)).toEqual(["INTERROGATION STARTS IN  00:03", "INTERROGATION STARTS IN  00:02", "INTERROGATION STARTS IN  00:01"]);
  expect(ticks.at(-1)!.start + ticks.at(-1)!.duration).toBe(390);
  // Each half of the split screen fills its half: cropped, centred a quarter in.
  const left = clipNamed(p, "Split screen · left");
  expect(left.type === "video" && left.transform.x).toBe(-480);
  expect(clipNamed(p, "Split screen · right tag").type).toBe("text");
  expect(clipNamed(p, "Fast forward").type).toBe("adjustment");
  expect((clipNamed(p, "Disclaimer · title") as TextClip).text).toBe("DISCLAIMER");
  expect((clipNamed(p, "Text slam") as TextClip).word_times).toEqual([0, 6, 12, 18, 24]);
  expect((clipNamed(p, "Timeline · to") as TextClip).style.leader).toBeDefined();
  expect(clipNamed(p, "Red flash").type).toBe("solid");
});

test("a date over a top-down map is a lower third with its place above it, not darkened", () => {
  const p = room();
  const [date] = apply(p, [{ op: "date_title", text: "October 13th, 2011", place: "Keller, Texas", position: "bottom", start: 0, end: 120 }]).results as { date: string; darken: string | null }[];
  expect(date!.darken).toBeNull();
  const text = clipNamed(p, "Date") as TextClip;
  expect(text.text).toBe("Keller, Texas\nOctober 13th, 2011");
  expect(text.transform.y).toBeGreaterThan(300);
});
