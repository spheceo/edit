// people.rs's tests, same names, same cases.

import { expect, test } from "bun:test";

import { hex } from "../src/captions_core.ts";
import type { Project, Rgba, TextClip } from "../src/model.ts";
import { APART, oneColourPerPerson, PALETTE, SUBTITLE_PREFIX, summary, toHex, whitish } from "../src/people.ts";
import { newProject } from "../src/project.ts";
import { apart, pinkish } from "../src/speakers.ts";

function fromHex(text: string, alpha: number): Rgba {
  const color = hex(text) ?? [1, 1, 1, 1];
  color[3] = alpha;
  return color;
}

function subtitle(id: string, start: number, from: string, label: string, colour: string): TextClip {
  return {
    id,
    track: "v9",
    start,
    duration: 30,
    color: "cyan",
    name: `${SUBTITLE_PREFIX}${from}`,
    fade_in: 0,
    fade_out: 0,
    type: "text",
    text: "words",
    style: {
      font: "Geist",
      weight: 700,
      size: 96,
      color: [1, 1, 1, 1],
      tracking: 0,
      line_height: 1.15,
      glow: { enabled: true, color: null, radius: 46, strength: 0.5 },
      label: { text: label, color: fromHex(colour, 1.0), size: 26.0 },
    },
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    animation: { preset: "none", duration: 12, stagger: 1.5 },
    opacity: 1,
  };
}

function text(id: string, name: string, colour: string): TextClip {
  const clip = subtitle(id, 0, "x", "x", colour);
  clip.name = name;
  delete clip.style.label;
  clip.style.color = fromHex(colour, 1.0);
  return clip;
}

function labelColour(project: Project, id: string): string {
  const clip = project.clips.find((one) => one.id === id);
  if (clip === undefined || clip.type !== "text") throw new Error(`${id} isn't text`);
  return toHex(clip.style.label?.color ?? clip.style.color);
}

function project(clips: TextClip[]): Project {
  const out = newProject("p", "t", { width: 1920, height: 1080, fps: 30 });
  out.clips = clips;
  return out;
}

test("one_person_one_colour_and_no_two_people_alike", () => {
  // The bodycam edit's mess: one officer in three teals, a child in two
  // colours, and one orange on a child and a neighbour.
  const clips: TextClip[] = [];
  for (let i = 0; i < 6; i++) clips.push(subtitle(`o${i}`, i * 40, "Officer", "Officer:", "#00e5c7"));
  clips.push(subtitle("o6", 300, "Sinclair (Officer)", "Officer:", "#b5f8ee"));
  clips.push(subtitle("o7", 340, "Officer", "Officer:", "#009e8c"));
  clips.push(subtitle("c1", 400, "Child 2", "Child:", "#e57e00"));
  clips.push(subtitle("c2", 440, "Child", "Child:", "#3ddc84"));
  clips.push(subtitle("c3", 480, "Child 2", "Child:", "#e57e00"));
  clips.push(subtitle("n1", 520, "Neighbor", "Neighbor:", "#e57e00"));
  clips.push(subtitle("n2", 560, "Neighbor", "Neighbor:", "#e57e00"));
  clips.push(subtitle("n3", 600, "Neighbor", "Neighbor:", "#e57e00"));
  clips.push(subtitle("n4", 640, "Neighbor", "Neighbor:", "#e57e00"));
  // A doctor in a teal too near the officer's.
  clips.push(subtitle("d1", 700, "Como (Doctor)", "Doctor:", "#4dffbf"));
  // The intro caption of the named officer, and a quote of the child's.
  clips.push(text("cap", "Caption · Sinclair (Officer)", "#b5f8ee"));
  clips.push(text("q", "Quote · Child", "#ffffff"));
  const edit = project(clips);
  const report = oneColourPerPerson(edit) as unknown[];
  const officer = labelColour(edit, "o0");
  for (const id of ["o1", "o6", "o7", "cap"]) expect(labelColour(edit, id), id).toBe(officer);
  expect(officer).toBe("#00e5c7");
  const child = labelColour(edit, "c1");
  expect(labelColour(edit, "c2")).toBe(child);
  expect(labelColour(edit, "q")).toBe(child);
  const neighbour = labelColour(edit, "n1");
  const doctor = labelColour(edit, "d1");
  // The neighbour (more lines) keeps the orange; the child moves off it.
  expect(neighbour).toBe("#e57e00");
  const people = [officer, child, neighbour, doctor];
  people.forEach((a, i) => {
    for (const b of people.slice(i + 1)) expect(apart(a, b), `${a} vs ${b}`).toBeGreaterThanOrEqual(APART);
  });
  expect(report.length).toBe(4);
  // A second run changes nothing.
  const before = structuredClone(edit);
  oneColourPerPerson(edit);
  expect(edit).toEqual(before);
});

