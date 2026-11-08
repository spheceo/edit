import { describe, expect, it } from "vitest";

import { forgetUnsaved, keepUnsaved, readUnsaved } from "./unsaved";

describe("unsaved edits storage", () => {
  // No IndexedDB here, like a browser that blocks it: answers, never throws.
  it("answers false and null when storage isn't there", async () => {
    await expect(keepUnsaved({ id: "p1", base_rev: 1, patch: { set: {}, unset: [], lists: {} }, at: 0 })).resolves.toBe(false);
    await expect(readUnsaved("p1")).resolves.toBeNull();
    await expect(forgetUnsaved("p1")).resolves.toBeUndefined();
  });
});
