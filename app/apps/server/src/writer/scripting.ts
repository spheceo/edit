// Claude's work on a script, each run as a job (jobs.ts): writing it,
// changing it on the producer's request, and hearing a captioned script's
// chosen footage exactly before cutting it again. Each reads the script
// again before saving, so what the producer edited meanwhile stays, and
// says in the chat what it did or why it couldn't.

import type { Clip, Focus, Kind, Research, Script } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import * as build from "./build.ts";
import * as casefiles from "./casefiles.ts";
import * as chat from "./chat.ts";
import * as house from "./house.ts";
import * as commentary from "./commentary.ts";
import { checkClips } from "./edits.ts";
import * as exact from "./exact.ts";
import { footageFor, footagePath, soon as hearSoon, unsigned } from "./exact_after.ts";
import { checkStopped, type Job, type Outcome, named } from "./jobs.ts";
import * as lessonNote from "./lesson_note.ts";
import { lessonsText } from "./lessons.ts";
import * as media from "./media.ts";
import { nameVoices } from "./naming.ts";
import { ensureIds } from "./paragraphs.ts";
import { compile, type Plan } from "./plan.ts";
import * as research from "./research.ts";
import * as reuse from "./reuse.ts";
import { revise } from "./revise.ts";
import * as store from "./store.ts";
import { keepPeaks, readPeaks } from "./tidy.ts";
import * as versions from "./versions.ts";
import { THIS_MACHINE } from "../machine.ts";

const CHANGED = "The script changed while Claude was editing it, so nothing was applied. Ask again.";

/** The footage's 20 ms peaks, kept beside the script once read: transcription saves them, and a script made before that reads them once from its footage. */
export async function peaksOf(dir: string, script: Script, signal?: AbortSignal): Promise<Float32Array> {
  const kept = readPeaks(dir);
  if (kept !== null) return kept;
  let read: Float32Array;
  try {
    read = await media.peaks(footagePath(dir, script), signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return new Float32Array();
  }
  if (read.length > 0) keepPeaks(dir, read);
  return read;
}

/** The research the page lists: the case folder's PDFs first, then what was searched for. */
export function researchShown(dir: string): Research | null {
  const found = research.load(dir);
  if (found === null && !(casefiles.load(dir)?.read.length ?? 0)) return null;
  return casefiles.withDocuments(dir, found ?? { articles: [], queries: [], at: 0 });
}

/** Looks for the case's news again. */
export async function researchAgain(data: string, id: string, signal?: AbortSignal): Promise<Research> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  if (script.words.length === 0) throw new Error("Transcribe the footage before researching it.");
  return casefiles.withDocuments(dir, await research.run(script, dir, signal));
}

/** Saves the script after Claude's work on it, as a version of Claude's. */
function save(dir: string, before: Script, after: Script): void {
  after.revision++;
  after.updatedAt = Date.now();
  store.write(dir, after);
  versions.keep(dir, "claude", before, after);
}

/** Says a failure in the chat too (not a stop), then throws it. */
function failed(dir: string, job: Job, error: unknown): never {
  if (!job.signal.aborted) chat.add(dir, "editor", diag.messageOf(error), null, true);
  throw error;
}

/** Reused cases brought in whose moments weren't picked yet, picked before Claude's turn as Repack does; a failure leaves them out. */
async function pickReused(dir: string, script: Script, job: Job): Promise<Script> {
  if (!(script.parts ?? []).some((part) => part.reuse && !part.highlights)) return script;
  job.stage("Picking the reused cases' moments");
  await reuse.pickMissing(dir, job.signal).catch((error: unknown) => {
    if (job.signal.aborted) throw error;
  });
  return store.read(dir);
}

/**
 * Claude plans the whole script and the timeline is replaced with it. The
 * script is read again afterwards, so an edit made during the build to
 * anything but the timeline stays.
 */
