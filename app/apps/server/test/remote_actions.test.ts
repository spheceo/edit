import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import type { Script } from "@edit/types/writer";

import type { App } from "../src/app.ts";
import { problems, RESTART, resume, UNSTICK } from "../src/remote_actions.ts";
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

describe("remote support's other actions", () => {
  /** A Mac with nothing on it and, with `exporting`, an export running. */
  const quiet = (exporting = false) => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "edit-remote-"));
    return { store: { home: root, get: () => null, list: () => [], cloud: () => null }, scripts: { get: () => null, running: () => false }, agents: { runningProjects: () => [] }, exports: { running: () => exporting } } as unknown as App;
  };

  test("unstick on a Mac with nothing stuck says so; restart refuses while work would be cut off", async () => {
    expect(await resume(quiet(), UNSTICK)).toBe("nothing was stuck");
    await expect(resume(quiet(true), RESTART)).rejects.toThrow("Not restarted: an export would be cut off");
  });

  test("the problems of the last two days come once per kind, most frequent first, numbers and ids aside", () => {
    const now = Date.parse("2026-10-30T01:00:00");
    const lines = [
      "2026-10-29 23:00:01.000 ERROR [export] p1793273198608-28: export failed after 12 s: decoder stalled at 1200",
      "2026-10-29 23:10:01.000 ERROR [export] p1793132820736-211: export failed after 40 s: decoder stalled at 88",
      "2026-10-29 23:20:01.000 WARN [cloud] reading edit/proxies/a.mp4 in blocks: R2 answered 503 to a block read",
      "2026-10-29 23:20:02.000 INFO [cloud] all fine",
      "2026-10-26 23:20:02.000 ERROR [export] long ago",
    ];
    expect(problems(lines, now)).toEqual([
      "    2× last 2026-10-29 23:10:01 · ERROR [export] p1793132820736-211: export failed after 40 s: decoder stalled at 88",
      "    1× last 2026-10-29 23:20:01 · WARN [cloud] reading edit/proxies/a.mp4 in blocks: R2 answered 503 to a block read",
    ]);
  });
});
