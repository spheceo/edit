// Learning from a review. The notes on a commentary's review page are pulled
// into the project; then Script mode tests whether Claude has learned them
// rather than just obeying them:
//
// 1. The answer key: Opus applies the feedback directly.
// 2. The lesson: Opus turns the feedback into a skill in general terms that
//    never points at this script.
// 3. A round: a fresh Opus gets the script and the lesson only ("a reviewer
//    found problems of these kinds; find and fix them"), and Opus grades what
//    it changed against the feedback and the key.
//
// The producer improves the lesson (by hand, or by asking Opus to learn from
// the round's misses) and runs rounds until the match is high enough. Then
// the lesson is kept, so every later commentary build reads it, and what the
// last round still missed is fixed directly.

import * as fs from "node:fs";

import type { Draft, Feedback, FeedbackItem, Grade, LearnStep, Lesson, LessonRound, ScriptChange, Script } from "@edit/types/writer";

import { writeAtomic } from "../files.ts";
import { isFile, join, parent } from "../paths.ts";
import * as claude from "./claude.ts";
import * as cloud from "./cloud.ts";
import { GUIDE, write } from "./commentary.ts";
import type { Job, Outcome } from "./jobs.ts";
import { changeShelf, lessonsText, placedBlocks, scriptText, type Placed } from "./lessons.ts";
import * as reviews from "./reviews.ts";
import * as store from "./store.ts";

const MAX_ITEMS = 200;
const MAX_LESSON_CHARS = 12_000;
/** A run of this many words shared with the script is a lesson pointing at it. */
const SHINGLE = 6;

const folder = (dir: string) => join(dir, "feedback");

export function load(dir: string): Feedback | null {
  try {
    return JSON.parse(fs.readFileSync(join(folder(dir), "feedback.json"), "utf8")) as Feedback;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  fs.mkdirSync(parent(path) ?? ".", { recursive: true });
  writeAtomic(path, JSON.stringify(value, null, 2));
}

const save = (dir: string, feedback: Feedback) => writeJson(join(folder(dir), "feedback.json"), feedback);

function readDraft(path: string): Draft {
  if (!isFile(path)) throw new Error("A saved script for this feedback is missing. Pull the feedback again.");
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as Draft;
  } catch {
    throw new Error("A saved script for this feedback could not be read.");
  }
}

// ---- Kept lessons ----

/** Keeps the feedback's lesson, in place of one kept from the same pull. */
export function keep(data: string, id: string): Lesson[] {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  const feedback = load(dir);
  if (feedback === null) throw new Error("Pull feedback first.");
  if (feedback.lesson.trim() === "") throw new Error("There's no lesson yet. Run a round first.");
  return changeShelf(data, (shelf) => {
    const replaced = shelf.lessons.filter((lesson) => lesson.script === id && lesson.pulledAt === feedback.pulledAt).map((lesson) => lesson.id);
    shelf.lessons = shelf.lessons.filter((lesson) => !replaced.includes(lesson.id));
    shelf.forgotten.push(...replaced);
    const score = feedback.rounds.at(-1)?.score;
    shelf.lessons.push({
      id: `L${Date.now()}`,
      title: feedback.title.trim() === "" ? `From the review of ${script.title}` : feedback.title,
      text: feedback.lesson,
      script: id,
      scriptTitle: script.title,
      pulledAt: feedback.pulledAt,
      ...(score !== undefined ? { score } : {}),
      keptAt: Date.now(),
    });
    return shelf.lessons;
  });
}

export function forget(data: string, lesson: string): Lesson[] {
  return changeShelf(data, (shelf) => {
    if (!shelf.lessons.some((item) => item.id === lesson)) throw new Error("That lesson isn't kept.");
    shelf.lessons = shelf.lessons.filter((item) => item.id !== lesson);
    shelf.forgotten.push(lesson);
    return shelf.lessons;
  });
}

// ---- Pulling the feedback ----

