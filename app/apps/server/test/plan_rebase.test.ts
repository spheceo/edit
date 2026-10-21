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
