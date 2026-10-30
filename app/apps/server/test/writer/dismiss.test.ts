import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import { resume } from "../../src/writer/imports.ts";
import * as store from "../../src/writer/store.ts";

const ID = "5b1f0c2d-3e4a-4b6c-9d7e-8f0a1b2c3d4e";

// The user, Oct 30: a stopped import on Home's "need you" can be dismissed,
// confirmed. It leaves the list and stays stopped, its error kept, so Retry
// still carries it on.
test("dismissing a stopped import takes it off the list and leaves it stopped", async () => {
  const data = fs.mkdtempSync(join(os.tmpdir(), "edit-dismiss-"));
  const dir = store.scriptDir(data, ID);
  fs.mkdirSync(dir, { recursive: true });
  const error = "Transcription failed (520). Retry: what was heard is kept.";
  store.write(dir, { id: ID, title: "Case", sourceKind: "drive", sourceUrl: "", originalPath: join(dir, "original.mp4"), status: "error", stage: "transcribing", progress: 60, error, durationMs: 0, revision: 1, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null, words: [], clips: [] } as Script);

  const answered = await resume({} as never, data, ID, { kind: "dismiss" });
  expect(answered.status).toBe("error");
  expect(answered.error).toBe(error);
  expect(answered.dismissedAt).toBeGreaterThan(0);
  expect(store.list(data)[0]?.dismissedAt).toBe(answered.dismissedAt);
});
