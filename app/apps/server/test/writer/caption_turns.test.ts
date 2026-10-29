import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Script, Word } from "@edit/types/writer";

import { answerFile, find, lines, respell, runWith, sameInput, windows, type Ask } from "../../src/writer/caption_turns.ts";
import { parse } from "../../src/writer/captions.ts";

const word = (text: string, startMs: number, speaker: string): Word => ({ id: "", text, startMs, endMs: startMs + 200, speaker });
const base = (): Script => ({ id: "a1", title: "Case", sourceKind: "youtube", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 10_000, revision: 1, createdAt: 0, updatedAt: 0, words: [], clips: [], overview: [], proxyPath: null });

test("manual caption speakers apply, and a retry reads its saved answers without changing edits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writer-caption-speakers-"));
  const transcript = parse({ events: [
    { tStartMs: 500, dDurationMs: 500, segs: [{ utf8: ">> Where?" }] },
    { tStartMs: 1500, dDurationMs: 500, segs: [{ utf8: ">> Here." }] },
  ] });
  const script: Script = {
    ...base(), id: "abc", title: "Interview", sourceUrl: "https://youtu.be/aaaaaaaaaaa", durationMs: 3000, revision: 2,
    corrections: { "keep-0": "Where exactly?" },
    clips: [{ id: "keep-cut", startMs: 500, endMs: 2000 }, { id: "keep-narration", kind: "cut-in", startMs: 0, endMs: 3000, narration: "Keep this narration." }],
  };
  script.words = transcript.words.map((one, index) => ({ id: `keep-${index}`, text: one.text, startMs: Math.trunc(one.start * 1000), endMs: Math.trunc(one.end * 1000), speaker: one.speaker! }));
  const before = structuredClone(script);
  const answers: Ask = async (kept, schema, prompt) => {
    const answer = (schema.properties as Record<string, unknown>).people
      ? { people: [{ id: "p1", name: null, role: "Officer", how: "asks questions" }, { id: "p2", name: null, role: "Witness", how: "answers" }], suspects: [] }
      : { lines: [{ n: 0, person: "p1" }, { n: 1, person: "p2" }], splits: [], newPeople: [], spellings: [] };
    fs.writeFileSync(answerFile(kept, schema, prompt), JSON.stringify(answer));
    return [answer, false];
  };
  const report = await runWith(script, dir, [], "", () => {}, answers);
  expect([report.people, report.failed]).toEqual([2, 0]);
  expect(script.speakers).toEqual({ p1: "Officer", p2: "Witness" });
  expect(script.words.map((one) => one.speaker)).toEqual(["p1", "p2"]);
  // Again from the kept answers, asking nothing.
  const kept: Ask = async (dirKept, schema, prompt) => [JSON.parse(fs.readFileSync(answerFile(dirKept, schema, prompt), "utf8")), true];
  const retry = await runWith(script, dir, [], "", () => {}, kept);
  expect([retry.cached, retry.failed]).toEqual([2, 0]);
  expect(script.clips).toEqual(before.clips);
  expect(script.corrections).toEqual(before.corrections);
  expect(script.revision).toBe(before.revision);
  expect(script.words.map((one) => one.id)).toEqual(["keep-0", "keep-1"]);
  fs.rmSync(dir, { recursive: true });
});

test("raw turns aren't reused for different words with the same count", () => {
  const one: Word = { id: "original", text: "Hello", startMs: 500, endMs: 800 };
  expect(sameInput([one], [{ ...one, id: "recovered" }])).toBe(false);
  expect(sameInput([one], [{ ...one, speaker: "p1", text: "Corrected" }])).toBe(true);
});

test("lines break at turns, pauses and length", () => {
  const script = base();
  script.words = [word("Objection.", 0, "t1"), word("Sustained.", 300, "t2"), word("Move", 600, "t2"), word("on.", 3_000, "t2")];
  expect(lines(script).map((line) => [line.first, line.last, line.mark])).toEqual([[0, 0, true], [1, 2, true], [3, 3, false]]);
});

test("windows overlap within a recording", () => {
  const given = Array.from({ length: 250 }, (_, n) => ({ group: n >= 200 ? 1 : 0, first: n, last: n, mark: true }));
  expect(windows(given)).toEqual([[0, 120], [114, 200], [200, 250]]);
});

test("a split is found by its first words", () => {
  const words = "Yes I did. No further questions your honor".split(" ").map((text, i) => word(text, i * 100, "t1"));
  expect(find(words, "no further questions")).toBe(3);
  expect(find(words, "Yes I did.")).toBeNull();
  const misheard = word("Jaden,", 0, "t1");
  respell(misheard, new Map([["jaden", "Jadon"]]));
  expect(misheard.text).toBe("Jadon,");
});
