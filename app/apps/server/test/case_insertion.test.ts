import { expect, test } from "bun:test";
import { finishCase, hasCase, pendingCase, queueCase } from "../src/case_insertion.ts";
import { layOut, unfinished } from "../src/script.ts";
import { clipOf, duration } from "../src/project.ts";
import { native } from "../src/native/index.ts";
import { media, project, stubNative } from "./helpers/model.ts";

function original() {
  stubNative();
  const p = project();
  p.media.push(media({ id: "m1", name: "Original footage", path: "/tmp/footage.mp4", kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true }));
  p.script = { source: "Earlier Doc", blocks: [
    { kind: "footage", file: "OriginalFileAbc", url: "", label: "Original case", start: 0, end: 10, media: "m1" },
    { kind: "narration", text: "The original finished words." },
    { kind: "footage", file: "OriginalFileAbc", url: "", label: "Original case 2", start: 20, end: 30, media: "m1" },
  ] };
  layOut(p);
  return p;
}
const input = { title: "Missing case", blocks: [{ kind: "footage" as const, file: "OriginalFileAbc", url: "", label: "New range", start: 40, end: 45 }] };
function prepared(p: ReturnType<typeof original>) {
  for (const block of p.script!.blocks) if (block.kind === "footage" && !block.media) block.media = "m1";
  const previous = new Set(p.clips.map((clip) => clip.id));
  layOut(p);
  finishCase(p, previous);
}

test("inserting a case ripples the finished edit intact and preserves script order, source offsets and clip IDs", () => {
  const p = original();
  const old = structuredClone(p);
  queueCase(p, input, { id: "missing-case", at: 300, number: 2, intro: "The new case's researched opening." });
  expect(unfinished(p)).toBe(true);
  expect(pendingCase(JSON.parse(JSON.stringify(p)))?.id).toBe("missing-case");
  prepared(p);
  expect(pendingCase(p)).toBeNull();
  expect(p.script!.blocks.map((block) => block.kind === "narration" ? block.text : block.label)).toEqual([
    "Original case", "The new case's researched opening.", "New range", "The original finished words.", "Original case 2",
  ]);
  for (const clip of old.clips) expect(clipOf(p, clip.id)).toEqual({ ...clip, start: clip.start >= 300 ? clip.start + 240 : clip.start });
  expect(duration(p)).toBe(duration(old) + 240);
  expect(native().projectValidate(JSON.stringify(p))).toBeNull();
});

test("one stable request is idempotent and a second pending case is refused", () => {
  const p = original();
  expect(queueCase(p, input, { id: "same", at: 0, number: 1 })).toBe(true);
  expect(queueCase(p, input, { id: "same", at: 0, number: 1 })).toBe(false);
  expect(() => queueCase(p, input, { id: "different", at: 0, number: 1 })).toThrow("already importing");
  prepared(p);
  expect(hasCase(p, "same")).toBe(true);
  expect(queueCase(p, input, { id: "same", at: 0, number: 1 })).toBe(false);
});

test("a spanning segment is split around the new case and metadata follows its old content", () => {
  const p = original();
  p.segments = [{ start: 0, end: duration(p), kind: "footage" }];
  p.markers = [{ frame: 390, name: "Original scene" }];
  p.mark_in = 390;
  p.mark_out = duration(p) - 1;
  queueCase(p, input, { id: "segments", at: 300, number: 2, intro: "New opening." });
  prepared(p);
  expect(p.segments!.map((segment) => [segment.start, segment.end, segment.kind])).toEqual([
    [0, 300, "footage"], [300, 390, "narration"], [390, 540, "footage"], [540, 930, "footage"],
  ]);
  expect(p.markers![0]?.frame).toBe(630);
  expect(p.mark_in).toBe(630);
  expect(p.mark_out).toBe(929);
  expect(native().projectValidate(JSON.stringify(p))).toBeNull();
});

test("an insertion follows its anchor after an edit and never guesses when that anchor disappears", () => {
  const p = original();
  queueCase(p, input, { id: "anchor", at: 390, number: 2 });
  const anchor = pendingCase(p)!.anchor!;
  p.clips = p.clips.filter((clip) => clip.id !== anchor);
  expect(() => prepared(p)).toThrow("anchor was deleted");
});

test("crossing speech/video and invalid positions are refused before any script mutation", () => {
  const p = original();
  const before = JSON.stringify(p);
  expect(() => queueCase(p, input, { id: "bad", at: 150, number: 1 })).toThrow("clean case boundary");
  expect(() => queueCase(p, input, { id: "bad", at: 300, number: 0 })).toThrow("whole numbers");
  expect(() => queueCase(p, input, { id: "bad", at: 300, number: 2, before: 99 })).toThrow("outside");
  expect(JSON.stringify(p)).toBe(before);
});
