import { expect, test } from "bun:test";

import { picks } from "../src/frame_picks.ts";

const SIZE = 64 * 36;
/** A frame: a bright block at column `at` (a different picture per place), plus a little noise. */
function frame(at: number, seed: number): Uint8Array {
  const out = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    const x = i % 64;
    out[i] = (x >= at && x < at + 16 ? 220 : 30) + ((i * 7 + seed * 13) % 5);
  }
  return out;
}
const of = (frames: Uint8Array[]) => {
  const all = new Uint8Array(frames.length * SIZE);
  frames.forEach((one, index) => all.set(one, index * SIZE));
  return all;
};

test("a frame each time the picture settles, transitions waited out, glimpses skipped", () => {
  const frames = [
    ...Array.from({ length: 6 }, (_, i) => frame(0, i)), // 3 s of one shot
    frame(10, 0), // half a second of a whip between
    ...Array.from({ length: 8 }, (_, i) => frame(24, i)), // 4 s of the next
    frame(48, 1), // a glimpse
    ...Array.from({ length: 4 }, (_, i) => frame(0, i + 9)), // back to the first for 2 s
  ];
  const got = picks(of(frames), 100, 24);
  expect(got.map((one) => [one.from, one.to])).toEqual([
    [100, 103],
    [103.5, 107.5],
    [108, 110],
  ]);
  for (const one of got) expect(one.time >= one.from && one.time < one.to).toBe(true);
  // Capped: the state least unlike the one before goes, its time to it.
  expect(picks(of(frames), 0, 2)).toHaveLength(2);
  // A fixed camera: one.
  expect(picks(of(Array.from({ length: 40 }, (_, i) => frame(0, i))), 0, 12)).toHaveLength(1);
  expect(picks(new Uint8Array(0), 0, 12)).toEqual([]);
});
