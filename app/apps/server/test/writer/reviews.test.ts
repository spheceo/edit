import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { App } from "../../src/app.ts";
import { approvalOf, cancelShare, isOpen, noteOf, shareProgress, shareQueue, shareState, shareWork, sharedAnchor, startShare, untaken } from "../../src/writer/reviews.ts";
import type { Script } from "@edit/types/writer";

test("reads notes and approvals as Repack sends them", () => {
  const note = noteOf({
    noteId: "n1", reviewId: "r1", sourceId: "s1", version: 2.0, parentId: null,
    anchor: { kind: "text", blockId: "b1", start: 0, end: 4, quote: "Four" },
    text: "Cut", author: "Ana", fromApp: false, status: "open", attempt: { by: "x", at: 1.0 },
    deleted: true, createdAt: 5.0, updatedAt: 6.0,
  })!;
  expect([note.id, note.version, note.attempted, note.deleted, isOpen(note)]).toEqual(["n1", 2, true, true, true]);
  // Sent back as not fixed after the run took it: fixable again.
  const retry = noteOf({
    noteId: "n2", reviewId: "r1", version: 1.0, text: "Still wrong", author: "Ana", status: "open",
    intent: "wording", scope: "here", suggestion: null, action: false, general: null,
    attempt: { by: "Writer", at: 10.0 }, notFixed: { by: "Ana", at: 20.0, version: 2.0 }, confirmed: null,
    createdAt: 1.0, updatedAt: 20.0,
  })!;
  expect(untaken(retry)).toBe(true);
  expect([retry.intent, retry.action, retry.suggestion, retry.confirmed]).toEqual(["wording", undefined, undefined, false]);
  expect(untaken({ ...retry, notFixedAt: 5 })).toBe(false);
  expect(approvalOf({ version: 3.0, by: "Writer on Mac", at: 7.0 })).toEqual({ version: 3, by: "Writer on Mac", at: 7 });
  expect(approvalOf(null)).toBeNull();
});

test("names a comment's words in the shared text", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writer-anchor-"));
  fs.writeFileSync(path.join(dir, "review-text.json"), JSON.stringify({ version: 2, blocks: { p1: "He’s streamed with Kanye West, and more." } }));
  const link = { reviewId: "r", token: "t", url: "u", version: 2, revision: 1, sharedAt: 0 };
  // Where it was picked (the curly quote is one UTF-16 unit).
  expect(sharedAnchor(dir, link, 6, { kind: "text", blockId: "p1", start: 19, end: 29, quote: "Kanye West" }).start).toBe(19);
  // Edited since: the same words, found again in the shared text.
  expect(sharedAnchor(dir, link, 6, { kind: "text", blockId: "p1", start: 40, end: 50, quote: "Kanye West" }).start).toBe(19);
  // Words written since the share aren't on the page.
  expect(() => sharedAnchor(dir, link, 6, { kind: "text", blockId: "p1", start: 0, end: 5, quote: "Drake" })).toThrow();
  fs.rmSync(dir, { recursive: true });
});

test("a script share's place in the export queue follows its stage", () => {
  expect(shareProgress("checking the preview")).toBeCloseTo(0.05);
  expect(shareProgress("uploading the script")).toBeCloseTo(0.15);
  expect(shareProgress("uploading the footage")).toBeCloseTo(0.2);
  expect(shareProgress("uploading the footage 50%")).toBeCloseTo(0.5);
  expect(shareProgress("uploading the footage 100%")).toBeCloseTo(1);
  expect(shareProgress("publishing")).toBeCloseTo(0.95);
});

test("cancelling a script share takes it off the queue and is not a failure", async () => {
  const before = shareWork.run;
  let finish: (script: Script) => void = () => {};
  shareWork.run = () => new Promise<Script>((resolve) => { finish = resolve; });
  try {
    const pending = startShare({} as App, "/nowhere", "share-cancel");
    expect(cancelShare("share-cancel")).toBe(true);
    expect(shareState("share-cancel").sharing?.stage).toBe("cancelling");
    expect(cancelShare("missing")).toBe(false);
    finish({ id: "share-cancel" } as Script);
    await expect(pending).rejects.toThrow("cancelled");
    expect(shareState("share-cancel")).toEqual({});
    expect(shareQueue()).toEqual([]);
  } finally {
    shareWork.run = before;
  }
});

test("scripts share on their own, several at once, and one share of a script at a time (JJ, Nov 1)", async () => {
  const before = shareWork.run;
  const waiting = new Map<string, { resolve: (script: Script) => void; reject: (error: Error) => void }>();
  shareWork.run = (_app, _data, id) => new Promise<Script>((resolve, reject) => void waiting.set(id, { resolve, reject }));
  try {
    const app = {} as App;
    const a = startShare(app, "/nowhere", "share-a");
    const b = startShare(app, "/nowhere", "share-b");
    // Both under way at once; a second share of the same script is refused, saying the first carries on.
    expect(shareState("share-a").sharing).toBeDefined();
    expect(shareState("share-b").sharing).toBeDefined();
    // Both are on the shared export queue, at the first stage, until each share settles.
    expect(shareQueue().map((one) => one.id).sort()).toEqual(["share-a", "share-b"]);
    expect(shareQueue().every((one) => one.name === "Script" && one.stage === "checking the preview" && one.progress === 0.05)).toBe(true);
    await expect(startShare(app, "/nowhere", "share-a")).rejects.toThrow("already being shared");
    waiting.get("share-a")!.resolve({ id: "share-a" } as Script);
    await a;
    expect(shareState("share-a")).toEqual({});
    // One that fails says why until the next share.
    waiting.get("share-b")!.reject(new Error("R2 unreachable"));
    await expect(b).rejects.toThrow("R2 unreachable");
    expect(shareState("share-b").shareFailed?.error).toBe("R2 unreachable");
    const again = startShare(app, "/nowhere", "share-b");
    expect(shareState("share-b").shareFailed).toBeUndefined();
    waiting.get("share-b")!.resolve({ id: "share-b" } as Script);
    await again;
    expect(shareQueue()).toEqual([]);
  } finally {
    shareWork.run = before;
  }
});
