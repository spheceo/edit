// plan_limit.ts: a used-up Claude plan (JJ, Nov 4: "You've hit your 5-hour limit · resets 11:50pm (Asia/Dubai)",
// 155 times in an hour) is waited out by every Claude call instead of asked into.

import { afterEach, expect, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";

import * as usage from "../src/claude_usage.ts";
import * as planLimit from "../src/plan_limit.ts";
import { join } from "../src/paths.ts";
import { explain } from "../src/writer/claude.ts";

const JJ = 'Claude Code returned an error result: You\'ve hit your 5-hour limit · resets 11:50pm (Asia/Dubai)';

afterEach(() => planLimit.reset());

test("the plan used up is told from a busy model, and its reset is read in its own time zone", () => {
  expect(planLimit.isLimit(JJ)).toBe(true);
  expect(planLimit.isLimit("Claude usage limit reached. Your limit will reset at 5pm (America/New_York).")).toBe(true);
  expect(planLimit.isLimit("API Error: 429 rate limit exceeded")).toBe(false);
  expect(planLimit.isLimit("Claude's reply was cut off at its output limit")).toBe(false);
  // 23:48 in Dubai (UTC+4) is 19:48 UTC; 11:50pm there is two minutes away.
  const now = Date.UTC(2026, 10, 4, 19, 48);
  expect(planLimit.resetOf(JJ, now)).toBe(Date.UTC(2026, 10, 4, 19, 50));
  // A time already past is tomorrow's.
  expect(planLimit.resetOf(JJ, Date.UTC(2026, 10, 4, 20, 0))).toBe(Date.UTC(2026, 10, 5, 19, 50));
  // A weekly limit names its day.
  expect(planLimit.resetOf("You've hit your weekly limit · resets Nov 7, 9am (Asia/Dubai)", now)).toBe(Date.UTC(2026, 10, 7, 5, 0));
  expect(planLimit.resetOf("You've hit your limit", now)).toBeNull();
  // Script mode's words for it, marked as the plan's.
  expect(explain(JJ).limit).toBe(true);
  expect(explain("API Error: 529 overloaded").limit).toBe(false);
});

test("once noted, calls wait for the reset; one days away fails at once", async () => {
  const now = Date.now();
  // A reset three days off: no waiting, it says when.
  const far = new Date(now + 3 * 86_400_000);
  const hour = far.getHours() % 12 === 0 ? 12 : far.getHours() % 12;
  const month = far.toLocaleString("en-US", { month: "short" });
  planLimit.note(`You've hit your weekly limit · resets ${month} ${far.getDate()}, ${hour}${far.getHours() < 12 ? "am" : "pm"}`, now);
  expect(planLimit.until(now)).not.toBeNull();
  expect(planLimit.room()).rejects.toThrow("Your Claude plan is used up until");
  planLimit.reset();
  // A reset a moment away: waited out, stopped by the signal.
  planLimit.note("You've hit your limit", now);
  const stop = new AbortController();
  const waiting = planLimit.room(stop.signal);
  stop.abort();
  expect(waiting).rejects.toThrow("Stopped.");
  planLimit.reset();
  expect(planLimit.until()).toBeNull();
  await planLimit.room();
});

test("each day's Claude use is kept by kind of call, with the limits hit, for the report", () => {
  const home = fs.mkdtempSync(join(os.tmpdir(), "edit-usage-"));
  try {
    usage.use(home);
    const day = new Date(2026, 10, 4, 12).getTime();
    usage.record("Claude opus writing section 1 of 5", 0.4, day);
    usage.record("Claude opus writing section 2 of 5 (repair turn)", 0.6, day);
    usage.record("Claude opus watching footage", 0.1, day);
    usage.record("edit chat opus", 8, day);
    usage.limitHit(day);
    usage.record("edit chat opus", 2, day - 86_400_000);
    // Read back from the file, as after a restart.
    usage.use(home);
    expect(usage.reportLines(8, day)).toEqual([
      "2026-11-04: $9.10 at API prices over 4 calls (edit chat opus $8.00 ×1; Claude opus writing section N of N $1.00 ×2; Claude opus watching footage $0.10 ×1); plan used up 1×",
      "2026-11-03: $2.00 at API prices over 1 calls (edit chat opus $2.00 ×1)",
    ]);
  } finally {
    usage.use("/nonexistent-never-written");
    fs.rmSync(home, { recursive: true, force: true });
  }
});
