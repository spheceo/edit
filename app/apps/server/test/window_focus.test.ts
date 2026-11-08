// window_focus.ts's tests: Edit's window comes to the front when the sign-in comes back.

import { afterEach, expect, test } from "bun:test";

import * as windowFocus from "../src/window_focus.ts";

afterEach(() => windowFocus.resetForTests());

test("a window waiting is told to come to the front, and counts as open", async () => {
  expect(windowFocus.attached()).toBe(false);
  const asked = windowFocus.next(5_000);
  expect(windowFocus.attached()).toBe(true);
  windowFocus.focus();
  expect((await asked).focus).toBe(true);
});

test("a poll with nothing to do is answered no, and a focus asked between polls is kept for the next one", async () => {
  expect((await windowFocus.next(20)).focus).toBe(false);
  windowFocus.focus();
  expect((await windowFocus.next(20)).focus).toBe(true);
  expect((await windowFocus.next(20)).focus).toBe(false);
});

test("a notice goes to the window that's listening, once, and none is taken without a window", async () => {
  const notice = { key: "k", title: "First draft is ready", body: "Mom Leaves 5 Kids", path: "/scripts/abc" };
  expect(windowFocus.notify(notice)).toBe(false);
  const asked = windowFocus.next(5_000);
  expect(windowFocus.notify(notice)).toBe(true);
  expect(await asked).toEqual({ focus: false, notices: [notice] });
  // Between polls: kept for the next one.
  expect(windowFocus.notify({ ...notice, key: "k2" })).toBe(true);
  expect((await windowFocus.next(20)).notices.map((one) => one.key)).toEqual(["k2"]);
  expect((await windowFocus.next(20)).notices).toEqual([]);
});
