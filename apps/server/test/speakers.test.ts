// speakers.rs's tests, same names, same cases; then the TS side's own.

import { expect, test } from "bun:test";

import * as fs from "node:fs";

import {
  apart,
  BACKGROUND,
  colors,
  distinct,
  DISTINCT,
  editTranscript,
  ensure,
  evidence,
  labels,
  pinkish,
  relabel,
  roleFromLabel,
  setRole,
  type Person,
} from "../src/speakers.ts";
import { serialize, type Transcript, type Word } from "../src/transcribe.ts";
import { fixtureHome, write } from "./helpers/home.ts";

test("labels_roles_names_and_repeats", () => {
  const out = labels({
    speakers: [
      { id: "speaker_0", name: null, title: "Suspect", role: "suspect" },
      { id: "speaker_1", name: null, title: "Officer", role: "officer" },
      { id: "speaker_2", name: "Jane Doe", title: "Mother", role: "witness" },
      { id: "speaker_3", name: null, title: "Officer", role: "officer" },
    ],
  });
  expect(out.get("speaker_0")).toBe("Suspect");
  expect(out.get("speaker_2")).toBe("Jane Doe (Mother)");
  expect(out.get("speaker_3")).toBe("Officer 2");
});

const said = (voice: string): Word => ({ text: "x", start: 0.0, end: 0.1, speaker: voice });

test("colours_by_role_most_spoken_first", () => {
  const transcript: Transcript = {
    model: "scribe_v2",
    language: null,
    words: ["speaker_1", "speaker_1", "speaker_0", "speaker_2", "speaker_3", "speaker_3"].map(said),
    speakers: { speaker_0: "Juvenile" },
    roles: { speaker_1: "officer", speaker_2: "witness", speaker_3: "officer" },
    colors: {},
  };
  const out = colors(transcript);
  // Officers: the one who says most is the role's own teal, the other its pale teal.
  expect(out.speaker_1).toBe("#00e5c7");
  expect(out.speaker_3).toBe("#b5f8ee");
  expect(out.speaker_2).toBe("#e57e00");
  // No role given: read from the label (none here → other).
  expect(out.speaker_0).toBe("#3ddc84");
  expect(roleFromLabel("Raven (Officer)")).toBe("officer");
  expect(roleFromLabel("Mother")).toBe("witness");
});

test("no_two_people_look_alike", () => {
  // Six officers, two sergeants, a suspect, two witnesses, a narrator
  // and background talk, most spoken first.
  const cast = ["officer", "officer", "officer", "officer", "officer", "officer", "leader", "leader", "suspect", "witness", "witness", "narrator", BACKGROUND];
  const voice = (i: number) => `speaker_${String(i).padStart(2, "0")}`;
  const words: Word[] = [];
  cast.forEach((_, i) => {
    for (let n = 0; n < cast.length - i; n++) words.push(said(voice(i)));
  });
  const transcript: Transcript = {
    model: "scribe_v2",
    language: null,
    words,
    speakers: {},
    roles: Object.fromEntries(cast.map((role, i) => [voice(i), role])),
    colors: {},
  };
  const out = colors(transcript);
  // Officers go teal, pale teal, deep teal, then spare colours.
  const officers = [0, 1, 2, 3, 4, 5].map((i) => out[voice(i)]!);
  expect(officers.slice(0, 3)).toEqual(["#00e5c7", "#b5f8ee", "#009e8c"]);
  expect(out.speaker_06).toBe("#0090e5");
  expect(out.speaker_08).toBe("#ffff00");
  expect(out.speaker_09).toBe("#e57e00");
  // Hidden voices are white and take nobody's colour.
  expect(out.speaker_11).toBe("#ffffff");
  expect(out.speaker_12).toBe("#ffffff");
  const shown = Object.entries(out)
    .filter(([key]) => !["speaker_11", "speaker_12"].includes(key))
    .map(([, color]) => color);
  shown.forEach((a, i) => {
    for (const b of shown.slice(i + 1)) expect(apart(a, b), `${a} and ${b}`).toBeGreaterThanOrEqual(DISTINCT);
  });
  // The old officer shades stood 12–17 apart.
  expect(apart("#00e5c7", "#00c4aa")).toBeLessThan(DISTINCT);
  // However many officers, none in pink or magenta.
  for (const officer of officers) expect(pinkish(officer), officer).toBe(false);
});

test("officials_are_never_pink_and_people_across_files_stay_apart", () => {
  for (const pink of ["#f33bff", "#ffb3d9", "#ffc2f0", "#ff9e9e", "#ff00aa"]) expect(pinkish(pink), pink).toBe(true);
  for (const not of ["#00e5c7", "#0090e5", "#ffff00", "#e57e00", "#ffffff", "#c9a8ff", "#3ddc84"]) {
    expect(pinkish(not), not).toBe(false);
  }
  // Mom & Teen: two officers in near teals from two files, an officer
  // already given hot pink by hand, a mother and a narrator.
  const people: Person[] = [
    { role: "officer", lines: 90, color: "#00e5c7" },
    { role: "officer", lines: 40, color: "#00c4aa" },
    { role: "officer", lines: 30, color: "#ff3ec8" },
    { role: "other", lines: 60, color: "#3ddc84" },
    { role: "narrator", lines: 99, color: "#ffffff" },
  ];
  const out = distinct(people);
  // Who says most keeps their colour; the narrator stays white.
  expect(out[0]).toBe("#00e5c7");
  expect(out[3]).toBe("#3ddc84");
  expect(out[4]).toBe("#ffffff");
  // The near teal and the pink officer get colours of their own, never pink.
  for (const index of [1, 2]) expect(pinkish(out[index]!), out[index]).toBe(false);
  const shown = [out[0]!, out[1]!, out[2]!, out[3]!];
  shown.forEach((a, i) => {
    for (const b of shown.slice(i + 1)) expect(apart(a, b), `${a} and ${b}`).toBeGreaterThanOrEqual(DISTINCT);
  });
});

