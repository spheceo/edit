// The foot's Later card: when the next thing set aside comes back, in a few words.

import { expect, test } from "vitest";

import { whenBack } from "./time";

test("when something comes back reads as a day", () => {
  const now = new Date(2026, 10, 2, 21, 0).getTime(); // Mon Nov 2, 9 pm
  expect(whenBack(new Date(2026, 10, 2, 23, 0).getTime(), now)).toBe("today");
  expect(whenBack(now - 3_600_000, now)).toBe("today");
  expect(whenBack(new Date(2026, 10, 3, 8, 0).getTime(), now)).toBe("tomorrow");
  expect(whenBack(new Date(2026, 10, 5, 8, 0).getTime(), now)).toBe("Thu");
  expect(whenBack(new Date(2026, 10, 12, 8, 0).getTime(), now)).toBe("Nov 12");
});
