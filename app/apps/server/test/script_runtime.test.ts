// e-code times: an empty or mistyped time is an error, never timeline 0.

import { expect, test } from "bun:test";

import { seconds } from "../src/script_runtime.ts";
import { CUT_IN_GUIDE, JUDGMENT_GUIDE, extraGuides, formatOf, plain } from "../src/writer/formats.ts";

test("seconds reads plain and colon times and refuses the rest", () => {
  expect(seconds(83.4)).toBe(83.4);
  expect(seconds("83.4")).toBe(83.4);
  expect(seconds("1:23.4")).toBeCloseTo(83.4);
  expect(seconds("1:02:03")).toBe(3723);
  for (const bad of ["", " ", ":", "1:", "-5", "1::2", "a:b"] as const) {
    expect(() => seconds(bad)).toThrow("not a time");
  }
  expect(() => seconds(-5)).toThrow("not a time");
});

test("the writer guides sent to Script mode name no editor tools that don't exist there", () => {
  const sent = [plain(CUT_IN_GUIDE), plain(JUDGMENT_GUIDE), ...extraGuides(formatOf("interrogation", true, "When it happened")).map(([, guide]) => guide)].join("\n");
  for (const dead of ["write_cut_ins", "insert_cut_in", "read_script", "read_assets", "curate_assets", "inspect_frames", "set_reuse_link"]) {
    expect(sent).not.toContain(dead);
  }
});
