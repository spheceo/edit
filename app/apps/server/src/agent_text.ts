// The agent's text: Markdown in agent/ at the top of the repo, written by
// people rather than agents. agent_files.ts reads the folder at build time
// (a Bun macro), so a new file there is part of the build by itself:
//
//     agent/instructions.md                    the core house style
//     agent/skills/<name>.md                   a house skill
//     agent/styles/<style>/notes.md            a kind of video's own rules
//     agent/styles/<style>/skills/<name>.md    its own skill, or its version of a house one
//     agent/shared/<name>.md                   text taken in with {{> name}}
//     agent/writer/<name>.md                   Script mode's guides (Repack's, word for word)
//
// A file may open with frontmatter (`---` lines of `key: value`); a house
// skill's `description` is its line in the instructions' SKILLS list, which
// `{{skills}}` in instructions.md stands for.

import { agentFiles } from "./agent_files.ts" with { type: "macro" };

const FILES: Record<string, string> = agentFiles();

/** A Markdown file of the agent's: its frontmatter and its text. */
export interface Text {
  fields: Record<string, string>;
  body: string;
}

const SHARED: Record<string, string> = {};
for (const [path, file] of Object.entries(FILES)) {
  const name = /^shared\/(.+)\.md$/.exec(path)?.[1];
  if (name !== undefined) SHARED[name] = parse(file, {}).body;
}

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

/** The skills in `dir` ("skills/"), by name. */
function skillsIn(dir: string): Skill[] {
  const skills: Skill[] = [];
  for (const [path, file] of Object.entries(FILES)) {
    if (!path.startsWith(dir)) continue;
    const name = /^([a-z0-9-]+)\.md$/.exec(path.slice(dir.length))?.[1];
    if (name === undefined) continue;
    const { fields, body } = parse(file);
    skills.push({ name, description: fields.description ?? "", body });
  }
  return skills;
}

/** The house skills: edit-workflow first (the whole edit), the rest by name. */
export const SKILLS: readonly Skill[] = skillsIn("skills/").sort(
  (a, b) => Number(b.name === "edit-workflow") - Number(a.name === "edit-workflow") || a.name.localeCompare(b.name),
);

/** The core house style; `{{skills}}` is the SKILLS list. */
export const INSTRUCTIONS = parse(FILES["instructions.md"] ?? "").body.replace(
  "{{skills}}",
  SKILLS.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n"),
);

/** Each style's own rules and skills, by the style's folder name. */
export const STYLES: Record<string, { notes: string; skills: Skill[]; voice?: string }> = {};
for (const path of Object.keys(FILES)) {
  const style = /^styles\/([a-z0-9-]+)\//.exec(path)?.[1];
  if (style === undefined || style in STYLES) continue;
  const notes = FILES[`styles/${style}/notes.md`];
  const parsed = notes === undefined ? null : parse(notes);
  // `voice: <ElevenLabs voice id>` in the notes' frontmatter: its narrator, where it isn't the house voice.
  const voice = parsed?.fields.voice;
  STYLES[style] = { notes: parsed?.body ?? "", skills: skillsIn(`styles/${style}/skills/`), ...(voice ? { voice } : {}) };
}

/**
 * One of Script mode's guides (agent/writer/<name>.md), exactly as written:
 * Repack's guides and Writer's house rules go to the script builds whole,
 * frontmatter, partials and trailing newline untouched.
 */
export function writerGuide(name: string): string {
  const text = FILES[`writer/${name}.md`];
  if (text === undefined) throw new Error(`agent text: no agent/writer/${name}.md`);
  return text;
}

/** Every file's path under agent/ (the test checks each one is used). */
export const PATHS: readonly string[] = Object.keys(FILES);
