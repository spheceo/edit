import { expect, test } from "bun:test";

import { catchBugs, catchBugsAsync, isBug, panicResponse } from "../src/guard.ts";

test("panics_become_errors", () => {
  expect(catchBugs("sum", () => 1 + 1)).toBe(2);
  const crash = () =>
    catchBugs("job", (): number => {
      throw new TypeError("boom");
    });
  expect(crash).toThrow("job crashed (boom); this is a bug in Edit");
  const owned = () =>
    catchBugs("job", (): number => {
      const missing: { field?: { deeper: number } } = {};
      return missing.field!.deeper;
    });
  expect(owned).toThrow(/job crashed \(.*\); this is a bug in Edit/);
});

test("failures pass through as they are", async () => {
  expect(() =>
    catchBugs("job", () => {
      throw new Error("no project p1");
    }),
  ).toThrow(/^no project p1$/);
  await expect(
    catchBugsAsync("job", async () => {
      throw new RangeError("Invalid array length");
    }),
  ).rejects.toThrow("job crashed (Invalid array length)");
  expect(isBug(new Error("expected"))).toBe(false);
  expect(isBug(new ReferenceError("x is not defined"))).toBe(true);
});

test("a crashed request answers with JSON", async () => {
  const response = panicResponse(new TypeError("undefined is not an object"));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: "this request crashed (undefined is not an object); this is a bug in Edit",
  });
});
