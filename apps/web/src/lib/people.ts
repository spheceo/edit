// One colour per person (a `Project.people` entry): their clips are all in
// it, their label's colour when the clip has one, else their text's. The
// server's `Project::validate` refuses a save where one of a person's clips
// differs, so the UI recolours the person, never one of their clips.

import type { Clip, Project, Rgba } from "./types";

/** A colour as "#rrggbb" (alpha aside). */
export function toHex(color: Rgba): string {
  const byte = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 255);
  return `#${[color[0], color[1], color[2]].map((v) => byte(v).toString(16).padStart(2, "0")).join("")}`;
}

/** Whether `clip` names a person in `project`. */
export function personOf(project: Project, clip: Clip) {
  return clip.person === undefined ? undefined : project.people?.find((person) => person.id === clip.person);
}

/** Recolours everyone's clips of `clip`'s person (and the person) in `draft`; false when it names nobody. */
export function recolourPerson(draft: Project, clip: Clip, color: Rgba): boolean {
  const person = personOf(draft, clip);
  if (person === undefined) return false;
  person.color = toHex(color);
  for (const other of draft.clips) {
    if (other.person !== person.id || other.type !== "text") continue;
    const shown = other.style.label ?? other.style;
    shown.color = [color[0], color[1], color[2], shown.color[3]];
  }
  return true;
}
