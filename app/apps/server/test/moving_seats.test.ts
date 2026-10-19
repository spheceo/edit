// moving_seats.ts: faces on a moving camera, named in stills and followed between them.

import { expect, test } from "bun:test";

import type { Face, Faces } from "../src/faces.ts";
import { boxOf, followed, MovingSeats, stillTimes } from "../src/moving_seats.ts";
import { questioning } from "../src/subtitles_tools.ts";
import type { Transcript } from "../src/transcribe.ts";

const said = (speaker: string, from: number, count: number) =>
  Array.from({ length: count }, (_, n) => ({ text: "word", start: from + n, end: from + n + 0.5, speaker }));

test("stills every few seconds where a named person is talking, inside the stretches only", () => {
  const transcript: Transcript = {
    model: "scribe_v2",
    words: [...said("speaker_0", 0, 30), ...said("unknown", 40, 10), ...said("speaker_1", 100, 20)],
    speakers: { speaker_0: "Perez (Suspect)", speaker_1: "Officer" },
  };
  expect(stillTimes(transcript, [[10, 60], [100, 112]])).toEqual([10.25, 17.25, 24.25, 100.25, 107.25]);
});

test("a face named in a still is followed by the detector's faces to the next still, and found where a line starts", () => {
  // Perez's face drifts right a little each half second (the camera moves); another face sits still on the left.
  const found: Faces = new Map();
  for (let index = 0; index <= 40; index++) {
    const x = 0.5 + index * 0.004;
    found.set(index, [[x, 0.3, x + 0.1, 0.45] as Face, [0.05, 0.3, 0.15, 0.45] as Face]);
  }
  // The model's box at 5 s is loose but over Perez, not the other face.
  const tracks = followed([[5, "Perez (Suspect)", [0.52, 0.28, 0.66, 0.47]]], found);
  const seats = new MovingSeats(tracks, "k");
  expect(seats.seen()).toBe(1);
  const at = seats.dot("Perez (Suspect)", 12)!;
  // Sample 24: x 0.596–0.696, so the centre is at 64.6% across.
  expect(Math.round(at.x * 10) / 10).toBe(64.6);
  expect(Math.round(at.h)).toBe(15);
  // Beyond its reach (8 s from the still) and for someone never named: nothing.
  expect(seats.dot("Perez (Suspect)", 19)).toBeNull();
  expect(seats.dot("Officer", 5)).toBeNull();
  expect(MovingSeats.parse(seats.toJson())!.dot("Perez (Suspect)", 12)).toEqual(at);
});

test("the model's boxes and the tool's stretches are read strictly", () => {
  expect(boxOf([280, 520, 470, 660])).toEqual([0.52, 0.28, 0.66, 0.47]);
  expect(boxOf([])).toBeNull();
  expect(boxOf([500, 500, 400, 600])).toBeNull();
  // Backwards and past the end are dropped; the rest sorted, in frames.
  expect(questioning([[60, 30.5], [30, 40], [10, 20], [900, 1000]], 24, 0, 24 * 600)).toEqual([[240, 480], [720, 960]]);
  expect(() => questioning([[1]], 24, 0, 100)).toThrow("interrogation: each stretch is [start, end] in seconds");
});
