// notices.ts's tests: the person is told what finished the way that fits where they are.

import { afterEach, expect, test } from "bun:test";

import * as notices from "../src/notices.ts";
import * as windowFocus from "../src/window_focus.ts";

afterEach(() => {
  notices.resetForTests();
  windowFocus.resetForTests();
});

const notice = (key: string, path = "/scripts/abc"): notices.Notice => ({ key, title: "First draft is ready", body: "Mom Leaves 5 Kids", path });

/** A page at `path`, and what it was sent. */
function page(path: string, focused: boolean, system = false) {
  const sent: { how: string; notice: notices.Notice }[] = [];
  const viewer = notices.connect((text) => sent.push(JSON.parse(text) as (typeof sent)[number]));
  notices.heard(viewer, JSON.stringify({ type: "attention", focused, path, system }));
  return { viewer, sent };
}

test("nothing when they're looking at it, a toast when Edit's in front elsewhere", () => {
  const there = page("/scripts/abc", true);
  expect(notices.notify(notice("a"))).toBe("seen");
  expect(there.sent).toEqual([]);
  notices.heard(there.viewer, JSON.stringify({ type: "attention", focused: true, path: "/" }));
  expect(notices.notify(notice("b"))).toBe("toast");
  expect(there.sent).toEqual([{ type: "notice", how: "toast", notice: notice("b") }] as never);
  // The same thing twice at once is one notice.
  expect(notices.notify(notice("b"))).toBe("repeat");
  expect(there.sent.length).toBe(1);
});

test("nobody in front: Edit.app's window posts it, else the page in front last that may", async () => {
  const back = page("/scripts/abc", false, true);
  const older = page("/", false, true);
  const none = page("/", false, false);
  // Edit.app's window is polling: it takes it.
  const asked = windowFocus.next(5_000);
  expect(notices.notify(notice("w"))).toBe("window");
  expect((await asked).notices).toEqual([notice("w")]);
  windowFocus.resetForTests();
  // No window (Linux's Chrome window, a browser): the page focused last that may show it, once.
  notices.heard(older.viewer, JSON.stringify({ type: "attention", focused: true, path: "/" }));
  notices.heard(older.viewer, JSON.stringify({ type: "attention", focused: false, path: "/", system: true }));
  expect(notices.notify(notice("p"))).toBe("page");
  expect(older.sent).toEqual([{ type: "notice", how: "system", notice: notice("p") }] as never);
  expect(back.sent).toEqual([]);
  expect(none.sent).toEqual([]);
  // Gone: nobody to tell.
  for (const one of [back, older, none]) notices.disconnect(one.viewer);
  expect(notices.notify(notice("n"))).toBe("nobody");
});

test("a page's other messages are ignored, and a line fit for a notification is short and plain", () => {
  const one = page("/p/x", true);
  notices.heard(one.viewer, "not json");
  notices.heard(one.viewer, JSON.stringify({ type: "other", focused: false }));
  expect(one.viewer).toMatchObject({ focused: true, path: "/p/x" });
  expect(notices.line("\n**Tightened** the [intro](http://x).\nMore")).toBe("Tightened the intro.");
  expect(notices.line("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
});
