import { expect, test } from "bun:test";

import type { Cite, Draft, Paragraph, Role, Source } from "@edit/types/writer";

import { applyEdits, attributions, audit, compile, Corpus, docText, fileName, measure, offPacing, paragraphOf, planOf, type Sourced } from "../../src/writer/commentary.ts";
import { cites, noteLines } from "../../src/writer/paragraphs.ts";

const say = (text: string, id = ""): Paragraph => ({ id, pieces: [{ kind: "say", text }] });
const draftOf = (paragraphs: Paragraph[]): Draft => ({ open: [], sections: [{ heading: "Intro", paragraphs }], checks: [], report: "", writtenAt: 0 });
const source = (id: string, role: Role, timed: boolean): Source => ({ id, title: id, role, origin: "pasted", chars: 0, timed, preview: "", addedAt: 0 });
const clipCite: Cite = { source: "S3", video: "v", startMs: 1_000, endMs: 4_000, quote: "hi" };

function corpus(): Corpus {
  return new Corpus([
    [source("S1", "brief", false), "Old version: https://archive.org/details/x/Time.mp4\nNew version: https://youtu.be/abc?t=36"],
    [source("S2", "evidence", false), "  CUT:           Have you ever died from doing meth before? Yes, I've actually died like five times from\n      doing meth in GTA what's"],
    [source("S3", "evidence", true), "Transcript\n[0:12] A: I will upload more.\n[2:10] A: I want a Lambo. I will milk my fan base for money."],
    [source("S4", "style", false), "I'm the Internet Janitor"],
  ]);
}

const clip = (sourceId: string, start: string, end: string, quote: string): Record<string, unknown> => ({ kind: "clip", source: sourceId, video: "A video", start, end, quote });

const plan = (pieces: Record<string, unknown>[]): Record<string, unknown> => ({
  open: [],
  sections: [
    { heading: "Intro", paragraphs: [{ pieces: [{ kind: "say", text: "Hello." }] }] },
    { heading: "1. Cuts", paragraphs: [{ pieces, note: "Bleep it." }] },
    { heading: "Ending", paragraphs: [{ pieces: [{ kind: "say", text: "Bye." }] }] },
  ],
  checks: ["Check the voice."],
  report: "Fine.",
});

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a refusal");
};

test("a revision changes only the paragraphs it names", () => {
  const draft: Draft = {
    open: [],
    sections: [
      { heading: "Intro", paragraphs: [say("One.", "pa"), say("Two.", "pb")] },
      { heading: "1. Middle", paragraphs: [say("Three.", "pc")] },
      { heading: "Ending", paragraphs: [say("Four.", "pd")] },
    ],
    checks: [],
    report: "",
    writtenAt: 0,
  };
  const empty = new Corpus([]);
  const out = applyEdits(
    draft,
    [
      { op: "replace", id: "pb", paragraph: { pieces: [{ kind: "say", text: "Two, said better." }] } },
      { op: "insert_after", id: "pc", paragraph: { pieces: [{ kind: "say", text: "Three and a half." }] } },
      { op: "delete", id: "pa" },
      { op: "heading", id: "pc:heading", heading: "1. The Middle" },
      { op: "note", id: "pd", note: "a blue waveform under the call" },
    ],
    empty,
  );
  expect(out.sections[0]!.paragraphs.length).toBe(1);
  expect(out.sections[0]!.paragraphs[0]!.id).toBe("pb");
  expect(out.sections[0]!.paragraphs[0]!.pieces).toEqual([{ kind: "say", text: "Two, said better." }]);
  expect(out.sections[1]!.heading).toBe("1. The Middle");
  expect(out.sections[1]!.paragraphs[0]).toEqual(draft.sections[1]!.paragraphs[0]!);
  expect(out.sections[1]!.paragraphs[1]!.id).not.toBe("");
  expect(out.sections[2]!.paragraphs[0]!.note).toBe("edit: a blue waveform under the call");
  expect(refusal(() => applyEdits(draft, [{ op: "delete", id: "nope" }], empty))).toContain("no paragraph");
  expect(refusal(() => applyEdits(draft, [{ op: "delete", id: "pc" }], empty))).toContain("three sections");
  // The draft given is left as it was.
  expect(draft.sections[0]!.paragraphs.length).toBe(2);
});

