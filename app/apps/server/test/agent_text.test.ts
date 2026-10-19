import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as nodePath from "node:path";

import { parse, SKILLS } from "../src/agent_text.ts";
import tools from "../src/mcp/tools.json";
import * as styles from "../src/styles.ts";

const AGENT = nodePath.join(import.meta.dir, "../../../../agent");

test("every_file_in_agent_is_imported_and_every_import_is_a_file", () => {
  const source = fs.readFileSync(nodePath.join(import.meta.dir, "../src/agent_text.ts"), "utf8");
  const imported = [...source.matchAll(/from "\.\.\/\.\.\/\.\.\/\.\.\/agent\/([^"]+)" with \{ type: "text" \}/g)].map((m) => m[1]!).sort();
  const files = (fs.readdirSync(AGENT, { recursive: true }) as string[]).filter((file) => file.endsWith(".md")).sort();
  expect(imported).toEqual(files);
  // A file imported but left out of SKILLS or STYLES is unused: the import would be flagged by
  // noUnusedLocals, so typecheck catches that half.
});

test("every_house_skill_has_a_description_and_the_skill_tool_offers_every_skill", () => {
  for (const skill of SKILLS) expect(skill.description).not.toBe("");
  const tool = (tools as { name: string; inputSchema: { properties: { name: { enum: string[] } } } }[]).find((tool) => tool.name === "skill")!;
  expect(tool.inputSchema.properties.name.enum).toEqual(styles.allSkillNames());
});

test("frontmatter_and_partials", () => {
  expect(parse("---\ndescription: One line.\nlearnt_from: a video\n---\n\nBody {{> x}}.\n", { x: "here" })).toEqual({
    fields: { description: "One line.", learnt_from: "a video" },
    body: "Body here.",
  });
  expect(parse("No frontmatter.\n", {}).body).toBe("No frontmatter.");
  expect(() => parse("{{> missing}}", {})).toThrow("agent/shared/missing.md");
});
