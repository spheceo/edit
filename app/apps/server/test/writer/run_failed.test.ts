import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import * as chat from "../../src/writer/chat.ts";
import * as store from "../../src/writer/store.ts";

const ID = "7c2e1d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

// The user, Oct 30: a script whose Claude runs failed ("Can't reach the API
// server", then stopped) never got built and wasn't under Needs you. Its chat,
// which syncs, says so: the list carries runFailed until a run finishes.
test("a script whose last Claude run failed says so in the list, until a run finishes", () => {
  const data = fs.mkdtempSync(join(os.tmpdir(), "edit-run-failed-"));
  const dir = store.scriptDir(data, ID);
  fs.mkdirSync(dir, { recursive: true });
  store.write(dir, { id: ID, title: "Case", sourceKind: "drive", sourceUrl: "", originalPath: join(dir, "original.mp4"), status: "ready", stage: "ready", progress: 100, error: null, durationMs: 0, revision: 1, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null, words: [], clips: [] } as Script);
  expect(store.list(data)[0]?.runFailed).toBeNull();

  chat.add(dir, "producer", "Build the script.");
  chat.add(dir, "editor", 'Claude stopped: "API Error: Can\'t reach the API server" Nothing was changed.', null, true);
  const failed = store.list(data)[0]?.runFailed;
  expect(failed?.error).toContain("Can't reach the API server");
  expect(failed?.at).toBeGreaterThan(0);

  chat.add(dir, "producer", "Build the script.");
  chat.add(dir, "editor", "Built the script: 12 cut-ins.");
  expect(store.list(data)[0]?.runFailed).toBeNull();
});
