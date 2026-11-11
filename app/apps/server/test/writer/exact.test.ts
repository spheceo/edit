import { expect, test } from "bun:test";

import type { Clip, Script, Word } from "@edit/types/writer";

import { planOf, remapFrom, replan, retime, silent, split, stretches, withInserts, type Insert } from "../../src/writer/exact.ts";
import { wordAt } from "../../src/writer/plan.ts";
import type { Heard } from "../../src/writer/hearing.ts";

const word = (text: string, startMs: number): Word => ({ id: "", text, startMs, endMs: startMs + 200, speaker: "t1" });
const heard = (text: string, start: number, speaker: string): Heard => ({ text, start, end: start + 300, speaker });
const clip = (startMs: number, endMs: number): Clip => ({ id: "", startMs, endMs });
const base = (): Script => ({ id: "a1", title: "Case", sourceKind: "youtube", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 100_000, words: [], clips: [], overview: [], revision: 1, createdAt: 0, updatedAt: 0, proxyPath: null });

test("heard words take their times, spelling and voices", () => {
  // The captions put "investigating officer" 3 s early and misheard "Devine".
  const words = [word("the", 1_000), word("investigating", 1_200), word("officer", 1_900), word("mr", 2_400), word("divine", 2_600), word("lied", 2_900)];
  const said = [heard("The", 4_000, "a"), heard("investigating", 4_200, "a"), heard("officer", 4_900, "a"), heard("Mr.", 5_400, "b"), heard("Devine", 5_600, "b"), heard("lied.", 6_000, "b")];
  const voices: (string | null)[] = words.map(() => null);
  expect(retime(words, 0, 10_000, said, voices)).toEqual([6, 1]);
  expect(words[1]!.startMs).toBe(4_200);
  expect(words[4]!.text).toBe("Devine");
  expect(words[5]!.text).toBe("lied.");
  expect(voices[3]).toBe("b");
});

test("a word only the captions have sits between its neighbours", () => {
  const words = [word("and", 0), word("um", 500), word("then", 1_000)];
  retime(words, 0, 5_000, [heard("And", 2_000, "a"), heard("then", 3_000, "a")], [null, null, null]);
  expect(words[1]!.startMs).toBe(2_500);
  expect(words[0]!.endMs).toBeLessThanOrEqual(words[1]!.startMs);
  expect(words[1]!.endMs).toBeLessThanOrEqual(words[2]!.startMs);
});

test("stretches pad, join and skip what was heard", () => {
  const script = base();
  const clips = [clip(10_000, 12_000), clip(16_000, 20_000), clip(60_000, 61_000)];
  expect(stretches(script, clips)).toEqual([[7_000, 23_000], [57_000, 64_000]]);
  script.exact = [[7_000, 23_000]];
  expect(stretches(script, clips)).toEqual([[57_000, 64_000]]);
});

// JJ's Mac, Nov 5: "Remove the last intro clip" brought the footage back to hear it. A revision that only takes clips out has nothing left to hear, so its footage isn't needed.
test("a heard timeline with a clip taken out has nothing to hear", () => {
  const script = base();
  const clips = [clip(10_000, 12_000), clip(16_000, 20_000), clip(60_000, 61_000)];
  script.exact = stretches(script, clips);
  expect(stretches(script, clips.slice(0, 2))).toEqual([]);
  expect(stretches(script, [clips[0]!, clips[2]!])).toEqual([]);
});

test("a clip with no sound is found", () => {
  const peaks = new Array<number>(500).fill(0.5);
  for (let i = 100; i < 150; i++) peaks[i] = 0.01;
  expect(silent([clip(2_100, 2_900), clip(3_000, 4_000)], peaks)).toEqual([0]);
});

test("a built cut reads back as its plan", () => {
  const script = base();
  script.words = Array.from({ length: 6 }, (_, n) => ({ ...word("word", n * 1_000), id: `w${n}` }));
  const card = (text: string): Clip => ({ ...clip(0, 3_000), kind: "cut-in", narration: text });
  // A run the tightening cut in two, a card, then a clip further on.
  script.clips = [clip(0, 1_250), clip(1_900, 2_300), card("Intro."), clip(4_000, 5_300), card("Outro.")];
  const items = planOf(script).items!;
  expect(items).toHaveLength(4);
  expect([items[0]!.firstWordId, items[0]!.lastWordId]).toEqual(["w0", "w2"]);
  expect(items[1]!.narration).toBe("Intro.");
  expect([items[2]!.firstWordId, items[2]!.lastWordId]).toEqual(["w4", "w5"]);
});

