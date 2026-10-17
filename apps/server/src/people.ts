// One colour per person across the whole video, by construction.
//
// Subtitles take their colours from each file's transcript, and each
// transcript colours its own voices: the same person came out in three
// colours across files, and different people in different files shared one
// (an edit had "Officer:" in four teals, and one orange on a child, a
// neighbour, a sister and a social worker). The agent was asked to reconcile
// them by hand and didn't reliably. So after anything that places or
// relabels people's words (add_subtitles, caption_speakers, update_clips,
// a plan), `oneColourPerPerson` gives every person (a subtitle label:
// "Officer:", "Tabitha:") one colour everywhere: their subtitles' labels,
// their intro captions and their quotes; no two people share a colour or a
// near shade while the palette lasts. A person keeps the colour they have
// when it still stands apart (re-runs, and a colour chosen on purpose, stay
// put); the agent's part is only who is who (one label per person).

import { hex, subtitleName } from "./captions_core.ts";
import type { Clip, Project, Rgba } from "./model.ts";
import { CAPTION_PREFIX, clipEnd } from "./project.ts";
import { f32, round, trim } from "./rust.ts";
import * as speakers from "./speakers.ts";
import { compareKeys } from "./stable.ts";

/**
 * The house palette for people, light enough to read on black, each at
 * least ~30 ΔE from every other. The first six are the editors' role
 * colours (officer teal, leader blue, suspect yellow, victim and family
 * orange, medic and social worker magenta, bystander sage); the rest were
 * picked farthest-first, so the first ones used are the most different.
 * Never white: a white label reads as nobody's (the subtitle's words are
 * white).
 */
export const PALETTE = [
  "#00e5c7",
  "#0090e5",
  "#ffff00",
  "#e57e00",
  "#f33bff",
  "#66aa66",
  "#ff6694",
  "#1aff47",
  "#c7ff8f",
  "#f0b2ff",
  "#ffb08f",
  "#3dd8ff",
  "#e7ca55",
  "#3dff9e",
  "#b1ff3d",
  "#ff66d1",
  "#fff0b2",
  "#b2c9ff",
  "#9a8fff",
  "#ff7566",
] as const;

/**
 * How far apart (CIE76 ΔE) two people's colours must be: two teals or two
 * lavenders 20 apart still read as one person on a 26 px label.
 */
export const APART = 28.0;

/** Clip names that mark words said by a person, so they take that person's colour. */
export const SUBTITLE_PREFIX = "Subtitle · ";
/** A quote or claim list of someone's words: "Quote · Tabitha". */
export const QUOTE_PREFIX = "Quote · ";

/** The palette colour a role starts from. */
function roleColour(role: string): string | null {
  switch (role) {
    case "officer":
      return PALETTE[0];
    case "leader":
      return PALETTE[1];
    case "suspect":
      return PALETTE[2];
    case "victim":
    case "witness":
      return PALETTE[3];
    case "medic":
      return PALETTE[4];
    case "bystander":
      return PALETTE[5];
    default:
      return null;
  }
}

/** "Officer:" → "officer": who a label is, whatever its case or colon. */
export function personKey(label: string): string {
  return trim(trim(label).replace(/:+$/, "")).toLowerCase();
}

/** A colour as "#rrggbb" (its f32 channels clamped and rounded as Rust's `as u8`). */
export function toHex(color: Rgba): string {
  const byte = (v: number) => {
    const clamped = Math.min(Math.max(f32(v), 0), 1);
    return round(f32(clamped * 255));
  };
  return `#${[color[0], color[1], color[2]].map((v) => byte(v).toString(16).padStart(2, "0")).join("")}`;
}

function fromHex(text: string, alpha: number): Rgba {
  const color = hex(text) ?? [1, 1, 1, 1];
  color[3] = f32(alpha);
  return color;
}

/** Everything known about one person on screen. */
interface Person {
  /** The label as shown ("Officer:"), the most used spelling. */
  shown: Map<string, number>;
  /** Lines (subtitles and captions). */
  lines: number;
  /** Their colours now, by how many lines use each. */
  colours: Map<string, number>;
  /** The transcript names their lines came from ("Tabitha (Mother)"). */
  names: Map<string, number>;
  /** When they're on screen (frames). */
  spans: [number, number][];
}

/** What a clip says of whose words it is. */
type Words =
  /** A subtitle: its person and the transcript name it came from. */
  | { kind: "subtitle"; key: string; from: string | null }
  /** An intro caption, by the transcript name of its speaker. */
  | { kind: "caption"; who: string }
  /** A quote or claim list, named for its person. */
  | { kind: "quote"; key: string };

