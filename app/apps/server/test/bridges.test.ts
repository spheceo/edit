import { expect, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";

import { answered, disagreements, settle, type Line, type Watched } from "../src/bridges.ts";
import { join } from "../src/paths.ts";

/** A window's lines: [start, label, person] each a second long, words numbered from `first`. */
function watched(lines: [number, string, number | null][], first = 0): Watched {
  const out: Line[] = lines.map(([start, label], n) => ({ start, end: start + 1, text: `line ${n}`, label, words: [first + n] }));
  return { lines: out, person: (n) => lines[n]?.[2] ?? null };
}

test("a voice talking across the edge that the windows give to two people is a disagreement, followed while it goes on", () => {
  // Earlier: the suspect answers (2), then the detective (voice 0) talks to the edge at 100, as person 0.
  const earlier = watched([
    [20, "speaker_3", 2],
    [40, "speaker_0", 0],
    [70, "speaker_0", 0],
    [77, "speaker_0", 0],
    [83, "speaker_0", 0],
    [85, "speaker_3", 2],
    [89, "speaker_0", 0],
    [95, "speaker_0", 0],
  ]);
  // Later: the same voice goes on, as person 1, then stops for a while.
  const later = watched([
    [101, "speaker_3", 2],
    [102, "speaker_0", 1],
    [108, "speaker_0", 1],
    [140, "speaker_0", 1],
  ]);
  // Followed back to 70 (40 is 29 s before it), forward to 109 (140 is 31 s on).
  expect(disagreements(100, earlier, later)).toEqual([{ edge: 100, voice: "speaker_0", before: 0, after: 1, from: 70, to: 109 }]);
});

test("no disagreement when both windows give the turn to one person, or nobody talks near the edge", () => {
  const earlier = watched([[97, "speaker_0", 0]]);
  expect(disagreements(100, earlier, watched([[102, "speaker_0", 0]]))).toEqual([]);
  expect(disagreements(100, watched([[60, "speaker_0", 0]]), watched([[102, "speaker_0", 1]]))).toEqual([]);
  // A guess (no person) says nothing.
  expect(disagreements(100, earlier, watched([[102, "speaker_0", null]]))).toEqual([]);
});

test("the second look moves only the disputed voice's lines, to one of the two people, and is kept", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "edit-bridges-"));
  try {
    const lines: Line[] = [
      { start: 90, end: 91, text: "So", label: "speaker_0", words: [5] },
      { start: 92, end: 93, text: "Okay.", label: "speaker_3", words: [6] },
      { start: 97, end: 98, text: "you went there.", label: "speaker_0", words: [7] },
      { start: 102, end: 103, text: "And then", label: "speaker_0", words: [8] },
    ];
    let posts = 0;
    const asker = {
      cut: async (_start: number, _end: number, out: string) => fs.writeFileSync(out, "x"),
      post: async () => {
        posts += 1;
        // 1 is Joe, 2 is Mark, 3 the suspect: the suspect's line stays, a "0" moves nothing.
        return { choices: [{ message: { content: JSON.stringify({ lines: [{ n: 0, who: 2 }, { n: 1, who: 3 }, { n: 2, who: 2 }, { n: 3, who: 0 }] }) } }] };
      },
      unfence: (text: string) => text,
      model: "test",
    };
    const disputed = { edge: 100, voice: "speaker_0", before: 0, after: 1, from: 90, to: 103 };
    const candidates = [
      { person: 0, label: "Joe (Detective)", look: "grey polo, back to the camera" },
      { person: 1, label: "Mark (Detective)", look: "bald, left of the table" },
      { person: 2, label: "Darius Cole (Suspect)", look: "dreadlocks" },
    ];
    const first = await settle(disputed, lines, candidates, dir, asker);
    expect(first).toEqual({ moves: [[[5], 1], [[7], 1]], cost: 0, cached: false });
    const again = await settle(disputed, lines, candidates, dir, asker);
    expect(again).toEqual({ moves: [[[5], 1], [[7], 1]], cost: 0, cached: true });
    expect(posts).toBe(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an answer that leaves most lines out, or names someone not listed, isn't used", () => {
  expect(answered({ lines: [{ n: 0, who: 1 }] }, 4, 2)).toBeNull();
  expect(answered({ lines: [{ n: 0, who: 1 }, { n: 1, who: 9 }] }, 2, 2)).toBeNull();
  expect(answered({ lines: [{ n: 0, who: 1 }, { n: 1, who: 0 }] }, 2, 2)).toEqual(new Map([[0, 1], [1, 0]]));
});
