// writer_handoff.ts: a Writer script as Edit's script blocks.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import { caseNames } from "../src/names.ts";
import * as writerStore from "../src/writer/store.ts";
import { carryResearch, resolveWriterCases, styleOf, toParsed, type WriterScript } from "../src/writer_handoff.ts";
import { reusedScriptBlock } from "../src/project.ts";
import { fixtureHome } from "./helpers/home.ts";

test("a Writer script's clips become footage ranges of each recording and cut-ins, notes and edit: notes kept", () => {
  const joined: WriterScript = {
    id: "w1",
    title: "Mom Leaves 5 Kids",
    kind: "foia",
    sourceKind: "drive",
    parts: [
      { title: "Sinclair BWC.mp4", startMs: 0, durationMs: 60_000, url: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123/view" },
      { title: "Ramos BWC.mp4", startMs: 60_000, durationMs: 120_000, url: "https://drive.google.com/file/d/1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876/view" },
    ],
    clips: [
      { id: "c1", startMs: 5_000, endMs: 9_000, notes: [{ text: "edit: blur the child's face" }] },
      { id: "c2", kind: "cut-in", startMs: 0, endMs: 3_000, narration: "On July 22, 2023, a call came in." },
      // Across the join: the end of one recording and the start of the next.
      { id: "c3", startMs: 58_000, endMs: 62_500 },
    ],
  };
  const parsed = toParsed(joined);
  expect(parsed.title).toBe("Mom Leaves 5 Kids");
  expect(parsed.blocks).toEqual([
    { kind: "footage", url: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123/view", file: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123", start: 5, end: 9, label: "00:05 - 00:09", notes: ["edit: blur the child's face"] },
    { kind: "narration", text: "On July 22, 2023, a call came in." },
    { kind: "footage", url: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123/view", file: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123", start: 58, end: 60, label: "00:58 - 01:00" },
    { kind: "footage", url: "https://drive.google.com/file/d/1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876/view", file: "1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876", start: 0, end: 2.5, label: "00:00 - 00:03" },
  ]);
  expect(styleOf("foia")).toBe("bodycam");
  expect(styleOf("courtroom")).toBe("courtroom");
  expect(styleOf(undefined)).toBe("interrogation");
});

test("a script whose footage no other machine can fetch, or with none, says why", () => {
  expect(() => toParsed({ id: "x", title: "x", sourceKind: "file", sourceUrl: "/tmp/a.mp4", clips: [{ id: "c", startMs: 0, endMs: 1000 }] })).toThrow("only on the Mac that imported it");
  expect(() => toParsed({ id: "x", title: "x", sourceKind: "commentary" })).toThrow("commentary script has no finished draft");
  expect(() => toParsed({ id: "x", title: "x", sourceKind: "youtube", sourceUrl: "https://youtu.be/dslLBsHkVzE", clips: [] })).toThrow("no footage ranges");
});

test("a reused Doc expands its full script after its transition without rewriting ranges or cut-ins", () => {
  const doc = "https://docs.google.com/document/d/1EarlierScriptAbcdef/edit";
  const source = "https://youtu.be/dslLBsHkVzE";
  const original = "https://drive.google.com/file/d/1OriginalFootageAbcdef/view";
  const text = `Earlier case\n\n(00:12 - 00:18) <${original}>\n\nThe finished words must stay exactly as written.\n\n(01:23 - 01:29) <${original}>`;
  const parsed = toParsed({ id: "comp", title: "Compilation", sourceUrl: source, sourceKind: "compilation",
    clips: [
      { id: "c1", startMs: 0, endMs: 5000 },
      { id: "c2", startMs: 0, endMs: 3000, kind: "cut-in", narration: "In another case…", reuse: doc },
    ], reuses: [{ url: doc, after: 1, script: doc, scriptTitle: "Earlier case", scriptText: text }],
  });
  expect(parsed.blocks.map((block) => block.kind === "footage" ? [block.file, block.start, block.end] : block.text)).toEqual([
    ["youtube:dslLBsHkVzE", 0, 5], "In another case…", ["1OriginalFootageAbcdef", 12, 18], "The finished words must stay exactly as written.", ["1OriginalFootageAbcdef", 83, 89],
  ]);
  expect(parsed.blocks.slice(2).every(reusedScriptBlock)).toBe(true);
});

test("an explicitly reused finished video is whole, while a reused Doc never falls back to its short narration summary", () => {
  const source = "https://youtu.be/dslLBsHkVzE";
  const base: WriterScript = { id: "comp", title: "Compilation", sourceKind: "compilation", sourceUrl: source,
    clips: [{ id: "c1", startMs: 0, endMs: 5000 }, { id: "c2", startMs: 0, endMs: 3000, kind: "cut-in", reuse: source }], reuses: [{ url: source, after: 1 }],
  };
  expect(toParsed(base).blocks.at(-1)).toMatchObject({ kind: "footage", file: "youtube:dslLBsHkVzE", label: "Reuse (the whole video)" });
  const doc = "https://docs.google.com/document/d/1EarlierScriptAbcdef/edit";
  base.clips![1]!.reuse = doc;
  base.reuses = [{ url: doc, after: 1 }];
  expect(() => toParsed(base)).toThrow("complete linked script text");
});

test("older Writer reuse records fetch their original Doc rather than dropping the case", async () => {
  const doc = "https://docs.google.com/document/d/1EarlierScriptAbcdef/edit";
  const input: WriterScript = { id: "x", title: "x", reuses: [{ url: doc, after: 1, script: doc }] };
  const prepared = await resolveWriterCases(input, async (id) => {
    expect(id).toBe("1EarlierScriptAbcdef");
    return ['<html><body><p><a href="https://youtu.be/dslLBsHkVzE">00:01 - 00:03</a></p><p>Keep the original words.</p></body></html>', "Earlier case"];
  });
  expect(prepared.reuses?.[0]?.scriptBlocks?.[1]).toMatchObject({ kind: "narration", text: "Keep the original words." });
  expect(input.reuses?.[0]?.scriptBlocks).toBeUndefined();
});

test("a Writer folder case uses its complete shared-master clock and original, never its first recording", () => {
  const hash = "a".repeat(64);
  const key = `edit/originals/sha256/${hash}/00.mp4`;
  const parsed = toParsed({ id: "w", title: "Folder case", sourceKind: "compilation",
    parts: [{ title: "All recordings", startMs: 0, durationMs: 120_000, url: "https://drive.google.com/drive/folders/1WholeFolderAbcdef", mediaSource: `sha256:${hash}`, originalKey: key }],
    clips: [{ id: "across-recordings", startMs: 58_000, endMs: 65_000 }],
  });
  expect(parsed.blocks[0]).toMatchObject({ file: `sha256:${hash}`, start: 58, end: 65, notes: [`Shared original: ${key}`] });
});

test("a reused earlier Trello case rebuilds the saved selected Doc section while keeping its original reuse URL", async () => {
  const url = "https://trello.com/c/AbCd1234/earlier-compilation";
  const doc = "https://docs.google.com/document/d/1EarlierScriptAbcdef/edit";
  const source = "https://youtu.be/dslLBsHkVzE";
  const input: WriterScript = { id: "x", title: "x", sourceUrl: source,
    clips: [{ id: "transition", startMs: 0, endMs: 1000, kind: "cut-in", reuse: url }],
    reuses: [{ url, after: 1, script: doc, scriptText: `(00:12 - 00:18) <${source}>\nKeep this selected case's words.` }],
  };
  expect(toParsed(input).blocks).toMatchObject([{ start: 12, end: 18 }, { text: "Keep this selected case's words." }]);
  expect(input.reuses?.[0]?.url).toBe(url);
  delete input.reuses![0]!.scriptText;
  await expect(resolveWriterCases(input, async () => { throw new Error("must not fetch the whole compilation"); })).rejects.toThrow("selected script text is missing");
});

test("a script's research and case names go to the edit made from it, so neither is asked for again", async () => {
  const { app, store, cleanup } = fixtureHome("handoff-research");
  try {
    const id = "6b1f0c2e-3a4d-4e5f-9a8b-7c6d5e4f3a2b";
    const dir = writerStore.scriptDir(writerStore.dataDir(app.store.home), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "research.json"), JSON.stringify({ queries: ["q"], at: 1, articles: [{ title: "Sentenced", outlet: "Town News", published: "2025-04-30", url: "https://news.test/a", summary: "Ryan Reese was sentenced.", facts: ["390 years"], video: null }] }));
    fs.writeFileSync(join(dir, "names.json"), JSON.stringify({ hash: "the script's", names: ["Ryan Reese", "Reese"] }));
    const live = store.create("Case", { width: 1920, height: 1080, fps: 30 });
    carryResearch(app, id, live.project.id);
    const articles = JSON.parse(fs.readFileSync(join(app.store.home, "research", live.project.id, "articles.json"), "utf8"));
    expect(articles).toEqual([{ id: expect.any(String), url: "https://news.test/a", title: "Sentenced", outlet: "Town News", published: "2025-04-30", summary: "Ryan Reese was sentenced.", text: "Ryan Reese was sentenced.\n390 years" }]);
    // Kept as listed from the edit's own sources: asked for, they come back without a model call.
    expect(await caseNames(app, store.get(live.project.id)!.project)).toEqual(["Ryan Reese", "Reese"]);
  } finally {
    cleanup();
  }
});
