import { expect, test } from "bun:test";

import * as fs from "node:fs";

import { human, info, lines, open, rotation, scrub, timeAsync, timeOn, timings } from "../src/diag.ts";
import { scratch } from "./helpers/home.ts";

test("records_failures_and_timings", () => {
  expect(timeOn("test", "diag ok", "x", () => 1)).toBe(1);
  expect(() =>
    timeOn("test", "diag fails", "x", () => {
      throw new Error("boom");
    }),
  ).toThrow("boom");
  const fails = timings().find((timing) => timing.name === "diag fails")!;
  expect([fails.count, fails.failed]).toEqual([1, 1]);
  expect(lines(2000).some((line) => line.level === "error" && line.message.includes("diag fails failed"))).toBe(true);
  expect(human(850)).toBe("850 ms");
  expect(human(185_000)).toBe("3 min 05 s");
});

test("async work is timed and its failure named", async () => {
  await expect(timeAsync("test", "diag async", Promise.reject(new Error("nope")))).rejects.toThrow("nope");
  const timing = timings().find((entry) => entry.name === "diag async")!;
  expect(timing.failed).toBe(1);
  expect(
    lines(5).some((line) => line.message.startsWith("diag async failed after") && line.message.endsWith(": nope")),
  ).toBe(true);
  expect(human(12_400)).toBe("12.4 s");
});

test("lines go to the log file", () => {
  const { dir, cleanup } = scratch("diag");
  try {
    open(dir);
    timeOn("test", "diag file", "the subject", () => {
      try {
        throw new Error("written");
      } catch {
        return 0;
      }
    });
    expect(() =>
      timeOn("test", "diag file fails", "the subject", () => {
        throw new Error("to the file");
      }),
    ).toThrow();
    const log = fs.readFileSync(`${dir}/logs/edit.log`, "utf8");
    expect(log).toContain("INFO [edit] started");
    expect(log).toMatch(/\d+ ERROR \[test\] diag file fails failed after .*: the subject: to the file/);
  } finally {
    cleanup();
  }
});

test("presigned URLs never reach a log line", () => {
  expect(scrub("GET https://r2.example/edit/x?X-Amz-Signature=abc failed: 403")).toBe("GET <url> failed: 403");
  expect(scrub("'http://a/b' and \"https://c/d\"")).toBe("'<url>' and \"<url>\"");
  expect(scrub("nothing to hide")).toBe("nothing to hide");
});

test("the log is set aside as it grows, the last five kept", () => {
  const { dir, cleanup } = scratch("diag-rotate");
  const was = { ...rotation };
  try {
    rotation.bytes = 2000;
    open(dir);
    for (let n = 0; n < 200; n++) info("test", `line ${n} ${"x".repeat(100)}`);
    const logs = fs.readdirSync(`${dir}/logs`).sort();
    expect(logs).toEqual(["edit.log", "edit.log.1", "edit.log.2", "edit.log.3", "edit.log.4", "edit.log.5"]);
    // Newest in edit.log, then .1, .2…: each set-aside file's lines come before the next newer one's.
    const first = (name: string) => Number(/line (\d+)/.exec(fs.readFileSync(`${dir}/logs/${name}`, "utf8"))![1]);
    expect(first("edit.log.5")).toBeLessThan(first("edit.log.4"));
    expect(first("edit.log.1")).toBeLessThan(first("edit.log"));
  } finally {
    Object.assign(rotation, was);
    cleanup();
  }
});
