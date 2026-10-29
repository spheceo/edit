import { expect, test } from "bun:test";

import { parse, PATHS, SKILLS, STYLES as TEXT } from "../src/agent_text.ts";
import { STYLES } from "../src/model.ts";
import { TOOLS } from "../src/mcp/registry.ts";
import * as styles from "../src/styles.ts";

test("every_file_in_agent_is_one_the_server_reads", () => {
  const known = /^(instructions\.md|shared\/[a-z0-9-]+\.md|skills\/[a-z0-9-]+\.md|writer\/[a-z0-9-]+\.md|styles\/[a-z0-9-]+\/(notes\.md|skills\/[a-z0-9-]+\.md))$/;
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

test("frontmatter_and_partials", () => {
  expect(parse("---\ndescription: One line.\nlearnt_from: a video\n---\n\nBody {{> x}}.\n", { x: "here" })).toEqual({
    fields: { description: "One line.", learnt_from: "a video" },
    body: "Body here.",
  });
  expect(parse("No frontmatter.\n", {}).body).toBe("No frontmatter.");
  expect(() => parse("{{> missing}}", {})).toThrow("agent/shared/missing.md");
});
