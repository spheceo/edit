import { expect, test } from "bun:test";
import { cantBeHad, leftOver } from "../src/put_off.ts";

test("a turn's last message: the items it says it didn't get to, under a heading or on their own (Nov 6, the horror edit)", () => {
  // The in-app agent's own ending, two turns running.
  const ending = [
    "I worked through the notes, but the picture-over-text fix and several other notes are still open.",
    "",
    "**Done this turn**",
    "- **1:30:** the stones jump is re-pointed to the right moment.",
    "- **2:30:** the linked study is shown as a card with a marker on it.",
    "",
    "**Not done or not working**",
    "- **3:40:** the Windows-XP-style profile-picture pop-up isn't built.",
    "- **3:25 and 3:31:** the background switch and the text-inside-box note weren't touched.",
    "- **4:44, 5:18, 5:40:** not done.",
    "",
    "**Audit leftovers**",
    "- Reused-source warnings.",
  ].join("\n");
  expect(leftOver(ending)).toEqual([
    "**3:40:** the Windows-XP-style profile-picture pop-up isn't built.",
    "**3:25 and 3:31:** the background switch and the text-inside-box note weren't touched.",
    "**4:44, 5:18, 5:40:** not done.",
  ]);
  expect(leftOver("**Still open:**\n- **1:58 caption:** the words\n- **White text**")).toEqual(["**1:58 caption:** the words", "**White text**"]);
  // Prose alone counts when there are no items; a finished turn has nothing left.
  expect(leftOver("I didn't get to the rest.")).toEqual(["I didn't get to the rest."]);
  expect(leftOver("**Done**\n- Every note is fixed and the audit is clean.")).toEqual([]);
});

test("an item saying what stops it is not sent back as put off (Nov 9, ModelingWorks)", () => {
  const text = [
    "Everything else is on screen.",
    "",
    "**Still open**",
    "- **Not done: block 17, ModelingWorks.** The Wayback Machine only has a parked-domain placeholder for modelingworks.com, with nothing of the site itself, so I couldn't show it on screen.",
    "- Not done: the CBS article, ran out of time.",
  ].join("\n");
  expect(leftOver(text)).toEqual(["Not done: the CBS article, ran out of time."]);
  expect(cantBeHad("the video is private to its owner")).toBe(true);
  expect(cantBeHad("not reached this turn")).toBe(false);
});
