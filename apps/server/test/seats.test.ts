// seats.ts's tests (the scene finder is the addon's, so its test runs only
// against the real one).

import { expect, test } from "bun:test";

import * as fs from "node:fs";

import { findAddon, native, useNative } from "../src/native/index.ts";
import { join } from "../src/paths.ts";
import { faces, FILE, names, Seats, seats, sightings, windows, type Dot, type Sighting } from "../src/seats.ts";
import type { Transcript } from "../src/transcribe.ts";
import { fixtureHome, write } from "./helpers/home.ts";

const WIDE = 64;
const HIGH = 36;

test("faces_are_each_angles_medians_in_any_order", () => {
  const seen = (name: string, x: number): Sighting => [name, [x, 40.0, 20.0]];
  const looks: [number, Sighting[]][] = [
    [1, [seen("Officer", 70.0)]],
    [0, [seen("Officer", 30.0), seen("Suspect", 60.0)]],
    [1, [seen("Officer", 72.0)]],
    [0, [seen("Officer", 34.0)]],
    [1, [seen("Officer", 90.0)]],
  ];
  const reversed = [...looks].reverse();
  const found = faces(3, looks);
  expect(found).toEqual(faces(3, reversed));
  expect(found.length).toBe(3);
  const officer = (angle: number) => found[angle]?.get("Officer");
  expect(officer(0)?.x).toBe(34.0);
  expect(officer(1)).toEqual({ x: 72.0, y: 40.0, h: 20.0 } satisfies Dot);
  expect(found[2]?.size).toBe(0);
});

// The scene finder is native (`seatsScenes`); the stub doesn't have it.
test.skipIf(findAddon() === null)("a_room_seen_again_is_the_same_angle_however_short", async () => {
  useNative(null);
  const frame = (shade: number, stripe: boolean) =>
    Array.from({ length: WIDE * HIGH }, (_, index) => (stripe && index % WIDE < WIDE / 2 ? Math.min(shade + 120, 255) : shade));
  const frames: number[] = [];
  // 25 s of the room, 5 s of a photo (a cutaway), 5 s of the room again.
  for (let i = 0; i < 50; i++) frames.push(...frame(40, true));
  for (let i = 0; i < 10; i++) frames.push(...frame(200, false));
  for (let i = 0; i < 10; i++) frames.push(...frame(40, true));
  const { scenes, angles } = await native().seatsScenes(Buffer.from(frames));
  expect(angles).toBe(1);
  expect(scenes.map((scene) => scene[2])).toEqual([0, null, 0]);
});

// The TS side's own.

function transcript(): Transcript {
  const words = [];
  // Two voices through the first 200 s, one after that.
  for (let at = 0; at < 300; at += 2) {
    words.push({ text: "word", start: at, end: at + 1, speaker: at < 200 ? `speaker_${(at / 2) % 2}` : "speaker_0" });
  }
  return { model: "scribe_v2", language: null, words, speakers: { speaker_0: "Officer", speaker_1: "Suspect" } };
}

test("each angle is watched where the most people say the most, twice at most", () => {
  const scenes: [number, number, number | null][] = [
    [0, 250, 0],
    [250, 260, null],
    [260, Number.POSITIVE_INFINITY, 1],
  ];
  const chosen = windows(scenes, 0, transcript());
  expect(chosen.length).toBe(2);
  // Both stretches inside the two-voice part, not overlapping.
  for (const [, end] of chosen) expect(end).toBeLessThanOrEqual(250);
  expect(chosen[0]![1] <= chosen[1]![0] || chosen[1]![1] <= chosen[0]![0]).toBe(true);
  // The last angle runs to the last word, not forever.
  const last = windows(scenes, 1, transcript());
  expect(last.every(([, end]) => Number.isFinite(end) && end <= 299)).toBe(true);
  expect(names(transcript())).toEqual(["Officer", "Suspect"]);
});

test("the model's boxes become centres and heights in %; empty boxes are nobody", () => {
  expect(
    sightings({
      people: [
        { name: "Officer", face: [100, 200, 300, 400] },
        { name: "Suspect", face: [] },
        { name: "Nobody", face: [500, 500, 400, 600] },
      ],
    }),
  ).toEqual([["Officer", [30, 20, 20]]]);
  expect(sightings("nonsense")).toEqual([]);
});

test("the cache is read back, its endless last scene included", async () => {
  const { cleanup, dir } = fixtureHome("seats-cache");
  try {
    const source = `${dir}/interview.mp4`;
    const cache = native().mediaCache(source)!;
    const saved = new Seats(
      [
        [0, 40, 0],
        [40, Number.POSITIVE_INFINITY, null],
      ],
      [new Map([["Officer", { x: 30, y: 40, h: 20 }]])],
      ["Officer", "Suspect"],
    );
    // As serde_json wrote it: the infinite end as null.
    expect(saved.toJson()).toBe(
      '{"scenes":[[0,40,0],[40,null,null]],"angles":[{"Officer":{"x":30,"y":40,"h":20}}],"names":["Officer","Suspect"]}',
    );
    write(join(cache, FILE), saved.toJson());
    const found = await seats(source, transcript());
    expect(found.dot("Officer", 10)).toEqual({ x: 30, y: 40, h: 20 });
    expect(found.dot("Officer", 50)).toBeNull();
    expect(found.dot("Suspect", 10)).toBeNull();
    expect(found.scenes[1]![1]).toBe(Number.POSITIVE_INFINITY);
    expect(fs.existsSync(join(cache, FILE))).toBe(true);
  } finally {
    cleanup();
  }
});