test("relabels_only_generic_titles", () => {
  expect(relabel("Witness", "suspect")).toBe("Suspect");
  expect(relabel("Officer 2", "leader")).toBe("Sergeant");
  expect(relabel("Raven (Officer)", "leader")).toBe("Raven (Sergeant)");
  expect(relabel("Mother", "suspect")).toBe("Mother");
  expect(relabel("Jane Doe (Mother)", "witness")).toBe("Jane Doe (Mother)");
});

// The TS side's own: the file-level operations around the colour code.

test("set_role checks the role, relabels a generic label, recolours and saves", async () => {
  const { app, cleanup, dir } = fixtureHome("speakers-role");
  try {
    const source = `${dir}/clip.mp4`;
    const target = app.media.paths(source).transcript;
    write(
      target,
      serialize({
        model: "scribe_v2",
        language: "eng",
        words: [said("speaker_0"), said("speaker_1")],
        speakers: { speaker_0: "Witness", speaker_1: "Mother" },
        roles: { speaker_0: "witness", speaker_1: "witness" },
      }),
    );
    const heard: unknown[] = [];
    const stop = app.store.subscribe((event) => heard.push(event));
    await expect(setRole(app, source, "speaker_0", "chief", null)).rejects.toThrow(
      "role is one of officer, leader, suspect, victim, witness, medic, bystander, narrator, dispatch, other, background",
    );
    const transcript = await setRole(app, source, "speaker_0", "suspect", null);
    expect(transcript.speakers?.speaker_0).toBe("Suspect");
    expect(transcript.colors?.speaker_0).toBe("#ffff00");
    const named = await setRole(app, source, "speaker_1", "victim", "  Tabitha (Mother) ");
    expect(named.speakers?.speaker_1).toBe("Tabitha (Mother)");
    const saved = JSON.parse(fs.readFileSync(target, "utf8")) as Transcript;
    expect(saved.roles).toEqual({ speaker_0: "suspect", speaker_1: "victim" });
    expect(heard).toContainEqual({ type: "transcript", path: source });
    stop();
    await expect(setRole(app, `${dir}/none.mp4`, "speaker_0", "officer", null)).rejects.toThrow("no transcript");
    const edited = await editTranscript(app, source, (t) => {
      t.roles!.speaker_1 = "officer";
    });
    expect(edited.colors?.speaker_1).toBe("#00e5c7");
  } finally {
    cleanup();
  }
});

test("ensure names a file's voices once, through the agent, keeping what's there", async () => {
  const asked: string[] = [];
  let answer = "";
  const { app, cleanup, dir } = fixtureHome("speakers-ensure", {
    services: {
      agents: {
        status: async () => ({}),
        models: async () => ({}),
        chat: () => ({}),
        send: async () => {},
        stop: async () => {},
        reset: () => {},
        ask: async (_model, _effort, _instructions, input) => {
          asked.push((input[0] as { text: string }).text);
          return answer;
        },
      },
    },
  });
  try {
    const source = `${dir}/clip.mp4`;
    const target = app.media.paths(source).transcript;
    write(
      target,
      serialize({
        model: "scribe_v2",
        language: "eng",
        words: [
          { text: "Ma'am,", start: 0, end: 0.4, speaker: "speaker_0" },
          { text: "yes?", start: 0.5, end: 0.9, speaker: "speaker_1" },
        ],
        roles: { speaker_1: "victim" },
      }),
    );
    answer = JSON.stringify({
      speakers: [
        { id: "speaker_0", name: null, title: "Officer", role: "officer" },
        { id: "speaker_1", name: "Jane", title: "Witness", role: "witness" },
      ],
    });
    ensure(app, source);
    ensure(app, source);
    for (let i = 0; i < 50 && !fs.readFileSync(target, "utf8").includes("speakers"); i++) await Bun.sleep(10);
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain("speaker_0: Ma'am,\nspeaker_1: yes?");
    const saved = JSON.parse(fs.readFileSync(target, "utf8")) as Transcript;
    // The role it had stays; the label follows it ("Jane (Witness)" → "Jane (Victim)").
    expect(saved.roles).toEqual({ speaker_0: "officer", speaker_1: "victim" });
    expect(saved.speakers).toEqual({ speaker_0: "Officer", speaker_1: "Jane (Victim)" });
    expect(saved.colors?.speaker_0).toBe("#00e5c7");
    // Named now: not asked again.
    ensure(app, source);
    await Bun.sleep(20);
    expect(asked.length).toBe(1);
  } finally {
    cleanup();
  }
});

test("the evidence keeps the opening and a spread of the rest within budget", () => {
  const words: Word[] = [];
  for (let i = 0; i < 2000; i++) words.push({ text: "word ".repeat(80).trim(), start: i, end: i + 0.5, speaker: `speaker_${i % 2}` });
  const text = evidence(words);
  expect([...text].length).toBeLessThanOrEqual(60_000);
  // Each passage capped at 300 characters.
  expect(text.split("\n")[0]!.length).toBe("speaker_0: ".length + 300);
  // The first 150 passages all there.
  expect(text.split("\n").slice(0, 150).every((line, i) => line.startsWith(`speaker_${i % 2}: `))).toBe(true);
});
