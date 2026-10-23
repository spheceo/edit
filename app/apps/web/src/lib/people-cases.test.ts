// The page's copy of the people rule (people.ts) against edit-core's own verdicts on the
// same projects (people-cases.json, written by edit-core's `people_rule_cases_for_the_page`):
// the two drifted once, and the preview refused Judge EXPLODES' white courtroom subtitles.

import { describe, expect, it } from "vitest";

import cases from "./people-cases.json";
import { peopleProblem } from "./people";
import type { Project } from "./types";

describe("the page's people rule agrees with edit-core's", () => {
  for (const one of cases as unknown as { name: string; ok: boolean; project: Project }[]) {
    it(one.name, () => {
      expect(peopleProblem(one.project) === null).toBe(one.ok);
    });
  }
});
