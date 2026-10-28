// reviews.ts: notes heard from Repack, placed on the timeline after later
// edits, set for the agent once they settle, and each fix's changed stretch.

import { expect, test } from "bun:test";

import type { Project } from "../src/model.ts";
import * as fs from "node:fs";

import { boxStills, changes, clearOthers, fixMessage, frameNow, fullKeyOf, givenUp, heard, MAX_ATTEMPTS, posterSecond, read, restoreArchived, shareable, waiting, type Note, type Version } from "../src/reviews.ts";
import { insertTime } from "../src/project.ts";
import { fixtureHome, scratch } from "./helpers/home.ts";
import * as tools from "../src/tools.ts";
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

test("Edit's own notes on a review (things for the client to confirm) are never taken as fixes to make", () => {
  const state = read("/nonexistent");
  const note = { reviewId: "r", sourceId: "p1", version: 1, anchor: { kind: "time", ms: 1000 }, author: "Edit", status: "open", createdAt: 1, updatedAt: 1 };
  expect(heard(state, [{ ...note, noteId: "mine", text: "Please confirm: …", fromApp: true }], new Set(["p1"]))).toEqual([]);
  expect(state.notes.mine).toBeUndefined();
  expect(heard(state, [{ ...note, noteId: "theirs", text: "cut this", author: "JJ" }], new Set(["p1"]))).toEqual(["p1"]);
});

test("notes heard are kept, the new open ones name their project, and settled ones wait for the agent once", () => {
  const state = read("/nonexistent");
  const notes = [
    { noteId: "n1", reviewId: "r", sourceId: "p1", version: 1, anchor: { kind: "time", ms: 5000 }, text: "music too loud", author: "JJ", status: "open", createdAt: 10, updatedAt: 10 },
    { noteId: "n2", reviewId: "r", sourceId: "p1", version: 1, anchor: { kind: "time", ms: 2000, endMs: 4000 }, text: "blur the kid", author: "JJ", status: "open", createdAt: 11, updatedAt: 11 },
    { noteId: "n3", reviewId: "r", sourceId: "elsewhere", version: 1, anchor: { kind: "time", ms: 1 }, text: "x", author: "JJ", status: "open", createdAt: 12, updatedAt: 12 },
  ];
  expect(heard(state, notes, new Set(["p1"]))).toEqual(["p1"]);
  // Heard again: nothing new.
  expect(heard(state, notes, new Set(["p1"]))).toEqual([]);
  // In order along the video; one tried isn't offered again (until half an hour has gone).
  expect(waiting(state, "p1", 1000).map((note) => note.id)).toEqual(["n2", "n1"]);
  state.notes.n2!.claimed = 1000;
  expect(waiting(state, "p1", 2000).map((note) => note.id)).toEqual(["n1"]);
  expect(waiting(state, "p1", 1000 + 31 * 60_000).map((note) => note.id)).toEqual(["n2", "n1"]);
  // Fixed, then opened again by the reviewer ("Not fixed"): new to fix, from the start; a reply is never claimed itself.
  state.notes.n1!.fix = { clips: ["a"], ranges: [[0, 30]], summary: "music down", at: 5 };
  state.notes.n1!.status = "done";
  expect(waiting(state, "p1", 2000).map((note) => note.id)).toEqual([]);
  const again = [
    { ...notes[0]!, status: "open", updatedAt: 20 },
    { noteId: "r1", reviewId: "r", sourceId: "p1", version: 1, parentId: "n1", text: "still too loud at the start", author: "JJ", status: "open", createdAt: 19, updatedAt: 19 },
  ];
  expect(heard(state, again, new Set(["p1"]))).toEqual(["p1"]);
  expect(state.notes.n1!.fix).toBeUndefined();
  expect(waiting(state, "p1", 2000).map((note) => note.id)).toEqual(["n1"]);
  // Deleted by its guest: gone.
  expect(heard(state, [{ ...notes[0]!, deleted: true, updatedAt: 30 }], new Set(["p1"]))).toEqual([]);
  expect(state.notes.n1).toBeUndefined();
});