/** Starts the feedback over from the notes on the script's review page: each reviewer's note, and each left from Edit, with the words it's on and its replies. */
export async function pull(data: string, id: string): Promise<Feedback> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  const current = script.commentary?.draft;
  if (!current) throw new Error("Write the script before teaching from feedback on it.");
  const link = script.review;
  if (!link) throw new Error("Share the script for review first: its notes are the feedback.");
  // The notes as the review page has them now, not as of the last poll.
  await reviews.poll(data).catch(() => false);
  const notes = reviews.notesOf(data, id);
  const problems: string[] = [];
  // The script as the reviewers read it: the version their notes are on, as it was shared.
  const version = Math.max(...notes.filter((note) => reviews.isRoot(note) && !note.deleted).map((note) => note.version), 0) || link.version;
  const shared = await reviewed(id, version);
  let draft: Draft;
  let revision: number;
  if (shared !== null) {
    [draft, revision] = shared;
    if (revision !== script.revision) problems.push(`The notes are on v${version} as it was shared; the script has changed since. Rounds start from v${version}, so using a round's script replaces the later edits.`);
  } else {
    if (link.revision !== script.revision) problems.push(`v${version} as it was shared couldn't be read from the cloud, and the script changed after it was shared. The notes are matched against the script as it is now.`);
    [draft, revision] = [current, script.revision];
  }
  const blocks = placedBlocks(draft);
  const where = places(draft);
  const items: FeedbackItem[] = notes
    .filter((note) => note.parentId == null && !note.deleted && (note.text.trim() !== "" || note.replacement !== undefined))
    .slice(0, MAX_ITEMS)
    .map((note, index): FeedbackItem => {
      const anchor = (note.anchor ?? {}) as Record<string, unknown>;
      const quote = (typeof anchor.quote === "string" ? anchor.quote : "").trim();
      // A suggestion says what to put in place of the words it's on.
      const words = note.replacement;
      const comment = words === undefined ? note.text.trim() : words === "" ? `Delete these words. ${note.text.trim()}`.trim() : note.text.trim() === "" || note.text.includes(words) ? `Replace with: ${words}` : `${note.text.trim()} (Replace with: ${words})`;
      const blockId = typeof anchor.blockId === "string" && anchor.blockId !== "" ? anchor.blockId : undefined;
      const place = (blockId !== undefined ? where.get(blockId) : undefined) ?? locate(quote, blocks) ?? undefined;
      return {
        id: `F${index + 1}`,
        kind: "comment",
        quote,
        comment,
        author: note.fromApp ? "Edit" : note.author,
        // Each reply signed, as the page shows it; the app's own accounts of a fix are left out.
        replies: reviews.replies(data, note.id).filter((reply) => !reply.fromApp && !reply.deleted && reply.text.trim() !== "").map((reply) => `${reply.author}: ${reply.text.trim()}`),
        ...(place !== undefined ? { place } : {}),
        note: "",
        skip: false,
        noteId: note.id,
        version: note.version,
        ...(blockId !== undefined ? { blockId } : {}),
        ...(typeof anchor.start === "number" ? { start: anchor.start } : {}),
        ...(typeof anchor.end === "number" ? { end: anchor.end } : {}),
        ...(note.intent !== undefined ? { intent: note.intent } : {}),
        ...(note.replacement !== undefined ? { replacement: note.replacement } : {}),
        status: note.status,
        ...(note.doneInVersion != null ? { doneIn: note.doneInVersion } : {}),
        at: note.createdAt,
      };
    });
  if (items.length === 0) throw new Error("The review has no notes yet. Leave some on its page, or add them here.");
  const missing = items.filter((item) => item.place === undefined && item.quote !== "").length;
  if (missing > 0) problems.push(`${missing} of the noted passages aren't in the script as it is now; Claude sees their words and finds them itself.`);
  // Starting over: the earlier pull's key and rounds were about other feedback.
  fs.rmSync(folder(dir), { recursive: true, force: true });
  writeJson(join(folder(dir), "base.json"), draft);
  const feedback: Feedback = { doc: link.reviewId, docUrl: link.url, pulledAt: Date.now(), revision, items, title: "", lesson: "", rounds: [], problems, costUsd: 0 };
  save(dir, feedback);
  return feedback;
}

/** The draft a version of the script was shared as, and its revision: the snapshot each share puts up beside the review. */
async function reviewed(id: string, version: number): Promise<[Draft, number] | null> {
  const bytes = await cloud.getBytes(`writer/reviews/${id}/v${version}/script.json`).catch(() => null);
  if (bytes === null) return null;
  try {
    const script = JSON.parse(new TextDecoder().decode(bytes)) as Script;
    return script.commentary?.draft ? [script.commentary.draft, script.revision] : null;
  } catch {
    return null;
  }
}