test("the audit flags what a reviewer would", () => {
  const essay: Sourced = [source("S2", "evidence", true), 'Captions of "The Rise of Someone" by Kettle Kate on YouTube (https://x). What it is: A commentary/documentary-style video essay by Kettle Kate on her career.\n[0:01] hello'];
  const podcast: Sourced = [source("S3", "evidence", true), 'Captions of "Someone Talks" by Big Pod on YouTube (https://y). What it is: Podcast episode with Someone.\n[0:01] hi'];
  const sources = [essay, podcast];
  const flagged = audit(draftOf([say("According to Kettle Kate, she started in 2012. Remember that phrase. Big Pod asked her why.")]), sources, "The Rise of Someone", "channel");
  expect(flagged.length).toBe(2);
  expect(flagged[0]).toContain("Kettle Kate's video 1 time");
  expect(flagged[1]).toContain("remember");
  // A creator the video is about isn't flagged; a podcast host never is.
  expect(audit(draftOf([say("Kettle Kate says she started in 2012.")]), sources, "Kettle Kate Was Right", "channel")).toEqual([]);
  // Clip endings count in either pacing.
  const ending: Paragraph[] = Array.from({ length: 10 }, () => ({ id: "", pieces: [{ kind: "say", text: "She went live." }, { kind: "clip", ...clipCite }] }));
  expect(audit(draftOf(ending), sources, "t", "channel")[0]).toContain("10 of 10 paragraphs end on a clip");
  expect(audit(draftOf(ending), sources, "t", "documentary")[0]).toContain("10 of 10 paragraphs end on a clip");
});

test("documentary pacing sends back a clip-heavy script", () => {
  const cite = (seconds: number): Cite => ({ source: "S1", video: "Stream", startMs: 0, endMs: seconds * 1000, quote: "" });
  // 1,500 words is 10 minutes of narration.
  const draft = (clips: Cite[]): Draft => ({
    open: [],
    sections: [{ heading: "1. Cuts", paragraphs: [{ id: "", pieces: [{ kind: "say", text: "word ".repeat(1_500) }, ...clips.map((one) => ({ kind: "clip" as const, ...one }))] }] }],
    checks: [],
    report: "",
    writtenAt: 0,
  });
  const times = (count: number, seconds: number) => Array.from({ length: count }, () => cite(seconds));
  // Turkey Tom's: 16 clips of 12 s against 10 minutes of narration.
  expect(offPacing("documentary", draft(times(16, 12)))).toBeNull();
  // Too much clip time, and too many clips.
  expect(offPacing("documentary", draft(times(10, 40)))).not.toBeNull();
  expect(offPacing("documentary", draft(times(30, 5)))).toContain("at most about 16 clips");
  // The channel's own pacing is clip-led, and never sent back for it.
  expect(offPacing("channel", draft(times(40, 40)))).toBeNull();
});

test("finds a quote across lines and elisions", () => {
  const draft = compile(plan([{ kind: "say", text: "Here's what he said…" }, clip("S2", "0:14", "0:21", "Have you ever died from doing meth before? … I've actually died like five times from doing meth in GTA")]), corpus());
  expect(cites(draft).length).toBe(1);
  expect(draft.sections[1]!.paragraphs[0]!.note).toBe("Bleep it.");
  expect(draft.checks).toEqual(["Check the voice."]);
});

test("refuses a made-up quote, a style cite and an unknown link", () => {
  const given = corpus();
  expect(refusal(() => compile(plan([clip("S2", "0:14", "0:21", "I love meth")]), given))).toContain("doesn't hold those words");
  expect(refusal(() => compile(plan([clip("S4", "0:00", "0:03", "I'm the Internet Janitor")]), given))).toContain("style example");
  expect(refusal(() => compile(plan([{ ...clip("S2", "0:14", "0:21", "doing meth in GTA"), link: "https://youtu.be/zzz" }]), given))).toContain("no source gives");
  expect(() => compile(plan([{ ...clip("S2", "0:14", "0:21", "doing meth in GTA"), link: "https://youtu.be/abc?t=40" }]), given)).not.toThrow();
  expect(refusal(() => compile(plan([{ kind: "say", text: "He said it — twice." }]), given))).toContain("em dash");
});

