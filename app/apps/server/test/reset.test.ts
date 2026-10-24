import { expect, test } from "bun:test";

import type { Project } from "../src/model.ts";
import { newProject } from "../src/project.ts";
import { answer, cleared, pending } from "../src/reset.ts";
import { layOut } from "../src/script.ts";

/** A script project as an import leaves it: two ranges of one file with a cut-in between, laid out. */
function imported(): Project {
  const project = newProject("p", "Case", { width: 1920, height: 1080, fps: 30 }, "bodycam");
  project.media.push({ id: "m1", name: "bodycam.mp4", path: "/x/bodycam.mp4", kind: "video", duration: 120, width: 1920, height: 1080, fps: 30, has_audio: true });
  project.script = {
    source: "https://docs.google.com/document/d/x",
    blocks: [
      { kind: "footage", url: "https://drive.google.com/file/d/f1", file: "f1", start: 10, end: 15, label: "00:10 - 00:15", media: "m1" },
      { kind: "narration", text: "Officers arrived at the house a minute later." },
      { kind: "footage", url: "https://drive.google.com/file/d/f1", file: "f1", start: 40, end: 48, label: "00:40 - 00:48", media: "m1" },
    ],
  };
  layOut(project);
  return project;
}

/** What the timeline plays, ids aside: each clip's kind, place and source. */
const shape = (project: Project) =>
  project.clips.map((clip) => [clip.type, clip.start, clip.duration, "media" in clip ? clip.media : null, "source_in" in clip ? clip.source_in : null]).sort();

test("a reset takes the edit back to the script's first layout and keeps the rest", () => {
  const first = imported();
  const edited: Project = structuredClone(first);
  // What an edit does: a clip moved and trimmed, one added, markers, in and out, a cast.
  edited.clips[0]!.start += 30;
  edited.clips.push({ ...structuredClone(edited.clips[0]!), id: "extra", start: 900 });
  edited.markers = [{ frame: 12, name: "beat", note: "" }];
  edited.mark_in = 10;
  edited.mark_out = 200;
  edited.people = [];
  cleared(edited);
  expect(shape(edited)).toEqual(shape(first));
  expect(edited.markers).toBeUndefined();
  expect(edited.mark_in).toBeUndefined();
  expect(edited.mark_out).toBeUndefined();
  expect(edited.people).toBeUndefined();
  // Media and the script stay; each block points at its new clip.
  expect(edited.media).toEqual(first.media);
  expect(edited.script!.blocks.map((block) => block.kind)).toEqual(["footage", "narration", "footage"]);
  for (const block of edited.script!.blocks) expect(edited.clips.some((clip) => clip.id === block.clip)).toBe(true);
});

test("a project not started from a script has nothing to go back to", () => {
  expect(() => cleared(newProject("q", "Plain", { width: 1920, height: 1080, fps: 30 }))).toThrow("wasn't started from a script");
});

test("the chat's answer goes only to a reset that's asking", () => {
  expect(pending("nobody")).toBeNull();
  expect(answer("nobody", true)).toBe(false);
});
