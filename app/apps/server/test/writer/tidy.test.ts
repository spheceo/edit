import { expect, test } from "bun:test";

import type { Clip, Script, Word } from "@edit/types/writer";

import { lineCount, pageCount, textWidth } from "../../src/writer/pages.ts";
import { beatForFloor, boundaryIssues, joinSlivers, PAUSE_BEAT_MS, polish, tighten } from "../../src/writer/tidy.ts";

const clip = (id: string, startMs: number, endMs: number): Clip => ({ id, startMs, endMs });

const words = (said: [string, string, number, number][]): Word[] =>
  said.map(([text, speaker, startMs, endMs], i) => ({ id: `w${i}`, text, startMs, endMs, speaker }));

test("a sliver left by a cut pause joins its neighbour", () => {
  const card: Clip = { ...clip("", 0, 3_000), kind: "cut-in" };
  const joined = joinSlivers([clip("", 856_400, 856_900), clip("", 857_800, 860_500), card, clip("", 900_000, 900_800), clip("", 950_000, 955_000)], []);
  expect(joined.map((one) => [one.startMs, one.endMs])).toEqual([
    [856_400, 860_500],
    [0, 3_000],
    [900_000, 900_800],
    [950_000, 955_000],
  ]);
});

test("fixes an edge that runs on into fillers", () => {
  const said = words([["No.", "a", 0, 400], ["Yeah,", "a", 500, 800], ["so", "a", 900, 1_100], ["Next.", "b", 3_000, 3_400]]);
  const issues = boundaryIssues([clip("c", 0, 1_200)], said);
  expect(issues).toHaveLength(1);
  expect(issues[0]!.end).toBe(true);
  expect(issues[0]!.issue).toContain("runs on past");
  const [fixed, count] = polish([clip("c", 0, 1_200)], said, {}, 10_000);
  expect(count).toBe(1);
  // Back to "No." with room that stops short of "Yeah,".
  expect([fixed[0]!.startMs, fixed[0]!.endMs]).toEqual([0, 440]);
});

test("fixes that cross leave a short clip as it was", () => {
  const said = words([["Okay.", "a", 0, 300], ["John,", "a", 400, 700], ["so", "a", 800, 1_000], ["Next.", "b", 3_000, 3_300]]);
  const [fixed] = polish([clip("c", 0, 1_100)], said, {}, 10_000);
  expect(fixed[0]!.endMs).toBeGreaterThan(fixed[0]!.startMs);
});

test("finishes a sentence cut short", () => {
  const said = words([["Do", "a", 0, 200], ["you", "a", 250, 400], ["feel", "a", 450, 600], ["remorse?", "a", 650, 1_000], ["No.", "b", 2_000, 2_300]]);
  const [fixed, count] = polish([clip("c", 0, 520)], said, {}, 10_000);
  expect(count).toBe(1);
  expect(fixed[0]!.endMs).toBe(1_400);
});

test("tightens only quiet gaps", () => {
  const said = words([["Hi.", "a", 0, 500], ["There.", "a", 5_500, 6_000], ["Again.", "a", 11_000, 11_500]]);
  // Loud sound in the second gap (untranscribed speech), silence in the first.
  const peaks = new Array<number>(600).fill(0.5);
  for (let i = 30; i < 270; i++) peaks[i] = 0;
  const done = tighten({ words: said, peaks, parts: [], durationMs: 12_000, compilation: false, relaxed: false }, [clip("c", 0, 12_000)], PAUSE_BEAT_MS, () => false);
  expect(done.pauses).toBe(1);
  expect(done.clips.reduce((sum, one) => sum + one.endMs - one.startMs, 0)).toBe(12_000 - 4_000);
});

test("finds the shortest beat that keeps the floor", () => {
  const beat = beatForFloor((value) => 9_000 + value, 1_000, 10_000, 50_000);
  expect(beat).not.toBeNull();
  expect(beat!).toBeGreaterThanOrEqual(1_000);
  expect(beat!).toBeLessThanOrEqual(1_100);
  expect(beatForFloor(() => 5_000, 1_000, 10_000, 50_000)).toBeNull();
});

test("measures Arial and wraps lines", () => {
  // As Repack's textWidth measures them, kerning included.
  expect(Math.abs(textWidth("Hello", 16, false) - 36.448)).toBeLessThan(0.001);
  expect(Math.abs(textWidth("INTERRO The Case", (19 * 96) / 72, true) - 233.674_666)).toBeLessThan(0.001);
  expect(lineCount("short", 16, false)).toBe(1);
  expect(lineCount("word ".repeat(200), 16, false)).toBe(13);
});

test("a long script runs onto more pages", () => {
  const script = { id: "a1", title: "Case", sourceKind: "file", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 10_000, words: [], clips: [], overview: [], revision: 1, createdAt: 0, updatedAt: 0, proxyPath: null } as Script;
  const block = (n: number): Clip[] => [clip(`c${n}`, 0, 5_000), { ...clip(`n${n}`, 0, 3_000), kind: "cut-in", narration: "A sentence of narration. ".repeat(12) }];
  const short = [0, 1].flatMap(block);
  expect(pageCount(script, short)).toBe(1);
  expect(pageCount(script, Array.from({ length: 40 }, (_, n) => block(n)).flat())).toBeGreaterThan(5);
});
