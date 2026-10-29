import { expect, test } from "bun:test";

import type { Script } from "@edit/types/writer";

import { formatOf } from "../../src/writer/formats.ts";
import { apply, current, editNote, settle } from "../../src/writer/revise.ts";

function script(): Script {
  const said = ["Hi,", "I'm", "Detective", "Smith.", "Where", "were", "you?", "Home.", "All", "night."];
  return {
    id: "a1", title: "Case", sourceKind: "file", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 10_000, revision: 3, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null,
    words: said.map((text, index) => ({ id: `w${index}`, text, startMs: index * 1_000, endMs: index * 1_000 + 500, speaker: index < 7 ? "a" : "b" })),
    clips: [
      { id: "c1", startMs: 0, endMs: 3_900 },
      { id: "n1", startMs: 0, endMs: 3_000, kind: "cut-in", narration: "He said he was home." },
      { id: "c2", startMs: 3_850, endMs: 9_900 },
      { id: "n2", startMs: 0, endMs: 3_000, kind: "cut-in", narration: "" },
    ],
  };
}

test("applies edits in order and names new items", () => {
  const [clips, , proposals] = apply(script(), [
    { op: "split", id: "i3", wordId: "w7" },
    { op: "insert_cut_in", afterId: "i3", narration: "Then he changed his story." },
    { op: "move", ids: ["n2"], beforeId: "i1" },
    { op: "trim", id: "n1", edge: "out", wordId: "w8" },
  ], [], false);
  expect(clips.map((clip) => (clip.kind === "cut-in" ? "cut" : "clip"))).toEqual(["cut", "clip", "cut", "clip", "clip", "cut"]);
  expect(clips[0]!.narration).toBe("Then he changed his story.");
  // The second half of the split, trimmed to end after "All".
  expect([clips[4]!.startMs, clips[4]!.endMs]).toEqual([7_000, 8_900]);
  expect(proposals).toEqual([]);
});

test("a review fix writes saved narration straight in", () => {
  const [clips, , proposals] = apply(script(), [{ op: "write", id: "i2", narration: "He swore he was home." }], [], true);
  expect(clips[1]!.narration).toBe("He swore he was home.");
  expect(proposals).toEqual([]);
});

test("adds an edit note to a footage clip only", () => {
  const [clips] = apply(script(), [{ op: "note", id: "i1", text: "a blue waveform for this call" }], [], false);
  expect(clips[0]!.notes?.at(-1)?.text).toBe("edit: a blue waveform for this call");
  expect(() => apply(script(), [{ op: "note", id: "i2", text: "edit: zoom" }], [], false)).toThrow("footage clip");
  expect(editNote("Edit:  zoom in slowly ")).toBe("edit: zoom in slowly");
});

test("writes an empty cut-in and proposes a change to a saved one", () => {
  const [clips, , proposals] = apply(script(), [{ op: "write", id: "i2", narration: "He swore he was home." }, { op: "write", id: "i4", narration: "He was not." }], [], false);
  expect(clips[1]!.narration).toBe("He said he was home.");
  expect(clips[3]!.narration).toBe("He was not.");
  expect(proposals).toHaveLength(1);
  expect([proposals[0]!.before, proposals[0]!.after]).toEqual(["He said he was home.", "He swore he was home."]);
  // Accepting it (the paragraph now reads as proposed) settles it.
  const accepted = structuredClone(clips);
  accepted[1]!.narration = "He swore he was home.";
  expect(settle(accepted, proposals)).toEqual([]);
});

test("refuses a bad edit and keeps nothing", () => {
  expect(() => apply(script(), [{ op: "delete", ids: ["i1"] }, { op: "trim", id: "i9", edge: "in", wordId: "w1" }], [], false)).toThrow(/^Edit 2 \(trim\): There is no item i9/);
  expect(() => apply(script(), [{ op: "write", id: "i4", narration: "A dash — here." }], [], false)).toThrow("em dash");
});

test("removes words from every clip and fixes spelling", () => {
  const [clips, corrections] = apply(script(), [{ op: "remove_words", firstWordId: "w4", lastWordId: "w6" }, { op: "correct_word", wordId: "w3", text: "Smyth." }], [], false);
  expect(clips.filter((clip) => clip.kind !== "cut-in").every((clip) => clip.endMs <= 4_000 || clip.startMs >= 6_500)).toBe(true);
  expect(corrections.w3).toBe("Smyth.");
});

test("lists the script for Claude", () => {
  const text = current(script(), formatOf("interrogation", false, "Case"));
  expect(text).toContain('i1 clip [0:00–0:03] w0–w3 "Hi, I\'m Detective Smith."');
  expect(text).toContain('i2 cut-in (Intro): "He said he was home."');
  expect(text).toContain("i4 cut-in (Outro): (nothing written)");
});