export async function buildOnce(app: App, data: string, id: string, note: string, kind: Kind | undefined, job: Job): Promise<Outcome> {
  const dir = store.scriptDir(data, id);
  let script = store.read(dir);
  if (script.commentary) return buildCommentary(data, dir, script, note, job);
  if (kind !== undefined && kind !== script.kind) {
    script.kind = kind;
    store.write(dir, script);
  }
  // Names for the voices, then the news about the case. Neither is needed to write the script, so neither can stop it.
  if (Object.keys(script.speakers ?? {}).length === 0) {
    job.stage("Naming the speakers");
    try {
      await nameVoices(script, false, job.signal);
      // Only the names and suspects are this step's to write.
      const now = store.read(dir);
      now.speakers = script.speakers ?? {};
      if (script.suspects) now.suspects = script.suspects;
      store.write(dir, now);
      script = now;
    } catch (error) {
      checkStopped(job);
      diag.warn("writer", `${named(id, script.title)}: the speakers weren't named: ${diag.messageOf(error)}`);
    }
  }
  // Only the producer's brief kept from the import isn't a search yet: the news is still looked for beside it.
  const searched = (found: Research) => found.queries.length > 0 || found.articles.some((article) => article.outlet !== research.BRIEF);
  const kept = research.load(dir);
  let found: Research;
  if (kept !== null && (kept.articles.length > 0 || kept.problem === undefined) && searched(kept)) found = kept;
  // The case folder's incident report gives the facts, as in Repack: no search.
  else if (casefiles.load(dir)?.read.some((document) => document.incidentReport)) found = { articles: [], queries: [], at: Date.now(), problem: "not searched: the case folder's incident report gives the facts." };
  else {
    job.stage("Researching the case");
    found = await research.run(script, dir, job.signal);
  }
  found = casefiles.withDocuments(dir, found);
  found = await withNoteDocs(note, found, id, script.title);
  script = await pickReused(dir, script, job);
  // The sound, so pauses with speech the transcript missed are kept.
  const peaks = await peaksOf(dir, script, job.signal);
  job.stage("Writing the script");
  chat.add(dir, "producer", note.trim() === "" ? "Build the script." : `Build the script. ${note.trim()}`);
  let built: build.Built;
  try {
    built = await (build.fastChosen() ? build.buildFast : build.build)(script, note, found, peaks, job.signal, job.stage);
  } catch (error) {
    failed(dir, job, error);
  }
  const reports = found.articles.length;
  const researched = reports === 0 ? `Research: ${found.problem ?? "nothing found."}` : `Research: ${reports} ${reports === 1 ? "report" : "reports"} (${found.articles.map((article) => article.outlet).join(", ")}).`;
  let report = `${built.report.trim()}\n\n${researched}`;
  checkStopped(job);
  const now = store.read(dir);
  const before = structuredClone(now);
  let clips = built.clips;
  if (exact.wanted(now)) {
    let said: string;
    [clips, said] = await cutExactly(app, data, dir, now, built.plan, clips, peaks, job);
    report = `${report}\n\n${said}`;
  }
  try {
    now.clips = checkClips(clips, now.durationMs);
  } catch (error) {
    failed(dir, job, error);
  }
  now.proposals = [];
  const muted = house.withMuteNotes(now);
  if (muted > 0) report = `${report}\n\nMute notes for the editor on ${muted} footage clip${muted === 1 ? "" : "s"} (sex and rape-type words).`;
  save(dir, before, now);
  chat.add(dir, "editor", report, built.costUsd);
  return [report, built.costUsd];
}

/**
 * Fresh eyes for a script (loop 7, Nov 2; Edit mode's FRESH_EYES, agent.ts):
 * once a build is saved, a second Opus turn reads it as the team reviews it,
 * with only the script, its sources and the house rules, and fixes what it
 * finds, saved narration written straight in. Off with EDIT_SCRIPT_FRESH_EYES=0
 * or a build asked with review: false.
 */
export function freshEyesRequest(courtroom: boolean): string {
  const blocks = courtroom
    ? "Every footage block: as the courtroom shape paces it (tight early, relaxed later), no cut-in after less than about a minute of footage, no crumbs."
    : "Every footage block: none past about three minutes (break it where the conversation turns, with a cut-in that adds what the footage can't), no cut-in after less than about a minute of footage, no crumbs, no procedure or sound-only stretch holding the picture back.";
  const opening = courtroom ? "The intro clips: the moments the title promises?" : "The very first clip: the title's moment, with picture?";
  return `Read this script once more with fresh eyes, as the team reviews it before recording, and fix what they would flag. ${opening} ${blocks} Every cut-in: does it turn what the viewer just saw rather than describe it again, carry what the footage can't show (the people's life, the motive, what changed), introduce anyone it speaks of? The format's shape and guides hold throughout. Change only what needs it; keep what already works, and say in a few lines what you changed and why.`;
}

// On by default since loop 7 S2–S3 (four builds with and without: fewer flags, less re-telling, crumbs merged, for about two minutes); EDIT_SCRIPT_FRESH_EYES=0 turns it off, a build may ask with review.
export const scriptFreshEyes = (asked: boolean | undefined): boolean => asked ?? process.env.EDIT_SCRIPT_FRESH_EYES !== "0";

/**
 * A Google Doc the build's note links to, read with the team's sign-in and
 * given to the builder beside the research (Republican Chairman, Nov 1: "you
 * can basically look at this script right here and more or less take direct
 * inspiration from it, in particular when it comes to the intro since this is
 * the same case: <Doc>"; the build answered "I couldn't open your reference
 * doc"). One that can't be read is said so to the builder, which tells the producer.
 */