/** Each review block's place: the montage, a heading (`<first paragraph>:heading`) and every paragraph by its id. */
function places(draft: Draft): Map<string, string> {
  const out = new Map<string, string>();
  if (draft.open.length > 0) out.set("open", "Montage clip 1");
  for (const section of draft.sections) {
    const first = section.paragraphs[0];
    if (first?.id) out.set(`${first.id}:heading`, section.heading);
    section.paragraphs.forEach((paragraph, index) => {
      if (paragraph.id) out.set(paragraph.id, `${section.heading} ¶${index + 1}`);
    });
  }
  return out;
}

/** Paragraph by paragraph, what changed from one draft to the other (a longest common run of unchanged blocks). */
export function diff(before: Draft, after: Draft): ScriptChange[] {
  const [a, b] = [placedBlocks(before), placedBlocks(after)];
  const [n, m] = [a.length, b.length];
  const table = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i]![j] = a[i]!.text === b[j]!.text ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const changes: ScriptChange[] = [];
  let gone: Placed[] = [];
  let came: Placed[] = [];
  const flush = () => {
    // Removed and added side by side read as one paragraph rewritten.
    for (let index = 0; index < Math.max(gone.length, came.length); index++) {
      const [old, fresh] = [gone[index], came[index]];
      changes.push({ place: (old ?? fresh)!.place, ...(old ? { before: old.text } : {}), ...(fresh ? { after: fresh.text } : {}) });
    }
    gone = [];
    came = [];
  };
  let [i, j] = [0, 0];
  while (i < n || j < m) {
    if (i < n && j < m && a[i]!.text === b[j]!.text) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || table[i]![j + 1]! >= table[i + 1]![j]!)) came.push(b[j++]!);
    else gone.push(a[i++]!);
  }
  flush();
  return changes;
}

/** Lowercase words and digits, one space apart. */
function normalise(text: string): string {
  return [...text]
    .flatMap((c) => (/[\p{L}\p{N}]/u.test(c) ? [c.toLowerCase()] : c === "'" || c === "’" ? [] : [" "]))
    .join("")
    .split(/\s+/)
    .filter((word) => word !== "")
    .join(" ");
}

/** The block the words are in: the whole run, else its first or last words. */
export function locate(quote: string, blocks: Placed[]): string | null {
  const words = quote.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return null;
  const normalised = blocks.map((block) => normalise(block.text));
  for (const probe of [normalise(quote), normalise(words.slice(0, 8).join(" ")), normalise(words.slice(-8).join(" "))]) {
    if (probe.split(" ").length < 3 && probe.length < 12) continue;
    const at = normalised.findIndex((text) => text.includes(probe));
    if (at >= 0) return blocks[at]!.place;
  }
  return null;
}

// ---- Keeping a lesson general ----

function shingles(text: string): Set<string> {
  const words = text.split(" ").filter((word) => word !== "");
  const out = new Set<string>();
  for (let at = 0; at + SHINGLE <= words.length; at++) out.add(words.slice(at, at + SHINGLE).join(" "));
  return out;
}