test("checks times in a timed transcript", () => {
  expect(() => compile(plan([clip("S3", "2:10", "2:16", "I want a Lambo")]), corpus())).not.toThrow();
  expect(refusal(() => compile(plan([clip("S3", "5:00", "5:06", "I want a Lambo")]), corpus()))).toContain("at 2:10");
});

test("a clip without words becomes a check", () => {
  const draft = compile(plan([clip("S2", "3:08", "3:15", "")]), corpus());
  expect(draft.checks.some((check) => check.includes("no words"))).toBe(true);
});

test("keeps a Doc's links", () => {
  const html = `<html><head><style>.c1{color:red}</style></head><body class="c5 doc-content"><p class="c1"><span>The MrBeast Files doc:</span></p><ul><li><span>SUPER: a $100K presale (</span><span class="c3"><a href="https://www.google.com/url?q=https://youtu.be/dslLBsHkVzE?t%3D195&amp;sa=D&amp;source=editors">3:15-3:47</a></span><span>)</span></li><li><span>Burger (</span><a href="https://www.google.com/url?q=https://youtu.be/IkTH9ZTKsls?t%3D606&amp;sa=D"> </a><a href="https://www.google.com/url?q=https://youtu.be/IkTH9ZTKsls?t%3D606&amp;sa=D">10:07</a><a href="https://www.google.com/url?q=https://youtu.be/IkTH9ZTKsls?t%3D606&amp;sa=D">-10:34</a><span>) &ldquo;no&rdquo;<sup><a href="#cmnt1" id="cmnt_ref1">[a]</a></sup></span></li></ul><p><a href="https://x.com/a">https://x.com/a</a></p></body></html>`;
  expect(docText(html)).toBe('The MrBeast Files doc:\n* SUPER: a $100K presale (3:15-3:47 <https://youtu.be/dslLBsHkVzE?t=195>)\n* Burger ( 10:07-10:34 <https://youtu.be/IkTH9ZTKsls?t=606>) "no"[a]\nhttps://x.com/a');
});

test("reads a file name header", () => {
  expect(fileName('attachment; filename="Report (1).txt"')).toBe("Report (1).txt");
  expect(fileName("attachment; filename=\"x\"; filename*=UTF-8''Caf%C3%A9.txt")).toBe("Café.txt");
});

test("notes carry their words, and quote pop-ups are checked", () => {
  const given = corpus();
  const clips = { count: 0 };
  const paragraph = {
    pieces: [{ kind: "say", text: "He wanted a car. He said it himself: I want a Lambo. Then he said the quiet part." }],
    notes: [
      { on: "He wanted a car.", text: "Show: the dealership photo." },
      { on: "words that aren't here", text: "Find: the stream." },
    ],
    quotes: [{ on: "I want a Lambo", who: "Him", source: "S3", video: "Stream", start: "2:10", end: "2:14", quote: "I want a Lambo." }],
  };
  const out = paragraphOf(paragraph, given, "1. Money", clips)!;
  expect(noteLines(out)).toEqual(["Show: the dealership photo.", "Find: the stream.", "Quote pop-up (typewriter): “I want a Lambo.” (Him, Stream 2:10-2:14)"]);
  // The note whose words aren't said is on the whole paragraph.
  expect(out.marks!.length).toBe(2);
  expect(out.marks![0]!.on).toBe("He wanted a car.");
  expect(out.marks![1]!.quote!.said.quote).toBe("I want a Lambo.");
  // The plan given back keeps each note's words and the pop-up.
  const back = planOf({ open: [], sections: [{ heading: "1. Money", paragraphs: [out] }], checks: [], report: "", writtenAt: 0 }) as { sections: { paragraphs: unknown[] }[] };
  expect(paragraphOf(back.sections[0]!.paragraphs[0], given, "1. Money", clips)).toEqual(out);
  // A pop-up has to type what the source holds, and the narration has to say it.
  const madeUp = { pieces: [{ kind: "say", text: "He said: I want a Ferrari." }], quotes: [{ on: "I want a Ferrari", who: "Him", source: "S3", video: "Stream", start: "2:10", end: "2:14", quote: "I want a Ferrari." }] };
  expect(refusal(() => paragraphOf(madeUp, given, "1. Money", clips))).toContain("doesn't hold those words");
  const unsaid = { pieces: [{ kind: "say", text: "He wanted a car." }], quotes: [{ on: "I want a Lambo", who: "Him", source: "S3", video: "Stream", start: "2:10", end: "2:14", quote: "I want a Lambo." }] };
  expect(refusal(() => paragraphOf(unsaid, given, "1. Money", clips))).toContain("aren't in that paragraph's narration");
  // A revision's note goes on the words it names.
  const draft: Draft = {
    open: [],
    sections: [
      { heading: "Intro", paragraphs: [{ ...out, id: "pa" }] },
      { heading: "1", paragraphs: [{ ...out, id: "pb" }] },
      { heading: "Ending", paragraphs: [{ ...out, id: "pc" }] },
    ],
    checks: [],
    report: "",
    writtenAt: 0,
  };
  const edited = applyEdits(draft, [{ op: "note", id: "pa", note: "a red flash", on: "the quiet part" }], given);
  const mark = edited.sections[0]!.paragraphs[0]!.marks!.at(-1)!;
  expect([mark.line, mark.on]).toEqual(["edit: a red flash", "the quiet part"]);
});

