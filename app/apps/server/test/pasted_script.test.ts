import { expect, test } from "bun:test";

import { pastedScript } from "../src/compilation_input.ts";

// Oct 30, the team: an external writer's Doc Edit's Google account can't open,
// and pasting its words lost the timestamps' links. New project's box keeps a
// rich paste's links as [text](url); that text is read as the Doc would be.
test("a Doc's words pasted with their links are read as the script", () => {
  const pasted = [
    "([41:21-41:32](https://youtu.be/4NiDAhqfVZc?t=2482)) + ([16:19‑16:28](https://www.youtube.com/watch?v=5uB7ysH2BtY&t=979))[[a]](#cmnt1)",
    "",
    "A group of cop watchers in Livingston, Texas, filmed police answering a call about a lawful gun, and days later they faced criminal warrants.",
    "([22:19-22:29](https://youtu.be/gmwUoZuYdxo?t=1339))",
    "Under oath, the officers behind those charges struggled to say what crime had actually been committed by anyone there.",
  ].join("\n");
  const parsed = pastedScript(pasted)!;
  expect(parsed).not.toBeNull();
  expect(parsed.blocks.filter((block) => block.kind === "footage").length).toBe(3);
  expect(parsed.blocks.filter((block) => block.kind === "narration").length).toBe(2);
  expect(JSON.stringify(parsed.blocks)).not.toContain("cmnt");
});

// Nov 12: a Doc taken as Markdown (Docs' export) escapes its brackets and marks
// its chapter titles in bold: the titles are shown, never voiced, as the Doc's own.
test("a Doc's Markdown keeps its chapter titles off the voice-over and loses its escapes", () => {
  const pasted = [
    "**HOOK** ",
    "\\[[4:49-4:55](https://drive.google.com/file/d/1gv3wq3IRO26Ani4h1OYibV7PrEqzzjoI/view)\\]  ",
    "Yea, keep going keep going\\!",
    "Police just arrived at the backyard of a quiet neighbourhood home in Columbus where they found Darrell shot.",
    "**ACT 1**",
    "\\[[2:52-4:31](https://drive.google.com/file/d/1gv3wq3IRO26Ani4h1OYibV7PrEqzzjoI/view)\\]",
    "On the afternoon of December 10th, 2024, a 911 dispatcher received an alarming call from East Moler Street.",
  ].join("\n");
  const parsed = pastedScript(pasted)!;
  expect(parsed.blocks.filter((block) => block.kind === "footage").map((block) => block.kind === "footage" && [block.start, block.end])).toEqual([[289, 295], [172, 271]]);
  const narration = parsed.blocks.flatMap((block) => (block.kind === "narration" ? [block.text] : [])).join("\n");
  expect(narration).not.toContain("ACT 1");
  expect(narration).not.toContain("\\");
  expect(narration).toContain("keep going!");
});

test("a list of video links, or a title, is not a pasted script", () => {
  expect(pastedScript("https://youtu.be/4NiDAhqfVZc\nhttps://youtu.be/gmwUoZuYdxo\nhttps://youtu.be/5uB7ysH2BtY")).toBeNull();
  expect(pastedScript("Case 1: [the video](https://youtu.be/4NiDAhqfVZc)")).toBeNull();
});
