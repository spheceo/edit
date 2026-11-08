import { expect, test } from "bun:test";

import * as fs from "node:fs";

import { casesOf, checked, itemsText, planCast, type CastPerson, type Seen } from "../src/cast.ts";
import { join } from "../src/paths.ts";
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
  // Each voice carries its person's fullest description, for the seats.
  expect(plan.looks.get("speaker_4")).toBe("bald, later black polo; standing");
  expect(plan.looks.get("speaker_3.3")).toBe("deputy at the door; doorway");
  void W;
});

test("an answer is held together: an item twice stays with its first person, one left out is its own", () => {
  const twice = checked({ people: [...people, { name: null, title: "X", role: "other", members: [0] }] }, seen)!;
  expect(twice.map((person) => person.members)).toEqual(people.map((person) => person.members));
  const short = checked({ people: people.slice(1) }, seen)!;
  // The bald agent's three items, each on its own with the window's name and role.
  expect(short.slice(3)).toEqual([
    { name: "Travis Lawson", title: "Officer", role: "officer", members: [0] },
    { name: null, title: "Officer", role: "officer", members: [5] },
    { name: null, title: "Officer", role: "officer", members: [7] },
  ]);
  expect(checked({ nope: 1 }, seen)).toBeNull();
  expect(checked({ people: [] }, seen)).toBeNull();
});

test("one person given two letters in one window (a split voice) is one person", () => {
  // Killer Couple: one window saw the bald detective as "Mike" (speaker_7) and
  // "bald detective, left of the table" (speaker_8); the cast was refused whole for it.
  const window: Seen[] = [
    { media: "m", from: 0, to: 240, letter: "A", voice: "speaker_8", name: "", role: "leader", look: "bald detective, tattoos", place: "left of the table" },
    { media: "m", from: 0, to: 240, letter: "B", voice: "speaker_9", name: "Malik Jones", role: "witness", look: "orange jumpsuit", place: "right of the table" },
    { media: "m", from: 0, to: 240, letter: "D", voice: "speaker_7", name: "Mike", role: "leader", look: "bald, beard, tattoos", place: "left side" },
    { media: "m", from: 240, to: 480, letter: "A", voice: "speaker_7", name: "Mike", role: "leader", look: "bald, black police shirt", place: "left" },
  ];
  const cast = checked(
    {
      people: [
        { name: "Mike", title: "Detective", role: "leader", members: [0, 2, 3] },
        { name: "Malik Jones", title: "Witness", role: "witness", members: [1] },
      ],
    },
    window,
  )!;
  expect(cast.map((person) => person.members)).toEqual([[0, 2, 3], [1]]);
  const plan = planCast(window, cast, new Map([["m", [...said("speaker_8", 10, 20), ...said("speaker_9", 40, 20), ...said("speaker_7", 70, 30), ...said("speaker_7", 300, 40)]]])).get("m")!;
  expect(plan.names.get("speaker_7")).toEqual(["Mike (Detective)", "leader"]);
  expect(plan.names.get("speaker_8")).toEqual(["Mike (Detective)", "leader"]);
  expect(plan.moves).toEqual([]);
});

test("a real interrogation's cast holds: the bald detective's four voices and two letters of one window are one person", () => {
  const fixture = JSON.parse(fs.readFileSync(join(import.meta.dir, "fixtures/cast-interrogation.json"), "utf8")) as { seen: Seen[]; answer: unknown };
  const cast = checked(fixture.answer, fixture.seen)!;
  expect(cast).not.toBeNull();
  // What the old check refused it for: one person, two items of one window.
  const bald = cast.find((person) => person.name === "Mark")!;
  const windows = bald.members.map((n) => fixture.seen[n]!.from);
  expect(new Set(windows).size).toBeLessThan(windows.length);
  const words = new Map([["m", fixture.seen.map((item, n) => ({ text: "w", start: item.from + 1 + n / 100, end: item.from + 2, speaker: item.voice }))]]);
  const plan = planCast(fixture.seen, cast, words).get("m")!;
  const label = plan.names.get("speaker_7")?.[0];
  expect(label?.startsWith("Mark")).toBe(true);
  for (const voice of ["speaker_8", "speaker_11", "speaker_15"]) expect(plan.names.get(voice)?.[0]).toBe(label);
});

// Police Hunt Down Their Own Colleague (JJ, Nov 8): "it makes no sense that we call this detective 'Detective 4.'
// We've not seen so many detectives in this specific case": a compilation's people are their own case's.
test("a compilation's people are their case's: never grouped across cases, numbered again in each", () => {
  const cases: Seen[] = [
    { media: "m1", from: 0, to: 240, letter: "A", voice: "speaker_0", name: "", role: "leader", look: "grey suit", place: "left", case: "Case 1" },
    { media: "m1", from: 0, to: 240, letter: "B", voice: "speaker_1", name: "", role: "leader", look: "blue shirt", place: "right", case: "Case 1" },
    { media: "m2", from: 0, to: 240, letter: "A", voice: "speaker_0", name: "", role: "leader", look: "grey suit", place: "left", case: "Case 2" },
    { media: "m2", from: 0, to: 240, letter: "B", voice: "speaker_2", name: "", role: "narrator", look: "voice-over", place: "off-screen", case: "Case 2" },
    { media: "m1", from: 0, to: 240, letter: "C", voice: "speaker_2", name: "", role: "narrator", look: "voice-over", place: "off-screen", case: "Case 1" },
  ];
  // The model put the two grey suits together, and the narrators: the detectives are split by case, the narrator stays one.
  const given = checked({ people: [
    { name: null, title: "Detective", role: "leader", members: [0, 2] },
    { name: null, title: "Detective", role: "leader", members: [1] },
    { name: null, title: "Narrator", role: "narrator", members: [3, 4] },
  ] }, cases)!;
  expect(given.map((person) => person.members)).toEqual([[0], [2], [1], [3, 4]]);
  const plans = planCast(cases, given, new Map([["m1", [...said("speaker_0", 0, 30), ...said("speaker_1", 40, 20)]], ["m2", said("speaker_0", 0, 30)]]));
  // Case 1 has two detectives; case 2's one is "Detective", not "Detective 3".
  expect(plans.get("m1")!.names.get("speaker_0")).toEqual(["Detective", "leader"]);
  expect(plans.get("m1")!.names.get("speaker_1")).toEqual(["Detective 2", "leader"]);
  expect(plans.get("m2")!.names.get("speaker_0")).toEqual(["Detective", "leader"]);
  expect(itemsText(cases.slice(0, 1))).toStartWith("0. case 1; window 0:00");
});

test("a file's case is its script blocks' Case note, only for a script of more than one case", () => {
  const block = (media: string, kase: string) => ({ kind: "footage" as const, url: "", file: "", start: 0, end: 1, label: "", media, notes: [`Case ${kase}: https://youtu.be/x`, "Source: a"] });
  expect([...casesOf({ script: { blocks: [block("m1", "1"), block("m2", "2"), block("m1", "1")] } } as never)]).toEqual([["m1", "Case 1"], ["m2", "Case 2"]]);
  expect(casesOf({ script: { blocks: [block("m1", "1"), block("m2", "1")] } } as never).size).toBe(0);
  expect(casesOf({ script: null } as never).size).toBe(0);
});
