import { expect, test } from "bun:test";

import type { Clip, Script } from "@edit/types/writer";

import { blows, childPairs, hasDate, places, textFlags } from "../../src/writer/house.ts";

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
