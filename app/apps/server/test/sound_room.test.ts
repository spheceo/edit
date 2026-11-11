// sound_room.ts's tests: a footage sound's crossfade room is the wordless
// source around it (JJ, Nov 10: cuts blended, never a word cut out heard
// again), set by the store on every save from the file's words.

import { expect, test } from "bun:test";

import type { Media, Project } from "../src/model.ts";
import { enforceSoundRoom, roomAround, wordsOf, type Words } from "../src/sound_room.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip, media } from "./helpers/model.ts";

const SETTINGS = { width: 1920, height: 1080, fps: 30 };

/** "one two three four": words at 1–2, 3–4, 6–7 and 7.02–8 s. */
const WORDS = wordsOf([
  { text: "one", start: 1, end: 2 },
  { text: "two", start: 3, end: 4 },
  { text: "three", start: 6, end: 7 },
  { text: "four", start: 7.02, end: 8 },
]);

test("the room reaches to the words either side and in to the clip's own, never into one, and no further than a second (the longest a crossfade reaches)", () => {
  // Each word is taken as 50 ms longer at each end (GUARD).
  // The clip plays "two" (2.5–4.5 s): quiet back to "one"'s end and a second on (the next word is at 6); its own word 3–4.
  expect(roomAround(WORDS, 2.5, 4.5, 60)).toEqual({ from: 2.05, to: 5.5, words_from: 2.95, words_to: 4.05 });
  // No word in it: out to the words either side (each 50 ms longer), and in all the way.
  expect(roomAround(WORDS, 4.4, 5, 60)).toEqual({ from: 4.05, to: 5.95, words_from: 5, words_to: 4.4 });
  // Cut through a word on either side: no room that side, out or in.
  expect(roomAround(WORDS, 1.5, 6.5, 60)).toEqual({ from: 1.5, to: 6.5, words_from: 1.5, words_to: 6.5 });
  // Cut tight on its own word, and before one 20 ms after it: no room either side.
  expect(roomAround(WORDS, 6, 7, 60)).toEqual({ from: 6, to: 7, words_from: 6, words_to: 7 });
  // Nor past the file's ends.
  expect(roomAround(WORDS, 0.2, 0.8, 0.9)).toEqual({ from: 0, to: 0.9, words_from: 0.8, words_to: 0.2 });
});

function footage(project: Project): void {
  project.media.push(media({ id: "m1", name: "a.mp4", path: "/nowhere/a.mp4", kind: "video", duration: 60, width: 1920, height: 1080, has_audio: true }));
  project.media.push(media({ id: "song", name: "song.mp3", path: "/nowhere/song.mp3", kind: "audio", duration: 60, has_audio: true, library: "music" }));
  const a1 = project.tracks.find((track) => track.kind === "audio")!.id;
  project.clips.push(clip({ id: "s1", type: "audio", track: a1, media: "m1", start: 0, duration: 60, source_in: 2.5 }));
  project.clips.push(clip({ id: "s2", type: "audio", track: a1, media: "m1", start: 60, duration: 30, source_in: 6 }));
  project.clips.push(clip({ id: "music", type: "audio", track: a1, media: "song", start: 90, duration: 30, source_in: 0 }));
}

const roomOf = (project: Project, id: string) => {
  const found = project.clips.find((one) => one.id === id);
  return found?.type === "audio" ? found.room : undefined;
};

test("every save sets each footage sound's room from its file's words, and keeps one from elsewhere while it's uncut", async () => {
  const fixture = fixtureHome("sound-room");
  try {
    const { store } = fixture;
    let known: Words | null = WORDS;
    const asked: string[] = [];
    store.setWords((one: Media) => {
      asked.push(one.id);
      return known;
    });
    const id = store.createAs("Room", "bodycam", SETTINGS).project.id;
    await store.update(id, "agent", (project) => footage(project));
    let saved = store.get(id)!.project;
    expect(roomOf(saved, "s1")).toEqual({ from: 2.05, to: 5.5, words_from: 2.95, words_to: 4.05 });
    expect(roomOf(saved, "s2")).toEqual({ from: 6, to: 7, words_from: 6, words_to: 7 });
    // The team's music keeps its own fades: no room, and its words aren't looked for.
    expect(roomOf(saved, "music")).toBeUndefined();
    expect(asked.includes("song")).toBe(false);

    // Trimmed by hand (a page's save): its room follows.
    const trimmed = structuredClone(saved);
    const s1 = trimmed.clips.find((one) => one.id === "s1")!;
    s1.duration = 30; // Now 2.5–3.5 s: it ends inside "two".
    await store.replace(id, null, trimmed, "page");
    saved = store.get(id)!.project;
    expect(roomOf(saved, "s1")).toEqual({ from: 2.05, to: 3.5, words_from: 2.95, words_to: 3.5 });

    // On a machine without the words: a room stays while the clip does, and goes once it's cut otherwise.
    known = null;
    await store.update(id, "agent", (project) => {
      project.name = "Renamed";
    });
    saved = store.get(id)!.project;
    expect(roomOf(saved, "s1")).toEqual({ from: 2.05, to: 3.5, words_from: 2.95, words_to: 3.5 });
    await store.update(id, "agent", (project) => {
      const one = project.clips.find((own) => own.id === "s1")!;
      if (one.type === "audio") one.source_in = 2.6;
    });
    saved = store.get(id)!.project;
    expect(roomOf(saved, "s1")).toBeUndefined();
    expect(roomOf(saved, "s2")).toEqual({ from: 6, to: 7, words_from: 6, words_to: 7 });
  } finally {
    fixture.cleanup();
  }
});

test("a store without words (tests, tools) leaves sounds as they are", () => {
  const project = { settings: SETTINGS, media: [], clips: [] } as unknown as Project;
  expect(enforceSoundRoom(null, project, () => null)).toBe(0);
});
