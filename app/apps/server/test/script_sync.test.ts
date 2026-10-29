import { beforeAll, describe, expect, test } from "bun:test";

import type { Script } from "@edit/types/writer";

import type { Project } from "../src/model.ts";
import { findAddon, useNative, wrap, type Native } from "../src/native/index.ts";
import { clipEnd, cutTime } from "../src/project.ts";
import { layOut } from "../src/script.ts";
import { applyToEdit, applyToScript, changesOf, editSide, linkOf } from "../src/script_sync.ts";
import { toParsed, type WriterScript } from "../src/writer_handoff.ts";
import { media, project as newProject } from "./helpers/model.ts";

// The ripples are the addon's (edit_core::remove_time): these run against the real one when it's built.
const real = findAddon();
beforeAll(() => {
  if (real !== null) useNative(wrap(require(real) as Native));
});

/** A script of one YouTube video: a range, a cut-in, another range. */
function script(): Script {
  return {
    id: "s1", title: "Case", sourceKind: "youtube", sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 60_000, revision: 4, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null, words: [],
    clips: [
      { id: "a", startMs: 0, endMs: 10_000 },
      { id: "n", kind: "cut-in", startMs: 0, endMs: 3_000, narration: "Then the call came in." },
      { id: "b", startMs: 20_000, endMs: 30_000 },
    ],
  } as Script;
}

/** The edit made from it, laid out as the import lays it out, and the two agreed on. */
function made(given = script()): [Project, Script] {
  const project = newProject("edit");
  project.media.push(media({ id: "m1", name: "Case.mp4", path: "/case.mp4", kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true }));
  project.script = { source: "writer:s1", blocks: toParsed(given as unknown as WriterScript).blocks.map((block) => (block.kind === "footage" ? { ...block, media: "m1" } : block)) };
  layOut(project);
  const link = linkOf("p", given);
  link.clips = link.clips.map((kept) => ({ ...kept, edit: editSide(project, kept.id)! }));
  given.edit = link;
  return [project, given];
}

const clipOfBlock = (project: Project, origin: string) => project.clips.find((clip) => clip.id === project.script!.blocks.find((block) => block.origin === origin)!.clip)!;

