import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import * as store from "../../src/writer/store.ts";

const ID = "4b1f2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function made(): { data: string; dir: string; script: Script } {
  const data = fs.mkdtempSync(join(os.tmpdir(), "edit-note-"));
  const dir = store.scriptDir(data, ID);
  fs.mkdirSync(dir, { recursive: true });
  const script = { id: ID, title: "School Teacher Caught On CCTV", sourceKind: "youtube", sourceUrl: "", originalPath: join(dir, "original.mp4"), status: "processing", stage: "downloading", progress: 8, error: null, durationMs: 0, revision: 1, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null, words: [], clips: [], kind: "foia" } as unknown as Script;
  store.write(dir, script);
  return { data, dir, script };
}

// JJ, Nov 8: a note to self on a script, shown on Home beside its name, here while it imports.
test("a script's note is its own file: listed, kept when an import writes the script back, and cleared", () => {
  const { data, dir, script } = made();
  expect(store.writeNote(dir, "  goes on Sam's\nchannel ")).toBe("goes on Sam's channel");
  expect(store.list(data).find((one) => one.id === ID)?.note).toBe("goes on Sam's channel");
  // The import still running writes the script it holds: the note stays.
  store.write(dir, { ...script, progress: 40 });
  expect(store.summary(store.read(dir), dir).note).toBe("goes on Sam's channel");
  // Cleared: kept as an empty note (so the clearing syncs), and the summary has none.
  expect(store.writeNote(dir, "")).toBe("");
  expect(fs.existsSync(join(dir, store.NOTE_FILE))).toBe(true);
  expect(store.list(data).find((one) => one.id === ID)?.note).toBeUndefined();
});

test("a note is kept short, and only on a script this computer has", () => {
  const { data, dir } = made();
  expect(() => store.writeNote(dir, "x".repeat(store.NOTE_LIMIT + 1))).toThrow("Keep a note");
  expect(() => store.writeNote(store.scriptDir(data, "9b1f2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"), "hi")).toThrow("isn't on this computer");
});