export async function withNoteDocs(note: string, found: Research, id: string, title: string): Promise<Research> {
  const links = [...new Set(note.match(/https:\/\/docs\.google\.com\/document\/d\/[\w-]+[^\s)]*/gu) ?? [])].slice(0, 3);
  if (links.length === 0) return found;
  const articles = [...found.articles];
  for (const link of links) {
    try {
      const [name, text] = await commentary.fetchSource(link);
      articles.push({ title: `The producer's reference: ${name}`, outlet: "A Doc the producer's note links to (follow the note on what to take from it)", published: null, url: link, summary: [...text.trim()].slice(0, 20_000).join(""), facts: [] });
    } catch (error) {
      diag.warn("writer", `${named(id, title)}: the note's Doc ${link} couldn't be read: ${diag.messageOf(error)}`);
      articles.push({ title: "The producer's reference (not read)", outlet: "A Doc the producer's note links to", published: null, url: link, summary: `This Doc couldn't be read (${diag.messageOf(error)}). Say so in the report, with the reason.`, facts: [] });
    }
  }
  return { ...found, articles };
}

/** A build, then (unless asked not to) the fresh read. */
export async function buildAndReview(app: App, data: string, id: string, note: string, kind: Kind | undefined, review: boolean, job: Job): Promise<Outcome> {
  const [report, cost] = await buildOnce(app, data, id, note, kind, job);
  if (!review) return [report, cost];
  checkStopped(job);
  job.stage("Reading it with fresh eyes");
  try {
    const courtroom = store.read(store.scriptDir(data, id)).kind === "courtroom";
    const [again, more] = await reviseWith(data, id, freshEyesRequest(courtroom), "Fresh eyes: the final read.", { selected: [], picked: null, playheadMs: null }, true, job);
    return [`${report}\n\nFresh eyes: ${again}`, cost + more];
  } catch (error) {
    checkStopped(job);
    diag.warn("writer", `${named(id, store.read(store.scriptDir(data, id)).title)}: the fresh read didn't finish: ${diag.messageOf(error)}`);
    return [report, cost];
  }
}

/** A commentary is written from its sources alone: no speakers to name or case to research. */
async function buildCommentary(data: string, dir: string, script: Script, note: string, job: Job): Promise<Outcome> {
  job.stage("Writing the script");
  const built = await commentary.build(dir, script, note, lessonsText(data), job.signal);
  checkStopped(job);
  // Sources added or renamed during the build stay; the script is replaced.
  const now = store.read(dir);
  const before = structuredClone(now);
  if (now.commentary) now.commentary.draft = built.draft;
  save(dir, before, now);
  return [built.report, built.costUsd];
}

/**
 * A script built before its captioned footage was heard exactly, heard and
 * cut again: the same words and narration, read back from its clips, with
 * the producer's clip notes kept.
 */
export async function exactOnce(app: App, data: string, id: string, job: Job): Promise<Outcome> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  if (!exact.wanted(script)) throw new Error("Only footage transcribed from YouTube's captions needs hearing exactly.");
  if (!script.clips.some((clip) => clip.kind === "cut-in")) throw new Error("Build the script first.");
  const before = structuredClone(script);
  const peaks = await peaksOf(dir, script, job.signal);
  const [clips, said] = await cutExactly(app, data, dir, script, exact.planOf(script), before.clips, peaks, job);
  exact.keepNotes(before.words, before.clips, script.words, clips);
  checkStopped(job);
  if (store.read(dir).revision !== before.revision) throw new Error("The script changed while its footage was heard, so nothing was applied. Try again.");
  script.clips = checkClips(clips, script.durationMs);
  save(dir, before, script);
  chat.add(dir, "editor", said);
  return [said, 0];
}

/**
 * A captioned script's chosen footage heard exactly, then the same plan cut
 * again on those times, without any piece that has no sound. Hearing that
 * fails leaves the captions' cut, and says so.
 */
