import { afterAll, afterEach, expect, test } from "bun:test";

import * as progress from "../src/progress.ts";

const real = { ...progress.timing };
afterAll(() => Object.assign(progress.timing, real));
let clock = 0;
progress.timing.now = () => clock;
progress.timing.sleep = async (ms: number) => {
  clock += ms;
};
afterEach(() => {
  progress.reset();
  clock = 0;
});

test("a map shot's frames say how long it has left", () => {
  progress.begin("map", "p1", "k1", 600);
  // Nothing measured yet: how long a map takes here.
  expect(progress.remainingMs("p1")).toBe(300_000);
  clock = 10_000;
  progress.step("map", "p1", "k1", 100, 600);
  clock = 30_000;
  progress.step("map", "p1", "k1", 300, 600);
  // 200 frames in 20 s: 300 more take 30 s.
  expect(progress.remainingMs("p1")).toBe(30_000);
  expect(progress.summary("p1")).toBe("a map shot rendering: done in about 30 s");
  expect(progress.lookAgain("p1")).toContain("wait once (wait)");
  expect(progress.remainingMs("p2")).toBeNull();
  expect(progress.lookAgain("p2")).toBe("");
});

test("smoothing runs one clip at a time, so each waiting counts", () => {
  progress.begin("smooth", "p1", "c1");
  progress.begin("smooth", "p1", "c2");
  progress.begin("smooth", "other", "c9");
  clock = 40_000;
  // The first has 150 s left, the two behind it a whole one each.
  expect(progress.remainingMs("p1", ["smooth"])).toBe(150_000 + 2 * 190_000);
  expect(progress.summary("p1", ["smooth"])).toBe("2 clips smoothing: done in about 9 min");
  // A finished one teaches how long smoothing takes.
  progress.end("smooth", "p1", "c1");
  expect(progress.pending("p1")).toHaveLength(1);
});

test("the watcher's windows, a few at a time", () => {
  progress.begin("watch", "p1", "watch");
  progress.step("watch", "p1", "watch", 0, 30);
  // 30 windows, 12 at once: three rounds of ~130 s.
  expect(progress.remainingMs("p1", ["watch"])).toBe(3 * 130_000);
  expect(progress.summary("p1")).toBe("the watcher (0 of 30 windows): done in about 7 min");
});

test("an export follows its store's events", () => {
  const listeners: ((event: Record<string, unknown>) => void)[] = [];
  const store = { subscribe: (listener: (event: Record<string, unknown>) => void) => (listeners.push(listener), () => {}) };
  progress.followExports(store);
  progress.followExports(store);
  expect(listeners).toHaveLength(1);
  const emit = (event: Record<string, unknown>) => listeners[0]!({ type: "export", id: "p1", ...event });
  emit({ state: "queued", progress: 0 });
  clock = 5000;
  emit({ state: "running", progress: 0.1 });
  clock = 25_000;
  emit({ state: "running", progress: 0.3 });
  // 20 % in 20 s: 70 % more in 70 s.
  expect(progress.remainingMs("p1", ["export"])).toBe(70_000);
  emit({ state: "done", progress: 1 });
  expect(progress.remainingMs("p1")).toBeNull();
});

test("waiting returns when the work is done, or at the limit", async () => {
  progress.begin("map", "p1", "k1", 10);
  expect(await progress.waitFor("p1", ["map"], 3000)).toBe(false);
  expect(clock).toBe(3000);
  setTimeout(() => progress.end("map", "p1", "k1"), 0);
  await Bun.sleep(1);
  expect(await progress.waitFor("p1", ["map"], 3000)).toBe(true);
});
