import { expect, test } from "bun:test";

import { onlySoundChanged } from "../src/edit_tools.ts";
import type { Project } from "../src/model.ts";
import { project } from "./helpers/model.ts";

const withClips = (clips: unknown[]): Project => {
  const p = project("rebase");
  p.clips = clips as Project["clips"];
  return p;
};
const text = (id: string, words: string) => ({ id, type: "text", track: "v2", start: 0, duration: 30, text: words });
const sound = (id: string, start: number) => ({ id, type: "audio", track: "a2", start, duration: 30, media: "m1" });

test("a_plan_holds_over_the_agents_own_sounds_and_starring", () => {
  const before = withClips([text("t1", "he was murdered")]);
  // Its own add_from_library and mute_house_words between context and plan.
  expect(onlySoundChanged(before, withClips([text("t1", "he was m******d"), sound("s1", 10)]))).toBe(true);
  // Anything else that moved is a real conflict.
  expect(onlySoundChanged(before, withClips([{ ...text("t1", "he was murdered"), start: 5 }]))).toBe(false);
  expect(onlySoundChanged(before, withClips([text("t1", "he was murdered"), text("t2", "new")]))).toBe(false);
});

import { capIssues, ISSUES_PER_KIND } from "../src/edit_tools.ts";

test("an_audit_stays_readable_however_much_it_finds", () => {
  const many = Array.from({ length: 819 }, (_, at) => ({ kind: "unsubtitled_speech", start: at }));
  const cuts = Array.from({ length: 40 }, (_, at) => ({ kind: "cut_mid_word", at }));
  // Nothing subtitled yet: the unsubtitled lines are one note.
  const fresh = capIssues([...many, ...cuts], false);
  expect(fresh.filter((issue) => issue.kind === "unsubtitled_speech")).toEqual([
    { kind: "unsubtitled_speech", lines: 819, note: "nothing is subtitled yet: the subtitles stage covers these" },
  ]);
  expect(fresh.filter((issue) => issue.kind === "cut_mid_word").length).toBe(ISSUES_PER_KIND + 1);
  // Subtitled: the first of each kind and a count of the rest.
  const later = capIssues([...many, ...cuts], true);
  expect(later.length).toBe(2 * (ISSUES_PER_KIND + 1));
  expect(later.at(-2)).toEqual({ kind: "unsubtitled_speech", more: 819 - ISSUES_PER_KIND, note: `${819 - ISSUES_PER_KIND} more unsubtitled_speech after these (fix these, then look again)` });
});