/** Names the script uses that the guide doesn't: words its narration only ever capitalises, at least once mid-sentence, said at least twice. */
function names(draft: Draft): string[] {
  const COMMON = ["youtube", "twitch", "twitter", "instagram", "tiktok", "kick", "reddit", "google", "discord", "internet", "janitor", "intro"];
  const guide = new Set(normalise(GUIDE).split(" "));
  const counts = new Map<string, [number, boolean, boolean, string]>();
  for (const piece of draft.sections.flatMap((section) => section.paragraphs.flatMap((paragraph) => paragraph.pieces))) {
    if (piece.kind !== "say") continue;
    let starts = true;
    for (const token of piece.text.split(/\s+/).filter((one) => one !== "")) {
      const word = [...token].filter((c) => /[\p{L}\p{N}]/u.test(c)).join("");
      if ([...word].length >= 3) {
        const capital = /^\p{Lu}/u.test(word);
        const entry = counts.get(word.toLowerCase()) ?? [0, true, false, word];
        entry[0]++;
        entry[1] &&= capital;
        entry[2] ||= capital && !starts;
        counts.set(word.toLowerCase(), entry);
      }
      starts = /[.!?…:"“”]$/u.test(token);
    }
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .filter(([word, [count, always, inside]]) => always && inside && count >= 2 && !guide.has(word) && !COMMON.includes(word))
    .map(([, [, , , written]]) => written);
}

/** What in a lesson points at the script: phrases copied from it, and its names. */
export function leaks(lesson: string, draft: Draft): string[] {
  const script = new Set(placedBlocks(draft).flatMap((block) => [...shingles(normalise(block.text))]));
  const guide = shingles(normalise(GUIDE));
  const found = [...shingles(normalise(lesson))].filter((run) => script.has(run) && !guide.has(run)).sort();
  // Overlapping runs are one phrase; say a few.
  const phrases: string[] = [];
  for (const run of found) if (!phrases.some((phrase) => phrase.slice(1).split(" ").slice(0, 3).join(" ") === run.split(" ").slice(0, 3).join(" "))) phrases.push(`"${run}"`);
  // A name counts only capitalised, so "mark" the verb isn't Mark the person.
  const written = new Set(lesson.split(/[^\p{L}\p{N}]/u));
  phrases.push(...names(draft).filter((name) => written.has(name)).map((name) => `the name "${name}"`));
  return phrases.slice(0, 12);
}

// ---- The steps ----

const active = (feedback: Feedback): FeedbackItem[] => feedback.items.filter((item) => !item.skip);

function itemText(item: FeedbackItem): string {
  let out = `${item.id} · ${item.kind === "comment" ? "comment" : "highlight"}`;
  if (item.author !== "") out += ` by ${item.author}`;
  if (item.place) out += ` · in ${item.place}`;
  if (item.version !== undefined) out += ` · on v${item.version}`;
  if (item.quote !== "") out += `\nOn: "${item.quote}"`;
  if (item.comment !== "") out += `\nSays: ${item.comment}`;
  for (const reply of item.replies) out += `\nReply: ${reply}`;
  if (item.note.trim() !== "") out += `\nThe producer adds: ${item.note.trim()}`;
  else if (item.comment === "") out += "\n(Highlighted without a comment: the reviewer flagged it as a problem.)";
  return out;
}

const feedbackText = (items: FeedbackItem[]): string => items.map(itemText).join("\n\n");

function changesText(label: string, changes: ScriptChange[]): string {
  if (changes.length === 0) return "(no changes)";
  return changes.map((change, index) => `${label}${index + 1} · ${change.place}\nBefore: ${change.before ?? "(not there)"}\nAfter: ${change.after ?? "(removed)"}`).join("\n\n");
}

const applyRequest = (items: FeedbackItem[]): string =>
  `A reviewer left this feedback on the script. Apply every item, each where it is, as it asks. Where an item is a question, answer it in the script the way the reviewer is pointing. A highlight without a comment marks a passage the reviewer flagged: fix what's wrong with it as the guide would. Keep everything the feedback doesn't touch exactly as it is: every other paragraph, clip, time, quote and note. Send the complete script. In the report, one short line per item: what you changed.\n\nFEEDBACK\n\n${feedbackText(items)}`;

const BLIND_REQUEST =
  "A reviewer read this script and marked problems in it, every one of a kind the lesson above describes. You aren't told where they are. Read the script with the lesson in mind, find each problem, and fix it where it is. Change nothing the lesson doesn't call for: every other paragraph, clip, time, quote and note stays exactly as it is. Send the complete script. In the report, one short line per fix: where, and what was wrong.";

const TEACHER = `You teach the script writer for a commentary channel, the Internet Janitor (investigative video essays read by one narrator, with clips backing each point). A reviewer marked problems in one of its scripts. Turn the review into a lesson: a skill the writer reads before writing or fixing any script, so that it spots and fixes these problems on its own, in this script and every later one.

The writer will be tested: it gets this script and your lesson, but never the feedback and never where the problems are. So the lesson must teach the kind of problem, not the instance.
- For each kind of problem: what it is, why it's wrong for this channel, how to spot it in a draft (what to look for, as concretely as you can without pointing at this script), and how to fix it.
- Group items that share a cause into one kind. Say what the reviewer wants, not only what they don't.
- Never quote this script, never name its people, videos, places or chapters, and never point at a place in it. Where an example helps, make one up about a different person and a different story.
- Keep what the channel's guide already says out, unless the review shows the writer isn't following it; then say plainly how it slipped.
- Plain words, short. Markdown: a first line "# Lesson: <a short title>", then a "## " heading per kind. Under 700 words.`;

const LESSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "A short title for the lesson." },
    lesson: { type: "string", description: "The whole lesson, in Markdown." },
    report: { type: "string", description: "One or two sentences for the producer: what changed in the lesson, or anything in the review you couldn't teach in general terms." },
  },
  required: ["title", "lesson", "report"],
};

