// The "Low memory" chip's judge (memory.ts): macOS's pressure level, yellow
// for 30 s or red at once, over after a minute back at normal; and the app it
// names, with its helpers counted in and Edit left out.

import { expect, test } from "bun:test";

import { biggestApp, calm, judge, type MemoryState, type Pressure } from "../src/memory.ts";

function run(readings: [number, Pressure][]): MemoryState {
  return readings.reduce((state, [at, pressure]) => judge(state, pressure, at), calm);
}

test("low after 30 s of yellow, or at once on red; a short spike is nothing", () => {
  expect(run([[0, 2], [25_000, 2]]).low).toBe(false);
  expect(run([[0, 2], [30_000, 2]])).toMatchObject({ low: true, critical: false });
  expect(run([[0, 2], [20_000, 1], [40_000, 2]]).low).toBe(false);
  expect(run([[0, 4]])).toMatchObject({ low: true, critical: true });
  expect(run([[0, 4], [5_000, 2]])).toMatchObject({ low: true, critical: false });
});

test("over only after a minute back at normal", () => {
  expect(run([[0, 4], [5_000, 1], [60_000, 1]]).low).toBe(true);
  expect(run([[0, 4], [5_000, 1], [65_000, 1]]).low).toBe(false);
  // Pressure again before the minute: the minute starts over.
  expect(run([[0, 4], [5_000, 1], [30_000, 2], [35_000, 1], [90_000, 1]]).low).toBe(true);
});

test("names the app using the most, counting its helpers, never Edit or a bare process", () => {
  const footprints = ["PID    MEM", "10  2048M", "11  1.5G+", "12  900M-", "20  6G", "30  12G", "40  700K"].join("\n");
  const paths = [
    "10 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "11 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)",
    "12 /Applications/Slack.app/Contents/MacOS/Slack",
    "20 /Applications/Edit.app/Contents/MacOS/Edit",
    "30 /usr/local/bin/claude",
    "40 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
  ].join("\n");
  const found = biggestApp(footprints, paths, "/Applications/Edit.app");
  expect(found?.name).toBe("Google Chrome");
  expect(found?.bytes).toBe(2048 * 1024 ** 2 + 1.5 * 1024 ** 3);
  expect(biggestApp("", "", null)).toBeNull();
});
