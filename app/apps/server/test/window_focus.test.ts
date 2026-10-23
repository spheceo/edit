// window_focus.ts's tests: Edit's window comes to the front when the sign-in comes back.

import { afterEach, expect, test } from "bun:test";

import * as windowFocus from "../src/window_focus.ts";

afterEach(() => windowFocus.resetForTests());

test("a window waiting is told to come to the front, and counts as open", async () => {
  expect(windowFocus.attached()).toBe(false);
  const asked = windowFocus.next(5_000);
  expect(windowFocus.attached()).toBe(true);
  windowFocus.focus();
  expect(await asked).toBe(true);
});

test("a poll with nothing to do is answered no, and a focus asked between polls is kept for the next one", async () => {
  expect(await windowFocus.next(20)).toBe(false);
  windowFocus.focus();
  expect(await windowFocus.next(20)).toBe(true);
  expect(await windowFocus.next(20)).toBe(false);
});