async function cutExactly(app: App, data: string, dir: string, script: Script, plan: Plan, clips: Clip[], peaks: ArrayLike<number>, job: Job): Promise<[Clip[], string]> {
  // Footage cleared from this Mac once the cloud held it is read from the cloud's preview, a stretch at a time.
  const source = await footageFor(app, data, dir, script.id, job);
  if ("away" in source) return [clips, `The footage isn't on ${THIS_MACHINE} and couldn't be read from the cloud (${source.away}), so its cuts follow YouTube's captions. Build again to try once more.`];
  const words = script.words;
  let heard: exact.Report;
  try {
    heard = await exact.run(script, dir, source.footage, clips, job.stage, job.signal);
  } catch (error) {
    checkStopped(job);
    const why = unsigned(diag.messageOf(error));
    diag.warn("writer", `${named(script.id, script.title)}: the chosen footage couldn't be heard exactly: ${why}`);
    return [clips, `The chosen footage couldn't be heard exactly (${why}), so its cuts follow YouTube's captions. Build again to try once more.`];
  }
  let cut: Clip[];
  try {
    cut = compile(script, plan, peaks).clips;
  } catch (error) {
    diag.warn("writer", `${named(script.id, script.title)}: the plan didn't cut again on the exact times: ${diag.messageOf(error)}`);
    cut = exact.remapFrom(words, clips, script.words, script.durationMs);
  }
  const silent = new Set(exact.silent(cut, peaks));
  return [cut.filter((_, index) => !silent.has(index)), exact.said(heard, silent.size)];
}

/** Claude revises a built script on the producer's request (`said` is what the chat shows of it); `direct` (a fix from a review) writes saved narration straight in rather than proposing it. */
export async function reviseWith(data: string, id: string, request: string, said: string, focus: Focus, direct: boolean, job: Job): Promise<Outcome> {
  const dir = store.scriptDir(data, id);
  let script = store.read(dir);
  if (script.commentary) return reviseCommentary(data, dir, script, request, said, job);
  if (!script.clips.some((clip) => clip.kind === "cut-in")) throw new Error("Build the script first; then ask for changes.");
  const earlier = chat.recent(dir);
  chat.add(dir, "producer", said);
  script = await pickReused(dir, script, job);
  const peaks = await peaksOf(dir, script, job.signal);
  const found = casefiles.withDocuments(dir, research.load(dir) ?? { articles: [], queries: [], at: 0 });
  let done: Awaited<ReturnType<typeof revise>>;
  try {
    done = await revise(script, request, focus, earlier, found, peaks, direct, job.signal);
  } catch (error) {
    failed(dir, job, error);
  }
  checkStopped(job);
  const noted = await lessonNote.keep(script, done.lesson);
  // Starting over waits for the producer to confirm it in the chat.
  if (done.startOver) {
    chat.askReset(dir, done.answer + noted, done.costUsd);
    return [done.answer + noted, done.costUsd];
  }
  // Edits made by hand while Claude worked would be lost: ask again instead.
  const now = store.read(dir);
  if (now.revision !== script.revision) failed(dir, job, new Error(CHANGED));
  const before = structuredClone(now);
  const answer = done.answer;
  const clips = done.clips;
  try {
    now.clips = checkClips(clips, now.durationMs);
  } catch (error) {
    failed(dir, job, new Error(`Claude's edits left the timeline unusable (${diag.messageOf(error)}), so nothing was applied. Ask again.`));
  }
  now.corrections = done.corrections;
  now.proposals = done.proposals;
  // Footage a revision brings in gets the editor's mute notes too (loop 7: the fresh read's new clips had none).
  house.withMuteNotes(now);
  save(dir, before, now);
  chat.add(dir, "editor", answer + noted, done.costUsd);
  // Footage it brought in is heard exactly after it's done, its cuts moved onto those times a moment later (exact_after.ts).
  hearSoon(data, id);
  return [answer + noted, done.costUsd];
}

/** A change to a written commentary: Opus edits the paragraphs the request is about and nothing else, written straight in (undo and the versions bring back what was there). */
export async function reviseCommentary(data: string, dir: string, given: Script, request: string, said: string, job: Job): Promise<Outcome> {
  // Edits name paragraphs by id: a script never shared gets them now.
  const script = structuredClone(given);
  if (script.commentary?.draft && ensureIds(script.commentary.draft)) store.write(dir, script);
  chat.add(dir, "producer", said);
  let done: commentary.Revised;
  try {
    done = await commentary.revise(dir, script, request, lessonsText(data), job.signal);
  } catch (error) {
    failed(dir, job, error);
  }
  checkStopped(job);
  const noted = await lessonNote.keep(script, done.lesson);
  if (done.startOver) {
    chat.askReset(dir, done.answer + noted, done.costUsd);
    return [done.answer + noted, done.costUsd];
  }
  const now = store.read(dir);
  if (now.revision !== script.revision) failed(dir, job, new Error(CHANGED));
  if (now.commentary && JSON.stringify(now.commentary.draft) !== JSON.stringify(done.draft)) {
    const before = structuredClone(now);
    now.commentary.draft = done.draft;
    save(dir, before, now);
  }
  chat.add(dir, "editor", done.answer + noted, done.costUsd);
  return [done.answer + noted, done.costUsd];
}
