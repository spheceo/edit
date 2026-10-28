// finished.ts: a finished video of ours by its review link, played untouched.

import { expect, test } from "bun:test";

import { lookUpFinished, sourceLines } from "../src/compilation_input.ts";
import { proxyKey } from "../src/cloud_media.ts";
import { reviewCode, reviewOf } from "../src/finished.ts";
import type { ScriptBlock } from "../src/model.ts";
import { footageFile, REUSE } from "../src/script.ts";

const LINK = "https://feedback.spheceo.com/r/E4l2mySUxtylewfsxVZFWA";

test("a review link is a finished video's, and nothing else is", () => {
  expect(reviewCode(LINK)).toBe("E4l2mySUxtylewfsxVZFWA");
  expect(reviewCode(`${LINK}/`)).toBe("E4l2mySUxtylewfsxVZFWA");
  expect(reviewCode("https://feedback.spheceo.com/s/E4l2mySUxtylewfsxVZFWA")).toBeNull();
  expect(reviewCode("https://evil.example/r/E4l2mySUxtylewfsxVZFWA")).toBeNull();
  expect(footageFile(LINK)).toBe("feedback:E4l2mySUxtylewfsxVZFWA");
  expect(reviewOf("review:p1793208962795-1/2")).toEqual({ project: "p1793208962795-1", version: 2 });
  expect(reviewOf("review:../x/2")).toBeNull();
  // Pasted, it's a finished case, played as it is.
  expect(sourceLines(`Case 3: ${LINK}`)).toEqual([{ url: LINK, kind: "video", reuse: true, case: "3" }]);
  // Its proxy: one per version.
  expect(proxyKey("review:p1793208962795-1/2")).toBe("edit/proxies/review/p1793208962795-1/2.mp4");
});

test("review links are looked up once each, before the import, into untouched finished sections", async () => {
  const blocks: ScriptBlock[] = [
    { kind: "footage", url: LINK, file: "feedback:E4l2mySUxtylewfsxVZFWA", start: 0, end: 1, label: REUSE, notes: ["Reuse: link"] },
    { kind: "narration", text: "And then." },
    { kind: "footage", url: LINK, file: "feedback:E4l2mySUxtylewfsxVZFWA", start: 0, end: 1, label: "whole" },
  ];
  const asked: string[] = [];
  await lookUpFinished(blocks, async (url) => {
    asked.push(url);
    return { file: "review:p1793208962795-1/2", title: "Cop Beats a Teen", version: 2 };
  });
  expect(asked).toEqual([LINK]);
  const footage = blocks.filter((block): block is Extract<ScriptBlock, { kind: "footage" }> => block.kind === "footage");
  expect(footage.map((block) => [block.file, block.label])).toEqual([
    ["review:p1793208962795-1/2", REUSE],
    ["review:p1793208962795-1/2", REUSE],
  ]);
  expect(footage[0]!.notes).toContain("Finished video: Cop Beats a Teen (v2), played as it is");
  // One that isn't ours stops the import, saying so.
  const other: ScriptBlock[] = [{ kind: "footage", url: LINK, file: "feedback:E4l2mySUxtylewfsxVZFWA", start: 0, end: 1, label: REUSE }];
  await expect(lookUpFinished(other, async () => Promise.reject(new Error("That review link isn't one of Edit's videos")))).rejects.toThrow("isn't one of Edit's videos");
});
