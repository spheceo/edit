// What the agent is taught for each kind of video (a project's style:
// bodycam, interrogation, courtroom). They all share the house
// style (the MCP instructions and the skills) for now. A style's own rules go
// in its guide: `notes` are added to the agent's instructions, and `skills`
// are added to the shared ones (one with a shared skill's name replaces it
// for that style), so the effects stay the same and what the agent picks
// from them can differ.

import { STYLES, type Style } from "./model.ts";
import * as skills from "./skills.ts";
import type { Skill } from "./skills.ts";

export interface Guide {
  /** Rules for this kind of video only, read after the house style. */
  notes: string;
  /** Its own skills, and its versions of shared ones. */
  skills: readonly Skill[];
}

const GUIDES: Record<Style, Guide> = {
  bodycam: { notes: "", skills: [] },
  interrogation: { notes: "", skills: [] },
  courtroom: { notes: "", skills: [] },
};

/** Every style, in edit-core's order (Style::ALL). */
export const ALL: readonly Style[] = STYLES.map((style) => style.value);

export function guide(style: Style): Guide {
  return GUIDES[style] ?? GUIDES.bodycam;
}

/** The skill called `name` for this style: its own version, else the house one. */
export function skill(style: Style, name: string): Skill | undefined {
  return guide(style).skills.find((own) => own.name === name) ?? skills.get(name);
}

/** The skills this style can load. */
export function skillNames(style: Style): string[] {
  const names = skills.SKILLS.map((own) => own.name);
  for (const own of guide(style).skills) if (!names.includes(own.name)) names.push(own.name);
  return names;
}

/** Every skill name across the styles (the skill tool's choices). */
export function allSkillNames(): string[] {
  const names: string[] = [];
  for (const style of ALL) for (const name of skillNames(style)) if (!names.includes(name)) names.push(name);
  return names;
}

/** What the agent's instructions say about the project's style. */
export function instructions(style: Style): string {
  const notes = guide(style).notes.trim();
  let out = `THIS VIDEO'S STYLE: ${style}. The house style above applies to it`;
  if (notes === "") {
    out += ".";
  } else {
    out += ", with these rules for this kind of video (they win where they differ):\n";
    out += notes;
  }
  return out;
}
