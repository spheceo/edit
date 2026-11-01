import { expect, test } from "bun:test";

import type { Clip, Script } from "@edit/types/writer";

import { blows, childPairs, hasDate, paceFlags, places, textFlags, withMuteNotes } from "../../src/writer/house.ts";

const cutIn = (text: string): Clip => ({ id: text, startMs: 0, endMs: 3_000, kind: "cut-in", narration: text });

test("finds what the team flagged", () => {
  expect(places("Officers went to a home on Southeast Burgundy Lane in Port St. Lucie.")).toEqual(["Southeast Burgundy Lane"]);
  expect(places("He called from room 209 of the Red Roof Inn.")).toEqual(["room 209", "Red Roof Inn"]);
  expect(places("He taught at Buena High School in Sierra Vista.")).toEqual(["Buena High School"]);
  expect(places("Deputies from the Flagler County Sheriff's Office drove to Main.")).toEqual([]);
  expect(childPairs("charged with two counts of dissemination of child pornography")).toHaveLength(1);
  expect(childPairs("the child was safe with her grandmother")).toEqual([]);
  expect(blows("she had been hit in the head")).toHaveLength(1);
  expect(blows("the news hit hard")).toEqual([]);
  expect(blows("her heart was beating again")).toEqual([]);
  expect(blows("he kept beating her")).toHaveLength(1);
  expect(hasDate("On May 29, 2024, officers")).toBe(true);
  expect(hasDate("South of Ketchum, Idaho, a man called")).toBe(false);
});

test("flags outros, names and repeated transitions", () => {
  const script = { id: "a1", title: "Case", sourceKind: "compilation", speakers: { "1:speaker_0": "Briana Cole (Suspect)" } } as unknown as Script;
  const clips: Clip[] = [
    cutIn("A mother turned on her own baby."),
    { id: "f", startMs: 0, endMs: 9_000 },
    cutIn("On March 3, 2024, deputies met Briana outside the car."),
    { id: "g", startMs: 9_000, endMs: 99_000 },
    cutIn("In the end, Briana Cole was arrested, and her friend Mark Steiner was charged too."),
    cutIn("Up next, we have a case where a father drank."),
    { id: "h", startMs: 99_000, endMs: 104_000 },
    cutIn("Officers in Graham were called."),
    { id: "i", startMs: 104_000, endMs: 200_000 },
    cutIn("He was taken to the station to type up the charge against him, which the officers did that night after a long talk with his wife and the five-year-old girl."),
    cutIn("Up next, we have a case where parents kept five kids."),
  ];
  const all = textFlags(script, clips, ["intro", "case-opening", "outro", "transition", "case-opening", "outro", "transition"], true).join("\n");
  expect(all).toContain("without their full name: Briana Cole");
  expect(all).toContain("first named in an outro: Mark Steiner");
  expect(all).toContain('Transitions open the same way: "up next we have…"');
  expect(all).toContain("Case openings without a date");
  expect(all).toContain('Outros that don\'t open "In the end');
});

test("flags the opening and pacing the producers revised", () => {
  // Roblox, Masseur, Tutor (Oct 30–Nov 1): a sound-only first clip, 4 minutes of footage in a row, a cut-in after 35 s, crumbs, "child".
  const word = (id: string, text: string, startMs: number) => ({ id, text, startMs, endMs: startMs + 300, speaker: "1:speaker_0" });
  const script = {
    id: "p1",
    title: "Case",
    parts: [
      { title: "911", startMs: 0, durationMs: 60_000, audio: true },
      { title: "bodycam", startMs: 60_000, durationMs: 3_600_000, audio: false },
    ],
    words: [word("w1", "Nine-one-one,", 1_000), word("w2", "Yeah.", 400_000), word("w3", "Okay.", 400_400), word("w4", "sex", 900_000)],
  } as unknown as Script;
  const clips: Clip[] = [
    { id: "a", startMs: 0, endMs: 8_000 },
    cutIn("This man called 911."),
    { id: "b", startMs: 70_000, endMs: 90_000 },
    cutIn("On May 2, 2024, a child was found."),
    { id: "c", startMs: 100_000, endMs: 340_000 },
    cutIn("Officers went in."),
    { id: "d", startMs: 399_900, endMs: 401_000 },
    { id: "e", startMs: 500_000, endMs: 534_000 },
    cutIn("Then the brother came."),
    { id: "f", startMs: 600_000, endMs: 770_000 },
    cutIn("Then the car."),
    { id: "g", startMs: 1_000_000, endMs: 1_150_000 },
    cutIn("In the end, he was charged."),
  ];
  const all = paceFlags(script, clips, true).join("\n");
  expect(all).toContain("opens on a sound-only recording");
  expect(all).toContain("over about three minutes (4.0 min");
  expect(all).toContain("after too little footage (35 s");
  expect(all).toContain('Crumbs: clips of only "Yeah. Okay."');
  expect(all).toContain('"Child" or "children" 1 time');
  // A compilation's case intros sit close to their transitions by design.
  expect(paceFlags(script, clips, false).join("\n")).not.toContain("too little footage");
  // The editor's mute notes, once.
  const muted = { ...script, clips: [{ id: "s", startMs: 899_000, endMs: 902_000 }] } as Script;
  expect(withMuteNotes(muted, 1)).toBe(1);
  expect(muted.clips[0]!.notes![0]!.text).toBe('edit: mute "sex" (15:00).');
  expect(withMuteNotes(muted, 2)).toBe(0);
  // Past an hour, as the Doc writes it.
  const late = { ...script, words: [word("w9", "raped", 16_746_000)], clips: [{ id: "t", startMs: 16_745_000, endMs: 16_748_000 }] } as Script;
  withMuteNotes(late, 1);
  expect(late.clips[0]!.notes![0]!.text).toBe('edit: mute "raped" (4:39:06).');
});
