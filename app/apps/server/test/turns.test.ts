// turns.ts: words that spilled across a change of speaker put back (Repack's turns, ported).

import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { AT_ONCE, fixTurns, type TurnWord } from "../src/turns.ts";
import { scratch } from "./helpers/home.ts";

/** Words of `text`, a quarter second each, all `speaker`'s. */
function said(text: string, speaker: string, from: number): TurnWord[] {
  return text.split(" ").map((word, index) => ({ text: word, speaker, start_ms: from + index * 250, end_ms: from + index * 250 + 200 }));
}

// The run-through's news report (Oct 28): the reporter's "…when investigators
// questioned / him after this incident" landed on the sergeant's line.
const words = () => [
  ...said("that's the voice of the sergeant when investigators questioned", "reporter", 0),
  ...said("him after this incident I'm yelling the whole time", "sergeant", 3000),
];
const names = (speaker: string) => (speaker === "reporter" ? "Narrator" : "Sergeant");

/** A model that answers `cuts`, counting the asks. */
function model(cuts: unknown[]) {
  const asked: string[] = [];
  const post = async (body: string) => {
    asked.push(fs.readFileSync(body, "utf8"));
    return { choices: [{ message: { content: JSON.stringify({ cuts }) } }] };
  };
  return { asked, post };
}

test("spilled words go back to who said them, once asked (the answer kept)", async () => {
  const { dir, cleanup } = scratch("turns");
  try {
    const { asked, post } = model([
      { line: 0, first: "That's the voice of the sergeant when investigators questioned him after this incident.", second: "I'm yelling the whole time" },
    ]);
    const heard = words();
    expect(await fixTurns(heard, names, "Cop Beats a Teen", dir, post)).toBe(4);
    expect(heard.filter((word) => word.speaker === "reporter").map((word) => word.text).join(" ")).toBe(
      "that's the voice of the sergeant when investigators questioned him after this incident",
    );
    expect(heard.filter((word) => word.speaker === "sergeant").map((word) => word.text).join(" ")).toBe("I'm yelling the whole time");
    // The prompt names the speakers and shows the turns.
    expect(asked[0]).toContain("0 [0:00] Narrator: that's the voice");
    // Asked once: the same stretch again reads the kept answer.
    await fixTurns(words(), names, "Cop Beats a Teen", dir, post);
    expect(asked.length).toBe(1);
  } finally {
    cleanup();
  }
});

test("a cut that changes or drops a word is ignored, and no answer leaves the words as heard", async () => {
  const { dir, cleanup } = scratch("turns-bad");
  try {
    const dropped = model([{ line: 0, first: "That's the voice of the sergeant when investigators questioned him.", second: "I'm yelling the whole time" }]);
    const heard = words();
    expect(await fixTurns(heard, names, "t", dir, dropped.post)).toBe(0);
    expect(heard.map((word) => word.speaker)).toEqual(words().map((word) => word.speaker));
    const down = async () => {
      throw new Error("the model answered 503: request failed");
    };
    expect(await fixTurns(words(), names, "other title", dir, down)).toBe(0);
  } finally {
    cleanup();
  }
});

test("chained cuts all apply: a middle line losing words at both ends (the run-through's teaser, the model's real answer)", async () => {
  const { dir, cleanup } = scratch("turns-chained");
  try {
    let at = 0;
    const run = (text: string, speaker: string) => said(text, speaker, (at += 10_000));
    const heard = [
      ...run("one of the suspects appears to be thrown around by James just as the other officer", "reporter"),
      ...run("arrives he's fully on top of them and all I can see is his arm coming up and down that's the", "sergeant"),
      ...run("voice of the sergeant when investigators questioned", "reporter"),
      ...run("him after this incident I'm yelling the whole time James stop Tim stop", "sergeant"),
    ];
    const { post } = model([
      { line: 0, first: "one of the suspects appears to be thrown around by James just as the other officer arrives.", second: "He's fully on top of them and all I can see is his arm coming up and down." },
      { line: 1, first: "He's fully on top of them and all I can see is his arm coming up and down.", second: "That's the voice of the sergeant when investigators questioned" },
      { line: 2, first: "That's the voice of the sergeant when investigators questioned him after this incident.", second: "I'm yelling the whole time James stop Tim stop" },
    ]);
    expect(await fixTurns(heard, names, "Cop Beats a Teen", dir, post)).toBe(7);
    const lines: string[] = [];
    for (const word of heard) {
      const last = lines.at(-1);
      const who = names(word.speaker!);
      if (last?.startsWith(`${who}:`)) lines[lines.length - 1] = `${last} ${word.text}`;
      else lines.push(`${who}: ${word.text}`);
    }
    expect(lines).toEqual([
      "Narrator: one of the suspects appears to be thrown around by James just as the other officer arrives",
      "Sergeant: he's fully on top of them and all I can see is his arm coming up and down",
      "Narrator: that's the voice of the sergeant when investigators questioned him after this incident",
      "Sergeant: I'm yelling the whole time James stop Tim stop",
    ]);
  } finally {
    cleanup();
  }
});

test("clips' questions are asked side by side, never more than AT_ONCE, and one asked twice at once is asked once", async () => {
  // Nov 3 (JJ: "Is it possible to get some kind of tracker on how long each edit takes?"): add_subtitles asked one clip after another, 2–4 minutes an edit.
  const { dir, cleanup } = scratch("turns-at-once");
  try {
    let out = 0;
    let most = 0;
    const asked: string[] = [];
    const post = async (body: string) => {
      asked.push(fs.readFileSync(body, "utf8"));
      out += 1;
      most = Math.max(most, out);
      await Bun.sleep(40);
      out -= 1;
      return { choices: [{ message: { content: JSON.stringify({ cuts: [] }) } }] };
    };
    const clip = (n: number) => [...said(`clip ${n} the reporter speaks`, "reporter", 0), ...said(`and clip ${n} the sergeant answers`, "sergeant", 3000)];
    const began = performance.now();
    // Twelve different clips, and one of them twice.
    await Promise.all([...Array.from({ length: 12 }, (_, n) => fixTurns(clip(n), names, "t", dir, post)), fixTurns(clip(0), names, "t", dir, post)]);
    const took = performance.now() - began;
    expect(most).toBe(AT_ONCE);
    expect(asked.length).toBe(12);
    // Two rounds of six, not twelve in a row.
    expect(took).toBeLessThan(12 * 40);
  } finally {
    cleanup();
  }
});
