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

/** "#rrggbb" as bytes, or null (edit-core's parse_hex). */
function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(color);
  return match ? [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)] : null;
}

/**
 * White or a near-white grey (CIELAB lightness over 85, chroma under 15):
 * never a person's colour, since the words they say are white (edit-core's `whitish`).
 */
export function whitish([red, green, blue]: [number, number, number]): boolean {
  const channel = (byte: number) => {
    const v = byte / 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  };
  const [r, g, b] = [channel(red), channel(green), channel(blue)];
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  const [l, a, bb] = [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  return l > 85 && Math.hypot(a, bb) < 15;
}

/** Why `project`'s people break one colour per person (edit-core's `validate_people`), or null. */
export function peopleProblem(project: Project): string | null {
  const people = new Map<string, { name: string; color: string; bytes: [number, number, number] }>();
  for (const person of project.people ?? []) {
    if (person.id === "" || people.has(person.id)) return `people need distinct ids`;
    const bytes = parseHex(person.color);
    if (bytes === null) return `${person.name} needs a colour as #rrggbb`;
    if (whitish(bytes)) return `${person.name} can't be white or a near-white grey: their words are white`;
    people.set(person.id, { name: person.name, color: person.color, bytes });
  }
  for (const clip of project.clips) {
    if (clip.person === undefined || clip.person === null) continue;
    const person = people.get(clip.person);
    if (person === undefined) return `a clip names a person who isn't in the cast`;
    if (clip.type !== "text") return `a clip names a person but isn't text`;
    const shown = toHex((clip.style.label ?? clip.style).color);
    if (shown !== toHex([person.bytes[0] / 255, person.bytes[1] / 255, person.bytes[2] / 255, 1])) {
      return `${person.name}'s clips must all be in their colour ${person.color}: recolour the person, not one of their clips`;
    }
  }
  return null;
}
