// The "Low memory" chip's judge (memory.ts): macOS's pressure level, yellow
// for 30 s or red at once, over after a minute back at normal; and the app it
// names, with its helpers counted in and Edit left out.

import { expect, test } from "bun:test";

import { biggestApp, biggestApps, calm, claudeGate, claudesRunning, claudeTurn, editUse, judge, linuxPressure, useLine, type MemoryState, type Pressure } from "../src/memory.ts";

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

test("a report says what Edit's server and its work use, and the biggest apps", () => {
  const top = ["PID MEM", "100  600M", "101  300M", "102  250M", "103  120M", "104  1M", "200  9G", "201  1G"].join("\n");
  const tree = ["100 1 /Applications/Edit.app/Contents/Resources/edit", "101 100 /Users/jj/.local/bin/claude", "102 100 claude", "103 100 /opt/homebrew/bin/ffmpeg", "104 100 /usr/bin/caffeinate", "200 1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "201 1 /Applications/Slack.app/Contents/MacOS/Slack"].join("\n");
  const use = editUse(top, tree, 100);
  expect(use.parts).toEqual([{ kind: "Claude Code", count: 2, bytes: 550 * 1024 ** 2 }, { kind: "FFmpeg", count: 1, bytes: 120 * 1024 ** 2 }]);
  const paths = tree.replace(/^(\s*\d+)\s+\d+/gm, "$1");
  const apps = biggestApps(top, paths, "/Applications/Edit.app");
  expect(apps.map((app) => app.name)).toEqual(["Google Chrome", "Slack"]);
  expect(useLine(use, apps)).toBe("Edit 1.2 GB (server 0.6 GB · Claude Code ×2 0.5 GB · FFmpeg 0.1 GB) · biggest apps: Google Chrome 9.0 GB, Slack 1.0 GB");
});

test("Claude Code questions start at once with memory to spare, three at a time while it's short", async () => {
  let pressure: Pressure = 1;
  claudeGate.pressure = async () => pressure;
  claudeGate.lookMs = 20;
  const free = await Promise.all([1, 2, 3, 4, 5].map((n) => claudeTurn(`q${n}`)));
  expect(claudesRunning()).toBe(5);
  free.forEach((release) => release());
  pressure = 2;
  const first = await Promise.all([1, 2, 3].map((n) => claudeTurn(`q${n}`)));
  let fourth: (() => void) | null = null;
  void claudeTurn("q4").then((release) => (fourth = release));
  await Bun.sleep(60);
  expect(fourth).toBeNull();
  first[0]!();
  first[0]!();
  await Bun.sleep(10);
  expect(fourth).not.toBeNull();
  expect(claudesRunning()).toBe(3);
  // A waiting question stopped by the person ends without starting.
  const stop = new AbortController();
  const stopped = claudeTurn("q5", stop.signal);
  stop.abort();
  await expect(stopped).rejects.toThrow("stopped");
  // Memory back: the next starts whatever runs.
  pressure = 1;
  const fifth = await claudeTurn("q6");
  expect(claudesRunning()).toBe(4);
  [first[1]!, first[2]!, fourth!, fifth].forEach((release) => release());
  expect(claudesRunning()).toBe(0);
});

test("on Linux the level comes from MemAvailable (never MemFree) and how long work stalled on memory", () => {
  const meminfo = (available: number) => `MemTotal:       1000000 kB\nMemFree:          10000 kB\nMemAvailable:   ${available} kB\n`;
  const psi = (some: number, full: number) => `some avg10=${some.toFixed(2)} avg60=0.00 avg300=0.00 total=1\nfull avg10=${full.toFixed(2)} avg60=0.00 avg300=0.00 total=1\n`;
  // 1% free but half available (the page cache): normal.
  expect(linuxPressure(meminfo(500_000), psi(0, 0))).toBe(1);
  expect(linuxPressure(meminfo(100_000), psi(0, 0))).toBe(2);
  expect(linuxPressure(meminfo(40_000), psi(0, 0))).toBe(4);
  expect(linuxPressure(meminfo(500_000), psi(25, 0))).toBe(2);
  expect(linuxPressure(meminfo(500_000), psi(50, 12))).toBe(4);
  // No PSI (an old kernel): memory alone.
  expect(linuxPressure(meminfo(500_000), "")).toBe(1);
});
