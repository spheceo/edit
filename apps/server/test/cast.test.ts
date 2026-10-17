import { expect, test } from "bun:test";

import { checked, planCast, type CastPerson, type Seen } from "../src/cast.ts";
import type { Word } from "../src/transcribe.ts";

// Young Actress, shaped: two agents and the suspect over three windows; the
// bald agent is three voices, and speaker_3 is the door officer at the start
// and the bald agent at the end.
const W = [
  [0, 240],
  [240, 480],
  [480, 720],
] as const;
const seen: Seen[] = [
  { media: "m", from: 0, to: 240, letter: "A", voice: "speaker_7", name: "Travis Lawson", role: "officer", look: "bald, orange shirt", place: "right" },
  { media: "m", from: 0, to: 240, letter: "B", voice: "speaker_0", name: "Jeremy", role: "officer", look: "green polo", place: "left" },
  { media: "m", from: 0, to: 240, letter: "C", voice: "speaker_3", name: "", role: "officer", look: "deputy at the door", place: "doorway" },
  { media: "m", from: 0, to: 240, letter: "D", voice: "speaker_1", name: "Lauren", role: "suspect", look: "floral dress", place: "back wall" },
  { media: "m", from: 240, to: 480, letter: "A", voice: "speaker_0", name: "", role: "leader", look: "green shirt", place: "left" },
  { media: "m", from: 240, to: 480, letter: "B", voice: "speaker_4", name: "", role: "officer", look: "bald, orange shirt", place: "right" },
  { media: "m", from: 240, to: 480, letter: "C", voice: "speaker_6", name: "Lauren", role: "suspect", look: "floral dress", place: "back wall" },
  { media: "m", from: 480, to: 720, letter: "A", voice: "speaker_3", name: "", role: "officer", look: "bald, later black polo", place: "standing" },
  { media: "m", from: 480, to: 720, letter: "B", voice: "speaker_1", name: "Lauren", role: "suspect", look: "floral dress", place: "back wall" },
];
const people: CastPerson[] = [
  { name: null, title: "Agent", role: "officer", members: [0, 5, 7] },
  { name: null, title: "Agent", role: "leader", members: [1, 4] },
  { name: null, title: "Officer", role: "officer", members: [2] },
  { name: "Lauren", title: "Suspect", role: "suspect", members: [3, 6, 8] },
];
function said(voice: string, at: number, count: number): Word[] {
  return Array.from({ length: count }, (_, n) => ({ text: "w", start: at + n, end: at + n + 0.5, speaker: voice }));
}
const words = new Map([
  [
    "m",
    [
      ...said("speaker_7", 10, 30),
      ...said("speaker_0", 50, 70),
      ...said("speaker_3", 100, 20),
      ...said("speaker_1", 130, 40),
      ...said("speaker_0", 250, 80),
      ...said("speaker_4", 340, 20),
      ...said("speaker_6", 380, 50),
      ...said("speaker_3", 500, 90),
      ...said("speaker_1", 600, 30),
    ],
  ],
]);

test("one person, one name: split voices joined, a voice that's two people split where it's the other", () => {
  expect(checked({ people }, seen)).not.toBeNull();
  const plan = planCast(seen, people, words).get("m")!;
  const name = (voice: string) => plan.names.get(voice)?.[0];
  // The bald agent's three voices, and speaker_3 (mostly him): one name.
  expect(new Set(["speaker_7", "speaker_4", "speaker_3"].map(name))).toEqual(new Set([name("speaker_7")]));
  // The green-shirt agent says most: the plain title; the other "Agent 2".
  expect(name("speaker_0")).toBe("Agent");
  expect(name("speaker_7")).toBe("Agent 2");
  expect(new Set(["speaker_1", "speaker_6"].map(name))).toEqual(new Set(["Lauren (Suspect)"]));
  // The door officer's words at the start leave speaker_3 for a voice of his own.
  expect(plan.moves).toEqual([{ voice: "speaker_3", from: 0, to: 240, to_voice: "speaker_3.3" }]);
  expect(plan.names.get("speaker_3.3")).toEqual(["Officer", "officer"]);
  void W;
});

test("an answer that doesn't hold together is refused", () => {
  // An item twice, an item left out, two of one window as one person.
  expect(checked({ people: [...people, { name: null, title: "X", role: "other", members: [0] }] }, seen)).toBeNull();
  expect(checked({ people: people.slice(1) }, seen)).toBeNull();
  expect(
    checked(
      {
        people: [
          { name: null, title: "Agent", role: "officer", members: [0, 1, 5, 7] },
          { name: null, title: "Agent", role: "leader", members: [4] },
          ...people.slice(2),
        ],
      },
      seen,
    ),
  ).toBeNull();
  expect(checked({ nope: 1 }, seen)).toBeNull();
});