test("measures what the team flags", () => {
  expect(attributions("On Bradley Martyn's podcast, he told Steiny that, according to Logan Paul, it was fake.")).toEqual(["on Bradley Martyn's podcast", "told Steiny", "according to Logan"]);
  expect(attributions("According to the lawsuit, he told police nothing. On his own stream he laughed.")).toEqual([]);
  // "He… He… He…" and sequence openers are a recital; "and then" is counted anywhere. A device isn't one: "Whether… Whether… Whether…".
  expect(measure(draftOf([say("Whether he paid. Whether he knew. Whether anyone was paid.")])).recitalRuns).toEqual([]);
  const measured = measure(draftOf([say("He went live. He insulted a guest. He got banned. Later, he came back. A week later, he did it again. And then it got worse.")]));
  expect(measured.sequenceOpeners).toBe(3);
  expect(measured.andThen).toBe(1);
  expect(measure(draftOf([say("Sneako said: “He called and then went to gamble.”")])).andThen).toBe(0);
  expect(measured.recitalRuns.length).toBe(2);
  // A note on no words, or on all of a long paragraph, is on the whole paragraph.
  const long = "This paragraph runs on for a while about one thing and then another so that it has well over twenty five words in it to measure the share.";
  const noted: Paragraph = {
    ...say(long),
    note: "Show: the post.\nFind: the stream.\nShow: the clip.",
    marks: [
      { line: "Show: the post.", on: "one thing" },
      { line: "Find: the stream.", on: long },
    ],
  };
  const notes = measure(draftOf([noted]));
  expect(notes.notes).toBe(3);
  expect(notes.wholeParagraphNotes).toEqual(['"Find: the stream."', '"Show: the clip."']);
  // Sentences leading into a clip.
  const leading = measure(draftOf([{ id: "", pieces: [{ kind: "say", text: "One. Two. Watch this…" }, { kind: "clip", ...clipCite }, { kind: "say", text: "Four." }] }]));
  expect([leading.sentences, leading.sentencesIntoClips, leading.clips]).toEqual([4, 1, 1]);
});

test("the audit flags attributions, recitals, clip leads and whole-paragraph notes", () => {
  const named = (count: number) => Array.from({ length: count }, (_, index) => say(`On Host${index}'s podcast, he said it was fine.`));
  expect(audit(draftOf(named(5)), [], "t", "channel").some((flag) => flag.includes("5 sentences say who or where"))).toBe(true);
  expect(audit(draftOf(named(4)), [], "t", "channel").some((flag) => flag.includes("who or where"))).toBe(false);
  // Half the sentences leading into clips, in either pacing.
  const led: Paragraph[] = Array.from({ length: 40 }, () => ({ id: "", pieces: [{ kind: "say", text: "It was a big day." }, { kind: "say", text: "Watch…" }, { kind: "clip", ...clipCite }] }));
  expect(audit(draftOf(led), [], "t", "channel").some((flag) => flag.includes("40 of 80 sentences lead straight into a clip"))).toBe(true);
  const noted: Paragraph = { ...say("She posted it at midnight."), note: "Show: the post." };
  expect(audit(draftOf([noted]), [], "t", "channel").some((flag) => flag.includes("1 editor notes are on a whole paragraph"))).toBe(true);
});
