// Nov 5: a horror, commentary or Shorts project's cloud summary was read as
// bodycam, by Edit and by the relay, so someone given only Horror edits
// couldn't see one and a bodycam editor could.
import { expect, test } from "bun:test";

import { mayWork as relayMayWork, shapeOf } from "../../relay/src/authz.ts";
import { cloudShape } from "../src/cloud_projects.ts";
import { mayWork } from "../src/kinds.ts";
import { STYLES } from "../src/model.ts";

test("every style keeps its own kind in the cloud", () => {
  for (const { value } of STYLES) {
    const summary = { style: value, subtitles: false, footageOnly: false };
    expect(cloudShape(summary).style).toBe(value);
    expect(shapeOf(summary).style).toBe(value);
  }
  expect(cloudShape({ style: "nope" }).style).toBe("bodycam");
  expect(shapeOf({ style: "nope" }).style).toBe("bodycam");
});

test("Horror edits alone opens horror projects and nothing else", () => {
  const given = new Set(["edit.horror"]);
  const horror = { style: "horror", subtitles: false, footageOnly: false };
  const bodycam = { style: "bodycam", subtitles: false, footageOnly: false };
  expect(mayWork(cloudShape(horror), given)).toBe(true);
  expect(relayMayWork(shapeOf(horror), given)).toBe(true);
  expect(mayWork(cloudShape(bodycam), given)).toBe(false);
  expect(relayMayWork(shapeOf(bodycam), given)).toBe(false);
  expect(relayMayWork(shapeOf(horror), new Set(["edit.bodycam"]))).toBe(false);
});
