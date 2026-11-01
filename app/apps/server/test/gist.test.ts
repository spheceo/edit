// A tool's error output kept short (diag.gist), and a script's summary small
// enough for the cloud whatever its error (Nov 1: 545 KB of FFmpeg's lines as a
// script's error kept it out of the cloud: "The summary is too large").

import { expect, test } from "bun:test";

import type { Script } from "@edit/types/writer";

import { gist } from "../src/diag.ts";
import { summary } from "../src/writer/store.ts";

const FLOOD = ["[aac @ 0x1336043e0] channel element 0.0 duplicate"]
  .concat(Array.from({ length: 20_000 }, (_, i) => `[h264 @ 0x144204af0] Invalid NAL unit size (${16777217 + i} > ${175 + (i % 9)}).`))
  .concat(["[h264 @ 0x144204af0] Error splitting the input into NAL units."])
  .join("\n");

test("FFmpeg's flood of one message comes down to each message once, with how many lines were left out", () => {
  const short = gist(FLOOD);
  expect(short.length).toBeLessThan(700);
  expect(short).toContain("channel element 0.0 duplicate");
  expect(short).toContain("Invalid NAL unit size");
  expect(short).toContain("Error splitting the input");
  expect(short).toMatch(/\(and 19999 more lines\)$/);
  expect(gist("one line")).toBe("one line");
  expect(gist("")).toBe("");
});

test("a script's summary stays far under the cloud's 64 KB whatever its error", () => {
  const script = { id: "s1", title: "Mom Secretly Has a Baby", status: "error", stage: "", progress: 0, error: `could not extract audio: ${FLOOD}`, durationMs: 0, updatedAt: 0, words: [], clips: [], createdAt: 0 } as unknown as Script;
  const row = summary(script);
  expect(JSON.stringify(row).length).toBeLessThan(4_000);
  expect(row.error).toStartWith("could not extract audio:");
  expect(summary({ ...script, error: "short" }).error).toBe("short");
});