/** Opus writes or rewrites the lesson, sent back while it points at the script. */
async function teach(prompt: string, base: Draft, signal?: AbortSignal): Promise<[string, string, string, number]> {
  let turn = await claude.askPatiently({ model: claude.OPUS, system: TEACHER, prompt, schema: LESSON_SCHEMA, label: "Claude opus writing a lesson", ...(signal ? { signal } : {}) });
  let cost = turn.costUsd;
  for (let attempt = 0; ; attempt++) {
    const plan = claude.planOf(turn);
    if (plan === null) throw new Error("Claude did not send a lesson.");
    const text = (key: string) => (typeof plan[key] === "string" ? (plan[key] as string).trim() : "");
    if (text("lesson") === "") throw new Error("Claude sent an empty lesson.");
    const lesson = [...text("lesson")].slice(0, MAX_LESSON_CHARS).join("");
    const found = leaks(lesson, base);
    if (found.length === 0 || attempt === 2 || turn.session === null) {
      const report = found.length === 0 ? text("report") : `${text("report")} The lesson still points at the script (${found.join(", ")}); edit those parts before the next round.`;
      return [text("title"), lesson, report, cost];
    }
    const refusal = `The app sent the lesson back: it points at this script, so the test would show the writer the answers. It uses ${found.join(", ")}. Rewrite those parts in general terms, or with a made-up example about someone else, and send the whole lesson again.`;
    turn = await claude.askPatiently({ model: claude.OPUS, system: TEACHER, prompt: refusal, schema: LESSON_SCHEMA, resume: turn.session, label: "Claude opus writing a lesson (repair turn)", ...(signal ? { signal } : {}) });
    cost += turn.costUsd;
  }
}

const GRADER = `You grade a test of a script writer. A reviewer left feedback on a script. The answer key is the script with that feedback applied directly. The test is the same script fixed by a writer who never saw the feedback, only a lesson drawn from it, and had to find the problems itself.
For each feedback item, grade the test:
- fixed: it found this problem where it is and fixed it the way the reviewer asked. Its words can differ from the key's; what matters is that the reviewer would accept it.
- partly: it found the problem but the fix falls short, or fixed only part of it.
- missed: it left the problem as it was.
- wrong: it changed that passage in a way the reviewer wouldn't want, or made it worse.
Name the test's changes (T1, T2…) that deal with each item. Then list every test change that deals with no item, and say whether it's harmful (it breaks something the reviewer or the guide would want, or loses something that was fine) or harmless (a fair fix of the same kind, or neutral).
Be strict and specific: each "why" is one or two sentences a producer can act on, saying what the test did and what the key did.`;

const GRADE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdicts: {
      type: "array",
      items: { type: "object", additionalProperties: false, properties: { item: { type: "string", description: "The feedback item's ID, e.g. F3." }, grade: { type: "string", enum: ["fixed", "partly", "missed", "wrong"] }, changes: { type: "array", items: { type: "string" } }, why: { type: "string" } }, required: ["item", "grade", "changes", "why"] },
    },
    extras: { type: "array", items: { type: "object", additionalProperties: false, properties: { change: { type: "string", description: "The test change's ID, e.g. T4." }, harmful: { type: "boolean" }, why: { type: "string" } }, required: ["change", "harmful", "why"] } },
    summary: { type: "string", description: "Two or three sentences: what the lesson taught well, and what it failed to teach." },
  },
  required: ["verdicts", "extras", "summary"],
};

type Verdict = LessonRound["verdicts"][number];

/** Fixed counts 1, partly a half, of the items graded. */
export const score = (verdicts: Verdict[]): number => (verdicts.length === 0 ? 0 : verdicts.reduce((sum, verdict) => sum + (verdict.grade === "fixed" ? 1 : verdict.grade === "partly" ? 0.5 : 0), 0) / verdicts.length);

