import { expect, test } from "bun:test";

import type { Clip, Script, Word } from "@edit/types/writer";

import { WHOLE_UP_TO } from "../../src/transcribe.ts";
import { pieces, planOf, retime, silent, stretches } from "../../src/writer/exact.ts";
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

test("long stretches are heard in single requests", () => {
  const cut = pieces(200);
  expect(cut).toHaveLength(3);
  expect(cut.every((piece) => piece.to - piece.from < WHOLE_UP_TO)).toBe(true);
});