describe.skipIf(real === null)("a script and its edit, kept in step", () => {
  test("every block knows its script clip, and the edit's side reads each range's ends and cut-in's words", () => {
    const [project] = made();
    expect(project.script!.blocks.map((block) => [block.kind, block.origin])).toEqual([["footage", "a"], ["narration", "n"], ["footage", "b"]]);
    expect(editSide(project, "a")).toEqual({ head: 0, tail: 10, text: null });
    expect(editSide(project, "n")).toEqual({ head: 0, tail: 0, text: "Then the call came in." });
  });

  test("a range trimmed in the script loses that time on every track; one lengthened gains it", () => {
    const [project, given] = made();
    const now = structuredClone(given);
    now.clips[0]!.endMs = 8_000;
    now.clips[2]!.startMs = 18_000;
    applyToEdit(project, now as unknown as WriterScript, changesOf(given.edit!, now));
    const [a, b] = [clipOfBlock(project, "a"), clipOfBlock(project, "b")];
    expect(a.duration).toBe(240);
    // b starts 2 s earlier in its footage and is 2 s longer, right after the cut-in that moved back with a.
    expect(b.type === "video" && b.source_in).toBe(18);
    expect(b.duration).toBe(360);
    expect(editSide(project, "a")!.tail).toBe(8);
    expect(project.script!.blocks[0]!.kind === "footage" && project.script!.blocks[0]!.label).toBe("00:00 - 00:08");
  });

  test("a clip taken out of the script takes its time with it; a cut-in added goes in at the cut after the clip before it", () => {
    const [project, given] = made();
    const length = Math.max(...project.clips.map(clipEnd));
    const now = structuredClone(given);
    now.clips = [now.clips[0]!, { id: "m", kind: "cut-in", startMs: 0, endMs: 3_000, narration: "He was never seen again." }, now.clips[2]!];
    const done = applyToEdit(project, now as unknown as WriterScript, changesOf(given.edit!, now));
    expect(done.voice).toBe(true);
    expect(project.script!.blocks.map((block) => block.origin)).toEqual(["a", "m", "b"]);
    // The old cut-in's time went, the new one's came in at the same cut.
    expect(Math.max(...project.clips.map(clipEnd))).toBe(length);
    expect(project.script!.blocks[1]!.kind === "narration" && project.script!.blocks[1]!.text).toBe("He was never seen again.");
  });

  test("a cut-in reworded before it's voiced changes its card's words", () => {
    const [project, given] = made();
    const now = structuredClone(given);
    now.clips[1]!.narration = "Then the second call came in.";
    const done = applyToEdit(project, now as unknown as WriterScript, changesOf(given.edit!, now));
    expect(done.revoice).toEqual([]);
    expect(project.clips.some((clip) => clip.type === "text" && clip.text === "Then the second call came in.")).toBe(true);
  });

  test("a range trimmed in the edit trims the script; pauses cut inside it don't", () => {
    const [project, given] = made();
    const a = clipOfBlock(project, "a");
    // A pause taken out of the middle of a (frames 90–120): the run's ends stay.
    cutTime(project, 90, 120);
    expect(applyToScript(project, given, given.edit!)).toBe(false);
    // Its last second taken off: the script's range ends a second sooner.
    const end = clipEnd(project.clips.filter((clip) => clip.type === "video" && clip.start < 300).sort((x, y) => clipEnd(y) - clipEnd(x))[0]!);
    cutTime(project, end - 30, end);
    expect(applyToScript(project, given, given.edit!)).toBe(true);
    expect(given.clips[0]!.endMs).toBe(9_000);
    expect(a.id).toBeDefined();
  });

  test("a cut-in reworded or a clip deleted in the edit changes the script", () => {
    const [project, given] = made();
    const block = project.script!.blocks.find((one) => one.origin === "n")!;
    if (block.kind === "narration") block.text = "Then the 911 call came in.";
    project.script!.blocks = project.script!.blocks.filter((one) => one.origin !== "b");
    expect(applyToScript(project, given, given.edit!)).toBe(true);
    expect(given.clips.map((clip) => clip.id)).toEqual(["a", "n"]);
    expect(given.clips[1]!.narration).toBe("Then the 911 call came in.");
  });

  test("a range's first piece cut away in the edit moves the script's in point; all of it deleted takes the clip out", () => {
    const [project, given] = made();
    // The pause after a's first second taken out, then that first second deleted: a now plays from 2 s.
    cutTime(project, 30, 60);
    const a = clipOfBlock(project, "a");
    project.clips = project.clips.filter((clip) => clip.id !== a.id && !(a.link && clip.link === a.link && clip.start === a.start));
    expect(applyToScript(project, given, given.edit!)).toBe(true);
    expect([given.clips[0]!.startMs, given.clips[0]!.endMs]).toEqual([2_000, 10_000]);
    // Every clip of b gone from the timeline (its block still in the edit's script): b is taken out of the script.
    const [fresh, script] = made();
    const b = clipOfBlock(fresh, "b");
    fresh.clips = fresh.clips.filter((clip) => clip.id !== b.id && !(b.link && clip.link === b.link));
    expect(applyToScript(fresh, script, script.edit!)).toBe(true);
    expect(script.clips.map((clip) => clip.id)).toEqual(["a", "n"]);
  });

  test("nothing changed is no change, either way", () => {
    const [project, given] = made();
    const change = changesOf(given.edit!, given);
    expect([change.removed, change.trimmed, change.reworded, change.added]).toEqual([[], [], [], []]);
    expect(applyToScript(project, given, given.edit!)).toBe(false);
  });
});
