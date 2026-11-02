import { expect, test } from "bun:test";

import { parse, PATHS, SKILLS, STYLES as TEXT } from "../src/agent_text.ts";
import { STYLES } from "../src/model.ts";
import { TOOLS } from "../src/mcp/registry.ts";
import * as styles from "../src/styles.ts";

test("every_file_in_agent_is_one_the_server_reads", () => {
  const known = /^(instructions\.md|shared\/[a-z0-9-]+\.md|skills\/[a-z0-9-]+\.md|writer\/[a-z0-9-]+\.md|ideas\/[a-z0-9-]+\.md|thumbnails\/[a-z0-9-]+\.md|styles\/[a-z0-9-]+\/(notes\.md|walkthrough\.md|skills\/[a-z0-9-]+\.md))$/;
  for (const path of PATHS) expect(path).toMatch(known);
  expect(PATHS).toContain("instructions.md");
  const names = STYLES.map((style) => style.value as string);
  for (const style of Object.keys(TEXT)) expect(names).toContain(style);
});

test("every_house_skill_has_a_description_and_the_skill_tool_offers_every_skill", () => {
  for (const skill of SKILLS) expect(skill.description).not.toBe("");
  const tool = TOOLS.find((tool) => tool.name === "skill")!;
  expect(tool.inputSchema.properties.name!.enum).toEqual(styles.allSkillNames());
  expect(styles.allSkillNames()).toContain("feedback");
});

test("each_story_style_has_a_walkthrough_its_notes_point_to", () => {
  for (const style of ["bodycam", "interrogation", "courtroom"] as const) {
    const own = styles.skill(style, "walkthrough");
    expect(own?.body.length ?? 0).toBeGreaterThan(800);
    expect(styles.instructions(style)).toContain("skill walkthrough");
  }
  // A style without one has none to load.
  expect(styles.skill("shorts", "walkthrough")).toBeUndefined();
});

test("frontmatter_and_partials", () => {
  expect(parse("---\ndescription: One line.\nlearnt_from: a video\n---\n\nBody {{> x}}.\n", { x: "here" })).toEqual({
    fields: { description: "One line.", learnt_from: "a video" },
    body: "Body here.",
  });
  expect(parse("No frontmatter.\n", {}).body).toBe("No frontmatter.");
  expect(() => parse("{{> missing}}", {})).toThrow("agent/shared/missing.md");
});