function wordsOf(clip: Clip): Words | null {
  if (clip.type !== "text") return null;
  const style = clip.style;
  const name = clip.name ?? "";
  if (style.label != null) {
    const from = name.startsWith(SUBTITLE_PREFIX) ? name.slice(SUBTITLE_PREFIX.length) : null;
    return { kind: "subtitle", key: personKey(style.label.text), from };
  }
  if (name.startsWith(CAPTION_PREFIX)) return { kind: "caption", who: trim(name.slice(CAPTION_PREFIX.length)) };
  if (name.startsWith(QUOTE_PREFIX)) {
    const key = personKey(name.slice(QUOTE_PREFIX.length));
    return key === "" ? null : { kind: "quote", key };
  }
  return null;
}

function add(tally: Map<string, number>, key: string): void {
  tally.set(key, (tally.get(key) ?? 0) + 1);
}

/** The most used key of a tally (ties: the first in order). */
function most(tally: Map<string, number> | undefined): string | undefined {
  let best: [string, number] | undefined;
  for (const entry of tally ?? []) {
    if (best === undefined || entry[1] > best[1] || (entry[1] === best[1] && compareKeys(entry[0], best[0]) < 0)) {
      best = entry;
    }
  }
  return best?.[0];
}

/** A tally's entries in key order (a BTreeMap's). */
function sorted<T>(map: Map<string, T>): [string, T][] {
  return [...map].sort((a, b) => compareKeys(a[0], b[0]));
}

/**
 * The person an intro caption's speaker is: the label their subtitles carry
 * (the same transcript name), else their first name or role.
 */
function captionPerson(who: string, subtitled: Map<string, Map<string, number>>): string {
  return most(subtitled.get(who)) ?? personKey(subtitleName(who));
}

function emptyPerson(): Person {
  return { shown: new Map(), lines: 0, colours: new Map(), names: new Map(), spans: [] };
}

/**
 * Gives every person one colour across the video (see the module notes).
 * Returns each person with their colour and how many clips changed. A
 * subtitled (Repack-style) video's subtitles carry no labels, so it has
 * nobody here and is left alone.
 */
export function oneColourPerPerson(project: Project): unknown {
  // Which person each transcript name's subtitles are under.
  const subtitled = new Map<string, Map<string, number>>();
  for (const clip of project.clips) {
    const words = wordsOf(clip);
    if (words?.kind === "subtitle" && words.from !== null) {
      let tally = subtitled.get(words.from);
      if (tally === undefined) subtitled.set(words.from, (tally = new Map()));
      add(tally, words.key);
    }
  }
  const people = new Map<string, Person>();
  for (const clip of project.clips) {
    if (clip.type !== "text") continue;
    const style = clip.style;
    const words = wordsOf(clip);
    let key: string;
    let colour: Rgba;
    let from: string | null;
    if (words?.kind === "subtitle") {
      key = words.key;
      colour = style.label?.color ?? style.color;
      from = words.from;
    } else if (words?.kind === "caption") {
      key = captionPerson(words.who, subtitled);
      colour = style.color;
      from = words.who;
    } else {
      continue;
    }
    if (key === "") continue;
    let person = people.get(key);
    if (person === undefined) people.set(key, (person = emptyPerson()));
    if (style.label != null) add(person.shown, style.label.text);
    person.lines += 1;
    add(person.colours, toHex(colour));
    if (from !== null) add(person.names, from);
    person.spans.push([clip.start, clipEnd(clip)]);
  }
  if (people.size === 0) return [];
  const colours = assign(people);
  // Every line of theirs in it.
  const changed = new Map<string, number>();
  for (const clip of project.clips) {
    const words = wordsOf(clip);
    if (clip.type !== "text" || words === null) continue;
    const style = clip.style;
    let key: string;
    let onLabel: boolean;
    switch (words.kind) {
      case "subtitle":
        [key, onLabel] = [words.key, true];
        break;
      case "caption":
        [key, onLabel] = [captionPerson(words.who, subtitled), false];
        break;
      case "quote":
        [key, onLabel] = [words.key, false];
        break;
    }
    const hexColour = colours.get(key);
    if (hexColour === undefined) continue;
    if (onLabel) {
      const label = style.label;
      if (label != null && toHex(label.color) !== hexColour) {
        label.color = fromHex(hexColour, label.color[3]);
        add(changed, key);
      }
    } else if (toHex(style.color) !== hexColour) {
      style.color = fromHex(hexColour, style.color[3]);
      add(changed, key);
    }
  }
  const order = sorted(people).sort((a, b) => b[1].lines - a[1].lines);
  return order.map(([key, person]) => {
    const label = most(person.shown) ?? key;
    const merged = mergedInto(key, person);
    const entry: Record<string, unknown> = {
      label,
      colour: colours.get(key) ?? null,
      lines: person.lines,
      recoloured: changed.get(key) ?? 0,
    };
    if (merged.length > 0) entry.other_voices_under_this_label = merged;
    return entry;
  });
}

/**
 * The role a person's names point to ("Tabitha (Mother)" → witness), for
 * the colour they start from.
 */
