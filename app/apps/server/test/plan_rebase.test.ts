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
  // A slowed shot swapped for its smoothed render (background smoothing).
  const shot = { id: "v1", type: "video", track: "v1", start: 0, duration: 60, media: "m1", source_in: 12, speed: 0.5 };
  expect(onlySoundChanged(withClips([shot]), withClips([{ ...shot, media: "m9", source_in: 0, speed: 1 }]))).toBe(true);
  expect(onlySoundChanged(withClips([shot]), withClips([{ ...shot, media: "m9", source_in: 0, speed: 1, start: 4 }]))).toBe(false);
  // highlight_evidence's marks on a card, on a track of their own (Nov 9: a plan, a highlight, a plan on the old revision).
  const card = { id: "k1", type: "video", track: "v1", start: 0, duration: 90, media: "m1", source_in: 0, speed: 1, name: "Horror · screenshot" };
  const was = withClips([card]);
  const marked = withClips([card, { id: "k2", type: "video", track: "v9", start: 10, duration: 80, media: "m2", source_in: 0, speed: 1, name: "Horror · marker" }]);
  marked.tracks = [...was.tracks, { id: "v9", kind: "video", name: "V9", hidden: false, muted: false, locked: false } as unknown as Project["tracks"][number]];
  expect(onlySoundChanged(was, marked)).toBe(true);
  // A mark on a track that already held other clips, or any other new picture, is a real change.
  const shared = withClips([card, { id: "k2", type: "video", track: "v1", start: 95, duration: 20, media: "m2", source_in: 0, speed: 1, name: "Horror · marker" }]);
  expect(onlySoundChanged(was, shared)).toBe(false);
  expect(onlySoundChanged(was, withClips([card, { ...card, id: "k3", name: "Horror · screenshot", start: 100 }]))).toBe(false);
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
