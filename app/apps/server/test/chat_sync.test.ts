import { expect, test } from "bun:test";

import { chatKey, isNewer, savedAtOf } from "../src/chat_sync.ts";

test("a chat's cloud copy is taken only when it's newer", () => {
  expect(chatKey("p123")).toBe("edit/chats/p123.json");
  expect(savedAtOf(JSON.stringify({ savedAt: 42, entries: [] }))).toBe(42);
  expect(savedAtOf("not json")).toBe(0);
  expect(savedAtOf(JSON.stringify({ entries: [] }))).toBe(0);
  expect(isNewer(100, 50)).toBe(true);
  expect(isNewer(50, 100)).toBe(false);
  expect(isNewer(50, 50)).toBe(false);
});
