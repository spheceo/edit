// one_line.ts's tests: no subtitle takes two lines (Marc, Judge EXPLODES v2), on
// every write, measured as the renderer wraps (the stub: 0.58 em a character).

import { expect, test } from "bun:test";

import type { Project, TextClip } from "../src/model.ts";
import { linesOf, pieces, twoLineSubtitles } from "../src/one_line.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";

const SETTINGS = { width: 1920, height: 1080, fps: 30 };

/** A house subtitle 400 px wide at 48 px: about 14 characters a line on the stub. */
function subtitle(project: Project, id: string, start: number, duration: number, text: string, extra: Record<string, unknown> = {}): TextClip {
  return clip({
    id,
    type: "text",
    track: project.tracks[1]!.id,
    name: "Subtitle · Judge",
    start,
    duration,
    text,
    style: { font: "Montserrat", weight: 600, size: 48, tracking: 0, max_width: 400 },
    ...extra,
  }) as TextClip;
}

const subtitles = (project: Project) =>
  project.clips
    .filter((one): one is TextClip => one.type === "text" && (one.name ?? "").startsWith("Subtitle · "))
    .sort((a, b) => a.start - b.start);

test("a subtitle that would wrap is split into one-line cues at its most natural break, covering its time, on any write", async () => {
  const { store, cleanup } = fixtureHome("one-line");
  try {
    const id = store.createAs("Judge", "courtroom", SETTINGS).project.id;
    await store.update(id, "agent", (project) => void project.clips.push(subtitle(project, "s1", 100, 120, "You laughed, Timothy. At your son.")));
    const made = subtitles(store.get(id)!.project);
    expect(made.map((one) => one.text)).toEqual(["You laughed,", "Timothy.", "At your son."]);
    expect(made.every((one) => linesOf(one).length === 1)).toBe(true);
    // In order, end to end, over the cue's time; the first keeps its id.
    expect(made[0]!.id).toBe("s1");
    expect(made.reduce((end, one) => (one.start === end ? one.start + one.duration : NaN), 100)).toBe(220);
    // The UI's whole save goes through the same rule.
    const live = store.get(id)!;
    const next = structuredClone(live.project) as Project;
    next.clips.push(subtitle(next, "s9", 400, 90, "Sit down and listen to me now"));
    await store.replace(id, live.rev, next, "ui");
    expect(subtitles(store.get(id)!.project).filter((one) => one.start >= 400).map((one) => one.text)).toEqual(["Sit down and", "listen to me", "now"]);
  } finally {
    cleanup();
  }
});

test("a split follows the words' own times when the subtitle has them, and short or unsplittable ones are left for the audit", async () => {
  const { store, cleanup } = fixtureHome("one-line-times");
  try {
    const id = store.createAs("Judge", "courtroom", SETTINGS).project.id;
    await store.update(id, "agent", (project) => {
      project.clips.push(subtitle(project, "w1", 0, 90, "Stand up now. Look at me.", { word_times: [0, 6, 12, 50, 56, 62] }));
      // Too short to share: two pieces need a second.
      project.clips.push(subtitle(project, "q1", 300, 20, "Stand up right now. Look at me."));
    });
    const made = subtitles(store.get(id)!.project);
    const timed = made.filter((one) => one.start < 300);
    expect(timed.map((one) => [one.text, one.start, one.word_times])).toEqual([
      ["Stand up now.", 0, [0, 6, 12]],
      ["Look at me.", 50, [0, 6, 12]],
    ]);
    // The short one stays (two lines), and the check says so.
    expect(twoLineSubtitles(store.get(id)!.project).map((one) => one.id)).toEqual(["q1"]);
  } finally {
    cleanup();
  }
});

test("a two-line subtitle from before is left as it is by an unrelated edit, and only reported", async () => {
  const { store, cleanup } = fixtureHome("one-line-old");
  try {
    const live = store.createAs("Judge", "courtroom", SETTINGS);
    // Written straight to the file as an older Edit left it.
    const old = structuredClone(live.project) as Project;
    old.clips.push(subtitle(old, "old", 0, 120, "This is a subtitle from before the rule"));
    store.putFromCloud(old, "cloud");
    const id = old.id;
    await store.update(id, "agent", (project) => void (project.name = "Judge v3"));
    expect(subtitles(store.get(id)!.project).map((one) => one.id)).toEqual(["old"]);
    expect(twoLineSubtitles(store.get(id)!.project)).toMatchObject([{ id: "old", start: 0 }]);
    expect(twoLineSubtitles(store.get(id)!.project)[0]!.lines).toBeGreaterThan(1);
  } finally {
    cleanup();
  }
});

test("pieces: the fewest one-line pieces, cut after a sentence end before a comma before any word", () => {
  const { store, cleanup } = fixtureHome("one-line-pieces");
  try {
    const id = store.createAs("x", "courtroom", SETTINGS).project.id;
    const sample = subtitle(store.get(id)!.project as Project, "p", 0, 60, "");
    const words = (text: string) => text.split(" ");
    expect(pieces(sample, words("No. I said sit down"))).toEqual([["No.", "I", "said", "sit"], ["down"]]);
    expect(pieces(sample, words("No. Sit down now"))).toEqual([["No."], ["Sit", "down", "now"]]);
    // Two pieces either way: cut after the sentence, not after the comma.
    expect(pieces(sample, words("Sit down. Tim, now"))).toEqual([["Sit", "down."], ["Tim,", "now"]]);
    expect(pieces(sample, words("Antidisestablishmentarianism"))).toBeNull();
  } finally {
    cleanup();
  }
});

test("capitals are measured as drawn (wider): a courtroom subtitle that fits in lower case but not in capitals is split", async () => {
  const { store, cleanup } = fixtureHome("one-line-caps");
  try {
    const id = store.createAs("Judge", "courtroom", SETTINGS).project.id;
    // The stub's widths don't change with case, so its capitals come from a narrower box here; the rule's input is what's drawn.
    await store.update(id, "agent", (project) => void project.clips.push(subtitle(project, "u1", 0, 90, "Sit down, Timothy", { style: { font: "Montserrat", weight: 600, size: 48, tracking: 0, max_width: 400, uppercase: true } })));
    expect(subtitles(store.get(id)!.project).map((one) => one.text)).toEqual(["Sit down,", "Timothy"]);
  } finally {
    cleanup();
  }
});
