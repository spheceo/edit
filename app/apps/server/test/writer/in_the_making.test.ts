// A file still being made is never synced nor left to the cloud
// (store.inTheMaking). Nov 1: a preview piece encoding as "….partial.mp4"
// went up with its script (498 MB), as the old test only knew ".partial".

import { expect, test } from "bun:test";

import { inTheMaking } from "../../src/writer/store.ts";

test("pieces mid-encode, downloads and hidden work files are in the making; finished footage isn't", () => {
  for (const name of ["1jKGSJSlkSEnHaQYmxUMW7vVvbJ1PjLif-_Extraction_1.2__Robyn_in_custody.partial.mp4", "clip.mp4.partial", "x.tmp", ".proxy-making.mp4", ".cutting-1-2-3.mp4", "A.PARTIAL.MOV"]) expect(inTheMaking(name)).toBe(true);
  for (const name of ["(Extraction_1.2)_Robyn_in_custody.mp4", "proxy.mp4", "partial interview.mp4", "the.partial.story.json.bak.mp4", "script.json"]) expect(inTheMaking(name)).toBe(false);
});