test("the stretches heard as one recording, a second of quiet between them, go back onto the footage", () => {
  // Two stretches, 2.5 s and 4 s long as cut: the second starts at 3.5 s in the joined recording.
  const spans: [number, number][] = [[10_000, 12_500], [40_000, 44_000]];
  const words = [
    { text: "first", start: 0.2, end: 0.6, speaker: "speaker_0" },
    { text: "edge", start: 2.3, end: 2.7, speaker: "speaker_0" },
    { text: "second", start: 3.6, end: 4.0, speaker: "speaker_1" },
    { text: "last", start: 7.2, end: 7.6, speaker: "speaker_0" },
  ];
  const out = split(words, spans, [2.5, 4]);
  expect(out[0]!.map((one) => [one.text, Math.round(one.start), Math.round(one.end), one.speaker])).toEqual([
    ["first", 10_200, 10_600, "speaker_0"],
    ["edge", 12_300, 12_500, "speaker_0"],
  ]);
  expect(out[1]!.map((one) => [one.text, Math.round(one.start), Math.round(one.end), one.speaker])).toEqual([
    ["second", 40_100, 40_500, "speaker_1"],
    ["last", 43_700, 44_000, "speaker_0"],
  ]);
});

/** Rough words that dropped a line's first word, and what Scribe heard: "Okay." then "We were out there last night." */
function droppedWe(): { before: Word[]; after: Word[] } {
  const mk = (index: number, text: string, startMs: number, endMs: number): Word => ({ id: `w${String(index).padStart(5, "0")}`, text, startMs, endMs, speaker: "t1" });
  // Apple heard "We were" as "Were"; an "um" it dropped earlier puts a second added word before the line.
  const rough = [mk(0, "So", 500, 700), mk(1, "yeah.", 1_000, 1_300), mk(2, "Okay.", 9_000, 9_400), mk(3, "Were", 10_300, 10_600), mk(4, "out", 10_600, 10_800), mk(5, "there", 10_800, 11_000), mk(6, "last", 11_000, 11_300), mk(7, "night.", 11_300, 11_700), mk(8, "And", 13_000, 13_200)];
  const scribe: Heard[] = [["So", 500, 700], ["um,", 750, 950], ["yeah.", 1_000, 1_300], ["Okay.", 9_000, 9_400], ["We", 10_150, 10_290], ["were", 10_300, 10_500], ["out", 10_550, 10_750], ["there", 10_780, 11_000], ["last", 11_020, 11_300], ["night.", 11_320, 11_700], ["And", 13_000, 13_200]].map(([text, start, end]) => ({ text: text as string, start: start as number, end: end as number, speaker: "a" }));
  const before = structuredClone(rough);
  const voices: (string | null)[] = rough.map(() => null);
  const inserts: Insert[] = [];
  retime(rough, 0, 20_000, scribe, voices, inserts);
  const [after] = withInserts(rough, voices, inserts);
  return { before, after };
}

test("a plan read back before the hearing names the same words after it, its clip grown over the line's first word only Scribe heard", () => {
  const { before, after } = droppedWe();
  expect(after.map((one) => one.text).join(" ")).toBe("So um, yeah. Okay. We were out there last night. And");
  // The plan as read back before the hearing: "Were" to "night." (w3..w7, places in the rough words).
  const plan = { items: [{ kind: "clip", firstWordId: "w3", lastWordId: "w7" }], report: "" };
  const [item] = replan(plan, before, after).items!;
  // Without the mapping, w3 would now be "Okay." (an added "um," sits before it); with it, the line starts on "We".
  expect(after[wordAt(after, item!.firstWordId)!]!.text).toBe("We");
  expect(after[wordAt(after, item!.lastWordId)!]!.text).toBe("night.");
});

test("a clip moved onto the exact times takes in the line's first word only Scribe heard, never a filler or the sentence before", () => {
  const { before, after } = droppedWe();
  const [moved] = remapFrom(before, [{ id: "c", startMs: 10_250, endMs: 12_100 }], after, 20_000);
  expect(moved!.startMs).toBeLessThanOrEqual(10_150);
  expect(moved!.startMs).toBeGreaterThan(9_400);
  // "um," is added too, but a filler before a finished "yeah." isn't a clip's: a clip on "yeah." stays on it.
  const [kept] = remapFrom(before, [{ id: "d", startMs: 950, endMs: 1_500 }], after, 20_000);
  expect(kept!.startMs).toBeGreaterThan(950 - 200);
});

test("a built cut reads back with places in the words, not stored ids", () => {
  const script = base();
  script.words = [{ ...word("Okay.", 0), id: "w00000" }, { ...word("We", 1_000), id: "w-added" }, { ...word("were", 1_300), id: "w00001" }, { ...word("there.", 1_600), id: "w00002" }];
  script.clips = [clip(900, 1_900), { ...clip(0, 3_000), kind: "cut-in", narration: "Outro." }];
  const [item] = planOf(script).items!;
  expect([item!.firstWordId, item!.lastWordId]).toEqual(["w1", "w3"]);
});
