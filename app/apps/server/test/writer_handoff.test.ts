// writer_handoff.ts: a Writer script as Edit's script blocks.

import { expect, test } from "bun:test";

import { styleOf, toParsed, type WriterScript } from "../src/writer_handoff.ts";

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
