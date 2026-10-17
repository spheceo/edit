// Takes the skills' text from crates/edit/src/skills.rs (the house style the
// agent loads with the `skill` tool), so the TS server's skills are the Rust
// server's word for word while it's the parity reference:
//
//     bun apps/server/scripts/dump-skills.ts
//
// Writes src/skills_text.ts. A test fails when skills.rs changed without a dump.

import * as fs from "node:fs";
import * as path from "node:path";

const source = path.join(import.meta.dir, "../../../crates/edit/src/skills.rs");
const out = path.join(import.meta.dir, "../src/skills_text.ts");

/** Every `Skill { name: "…", body: r#"…"# }` in skills.rs, in order. */
export function parseSkills(rust: string): { name: string; body: string }[] {
  const found: { name: string; body: string }[] = [];
  const pattern = /name:\s*"([^"]+)",\s*body:\s*r#"([\s\S]*?)"#,/g;
  for (const match of rust.matchAll(pattern)) found.push({ name: match[1]!, body: match[2]! });
  return found;
}

if (import.meta.main) {
  const skills = parseSkills(fs.readFileSync(source, "utf8"));
  // Template literals keep the text readable; only backslashes, backticks and `${` need escaping.
  const escape = (text: string) => text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
  const body = skills
    .map((skill) => `  {\n    name: ${JSON.stringify(skill.name)},\n    body: \`${escape(skill.body)}\`,\n  },`)
    .join("\n");
  fs.writeFileSync(
    out,
    `// The skills' text (skills.rs SKILLS), taken from the Rust source by
// scripts/dump-skills.ts. Edit the Rust original while it's the parity
// reference, then dump again. Keep the wording the team's: these rules were
// learnt edit by edit.

export const SKILL_TEXT: { name: string; body: string }[] = [
${body}
];
`,
  );
  console.log(`${skills.length} skills from ${source}`);
}