async function grade(items: FeedbackItem[], key: ScriptChange[], test: ScriptChange[], signal?: AbortSignal): Promise<[Verdict[], LessonRound["extras"], string, number]> {
  const prompt = `FEEDBACK\n\n${feedbackText(items)}\n\nTHE ANSWER KEY'S CHANGES (the feedback applied directly)\n\n${changesText("K", key)}\n\nTHE TEST'S CHANGES (made from the lesson alone)\n\n${changesText("T", test)}`;
  const turn = await claude.askPatiently({ model: claude.OPUS, system: GRADER, prompt, schema: GRADE_SCHEMA, label: "Claude opus grading a round", ...(signal ? { signal } : {}) });
  const plan = claude.planOf(turn);
  if (plan === null) throw new Error("Claude did not send its grades.");
  const given = (Array.isArray(plan.verdicts) ? plan.verdicts : []) as Verdict[];
  // One verdict per item, in order; an item it skipped counts as missed.
  const verdicts = items.map((item) => given.find((verdict) => verdict.item === item.id) ?? { item: item.id, grade: "missed" as Grade, changes: [], why: "The grader didn't grade it." });
  return [verdicts, (Array.isArray(plan.extras) ? plan.extras : []) as LessonRound["extras"], typeof plan.summary === "string" ? plan.summary.trim() : "", turn.costUsd];
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;

/** What a step needs before it starts, so the page hears at once. */
export function ready(dir: string, step: LearnStep): void {
  const feedback = load(dir);
  if (feedback === null) throw new Error("Pull feedback first.");
  if (active(feedback).length === 0) throw new Error("Every item is left out. Include at least one.");
  if (step.step === "improve" && feedback.rounds.length === 0) throw new Error("Run a round first: the lesson learns from what it missed.");
  if (step.step === "finish" && !feedback.rounds.some((round) => round.number === step.round)) throw new Error("There's no such round.");
}

/** One step, as a job. */
export async function run(data: string, id: string, step: LearnStep, job: Job): Promise<Outcome> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  const feedback = load(dir);
  if (feedback === null) throw new Error("Pull feedback first.");
  const base = readDraft(join(folder(dir), "base.json"));
  const items = active(feedback);
  if (items.length === 0) throw new Error("Every item is left out. Include at least one.");
  const lessons = lessonsText(data, { script: id, at: feedback.pulledAt });
  let cost = 0;
  if (step.step === "round") {
    if (!feedback.key) {
      job.stage("Making the answer key: the feedback applied directly");
      const built = await write(dir, script, { base, lessons, extra: "", request: applyRequest(items), pace: false }, job.signal);
      writeJson(join(folder(dir), "key.json"), built.draft);
      feedback.key = diff(base, built.draft);
      feedback.costUsd += built.costUsd;
      cost += built.costUsd;
      save(dir, feedback);
    }
    let said = "";
    if (feedback.lesson.trim() === "") {
      job.stage("Writing the lesson");
      const [title, lesson, report, spent] = await teach(`THE SCRIPT\n\n${scriptText(base)}\n\nTHE REVIEW\n\n${feedbackText(items)}`, base, job.signal);
      Object.assign(feedback, { title, lesson });
      feedback.costUsd += spent;
      cost += spent;
      said = report;
      save(dir, feedback);
    }
    const number = (feedback.rounds.at(-1)?.number ?? 0) + 1;
    job.stage(`Round ${number}: fixing the script from the lesson alone`);
    const lesson = feedback.lesson;
    const built = await write(dir, script, { base, lessons, extra: `LESSON FROM A REVIEW\n${lesson}`, request: BLIND_REQUEST, pace: false }, job.signal);
    writeJson(join(folder(dir), `round-${number}.json`), built.draft);
    const changes = diff(base, built.draft);
    job.stage(`Round ${number}: grading against the answer key`);
    const [verdicts, extras, summary, spent] = await grade(items, feedback.key ?? [], changes, job.signal);
    const round: LessonRound = { number, lesson, changes, verdicts, extras, score: score(verdicts), summary, costUsd: built.costUsd + spent, at: Date.now() };
    const fixed = verdicts.filter((verdict) => verdict.grade === "fixed").length;
    const harmful = extras.filter((extra) => extra.harmful).length;
    feedback.costUsd += round.costUsd;
    cost += round.costUsd;
    feedback.rounds.push(round);
    save(dir, feedback);
    return [`Round ${number}: ${percent(round.score)} match. ${fixed} of ${verdicts.length} items fixed${harmful > 0 ? `, ${harmful} unasked changes that hurt` : ""}.${summary === "" ? "" : ` ${summary}`}${said === "" ? "" : `\n\nThe lesson: ${said}`}`, cost];
  }
  if (step.step === "improve") {
    const round = feedback.rounds.at(-1);
    if (!round) throw new Error("Run a round first: the lesson learns from what it missed.");
    job.stage(`Improving the lesson from round ${round.number}`);
    const graded = round.verdicts.map((verdict) => `${verdict.item} · ${verdict.grade} · ${verdict.why}`).join("\n");
    const hurt = round.extras.filter((extra) => extra.harmful).map((extra) => `${extra.change} · ${extra.why}`).join("\n");
    const prompt = `THE SCRIPT\n\n${scriptText(base)}\n\nTHE REVIEW\n\n${feedbackText(items)}\n\nYOUR LESSON AS ROUND ${round.number} READ IT${round.lesson !== feedback.lesson ? " (the producer has edited it since; start from the edited one below)" : ""}\n\n${feedback.lesson}\n\nHOW THE WRITER DID (${percent(round.score)} match)\n${graded}\n\nCHANGES IT MADE THAT HURT\n${hurt === "" ? "(none)" : hurt}\n\nTHE WRITER'S CHANGES\n\n${changesText("T", round.changes)}\n\nRewrite the lesson so a writer who reads it catches what was missed or half fixed, and stops making the changes that hurt. Keep what worked. The same rules hold: never quote this script, name its people or point at a place in it.`;
    const [title, lesson, report, spent] = await teach(prompt, base, job.signal);
    if (title !== "") feedback.title = title;
    feedback.lesson = lesson;
    feedback.costUsd += spent;
    save(dir, feedback);
    return [`The lesson is rewritten from round ${round.number}. ${report}`, spent];
  }
  const found = feedback.rounds.find((round) => round.number === step.round);
  if (!found) throw new Error("There's no such round.");
  let draft = readDraft(join(folder(dir), `round-${step.round}.json`));
  const left = items.filter((item) => found.verdicts.find((verdict) => verdict.item === item.id)?.grade !== "fixed");
  let report = `Round ${step.round}'s script is the script now. It fixed every item.`;
  if (left.length > 0) {
    job.stage(`Fixing the ${left.length} items round ${step.round} missed`);
    const built = await write(dir, script, { base: draft, lessons: lessonsText(data), extra: "", request: applyRequest(left), pace: false }, job.signal);
    cost += built.costUsd;
    draft = built.draft;
    report = `Round ${step.round}'s script is the script now, with the ${left.length} items it missed fixed directly.`;
  }
  const now = store.read(dir);
  if (now.commentary) now.commentary.draft = draft;
  now.revision++;
  now.updatedAt = Date.now();
  store.write(dir, now);
  feedback.costUsd += cost;
  save(dir, feedback);
  return [report, cost];
}

