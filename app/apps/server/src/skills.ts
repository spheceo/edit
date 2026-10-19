// The house style beyond the core, as skills the agent loads when it gets to
// that part of the edit (the `skill` tool). All of it in every
// request was ~14k tokens read again on every round trip; now each part comes
// in once, when it's needed. `edit-workflow` is the whole edit, stage by
// stage, in one turn ("start the editing workflow"). Each one's one-line
// summary is in the SKILLS list of the MCP instructions.

// Each is a file in agent/skills/ (agent_text.ts).

import { SKILLS, type Skill } from "./agent_text.ts";

export { SKILLS, type Skill };

export function get(name: string): Skill | undefined {
  return SKILLS.find((skill) => skill.name === name);
}
