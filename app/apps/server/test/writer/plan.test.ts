import { expect, test } from "bun:test";

import type { Clip, Part, Script, Word } from "@edit/types/writer";

import { caseCount } from "../../src/writer/blocks.ts";
import { formatOf } from "../../src/writer/formats.ts";
import { compile, evidence, startHint, teamFlags, type Plan } from "../../src/writer/plan.ts";

function script(): Script {
  const said: [string, string][] = [["Hi,", "a"], ["I'm", "a"], ["Detective", "a"], ["Smith.", "a"], ["Where", "a"], ["were", "a"], ["you?", "a"], ["Home.", "b"], ["All", "b"], ["night.", "b"]];
  const words: Word[] = said.map(([text, speaker], index) => ({ id: `w${String(index).padStart(5, "0")}`, text, startMs: index * 1_000, endMs: index * 1_000 + 500, speaker }));
  return { id: "a1", title: "Case", sourceKind: "file", sourceUrl: "", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 10_000, words, clips: [], overview: [], revision: 1, createdAt: 0, updatedAt: 0, proxyPath: null };
}

const compileClips = (given: Script, plan: Plan): Clip[] => compile(given, plan).clips;
const refusal = (given: Script, plan: Plan): string => {
  try {
    compile(given, plan);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
};

test("flags what the team flagged in compilations", () => {
  const many: Script = { ...script(), compilation: true, title: "Cop Reports Dead Body" };
  many.parts = [
    { title: "One", startMs: 0, durationMs: 50_000, audio: false },
    { title: "Two", startMs: 50_000, durationMs: 50_000, audio: false },
  ];
  // A teaser with 2.2 s of nothing in it.
  many.words = [[0, 500], [600, 1_000], [3_200, 3_600]].map(([startMs, endMs], index) => ({ id: `w${index}`, text: "word", startMs: startMs!, endMs: endMs! }));
  const footage = (startMs: number, endMs: number): Clip => ({ id: `c${startMs}`, startMs, endMs });
  const cutIn = (text: string): Clip => ({ id: text, startMs: 0, endMs: 3_000, kind: "cut-in", narration: text });
  const clips = [
    footage(0, 3_600),
    cutIn("She thought nobody would check."),
    footage(20_000, 25_000),
    cutIn("On May 1, 2024, a man called 911."),
    footage(26_000, 30_000),
    footage(10_000, 15_000),
    cutIn("In the end, he was charged."),
    cutIn("So this one went even further…"),
    footage(60_000, 64_000),
    cutIn("On June 2, 2023, deputies arrived."),
    footage(66_000, 80_000),
    cutIn("In the end, she was convicted."),
  ];
  const flags = teamFlags(many, formatOf("interrogation", true, many.title), clips);
  // The team's three, then the house rules' footage checks on the same clips.
  expect(flags).toHaveLength(5);
  expect(flags[3]!.startsWith("Intro clips with no line in them")).toBe(true);
  expect(flags[4]!.startsWith("Intro clips that never play in the body")).toBe(true);
  expect(flags[0]).toContain("(0:00-0:03) (2.2 s)");
  expect(flags[0]).toContain("Dead space");
  expect(flags[1]).toContain("(0:10-0:15) after (0:26-0:30)");
  expect(flags[2]).toContain('a transition opening "So this one');
  // A courtroom compilation has no notes to check against.
  expect(teamFlags(many, formatOf("courtroom", true, "When Judges"), clips)).toEqual([]);
});

test("writes Repack's evidence", () => {
  const text = evidence(script(), null);
  expect(text).toContain("[0:00] A: w0 Hi, I'm Detective Smith. w4 Where were you?");
  expect(text).toContain("[0:07] B: w7 Home. w8 All night. (ends w9)");
});

test("compiles a plan with roles and breathing room", () => {
  const clips = compileClips(script(), {
    items: [
      { kind: "clip", firstWordId: "w0", lastWordId: "w3" },
      { kind: "cut-in", narration: "He said he was home." },
      { kind: "clip", firstWordId: "w0", lastWordId: "w9" },
      { kind: "cut-in", narration: "He was not." },
    ],
    report: "",
  });
  expect(clips[0]!.startMs).toBe(0);
  expect(clips[0]!.endMs).toBe(3_900);
  expect(clips[1]!.narrationRole).toBe("intro");
  expect(clips.at(-1)!.narrationRole).toBe("conclusion");
});

test("refuses an intro the body never replays", () => {
  const plan: Plan = {
    items: [
      { kind: "clip", firstWordId: "w7", lastWordId: "w9" },
      { kind: "cut-in", narration: "Intro." },
      { kind: "clip", firstWordId: "w0", lastWordId: "w3" },
      { kind: "cut-in", narration: "Outro." },
    ],
    report: "",
  };
  expect(refusal(script(), plan)).toContain("play again");
});

test("heads each recording and keeps clips inside one", () => {
  const two: Script = { ...script(), parts: [{ title: "Interview", startMs: 0, durationMs: 6_800, audio: false }, { title: "Jail call", startMs: 6_800, durationMs: 3_200, audio: true }] };
  const text = evidence(two, null);
  expect(text).toContain("Recording 1 · Interview\n[0:00] A: w0 Hi,");
  expect(text).toContain("w4 Where were you? (ends w6)\nRecording 2 · Jail call\n[0:07] B: w7 Home.");
  const crossing: Plan = {
    items: [
      { kind: "clip", firstWordId: "w0", lastWordId: "w9" },
      { kind: "cut-in", narration: "A." },
      { kind: "clip", firstWordId: "w0", lastWordId: "w3" },
      { kind: "cut-in", narration: "B." },
    ],
  };
  expect(refusal(two, crossing)).toContain("recording boundaries");
});

test("checks each format as Repack does", () => {
  const plan = (opening: string | null, first: string): Plan => ({
    items: [
      { kind: "clip", firstWordId: "w0", lastWordId: "w3" },
      { kind: "cut-in", narration: first },
      { kind: "clip", firstWordId: "w0", lastWordId: "w9" },
      { kind: "cut-in", narration: "In the end, he was charged." },
    ],
    ...(opening === null ? {} : { opening }),
  });
  const foia: Script = { ...script(), kind: "foia" };
  expect(refusal(foia, plan(null, "On March 3, 2023, deputies came."))).toContain("opening one-run or two-split");
  expect(refusal(foia, plan("one-run", "Deputies came one night."))).toContain("verified date");
  expect(() => compile(foia, plan("one-run", "On March 3, 2023, deputies in Pompano Beach, Florida, came."))).not.toThrow();
  const court: Script = { ...script(), kind: "courtroom" };
  expect(refusal(court, plan(null, "One paragraph only."))).toContain("two paragraphs");
  expect(() => compile(court, plan(null, "The promise.\n\nThe backstory."))).not.toThrow();
  // A compilation's transition comes straight after an outro.
  const many: Script = { ...script(), compilation: true, title: "When Lies Fall Apart" };
  const clips = compileClips(many, {
    items: [
      { kind: "clip", firstWordId: "w0", lastWordId: "w3" },
      { kind: "cut-in", narration: "Hook." },
      { kind: "clip", firstWordId: "w4", lastWordId: "w6" },
      { kind: "cut-in", narration: "These were the moments when…" },
      { kind: "cut-in", narration: "We begin with a case where…" },
      { kind: "clip", firstWordId: "w7", lastWordId: "w8" },
      { kind: "cut-in", narration: "On March 3, 2023, …" },
      { kind: "clip", firstWordId: "w0", lastWordId: "w9" },
      { kind: "cut-in", narration: "Outro." },
    ],
  });
  expect(clips.flatMap((clip) => (clip.narrationRole ? [clip.narrationRole] : []))).toEqual(["intro", "bridge", "bridge", "bridge", "conclusion"]);
});

test("reads where a link starts", () => {
  expect(startHint("https://www.youtube.com/watch?v=x&t=90")).toBe(90_000);
  expect(startHint("https://youtu.be/x?t=1h2m3s")).toBe(3_723_000);
  expect(startHint("https://youtu.be/x?si=a&t=45s")).toBe(45_000);
  expect(startHint("https://youtu.be/x")).toBeNull();
});

test("a reused case takes its transition and link only", () => {
  const many: Script = { ...script(), compilation: true, title: "Cops Who Got It Wrong", reuses: [{ url: "https://youtu.be/old", title: "An earlier case", after: 1 }] };
  const plan = (link: string): Plan => ({
    items: [
      { kind: "clip", firstWordId: "w0", lastWordId: "w3" },
      { kind: "cut-in", narration: "Intro." },
      { kind: "clip", firstWordId: "w4", lastWordId: "w6" },
      { kind: "cut-in", narration: "Outro of the first case." },
      { kind: "cut-in", narration: "Moving on to a case where…", reuseLink: link },
      { kind: "cut-in", narration: "Next, a case where…" },
      { kind: "clip", firstWordId: "w7", lastWordId: "w9" },
      { kind: "cut-in", narration: "Outro." },
    ],
  });
  expect(compileClips(many, plan("https://youtu.be/old")).flatMap((clip) => (clip.reuse ? [clip.reuse] : []))).toEqual(["https://youtu.be/old"]);
  expect(refusal(many, plan("https://youtu.be/made-up"))).toContain("not one of this compilation's reused cases");
  expect(evidence(many, null)).toContain("REUSED CASES");
  expect(() => compile(script(), plan("https://youtu.be/old"))).toThrow();
});

test("a reused case's footage only opens the video", () => {
  const old = "https://youtu.be/old";
  const parts: Part[] = [
    { title: "One", startMs: 0, durationMs: 4_000, audio: false },
    { title: "Two", startMs: 4_000, durationMs: 3_000, audio: false },
    { title: "An earlier case", startMs: 7_000, durationMs: 3_000, audio: false, url: old, reuse: old, highlights: [{ firstWordId: "w00008", lastWordId: "w00009", startMs: 8_000, endMs: 9_500, quote: "All night.", why: "A lie." }] },
  ];
  const many: Script = { ...script(), compilation: true, title: "When Liars Get Caught", sourceKind: "compilation", reuses: [{ url: old, title: "An earlier case", after: 1 }], parts };
  const said = evidence(many, null);
  expect(said).toContain("REUSED CASES' FOOTAGE");
  expect(said).toContain('w8..w9 [0:08] "All night."');
  // Its words are left out of the transcript, and the last case ends where it did.
  expect(said).not.toContain("w7 Home.");
  expect(said).toContain("(ends w6)");
  expect(caseCount(parts)).toBe(2);
  const plan = (opening: boolean): Plan => {
    const reused = { kind: "clip", firstWordId: "w8", lastWordId: "w9" };
    const items: Plan["items"] = [{ kind: "clip", firstWordId: "w0", lastWordId: "w1" }];
    if (opening) items.push(reused);
    items.push(
      { kind: "cut-in", narration: "Hook." },
      { kind: "cut-in", narration: "Title line." },
      { kind: "clip", firstWordId: "w2", lastWordId: "w3" },
      { kind: "cut-in", narration: "Outro of the first case." },
      { kind: "cut-in", narration: "Moving on…", reuseLink: old },
      { kind: "cut-in", narration: "Next, a case where…" },
      { kind: "clip", firstWordId: "w4", lastWordId: "w6" },
    );
    if (!opening) items.push(reused);
    items.push({ kind: "cut-in", narration: "Outro." });
    return { items };
  };
  expect(() => compile(many, plan(true))).not.toThrow();
  expect(refusal(many, plan(false))).toContain("only opens the video");
});

test("refuses a bad shape and em dashes", () => {
  expect(() => compile(script(), { items: [{ kind: "cut-in", narration: "A." }, { kind: "clip", firstWordId: "w0", lastWordId: "w3" }, { kind: "cut-in", narration: "B." }] })).toThrow();
  const dash: Plan = {
    items: [
      { kind: "clip", firstWordId: "w0", lastWordId: "w9" },
      { kind: "cut-in", narration: "He lied — twice." },
      { kind: "clip", firstWordId: "w0", lastWordId: "w9" },
      { kind: "cut-in", narration: "End." },
    ],
  };
  expect(refusal(script(), dash)).toContain("em dash");
});
