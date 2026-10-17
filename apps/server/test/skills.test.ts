import { expect, test } from "bun:test";

import { parseSkills } from "../scripts/dump-skills.ts";
import { INSTRUCTIONS } from "../src/mcp/instructions.ts";
import { get, SKILLS } from "../src/skills.ts";
import * as styles from "../src/styles.ts";

test("every_skill_the_instructions_list_exists_and_the_workflow_names_real_skills", () => {
  for (const skill of SKILLS) expect(INSTRUCTIONS).toContain(`- ${skill.name}: `);
  const workflow = get("edit-workflow")!.body;
  for (const name of ["research", "intro", "transitions", "cut-ins", "outro", "subtitles", "music-and-sound", "final-pass"]) {
    expect(workflow).toContain(name);
    expect(get(name)).toBeDefined();
  }
});

test("every_style_has_the_house_skills", () => {
  for (const style of styles.ALL) {
    for (const skill of SKILLS) {
      expect(styles.skillNames(style)).toContain(skill.name);
      expect(styles.skill(style, skill.name)).toBeDefined();
    }
    expect(styles.instructions(style)).toContain(style);
  }
  expect(styles.instructions("bodycam")).toBe("THIS VIDEO'S STYLE: bodycam. The house style above applies to it.");
  expect(styles.allSkillNames()).toEqual(SKILLS.map((skill) => skill.name));
});

// While the Rust server is the parity reference, skills.rs is where the
// skills are written; skills_text.ts is dumped from it (scripts/dump-skills.ts).
const SKILLS_RS = `${import.meta.dir}/../../../crates/edit/src/skills.rs`;

test.skipIf(!(await Bun.file(SKILLS_RS).exists()))("the skills are skills.rs's word for word", async () => {
  const rust = parseSkills(await Bun.file(SKILLS_RS).text());
  expect(rust.length).toBe(10);
  expect(SKILLS.map((skill) => ({ ...skill }))).toEqual(rust);
});
