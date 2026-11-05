// writer/spills.ts: a script's stretches checked for spilled words all at once, not one after another.

import { expect, test } from "bun:test";

import type { Script } from "@edit/types/writer";

import { scratch } from "../helpers/home.ts";

import { fix } from "../../src/writer/spills.ts";

let out = 0;
let most = 0;
/** Claude, a little slow, counting how many questions are out at once. */
async function post(): Promise<unknown> {
  most = Math.max(most, ++out);
  await Bun.sleep(150);
  out--;
  return { choices: [{ message: { content: JSON.stringify({ cuts: [] }) } }] };
}

test("a script's chosen stretches are asked about together (six at a time), each still on its own", async () => {
  const { dir, cleanup } = scratch("spills");
  try {
    // Ten stretches, each two speakers taking a turn.
    const words = Array.from({ length: 10 }, (_, stretch) =>
      ["did", "you", "see", "him", "no", "I", "didn't"].map((text, index) => ({
        id: `w${stretch}-${index}`,
        text,
        startMs: stretch * 10_000 + index * 300,
        endMs: stretch * 10_000 + index * 300 + 250,
        speaker: index < 4 ? "A" : "B",
      })),
    ).flat();
    const script = { title: "Spills", words, parts: [], speakers: { A: "Detective", B: "Suspect" } } as unknown as Script;
    const within = Array.from({ length: 10 }, (_, stretch): [number, number] => [stretch * 10_000, stretch * 10_000 + 5_000]);
    const began = Date.now();
    expect(await fix(script, dir, within, post)).toBe(0);
    expect(most).toBe(6);
    // Ten asks of 150 ms, six at a time: two rounds, not ten.
    expect(Date.now() - began).toBeLessThan(1_000);
  } finally {
    cleanup();
  }
});