test("the agent's message names each note with its moment, its place on the timeline and what's there", () => {
  const p = edit();
  const note: Note = { id: "n1", reviewId: "r", project: "p", version: 2, ms: 12_000, endMs: null, text: "change the music", author: "JJ", status: "open", parentId: null, createdAt: 1, updatedAt: 1 };
  const shared = { reviewId: "r", url: "https://repack.spheceo.com/r/abc", versions: [{ n: 2, timeline: "t", path: "/x", fps: 30, durationMs: 20_000, clips: [["b", 300, 300]] as [string, number, number][] }] };
  const message = fixMessage(p, shared, [note]);
  expect(message).toStartWith("(Edit, automatically) New feedback on this edit's review (https://repack.spheceo.com/r/abc): 1 note.");
  expect(message).toContain('- [n1] at 0:12.0 of v2 (timeline 12.00s, frame 360; there: b ');
  expect(message).toContain('"JJ": "change the music"');
  expect(message).toContain("feedback_done");
  // What the team said under it comes with it.
  const reply: Note = { ...note, id: "r1", parentId: "n1", text: "the second song too", createdAt: 2 };
  expect(fixMessage(p, shared, [note], [reply])).toContain('"JJ" replied: "the second song too"');
  // What the reviewer marked the note as comes with it.
  const marked: Note = { ...note, asks: { intent: "blur", scope: "everywhere", box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, pin: { source: "drive:abc", sourceMs: 12500, words: "come out here" } } };
  const said = fixMessage(p, shared, [marked]);
  expect(said).toContain("kind: blur; everywhere it happens");
  expect(said).toContain("centre 0, 0 px from the frame's centre, 960×540 px");
  expect(said).toContain('said there: "come out here"; footage: drive:abc @12.50s');
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

test("approving a version deletes the exports shared as the others, never the approved one's", () => {
  const { app, fixture, id } = (() => {
    const fixture = fixtureHome("approve");
    const id = fixture.store.create("approve", { width: 1920, height: 1080, fps: 30 }).project.id;
    return { app: fixture.app, fixture, id };
  })();
  try {
    const home = fixture.home;
    const files = [1, 2, 3].map((n) => `${home}/exports/v${n}.mp4`);
    fs.mkdirSync(`${home}/exports`, { recursive: true });
    for (const file of files) fs.writeFileSync(file, "x");
    const record = (path: string) => ({ path, name: path, finished_ms: 1, seconds: 1, bytes: 1, frames: 30, whole: true, format: "h264" });
    fs.writeFileSync(`${home}/exports.json`, JSON.stringify({ [id]: files.map(record) }));
    const versions = files.map((path, index) => ({ n: index + 1, timeline: `t${index}`, path, fps: 30, durationMs: 1000, clips: [] }));
    fs.writeFileSync(`${home}/reviews.json`, JSON.stringify({ cursor: 0, autoFix: true, shared: { [id]: { reviewId: "r", url: "u", versions } }, notes: {} }));
    expect(clearOthers(app, id, 3).sort()).toEqual(files.slice(0, 2));
    expect(files.map((file) => fs.existsSync(file))).toEqual([false, false, true]);
    // Again: nothing more to delete.
    expect(clearOthers(app, id, 3)).toEqual([]);
  } finally {
    fixture.cleanup();
  }
});

test("a review's poster is plain footage: not under a blur or a card", () => {
  const p = edit();
  const [, v2] = p.tracks.map((track) => track.id);
  // A blur over the first 4 s, a cut-in card from 4 to 6 s.
  p.clips.push(clip({ id: "blur", track: v2, start: 0, duration: 120, type: "adjustment", blur: { radius: 30 } }));
  p.clips.push(clip({ id: "card", track: v2, start: 120, duration: 60, type: "solid", name: "Cut-in 1 · card", fill: [0, 0, 0, 1] }));
  expect(posterSecond(p, 20)).toBe(6);
});

test("a boxed note comes to the agent with its frame, the box drawn on it", async () => {
  const dir = scratch("box");
  try {
    const video = `${dir.dir}/export.mp4`;
    await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2", "-pix_fmt", "yuv420p", video]);
    const shared = { reviewId: "r", url: "u", versions: [{ n: 1, timeline: "t", path: video, fps: 30, durationMs: 2000, clips: [] }] };
    const note = { id: "n1", reviewId: "r", project: "p", version: 1, ms: 1000, endMs: null, text: "blur this", author: "JJ", status: "open", parentId: null, createdAt: 0, updatedAt: 0, asks: { box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } } } satisfies Note;
    const stills = await boxStills(dir.dir, "p", shared, [note, { ...note, id: "n2", asks: {} }]);
    expect(Object.keys(stills)).toEqual(["n1"]);
    expect(fs.statSync(stills.n1!).size).toBeGreaterThan(1000);
    expect(fixMessage(edit(), shared, [note], [], stills)).toContain(`box drawn in red: ${stills.n1}`);
  } finally {
    dir.cleanup();
  }
});

test("a note the auto-fix tried twice without a result isn't tried again: it's left for the team", () => {
  const state = read("/nonexistent");
  const base = { reviewId: "r", project: "p1", version: 1, ms: 1000, endMs: null, text: "x", author: "JJ", status: "open" as const, parentId: null, createdAt: 1, updatedAt: 1 };
  state.notes.a = { ...base, id: "a", attempts: 1, claimed: 0 } as Note;
  state.notes.b = { ...base, id: "b", attempts: MAX_ATTEMPTS, claimed: 0 } as Note;
  const later = 31 * 60_000;
  expect(waiting(state, "p1", later).map((note) => note.id)).toEqual(["a"]);
  expect(givenUp(state, "p1", later).map((note) => note.id)).toEqual(["b"]);
  // Not while its last try may still be running.
  expect(givenUp(state, "p1", 60_000)).toEqual([]);
});

test("an export archived to the cloud after it finished is fetched back before it's shared, and refused if it comes back short", async () => {
  const { dir, cleanup } = scratch("restore");
  const path = `${dir}/edit.mp4`;
  const fetched: string[] = [];
  const fetch = async (key: string, dest: string) => {
    fetched.push(key);
    fs.writeFileSync(dest, "12345");
  };
  await restoreArchived({ path, bytes: 5, cloudKey: "edit/exports/p/edit.mp4" }, fetch);
  expect(fetched).toEqual(["edit/exports/p/edit.mp4"]);
  expect(fs.readFileSync(path, "utf8")).toBe("12345");
  // Already on disk, or never archived: nothing is fetched.
  await restoreArchived({ path, bytes: 5, cloudKey: "edit/exports/p/edit.mp4" }, fetch);
  await restoreArchived({ path: `${dir}/local.mp4`, bytes: 5 }, fetch);
  expect(fetched.length).toBe(1);
  const short = `${dir}/short.mp4`;
  await expect(restoreArchived({ path: short, bytes: 9, cloudKey: "edit/exports/p/short.mp4" }, fetch)).rejects.toThrow("not 9");
  expect(fs.existsSync(short)).toBe(false);
  cleanup();
});

test("a review shares the newest whole export, or a named export of the edit's opening, never a middle stretch", () => {
  const whole = { path: "/whole.mp4", whole: true, start: 0 };
  const opening = { path: "/first-6-min.mp4", whole: false, start: 0 };
  const middle = { path: "/middle.mp4", whole: false, start: 900 };
  const older = { path: "/older.mp4", whole: false };
  expect(shareable([opening, whole], null)).toBe(whole);
  expect(shareable([opening], null)).toBeUndefined();
  expect(shareable([opening, whole], "/first-6-min.mp4")).toBe(opening);
  expect(shareable([middle], "/middle.mp4")).toBeUndefined();
  expect(shareable([older], "/older.mp4")).toBeUndefined();
  expect(shareable([{ ...opening, missing: true }], "/first-6-min.mp4")).toBeUndefined();
});

test("a version's full-quality file sits beside its review copy, keeping the export's extension", () => {
  expect(fullKeyOf("edit/reviews/p1/abc", "/x/Judge v3.mp4")).toBe("edit/reviews/p1/abc/full.mp4");
  expect(fullKeyOf("edit/reviews/p1/abc", "/x/Judge v3.MOV")).toBe("edit/reviews/p1/abc/full.mov");
  expect(fullKeyOf("edit/reviews/p1/abc", "/x/odd.mkv")).toBe("edit/reviews/p1/abc/full.mp4");
});
