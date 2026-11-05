import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import { setKind } from "../../src/writer/edits.ts";
import * as store from "../../src/writer/store.ts";

const ID = "7c2e1a4b-5d6f-4a8b-9c0d-1e2f3a4b5c6d";

function made(extra: Partial<Script> = {}): string {
  const data = fs.mkdtempSync(join(os.tmpdir(), "edit-kind-"));
  const dir = store.scriptDir(data, ID);
  fs.mkdirSync(dir, { recursive: true });
  store.write(dir, { id: ID, title: "Police Hunt Down Their Own Colleague", sourceKind: "youtube", sourceUrl: "", originalPath: join(dir, "original.mp4"), status: "ready", stage: "", progress: 100, error: null, durationMs: 0, revision: 1, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null, words: [], clips: [], kind: "foia", compilation: true, ...extra } as Script);
  return data;
}

// JJ, Nov 5: a compilation started as Bodycam was meant to be Interrogation.
test("a compilation's category changes and it stays a compilation", () => {
  const data = made();
  const changed = setKind(data, ID, "interrogation");
  expect(changed.kind).toBe("interrogation");
  expect(changed.compilation).toBe(true);
  expect(changed.revision).toBe(2);
  expect(store.read(store.scriptDir(data, ID)).kind).toBe("interrogation");
});

test("only a footage script's kinds are taken, and never a commentary's", () => {
  expect(() => setKind(made(), ID, "horror")).toThrow("Choose Interrogation, Bodycam or Courtroom.");
  expect(() => setKind(made({ sourceKind: "commentary" }), ID, "foia")).toThrow("can't be changed");
});
