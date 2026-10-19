// The agent's text: Markdown in agent/ at the top of the repo, written by
// people rather than agents. Each file is imported here `with { type: "text" }`
// (so `bun build --compile` carries it); a new file needs its import and its
// place below, and test/agent_text.test.ts fails until it has them.
//
// A file may open with frontmatter (`---` lines of `key: value`); a skill's
// `description` is its line in the instructions' SKILLS list. `{{> name}}`
// takes in agent/shared/<name>.md.

import instructions from "../../../../agent/instructions.md" with { type: "text" };
import namesFirst from "../../../../agent/shared/names-first.md" with { type: "text" };
import editWorkflow from "../../../../agent/skills/edit-workflow.md" with { type: "text" };
import research from "../../../../agent/skills/research.md" with { type: "text" };
import intro from "../../../../agent/skills/intro.md" with { type: "text" };
import transitions from "../../../../agent/skills/transitions.md" with { type: "text" };
import cutIns from "../../../../agent/skills/cut-ins.md" with { type: "text" };
import outro from "../../../../agent/skills/outro.md" with { type: "text" };
import subtitles from "../../../../agent/skills/subtitles.md" with { type: "text" };
import subtitleVideo from "../../../../agent/skills/subtitle-video.md" with { type: "text" };
import musicAndSound from "../../../../agent/skills/music-and-sound.md" with { type: "text" };
import finalPass from "../../../../agent/skills/final-pass.md" with { type: "text" };
import feedback from "../../../../agent/skills/feedback.md" with { type: "text" };
import interrogationNotes from "../../../../agent/styles/interrogation/notes.md" with { type: "text" };
import interrogationEditWorkflow from "../../../../agent/styles/interrogation/skills/edit-workflow.md" with { type: "text" };
import interrogationFinalPass from "../../../../agent/styles/interrogation/skills/final-pass.md" with { type: "text" };
import interrogationIntro from "../../../../agent/styles/interrogation/skills/intro.md" with { type: "text" };
import interrogationOutro from "../../../../agent/styles/interrogation/skills/outro.md" with { type: "text" };
import interrogationSubtitles from "../../../../agent/styles/interrogation/skills/subtitles.md" with { type: "text" };
import interrogationTransitions from "../../../../agent/styles/interrogation/skills/transitions.md" with { type: "text" };
import courtroomNotes from "../../../../agent/styles/courtroom/notes.md" with { type: "text" };
import courtroomEditWorkflow from "../../../../agent/styles/courtroom/skills/edit-workflow.md" with { type: "text" };
import courtroomOutro from "../../../../agent/styles/courtroom/skills/outro.md" with { type: "text" };
import courtroomTransitions from "../../../../agent/styles/courtroom/skills/transitions.md" with { type: "text" };

/** A Markdown file of the agent's: its frontmatter and its text. */
export interface Text {
  fields: Record<string, string>;
  body: string;
}

const SHARED: Record<string, string> = { "names-first": parse(namesFirst, {}).body };

/** The frontmatter and the text, partials taken in (one trailing newline dropped). */
export function parse(file: string, shared: Record<string, string> = SHARED): Text {
  const fields: Record<string, string> = {};
  let body = file;
  const front = /^---\n([\s\S]*?)\n---\n\n?/.exec(file);
  if (front) {
    for (const line of front[1]!.split("\n")) {
      const at = line.indexOf(": ");
      if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 2).trim();
    }
    body = file.slice(front[0].length);
  }
  if (body.endsWith("\n")) body = body.slice(0, -1);
  body = body.replace(/\{\{> ([a-z0-9-]+)\}\}/g, (_, name: string) => {
    const text = shared[name];
    if (text === undefined) throw new Error(`agent text: no agent/shared/${name}.md`);
    return text;
  });
  return { fields, body };
}

export interface Skill {
  name: string;
  /** Its line in the SKILLS list (house skills only). */
  description: string;
  body: string;
}

function skills(files: [string, string][]): Skill[] {
  return files.map(([name, file]) => {
    const { fields, body } = parse(file);
    return { name, description: fields.description ?? "", body };
  });
}

/** The house skills, in the order the instructions list them. */
export const SKILLS: readonly Skill[] = skills([
  ["edit-workflow", editWorkflow],
  ["research", research],
  ["intro", intro],
  ["transitions", transitions],
  ["cut-ins", cutIns],
  ["outro", outro],
  ["subtitles", subtitles],
  ["subtitle-video", subtitleVideo],
  ["music-and-sound", musicAndSound],
  ["final-pass", finalPass],
  ["feedback", feedback],
]);

/** The core house style; `{{skills}}` is the SKILLS list. */
export const INSTRUCTIONS = parse(instructions).body.replace(
  "{{skills}}",
  SKILLS.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n"),
);

/** Each style's own rules (agent/styles/<style>/notes.md) and skills. */
export const STYLES = {
  interrogation: {
    notes: parse(interrogationNotes).body,
    skills: skills([
      ["edit-workflow", interrogationEditWorkflow],
      ["intro", interrogationIntro],
      ["transitions", interrogationTransitions],
      ["outro", interrogationOutro],
      ["subtitles", interrogationSubtitles],
      ["final-pass", interrogationFinalPass],
    ]),
  },
  courtroom: {
    notes: parse(courtroomNotes).body,
    skills: skills([
      ["edit-workflow", courtroomEditWorkflow],
      ["transitions", courtroomTransitions],
      ["outro", courtroomOutro],
    ]),
  },
};
