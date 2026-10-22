// reviews.ts: notes heard from Repack, placed on the timeline after later
// edits, set for the agent once they settle, and each fix's changed stretch.

import { expect, test } from "bun:test";

import type { Project } from "../src/model.ts";
import { changes, fixMessage, frameNow, heard, read, waiting, type Note, type Version } from "../src/reviews.ts";
import { insertTime } from "../src/project.ts";
import { clip, media, project as newProject } from "./helpers/model.ts";

function edit(): Project {
  const p = newProject("review");
  p.media.push(media({ id: "m", name: "bodycam.mp4", path: "/x/b.mp4", kind: "video", duration: 600, width: 1920, height: 1080, fps: 30, has_audio: true }));
  const [v1, , , a1] = p.tracks.map((track) => track.id);
  p.clips.push(
    clip({ id: "a", track: v1, start: 0, duration: 300, type: "video", media: "m", source_in: 0, link: "la" }),
    clip({ id: "sa", track: a1, start: 0, duration: 300, type: "audio", media: "m", source_in: 0, link: "la" }),
    clip({ id: "b", track: v1, start: 300, duration: 300, type: "video", media: "m", source_in: 100, link: "lb" }),
    clip({ id: "sb", track: a1, start: 300, duration: 300, type: "audio", media: "m", source_in: 100, link: "lb" }),
  );
  return p;
}

test("a note's moment on an old export finds its clip after later edits", () => {
  const p = edit();
  const v1: Version = { n: 1, timeline: "t", path: "/x/v1.mp4", fps: 30, durationMs: 20_000, clips: [["a", 0, 300], ["b", 300, 300]] };
  // 12 s on the export is 2 s into clip b; a second put in before it moves b on.
  expect(frameNow(p, v1, 12_000)).toBe(360);
  insertTime(p, 100, 30, new Set(["a", "sa"]), new Set());
  expect(frameNow(p, v1, 12_000)).toBe(390);
  // With no version kept, the moment is the frame.
  expect(frameNow(p, undefined, 12_000)).toBe(360);
});

test("notes heard are kept, the new open ones name their project, and settled ones wait for the agent once", () => {
  const state = read("/nonexistent");
  const notes = [
    { id: "n1", reviewId: "r", sourceId: "p1", version: 1, anchor: { kind: "time", ms: 5000 }, text: "music too loud", author: "JJ", status: "open", createdAt: 10, updatedAt: 10 },
    { id: "n2", reviewId: "r", sourceId: "p1", version: 1, anchor: { kind: "time", ms: 2000, endMs: 4000 }, text: "blur the kid", author: "JJ", status: "open", createdAt: 11, updatedAt: 11 },
    { id: "n3", reviewId: "r", sourceId: "elsewhere", version: 1, anchor: { kind: "time", ms: 1 }, text: "x", author: "JJ", status: "open", createdAt: 12, updatedAt: 12 },
  ];
  expect(heard(state, notes, new Set(["p1"]))).toEqual(["p1"]);
  expect(state.since).toBe(12);
  // Heard again: nothing new.
  expect(heard(state, notes, new Set(["p1"]))).toEqual([]);
  // In order along the video; one tried isn't offered again (until half an hour has gone).
  expect(waiting(state, "p1", 1000).map((note) => note.id)).toEqual(["n2", "n1"]);
  state.notes.n2!.claimed = 1000;
  expect(waiting(state, "p1", 2000).map((note) => note.id)).toEqual(["n1"]);
  expect(waiting(state, "p1", 1000 + 31 * 60_000).map((note) => note.id)).toEqual(["n2", "n1"]);
});

test("the agent's message names each note with its moment, its place on the timeline and what's there", () => {
  const p = edit();
  const note: Note = { id: "n1", reviewId: "r", project: "p", version: 2, ms: 12_000, endMs: null, text: "change the music", author: "JJ", status: "open", parentId: null, createdAt: 1, updatedAt: 1 };
  const shared = { reviewId: "r", url: "https://repack.spheceo.com/r/abc", versions: [{ n: 2, timeline: "t", path: "/x", fps: 30, durationMs: 20_000, clips: [["b", 300, 300]] as [string, number, number][] }] };
  const message = fixMessage(p, shared, [note]);
  expect(message).toStartWith("(Edit, automatically) New feedback on this edit's review (https://repack.spheceo.com/r/abc): 1 note.");
  expect(message).toContain('- [n1] at 0:12.0 of v2 (timeline 12.00s, frame 360; there: b ');
  expect(message).toContain('JJ: "change the music"');
  expect(message).toContain("feedback_done");
});

test("a fix's changes are the clips added, removed or changed, not the ones a ripple only moved along", () => {
  const before = edit();
  const after = structuredClone(before);
  // Clip a's sound turned down, and half a second put in at its cut (which only moves b along).
  const sa = after.clips.find((one) => one.id === "sa")!;
  if (sa.type === "audio") sa.volume_db = -6;
  insertTime(after, 300, 15, new Set(["a", "sa"]), new Set());
  const found = changes(before, after);
  expect(found.clips.sort()).toEqual(["a", "sa"]);
  expect(found.ranges).toEqual([[0, 315]]);
});
