import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import type { App } from "../src/app.ts";
import { resume } from "../src/remote_actions.ts";
import * as store from "../src/writer/store.ts";

/** An Edit home with one script in Script mode's folder, and no projects. */
function home(fields: Partial<Script>): [App, string] {
  const root = fs.mkdtempSync(join(os.tmpdir(), "edit-remote-"));
  const id = "4f6c2a1e-0b7d-4c3e-9a5f-2d8e1b6c7a90";
  const script = {
    id, title: "Case", sourceKind: "file", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 1_000, revision: 1, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null,
    words: [{ id: "w0", text: "Hi.", startMs: 0, endMs: 500 }], clips: [], ...fields,
  } as Script;
  const dir = store.scriptDir(store.dataDir(root), id);
  fs.mkdirSync(dir, { recursive: true });
  store.write(dir, script);
  return [{ store: { home: root, get: () => null } } as unknown as App, id];
}

describe("remote resume of a script", () => {
  test("a finished script only on this Mac goes to the cloud and isn't imported again", async () => {
    const [app, id] = home({});
    expect(await resume(app, id)).toBe('"Case": sent to the cloud; its import had finished');
  });

  test("an import waiting on a choice is left for them to answer", async () => {
    const [app, id] = home({ status: "needs_choice", decision: { kind: "no_speech", summary: "No speech was heard.", reason: "no_words" } });
    expect(await resume(app, id)).toContain("its import waits on a choice they make: No speech was heard.");
  });

  test("an id that's neither a project nor a script says so", async () => {
    const [app] = home({});
    await expect(resume(app, "nope")).rejects.toThrow("There's no project or script nope on this Mac.");
  });
});
