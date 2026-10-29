import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { approvalOf, isOpen, noteOf, sharedAnchor, untaken } from "../../src/writer/reviews.ts";

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
