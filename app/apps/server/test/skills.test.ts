import { expect, test } from "bun:test";

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
  // Bodycam is the house style; its notes only point to its worked edit.
  expect(styles.instructions("bodycam")).toBe(
    "THIS VIDEO'S STYLE: bodycam. The house style above applies to it, with these rules for this kind of video (they win where they differ):\n- A WORKED EDIT of this kind of video, stage by stage (what each stage made and the few calls it took): skill walkthrough, when you're unsure how a stage goes.",
  );
  // The house skills, and the styles' worked edits.
  expect(styles.allSkillNames()).toEqual([...SKILLS.map((skill) => skill.name), "walkthrough"]);
  // Interrogations and courtrooms have their own rules and versions of the workflow.
  expect(styles.instructions("interrogation")).toContain("INTERROGATION VIDEOS");
  expect(styles.instructions("courtroom")).toContain("COURTROOM VIDEO");
  for (const style of ["interrogation", "courtroom"] as const) {
    expect(styles.skill(style, "edit-workflow")).not.toBe(get("edit-workflow"));
  }
});