/** The producer's changes to an item: leave it out, or say what it means. */
export function setItem(dir: string, item: string, skip: boolean | null, note: string | null): Feedback {
  const feedback = load(dir);
  if (feedback === null) throw new Error("Pull feedback first.");
  const found = feedback.items.find((one) => one.id === item);
  if (!found) throw new Error("There's no such item.");
  if (skip !== null) found.skip = skip;
  if (note !== null) {
    if ([...note].length > 2_000) throw new Error("Keep the note under 2,000 characters.");
    found.note = note.trim();
  }
  // The key applied the feedback as it was.
  delete feedback.key;
  fs.rmSync(join(folder(dir), "key.json"), { force: true });
  save(dir, feedback);
  return feedback;
}

/** The producer's own edit of the lesson the next round reads; what it still gives away. */
export function setLesson(dir: string, lesson: string): [Feedback, string[]] {
  const feedback = load(dir);
  if (feedback === null) throw new Error("Pull feedback first.");
  if ([...lesson].length > MAX_LESSON_CHARS) throw new Error(`Keep the lesson under ${MAX_LESSON_CHARS} characters.`);
  feedback.lesson = lesson.trim();
  save(dir, feedback);
  return [feedback, leaks(feedback.lesson, readDraft(join(folder(dir), "base.json")))];
}
