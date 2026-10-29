import { expect, test } from "bun:test";

import type { Script, Word } from "@edit/types/writer";

import { call, finishPhase, newDraft, sectionPhase, stepsSystem, toolsOf, type Draft } from "../../src/writer/build.ts";
import { formatOf } from "../../src/writer/formats.ts";

function script(): Script {
  const words: Word[] = Array.from({ length: 40 }, (_, index) => ({ id: `w${index}`, text: index % 5 === 4 ? "end." : `word${index}`, startMs: index * 1000, endMs: index * 1000 + 800 }));
  return { id: "s1", title: "A case", sourceKind: "youtube", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 40_000, words, clips: [], overview: [], revision: 1, createdAt: 0, updatedAt: 0, proxyPath: null };
}

const steps = (): Draft => newDraft("steps", script(), []);

test("checks each item as it arrives and adds nothing on a refusal", () => {
  const draft = steps();
  let [said, refused] = call(draft, "add_section", { items: [{ kind: "clip", firstWordId: "w0", lastWordId: "w4" }, { kind: "cut-in", narration: "An intro — with a dash." }] });
  expect(refused).toBe(true);
  expect(said).toContain("Item 2");
  expect(said).toContain("em dash");
  expect(call(draft, "read_plan", {})[0]).toBe("The plan is empty.");
  [said, refused] = call(draft, "add_section", { items: [{ kind: "clip", firstWordId: "w0", lastWordId: "w4" }, { kind: "cut-in", narration: "An intro." }] });
  expect(refused).toBe(false);
  expect(said).toContain("i1 clip w0–w4");
  expect(said).toContain("i2 cut-in");
  [said, refused] = call(draft, "add_section", { items: [{ kind: "clip", firstWordId: "w9", lastWordId: "w3" }] });
  expect(refused).toBe(true);
  expect(said).toContain("Invalid clip range");
});

test("repairs by id and finishes once the whole plan passes", () => {
  const draft = steps();
  call(draft, "add_section", { items: [{ kind: "clip", firstWordId: "w0", lastWordId: "w4" }, { kind: "cut-in", narration: "An intro." }] });
  // No outro yet: the whole-plan check says so, and nothing is saved.
  let [said, refused] = call(draft, "finish", { report: "Done." });
  expect(refused).toBe(true);
  expect(said).toContain("outro");
  call(draft, "add_section", { items: [{ kind: "clip", firstWordId: "w5", lastWordId: "w9" }, { kind: "cut-in", narration: "A middle." }, { kind: "clip", firstWordId: "w0", lastWordId: "w9" }, { kind: "cut-in", narration: "The outro." }] });
  [said, refused] = call(draft, "replace_items", { from: "i4", to: "i4", items: [{ kind: "cut-in", narration: "A better middle." }] });
  expect(refused).toBe(false);
  expect(said).toContain("Replaced 1");
  [said, refused] = call(draft, "review_plan", {});
  expect(refused).toBe(false);
  expect(said.startsWith("It passes")).toBe(true);
  [said, refused] = call(draft, "finish", { report: "A short case." });
  expect(refused).toBe(false);
  expect(said.startsWith("Saved")).toBe(true);
  expect(draft.done).not.toBeNull();
});

test("a refused replacement changes nothing", () => {
  const draft = steps();
  call(draft, "add_section", { items: [{ kind: "clip", firstWordId: "w0", lastWordId: "w4" }, { kind: "cut-in", narration: "An intro." }] });
  expect(call(draft, "replace_items", { from: "i1", to: "i2", items: [{ kind: "cut-in", narration: "" }] })[1]).toBe(true);
  const [said] = call(draft, "read_plan", {});
  expect(said).toContain("i1 clip");
  expect(said).toContain("i2 cut-in");
});

test("a fast build's phases each take only their own tools", () => {
  const outline = newDraft("outline", script(), []);
  let [said, refused] = call(outline, "add_section", { items: [{ kind: "clip", firstWordId: "w0", lastWordId: "w4" }] });
  expect(refused).toBe(true);
  expect(said).toContain("set_outline");
  [said, refused] = call(outline, "set_outline", { sections: [{ title: "Opening", plan: "w0 to w4, then the intro.", footageSeconds: 5 }, { title: "Ending", plan: "w5 to w9, then the outro.", footageSeconds: 5 }], report: "Short." });
  expect(refused).toBe(false);
  expect(said).toContain("2 sections");
  expect(outline.outline?.sections).toHaveLength(2);
  const section = newDraft("section", script(), []);
  [said, refused] = call(section, "finish_section", {});
  expect(refused).toBe(true);
  expect(said).toContain("no items");
  expect(call(section, "finish", { report: "Done." })[1]).toBe(true);
  call(section, "add_section", { items: [{ kind: "clip", firstWordId: "w0", lastWordId: "w4" }, { kind: "cut-in", narration: "An intro." }] });
  [said, refused] = call(section, "finish_section", { note: "Ends on the arrest." });
  expect(refused).toBe(false);
  expect(said.startsWith("Section saved")).toBe(true);
  // Only a fast build lists the fast tools, and every phase the same ones.
  const names = (draft: Draft) => toolsOf(draft).map((tool) => (tool as { name: string }).name);
  expect(names(outline)).toContain("set_outline");
  expect(names(outline)).toEqual(names(section));
  expect(names(steps())).not.toContain("set_outline");
});

test("a section after the first writes as if a cut-in came before", () => {
  const outline = { sections: [{ title: "Opening", plan: "The intro.", seconds: 60 }, { title: "Ending", plan: "The outro.", seconds: 60 }], opening: null, report: "Short." };
  expect(sectionPhase(outline, 0)).toContain("opens the script");
  expect(sectionPhase(outline, 1)).toContain("ends the script");
  expect(sectionPhase(outline, 1)).toContain("a cut-in has already come before it");
  expect(finishPhase(outline, ["", ""], [1])).toContain("Section 2 came back empty");
});

test("the prompt asks for tools, not one answer", () => {
  const given = script();
  const prompt = stepsSystem(given, formatOf("interrogation", false, given.title));
  expect(prompt).not.toContain("answer ONCE");
  expect(prompt).toContain("WRITING THE PLAN WITH WRITER'S TOOLS");
  expect(prompt).not.toContain("your answer is the build_script plan");
});