test("an_officer_in_pink_is_moved_off_it", () => {
  // Mom & Teen's Officer Schweickart came out in hot pink.
  const edit = project([
    subtitle("o1", 0, "Schweickart (Officer)", "Schweickart:", "#ff66d1"),
    subtitle("o2", 40, "Schweickart (Officer)", "Schweickart:", "#ff66d1"),
    subtitle("m1", 80, "Mother", "Mom:", "#ff66d1"),
  ]);
  oneColourPerPerson(edit);
  const officer = labelColour(edit, "o1");
  expect(pinkish(officer), officer).toBe(false);
  expect(labelColour(edit, "m1")).toBe("#ff66d1");
});

test("never_white_and_merged_voices_are_named", () => {
  const edit = project([
    subtitle("s1", 0, "Sister 2", "Sister 2:", "#ffffff"),
    subtitle("s2", 40, "Sister 2", "Sister 2:", "#ffffff"),
    subtitle("m1", 80, "Mother", "Tabitha:", "#ff4d59"),
    subtitle("m2", 120, "Tabitha (Mother)", "Tabitha:", "#ff4d59"),
    subtitle("k1", 160, "Kevin (Father)", "Tabitha:", "#ff4d59"),
  ]);
  const report = oneColourPerPerson(edit) as Record<string, unknown>[];
  expect(whitish(labelColour(edit, "s1"))).toBe(false);
  const tabitha = report.find((person) => person.label === "Tabitha:")!;
  expect(tabitha.other_voices_under_this_label).toEqual(["Kevin (Father)"]);
  expect(PALETTE.every((colour) => !whitish(colour))).toBe(true);
});

test("the_palette_stands_apart_and_more_people_share_far_apart_in_time", () => {
  PALETTE.forEach((a, i) => {
    for (const b of PALETTE.slice(i + 1)) expect(apart(a, b), `${a} vs ${b}`).toBeGreaterThanOrEqual(APART);
  });
  // 22 people, each in their own minute, all in white to start with.
  const clips: TextClip[] = [];
  for (let person = 0; person < 22; person++) {
    for (let line = 0; line < 30 - person; line++) {
      clips.push(subtitle(`p${person}-${line}`, person * 1800 + line * 31, `Person ${person}`, `Person ${person}:`, "#ffffff"));
    }
  }
  const edit = project(clips);
  oneColourPerPerson(edit);
  const colour = (person: number) => labelColour(edit, `p${person}-0`);
  const seen = new Set(Array.from({ length: 20 }, (_, person) => colour(person)));
  expect(seen.size, "the first 20 people all differ").toBe(20);
  // The two with the fewest lines share with whoever is furthest away: the first people.
  for (const late of [20, 21]) {
    const shared = colour(late);
    const with_ = Array.from({ length: 20 }, (_, person) => person).find((person) => colour(person) === shared)!;
    expect(late - with_, `person ${late} shares with ${with_}`).toBeGreaterThanOrEqual(10);
  }
});

// The TS side's own.

test("the summary lists each label's lines, colours and voices", () => {
  const edit = project([
    subtitle("m1", 0, "Mother", "Tabitha:", "#ff4d59"),
    subtitle("m2", 40, "Tabitha (Mother)", "Tabitha:", "#ff4d59"),
    subtitle("o1", 80, "Officer", "Officer:", "#00e5c7"),
  ]);
  expect(summary(edit)).toEqual({
    "Officer:": "1 lines #00e5c7 (from Officer)",
    "Tabitha:": "2 lines #ff4d59 (from Mother, Tabitha (Mother))",
  });
});
