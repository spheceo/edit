import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import * as store from "../../src/writer/store.ts";

// Oct 31: a dev server reloaded by a saved file left the Kroger import
// stopped ("The import stopped when Edit closed. Retry") until someone pressed
// Retry. The imports a restart cut off are named, so Edit carries them on, and
// they stay importing until it does (Nov 10).
test("a restart names the imports it cut off and leaves the others alone", () => {
  const data = fs.mkdtempSync(join(os.tmpdir(), "edit-interrupted-"));
  const make = (id: string, status: Script["status"]) => {
    const dir = store.scriptDir(data, id);
    fs.mkdirSync(dir, { recursive: true });
    store.write(dir, { id, title: id, sourceKind: "youtube", sourceUrl: "", originalPath: join(dir, "original.mp4"), status, stage: "transcribing", progress: 60, error: null, durationMs: 0, revision: 1, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null, words: [], clips: [] } as Script);
  };
  const running = "5b1f0c2d-3e4a-4b6c-9d7e-8f0a1b2c3d4e";
  const ready = "6c2f0c2d-3e4a-4b6c-9d7e-8f0a1b2c3d4e";
  make(running, "processing");
  make(ready, "ready");
  expect(store.markInterrupted(data)).toEqual([running]);
  expect(store.read(store.scriptDir(data, running)).status).toBe("processing");
  expect(store.read(store.scriptDir(data, ready)).status).toBe("ready");
  // One that didn't carry on is stopped, for Retry.
  store.markStopped(data, running);
  expect(store.read(store.scriptDir(data, running)).status).toBe("error");
  expect(store.markInterrupted(data)).toEqual([]);
});
