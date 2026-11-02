// A live turn's "Working for _" (agentTurns.ts): when it shows, and how it reads.

import { expect, test } from "vitest";

import { formatWorking, isWorking } from "./agentTurns";

test("a turn is working once it calls a tool or a few seconds in", () => {
  expect(isWorking(1200, false)).toBe(false);
  expect(isWorking(1200, true)).toBe(true);
  expect(isWorking(5000, false)).toBe(true);
});

test("working reads to the second", () => {
  expect(formatWorking(8400)).toBe("Working for 8s");
  expect(formatWorking(72_000)).toBe("Working for 1m 12s");
  expect(formatWorking(3_840_000)).toBe("Working for 1h 4m");
  expect(formatWorking(-50)).toBe("Working for 0s");
});