function roleOf(key: string, person: Person): string {
  const roles = new Map<string, number>();
  for (const [name, count] of person.names) {
    const role = speakers.roleFromLabel(name);
    if (role !== "other") roles.set(role, (roles.get(role) ?? 0) + count);
  }
  return most(roles) ?? speakers.roleFromLabel(key);
}

/**
 * Colours for `people`, most lines first: each keeps the colour most of
 * their lines have while it stands APART from every colour taken (and,
 * for an officer, leader or dispatch, isn't pink: `speakers.allowed`), else
 * takes their role's, else the palette's next that stands apart. Past
 * the palette, someone (the fewest lines come last) shares the colour of
 * whoever is on screen furthest away in time from them.
 */
function assign(people: Map<string, Person>): Map<string, string> {
  const order = sorted(people).sort((a, b) => b[1].lines - a[1].lines);
  const taken: [string, Person][] = [];
  const out = new Map<string, string>();
  for (const [key, person] of order) {
    const role = roleOf(key, person);
    // Apart from everyone's, and never pink for an official.
    const free = (colour: string) =>
      speakers.allowed(role, colour) && taken.every(([other]) => speakers.apart(colour, other) >= APART);
    const own = sorted(person.colours).sort((a, b) => b[1] - a[1]);
    const first = own[0]?.[0];
    const kept = first !== undefined && free(first) && !whitish(first) ? first : undefined;
    const fromRole = roleColour(role);
    const colour =
      kept ??
      (fromRole !== null && free(fromRole) ? fromRole : undefined) ??
      PALETTE.find((candidate) => free(candidate)) ??
      furthestInTime(person, taken);
    taken.push([colour, person]);
    out.set(key, colour);
  }
  return out;
}

/**
 * The transcript voices under `key`'s label that are by their names someone
 * else ("Kevin (Father)" or "Sister 3" under "Tabitha:"; a bare role like
 * "Mother" or "Officer" may be anyone): never merged silently, the report
 * lists them so the agent confirms who is who.
 */
function mergedInto(key: string, person: Person): string[] {
  return sorted(person.names)
    .map(([name]) => name)
    .filter((name) => {
      const named = name.includes(" (") || /[0-9]/.test(name);
      return named && personKey(subtitleName(name)) !== key;
    });
}

/** White or a near-white grey: never a person's colour (their words are white). */
export function whitish(hexColour: string): boolean {
  const [l, a, b] = speakers.lab(hexColour);
  return l > 85.0 && Math.sqrt(a * a + b * b) < 15.0;
}

/**
 * More people than colours: the palette colour whose people are on screen
 * furthest (in time) from `person`, so a shared colour is never seen twice
 * in the same scene.
 */
function furthestInTime(person: Person, taken: [string, Person][]): string {
  const gap = (a: [number, number][], b: [number, number][]) => {
    let least = Number.POSITIVE_INFINITY;
    for (const [s1, e1] of a) {
      for (const [s2, e2] of b) least = Math.min(least, Math.max(s2 - e1, s1 - e2, 0));
    }
    return least;
  };
  let best: [string, number, number] | undefined;
  for (const colour of PALETTE) {
    const holders = taken.filter(([own]) => own === colour).map(([, holder]) => holder);
    const nearest = holders.reduce((least, holder) => Math.min(least, gap(person.spans, holder.spans)), Number.POSITIVE_INFINITY);
    const lines = holders.reduce((sum, holder) => sum + holder.lines, 0);
    // Rust's max_by: the furthest, then the fewest lines; the last of equals.
    if (best === undefined || nearest > best[1] || (nearest === best[1] && lines <= best[2])) {
      best = [colour, nearest, lines];
    }
  }
  return best?.[0] ?? PALETTE[0];
}

/**
 * Each person's line count, colour and the transcript names their lines
 * came from, for get_edit_context: "Tabitha: 257 lines #ff4d59 (from
 * Mother, Tabitha (Mother))".
 */
export function summary(project: Project): Record<string, string> {
  // Per label: lines, colours used, transcript voices.
  const out = new Map<string, [number, Map<string, number>, Map<string, number>]>();
  for (const clip of project.clips) {
    if (clip.type !== "text") continue;
    const label = clip.style.label;
    if (label == null) continue;
    let entry = out.get(label.text);
    if (entry === undefined) out.set(label.text, (entry = [0, new Map(), new Map()]));
    entry[0] += 1;
    add(entry[1], toHex(label.color));
    const name = clip.name;
    if (name != null && name.startsWith(SUBTITLE_PREFIX)) add(entry[2], name.slice(SUBTITLE_PREFIX.length));
  }
  const result: Record<string, string> = {};
  for (const [label, [lines, colours, names]] of sorted(out)) {
    const shades = sorted(colours).map(([colour]) => colour);
    const voices = sorted(names).map(([name]) => name);
    result[label] = `${lines} lines ${shades.join(" + ")} (from ${voices.join(", ")})`;
  }
  return result;
}
