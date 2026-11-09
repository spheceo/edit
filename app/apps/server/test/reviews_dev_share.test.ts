import { expect, test } from "bun:test";

import { DEFAULT_RELAY } from "../src/relay.ts";
import { devShareNote } from "../src/reviews.ts";

test("a share through a dev relay says its link opens nothing, never handed over as ready (Nov 9)", () => {
  expect(devShareNote(DEFAULT_RELAY)).toBe("");
  const said = devShareNote("https://edit-relay-dev.sphe-g-personal.workers.dev");
  expect(said).toContain("the link opens nothing on feedback.spheceo.com");
  expect(said).toContain("shared from a prod Edit");
});
