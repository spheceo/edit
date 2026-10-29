import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Clip, Script } from "@edit/types/writer";

import { blocksOf, outline, targetMs, type Block } from "../../src/writer/blocks.ts";
import { acted, editorNote, intentOf, outside, paragraphId, placeName, replaceId, rules, suggested } from "../../src/writer/fixing.ts";
import { isSuggestion, type Note } from "../../src/writer/reviews.ts";

function script(): Script {
  const said = ["Hi,", "I'm", "Detective", "Smith.", "Where", "were", "you?", "Home.", "All", "night."];
  return {
    id: "a1", title: "Case", sourceKind: "file", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 10_000, revision: 3, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null,
    words: said.map((text, index) => ({ id: `w${index}`, text, startMs: index * 1_000, endMs: index * 1_000 + 500 })),
    clips: [
      { id: "c1", startMs: 0, endMs: 3_900 },
      { id: "n1", startMs: 0, endMs: 3_000, kind: "cut-in", narration: "He swears he was home all night." },
      { id: "c2", startMs: 5_900, endMs: 9_900 },
      { id: "n2", startMs: 0, endMs: 3_000, kind: "cut-in", narration: "He swears it again." },
    ],
  };
}

const note = (fields: Partial<Note>): Note => ({ id: "x", reviewId: "r", version: 1, anchor: null, text: "", author: "Ana", status: "open", changedRanges: [], attempted: false, fromApp: false, confirmed: false, createdAt: 0, updatedAt: 0, ...fields });
const narration = (found: [Script, string] | null, at: number) => found![0].clips[at]!.narration;
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "writer-fixing-"));

test("a suggestion replaces the anchored words as written", () => {
  expect(narration(suggested(script(), note({ anchor: { blockId: "n1", start: 3, end: 9, quote: "swears" }, suggestion: "testified" })), 1)).toBe("He testified he was home all night.");
  // Moved since the note was written: the quote nearest the anchor still takes it.
  expect(narration(suggested(script(), note({ anchor: { blockId: "n1", start: 0, end: 6, quote: "swears" }, suggestion: "testified" })), 1)).toBe("He testified he was home all night.");
  // Everywhere: every cut-in's.
  const all = suggested(script(), note({ anchor: { blockId: "n1", start: 3, end: 9, quote: "swears" }, suggestion: "testified", scope: "everywhere" }))!;
  expect(all[0].clips[3]!.narration).toBe("He testified it again.");
  expect(all[1]).toContain("2 places");
});

test("suggestion notes replace, delete and insert", () => {
  expect(narration(suggested(script(), note({ intent: "suggestion", anchor: { blockId: "n1", start: 3, end: 9, quote: "swears" }, replacement: "insists" })), 1)).toBe("He insists he was home all night.");
  expect(narration(suggested(script(), note({ intent: "suggestion", anchor: { blockId: "n1", start: 21, end: 31, quote: " all night" }, replacement: "" })), 1)).toBe("He swears he was home.");
  expect(narration(suggested(script(), note({ intent: "suggestion", anchor: { blockId: "n1", start: 10, end: 13, quote: "he " }, replacement: "" })), 1)).toBe("He swears was home all night.");
  // At its offset while the words either side match, else where they meet.
  expect(narration(suggested(script(), note({ intent: "suggestion", anchor: { blockId: "n1", start: 21, end: 21, quote: "" }, replacement: "alone", context: { before: "was home", after: " all night." } })), 1)).toBe("He swears he was home alone all night.");
  expect(narration(suggested(script(), note({ intent: "suggestion", anchor: { blockId: "n1", start: 2, end: 2, quote: "" }, replacement: "alone", context: { before: "was home", after: " all" } })), 1)).toBe("He swears he was home alone all night.");
  // An insertion whose place is gone is Claude's to do.
  expect(suggested(script(), note({ intent: "suggestion", anchor: { blockId: "n1", start: 2, end: 2, quote: "" }, replacement: "alone", context: { before: "in court", after: " today" } }))).toBeNull();
  expect(isSuggestion(note({ intent: "suggestion", replacement: "" }))).toBe(true);
  expect(isSuggestion(note({ suggestion: "x" }))).toBe(false);
});

test("a deletion on footage words cuts them from the clip", async () => {
  const spans = (clips: Clip[]) => clips.map((clip) => [clip.startMs, clip.endMs]);
  const { carriedOutForTests } = await import("../../src/writer/fixing.ts").then((module) => ({ carriedOutForTests: (module as unknown as { acted: typeof acted }).acted }));
  const [action] = (await carriedOutForTests(dir(), script(), note({ anchor: { blockId: "c1", start: 4, end: 7, quote: "I'm" }, action: "cut" })))!;
  expect(spans(action.clips).slice(0, 2)).toEqual([[0, 1_000], [1_500, 3_900]]);
});

test("a suggestion on footage respells its words one for one", () => {
  const found = suggested(script(), note({ anchor: { blockId: "c1", start: 8, end: 24, quote: "Detective Smith." }, suggestion: "Detective Smyth." }))!;
  expect(found[0].corrections?.w3).toBe("Smyth.");
  expect(found[0].corrections?.w2).toBeUndefined();
  // A different number of words can't be a respelling: Claude's to do.
  expect(suggested(script(), note({ anchor: { blockId: "c1", start: 8, end: 24, quote: "Detective Smith." }, suggestion: "Smith" }))).toBeNull();
});

test("footage actions cut words and move edges exactly", async () => {
  const [cut, said] = (await acted(dir(), script(), note({ anchor: { blockId: "c1", start: 4, end: 7, quote: "I'm" }, action: "cut" })))!;
  expect(said.startsWith("Cut")).toBe(true);
  expect(cut.clips.filter((clip) => clip.kind !== "cut-in").every((clip) => !(clip.startMs < 1_500 && clip.endMs > 1_000))).toBe(true);
  // "were" is 31..35 in the words shown before c2 ("Hi, I'm Detective Smith. Where were"): it starts there now.
  const [longer, earlier] = (await acted(dir(), script(), note({ anchor: { blockId: "c2", start: 31, end: 35, quote: "were", side: "before" }, action: "extend" })))!;
  expect(earlier.startsWith("Started the clip earlier")).toBe(true);
  const c2 = longer.clips.find((clip) => clip.id === "c2")!;
  expect(c2.startMs <= 5_000 && c2.startMs > 4_500).toBe(true);
  // Extending with words inside the clip says nothing exact: Claude's to do.
  expect(await acted(dir(), script(), note({ anchor: { blockId: "c2", start: 0, end: 4, quote: "you?" }, action: "extend" }))).toBeNull();
});

test("a note for the editor goes on the clip as written", () => {
  const [out] = editorNote(script(), note({ anchor: { blockId: "c2", start: 0, end: 4, quote: "you?" }, text: "a blue waveform for this call", intent: "editor" }))!;
  expect(out.clips[2]!.notes!.at(-1)!.text).toBe("edit: a blue waveform for this call");
  // On narration: the clip before it.
  const [again] = editorNote(script(), note({ anchor: { blockId: "n1", start: 0, end: 2, quote: "He" }, text: "edit: zoom in" }))!;
  expect(again.clips[0]!.notes!.at(-1)!.text).toBe("edit: zoom in");
});

test("intents limit what a fix may change", () => {
  expect(intentOf(note({ intent: "for_editor" }))).toBe("editor");
  expect(intentOf(note({ intent: "FYI/praise" }))).toBe("fyi");
  const before = script();
  const trimmed = structuredClone(before);
  trimmed.clips[0]!.endMs = 3_000;
  expect(outside("wording", before, trimmed)).not.toBeNull();
  expect(outside("cut", before, trimmed)).toBeNull();
  const reworded = structuredClone(before);
  reworded.clips[1]!.narration = "He said so.";
  expect(outside("cut", before, reworded)).not.toBeNull();
  expect(rules("question", note({}))).toContain("Make no edits");
});

test("blocks carry what the review page plays and measures", () => {
  const found = blocksOf(script());
  const c2 = found.find((block) => block.id === "c2")!;
  expect(c2.text).toBe("you? Home. All night.");
  expect(c2.before).toBe("Hi, I'm Detective Smith. Where were");
  expect(c2.previewMs).toEqual([5_900, 9_900]);
  expect(c2.words!.length).toBe(4);
  expect(c2.durationMs).toBe(4_000);
  // 7 words at 150 a minute.
  expect(found.find((block) => block.id === "n1")!.readMs).toBe(2_800);
  expect(outline(script(), found)[0]!.title).toBe("Opening");
  expect(targetMs(script())?.[1]).toBe(40 * 60_000);
});

test("review text names places, not block ids", () => {
  const block: Block = { id: "pbd55a3f2", kind: "paragraph", text: "Adin unfollowed him, and the friend who had spent so much time" };
  const name = placeName(block);
  expect(name).toBe("the paragraph beginning “Adin unfollowed him, and the…”");
  const byId = (at: string) => (at.startsWith("pbd55a3f2") ? 9 : null);
  expect(replaceId("I rewrote the last line of pbd55a3f2 the way Marius suggested.", byId, name)).toBe("I rewrote the last line of the paragraph beginning “Adin unfollowed him, and the…” the way Marius suggested.");
  // "paragraph pX" isn't said twice; a sentence starting on one is capitalized.
  expect(replaceId("Paragraph pbd55a3f2 now ends there.", byId, name)).toBe("The paragraph beginning “Adin unfollowed him, and the…” now ends there.");
  // One since removed, or a heading's, is still never an id; one inside a word is left.
  expect(replaceId("I cut p0a1b2c3d and p0a1b2c3d:heading.", paragraphId, "a paragraph")).toBe("I cut a paragraph and a paragraph.");
  expect(replaceId("xp0a1b2c3d stays", paragraphId, "a paragraph")).toBe("xp0a1b2c3d stays");
  expect(placeName({ id: "pbd55a3f2:heading", kind: "heading", text: "Ending" })).toBe("the heading “Ending”");
});
