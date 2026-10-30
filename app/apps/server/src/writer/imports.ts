// Imports, built to bounce back. Every stage keeps what it finished on disk
// (the download, each Drive recording, the preview, each transcribed piece),
// so Retry carries on from where an import stopped. What only the producer
// can decide (some recordings failed, a folder holds too much, nothing was
// heard) pauses the import with a question instead of failing it, as Repack
// does. A YouTube video comes down into Edit's media folder, so Edit mode
// cuts from the same file.

import * as fs from "node:fs";

import type { Choice, Decision, ImportProgress, Kind, Label, Research, Reuse, Script, VideoCheck } from "@edit/types/writer";

import type { App } from "../app.ts";
import { creator } from "../accounts.ts";
import * as diag from "../diag.ts";
import { isFile, join } from "../paths.ts";
import { isUrl } from "../tools.ts";
import * as brief from "./brief.ts";
import * as can from "./can.ts";
import * as casefiles from "./casefiles.ts";
import { fix as fixSpills } from "./spills.ts";
import * as drive from "./drive.ts";
import * as handoff from "./handoff.ts";
import * as jobs from "./jobs.ts";
import * as media from "./media.ts";
import { caseNames } from "./names.ts";
import { nameVoices } from "./naming.ts";
import * as parts from "./parts.ts";
import * as research from "./research.ts";
import * as reuse from "./reuse.ts";
import * as storage from "./storage.ts";
import * as streamed from "./streamed.ts";
import * as store from "./store.ts";
import * as transcription from "./transcription.ts";
import * as trello from "./trello.ts";
import * as caption_turns from "./caption_turns.ts";
import * as versions from "./versions.ts";
import * as watch from "./watch.ts";
import * as youtube from "./youtube.ts";

/** Drive recordings (or compilation videos) downloaded at once. */
const DOWNLOADS = 3;
/** Repack's limits for one case. */
const MAX_FILES = 60;
const MAX_FILE_MS = 10 * 3_600_000;
const MAX_FILE_BYTES = 30_000_000_000;
/** Imports run side by side, up to three, each on its own script. */
const MAX_IMPORTS = 3;

const running = new Set<string>();
const latest = new Map<string, ImportProgress>();
/** When each running import began. */
const started = new Map<string, number>();

/** Whether this script is importing right now. */
export const importing = (id: string): boolean => running.has(id);
/** Whether any script is importing (a restart would cut it off). */
export const anyImporting = (): boolean => running.size > 0;

/** Every import running now, so the page can follow them. */
export const progress = (): ImportProgress[] => [...latest.values()];

function busy(id: string): () => void {
  if (jobs.running(id)) throw new Error("Wait for this project's current job to finish before retrying its import.");
  if (running.has(id)) throw new Error("This import is already running.");
  if (running.size >= MAX_IMPORTS) throw new Error(`${MAX_IMPORTS} imports are already running. Try again when one finishes.`);
  running.add(id);
  started.set(id, Date.now());
  return () => {
    running.delete(id);
    latest.delete(id);
    started.delete(id);
  };
}

/**
 * Where each running import's time went, by stage, as `say` hears them: the
 * import's last line breaks it down (the user, Oct 30: "logging how long things
 * take ... breaking down everything").
 */
const stages = new Map<string, { stage: string; since: number; spent: Map<string, number> }>();

function noteStage(id: string, stage: string): void {
  const now = Date.now();
  const at = stages.get(id);
  if (at === undefined) return void stages.set(id, { stage, since: now, spent: new Map() });
  if (at.stage === stage) return;
  at.spent.set(at.stage, (at.spent.get(at.stage) ?? 0) + now - at.since);
  at.stage = stage;
  at.since = now;
}

/** "downloading 52 min, processing 1 h 35 min, transcribing 26 min": the import's time by stage, then forgotten. */
function stageTimes(id: string): string {
  const at = stages.get(id);
  stages.delete(id);
  if (at === undefined) return "";
  at.spent.set(at.stage, (at.spent.get(at.stage) ?? 0) + Date.now() - at.since);
  const took = (ms: number) => (ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)} h ${Math.round((ms % 3_600_000) / 60_000)} min` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
  return [...at.spent.entries()].filter(([, ms]) => ms >= 1000).map(([stage, ms]) => `${stage || "starting"} ${took(ms)}`).join(", ");
}

function say(script: Script, detail: string, stage = script.stage, percent = script.progress): void {
  if (running.has(script.id)) noteStage(script.id, stage);
  if (running.has(script.id)) latest.set(script.id, { id: script.id, title: script.title, stage, percent, detail, ...(started.has(script.id) ? { startedAt: started.get(script.id)! } : {}) });
}

const clock = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

function note(script: Script, text: string): void {
  script.notes ??= [];
  if (!script.notes.includes(text)) script.notes.push(text);
}

/** The article given with footage, read before the import starts. */
const article = async (link: string | null | undefined): Promise<Research | null> => (link?.trim() ? research.provided(link.trim()) : null);

/** A title typed for an import, trimmed and cut to a title's length; null when blank, so the footage names the script. */
const givenTitle = (title: string | null | undefined): string | null => {
  const given = [...(title ?? "").trim()].slice(0, 180).join("");
  return given === "" ? null : given;
};

function newScript(title: string, sourceKind: string, sourceUrl: string, originalPath: string): Script {
  const now = Date.now();
  const who = creator();
  return {
    id: crypto.randomUUID(),
    title,
    sourceKind,
    sourceUrl,
    originalPath,
    status: "processing",
    stage: "reading",
    progress: 5,
    error: null,
    durationMs: 0,
    words: [],
    clips: [],
    overview: [],
    parts: [],
    notes: [],
    kind: "interrogation",
    ...(who ? { createdBy: who } : {}),
    revision: 1,
    createdAt: now,
    updatedAt: now,
    proxyPath: null,
  };
}

export async function fromFile(app: App, data: string, source: string, link: string | null, title: string | null, kind: Kind | null): Promise<Script> {
  let path: string;
  try {
    path = fs.realpathSync(source);
  } catch {
    throw new Error("That file can't be opened.");
  }
  if (!isFile(path)) throw new Error("That file can't be opened.");
  const name = givenTitle(title) ?? [...(path.split("/").pop() ?? "Untitled").replace(/\.[^.]+$/, "")].slice(0, 180).join("");
  return start(app, data, newScript(name, "file", path, path), await article(link), kind);
}

/** A title given is kept in place of the video's own, which is looked up otherwise. */
export async function fromYoutube(app: App, data: string, url: string, link: string | null, title: string | null, kind: Kind | null, then: Script["firstBuild"] | null = null): Promise<Script> {
  youtube.checkUrl(url);
  return start(app, data, newScript(givenTitle(title) ?? "YouTube video", "youtube", url.trim(), ""), await article(link), kind, then);
}

/** A Drive file, or a folder of recordings joined in name order, as Repack takes them; a title given is kept in place of the folder's name. */
export async function fromDrive(app: App, data: string, url: string, link: string | null, title: string | null, kind: Kind | null, then: Script["firstBuild"] | null = null): Promise<Script> {
  drive.parse(url);
  return start(app, data, newScript(givenTitle(title) ?? "Google Drive footage", "drive", url.trim(), ""), await article(link), kind, then);
}

/** A compilation's lines: each a video link, or "REUSE" and a link for a case the channel already covered, as Repack takes them. */
export const compilationLines = (given: string[]): [string[], Reuse[]] => linesFor(given, false);

/** The same lines for one Courtroom case across several videos: no reuses, and two videos are enough. */
export function linesFor(given: string[], oneCase: boolean): [string[], Reuse[]] {
  const urls: string[] = [];
  const reuses: Reuse[] = [];
  const text = given.join("\n");
  // Never silently drop a malformed source among otherwise valid cases.
  for (const url of trello.urls(text).map(trello.unwrapRedirect)) {
    if (!trello.isDoc(url) && !drive.isDrive(url) && !youtube.isYoutube(url) && trello.cardId(url) === null) throw new Error(`Unsupported compilation source: ${url}`);
  }
  for (const link of trello.linksIn(text)) {
    if (link.reuse) reuses.push({ url: link.url, title: "", after: urls.length, ...(link.earlier ? { earlier: link.earlier } : {}) });
    else urls.push(link.url);
  }
  if (oneCase && reuses.length > 0) throw new Error("A reused case belongs in a compilation, not one Courtroom case.");
  if (urls.length === 0 || urls.length > 20 || urls.length + reuses.length < 2) {
    throw new Error(oneCase ? "A Courtroom case across videos takes 2 to 20 links; for one video, use YouTube." : "A compilation takes at least two cases, including at least one new footage source (up to 20 new and 20 reused).");
  }
  if (reuses.length > 20) throw new Error("A compilation takes at most 20 reused cases.");
  return [urls, reuses];
}

/** Each compilation line checked before anything downloads: what the video is, or why it can't be imported. Four are asked about at once. */
export async function checkVideos(app: App, given: string[]): Promise<VideoCheck[]> {
  const [urls, reuses] = compilationLines(given);
  const wanted: [string, boolean, string | null][] = [];
  let next = 0;
  for (const [index, url] of urls.entries()) {
    while (next < reuses.length && reuses[next]!.after === index) {
      wanted.push([reuses[next]!.url, true, reuses[next]!.earlier ?? null]);
      next++;
    }
    wanted.push([url, false, null]);
  }
  for (const rest of reuses.slice(next)) wanted.push([rest.url, true, rest.earlier ?? null]);
  const checks: (VideoCheck | null)[] = wanted.map(() => null);
  let at = 0;
  const lane = async () => {
    for (let index = at++; index < wanted.length; index = at++) {
      const [url, reused, earlier] = wanted[index]!;
      let probe: youtube.Probe;
      if (trello.isDoc(url)) {
        try {
          const doc = await reuse.readDoc(url);
          probe = { title: doc.title, channel: "Google Doc", durationMs: null, problem: doc.narration.trim() === "" ? "That Doc holds no script to reuse." : null, warning: doc.footage === null ? "Lists no footage, so its video can't be brought in for intro clips." : null };
        } catch (error) {
          probe = { title: "", channel: "", problem: diag.messageOf(error) };
        }
      } else if (url.includes("drive.google.com")) {
        try {
          const [title, recordings] = await drive.recordings(await drive.hooks.accessToken(), drive.parse(url));
          probe = { title, channel: "Google Drive", durationMs: recordings.reduce((sum, one) => sum + (one.claimedMs ?? 0), 0), problem: recordings.length === 0 ? "That Drive link has no recordings." : null, warning: null };
        } catch (error) {
          probe = { title: "", channel: "", problem: diag.messageOf(error) };
        }
      } else probe = await youtube.probe(app, url);
      let earlierFound: string | null = null;
      if (earlier !== null) {
        try {
          const found = await reuse.readEarlier(earlier, url);
          const number = reuse.earlierLink(earlier)?.[1] ?? null;
          earlierFound = number !== null ? `Its script is case ${number} of “${found.title}”, read for its transition.` : `Its script is “${found.title}”, read for its transition.`;
        } catch (error) {
          earlierFound = `Its earlier script wasn't found: ${diag.messageOf(error)}`;
        }
      }
      checks[index] = { url, reuse: reused, ...(earlier !== null ? { earlier } : {}), ...(earlierFound !== null ? { earlierFound } : {}), title: probe.title, channel: probe.channel, durationMs: probe.durationMs ?? null, problem: probe.problem ?? null, warning: probe.warning ?? null };
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, lane));
  return checks.filter((check): check is VideoCheck => check !== null);
}

/** Several videos joined in order: a compilation, one case each, or (`oneCase`) one Courtroom case whose hearing runs across them. A link's `t` is a hint to where the case starts in that video. */
export function fromCompilation(app: App, data: string, title: string, urls: string[], oneCase: boolean, kind: Kind | null, then: Script["firstBuild"] | null = null): Promise<Script> {
  return compilationWith(app, data, title, urls, oneCase, kind, null, [], then);
}

/**
 * A producer's brief, pasted as it came (brief.ts): its first line the title,
 * its prose the producer's notes (filed first among the research, so no
 * search runs), its web pages read as articles, and its videos one case: a
 * single video imported as itself, several joined as one Courtroom case.
 */
export async function fromBrief(app: App, data: string, text: string, kind: Kind | null): Promise<Script> {
  const parsed = brief.parse(text);
  if (parsed.title === "") throw new Error("Put the script's title on the brief's first line.");
  const videos = brief.videosOf(parsed);
  if (videos.length === 0) throw new Error("The brief has no YouTube or Drive video to import.");
  const articles: Research["articles"] = [];
  if (parsed.notes.trim() !== "") articles.push(research.given(parsed.notes));
  for (const link of brief.articlesOf(parsed)) {
    try {
      articles.push(...(await research.provided(link.url)).articles);
    } catch (error) {
      diag.warn("writer", `${parsed.title}: the brief's article ${link.url} couldn't be read: ${diag.messageOf(error)}`);
    }
  }
  const found: Research | null = articles.length > 0 ? { articles, queries: [], at: Date.now() } : null;
  diag.info("writer", `${parsed.title}: from a brief, ${videos.length} videos (${videos.map((link) => link.label || "unlabelled").join(", ")}), ${parsed.notes === "" ? "no" : "with"} notes`);
  const [only] = videos;
  if (videos.length === 1 && only !== undefined) {
    const script = only.url.includes("drive.google.com") ? (drive.parse(only.url), newScript(parsed.title, "drive", only.url, "")) : (youtube.checkUrl(only.url), newScript(parsed.title, "youtube", only.url, ""));
    script.title = [...parsed.title].slice(0, 180).join("");
    return start(app, data, script, found, kind);
  }
  if (kind !== null && kind !== "courtroom") throw new Error("A brief with several videos is one Courtroom case. For a compilation, use Compilation.");
  const labels: Label[] = videos.map((link) => ({ label: link.label, role: link.role, ...(link.part !== undefined ? { part: link.part } : {}) }));
  return compilationWith(app, data, parsed.title, videos.map((link) => link.url), true, "courtroom", found, labels);
}

async function compilationWith(app: App, data: string, title: string, given: string[], oneCase: boolean, kind: Kind | null, found: Research | null, labels: Label[], then: Script["firstBuild"] | null = null): Promise<Script> {
  const name = title.trim();
  if (name === "" || [...name].length > 180) throw new Error("Give it a title (up to 180 characters).");
  const [urls, reuses] = linesFor(given, oneCase);
  const script = newScript(name, "compilation", urls.join("\n"), "");
  script.compilation = !oneCase;
  if (oneCase) script.kind = "courtroom";
  script.reuses = reuses;
  script.labels = labels;
  return start(app, data, script, found, kind, then);
}

async function start(app: App, data: string, script: Script, found: Research | null, kind: Kind | null, then: Script["firstBuild"] | null = null): Promise<Script> {
  if (then !== null) script.firstBuild = then;
  // Only kinds of script this person may write, starting as the first format they may.
  if (script.sourceKind === "compilation" && !script.compilation) {
    if (kind !== null && kind !== "courtroom") throw new Error("Videos of one Courtroom case must use the Courtroom format.");
    script.kind = "courtroom";
  } else script.kind = kind ?? (script.compilation ? can.firstCompilationKind() : can.firstSingleKind());
  can.requireKind(script, script.kind);
  const done = busy(script.id);
  let result: Script;
  try {
    const dir = store.scriptDir(data, script.id);
    fs.mkdirSync(dir, { recursive: true });
    store.write(dir, script);
    store.libraryChanged();
    // The producer's article is the case's research: no search runs.
    if (found !== null) research.keep(dir, found);
    result = await run(app, dir, script);
  } finally {
    done();
  }
  buildWhenReady(app, data, result);
  return result;
}

/** Where the build a script was made with is started (routes.ts: a job like the Build button's). */
export const hooks = { build: (_app: App, _id: string, _note: string): void => {} };

/**
 * A script made with a first build (New project's first message, or none:
 * "start the script workflow") is built as soon as its import is ready, from
 * whichever way it got there (straight through, or resumed after a pause).
 */
function buildWhenReady(app: App, data: string, script: Script): void {
  if (script.status !== "ready" || script.firstBuild === undefined) return;
  const dir = store.scriptDir(data, script.id);
  const note = script.firstBuild.note;
  try {
    const now = store.read(dir);
    delete now.firstBuild;
    store.write(dir, now);
    delete script.firstBuild;
    hooks.build(app, script.id, note);
    diag.info("writer", `${jobs.named(script.id, script.title)}: its import is ready, so its build started${note ? " with the note given" : ""}`);
  } catch (error) {
    diag.warn("writer", `${jobs.named(script.id, script.title)}: starting its build after the import: ${diag.messageOf(error)}`);
  }
}

/** Answers a paused import, or retries a failed one, then carries on. */
export async function resume(app: App, data: string, id: string, choice: Choice): Promise<Script> {
  const done = busy(id);
  let result: Script;
  try {
    const dir = store.scriptDir(data, id);
    const script = store.read(dir);
    const wordsMissing = script.status === "ready" && script.words.length === 0 && !script.noSpeech;
    if (!(script.status === "error" || script.status === "needs_choice" || wordsMissing)) throw new Error("This import isn't waiting on anything.");
    const decision = script.decision;
    if (choice.kind === "dismiss") {
      script.dismissedAt = Date.now();
      script.updatedAt = Date.now();
      store.write(dir, script);
      return script;
    }
    if (choice.kind === "cancel") {
      delete script.decision;
      script.status = "error";
      script.error = "Import cancelled. Retry starts it again from what it kept.";
      script.updatedAt = Date.now();
      store.write(dir, script);
      return script;
    }
    if (choice.kind === "skip_failed" && decision?.kind === "failed_recordings") {
      if (script.sourceKind === "compilation") {
        const videos = parts.readVideos(dir);
        if (videos === null) throw new Error("This compilation has lost its list of videos. Retry it.");
        for (const item of decision.failed) {
          if (!videos.skipped.includes(item.id)) videos.skipped.push(item.id);
          note(script, `Left out ${item.title}: ${item.error}`);
        }
        parts.writeVideos(dir, videos);
      } else {
        const manifest = parts.readManifest(dir);
        if (manifest === null) throw new Error("This import has lost its list of recordings. Retry it.");
        for (const item of decision.failed) {
          if (!manifest.skipped.includes(item.id)) manifest.skipped.push(item.id);
          note(script, `Left out ${item.title}: ${item.error}`);
        }
        parts.writeManifest(dir, manifest);
      }
    } else if (choice.kind === "select" && decision?.kind === "too_much") {
      const manifest = parts.readManifest(dir);
      if (manifest === null) throw new Error("This import has lost its list of recordings. Retry it.");
      const chosen = manifest.recordings.filter((recording) => choice.ids.includes(recording.id));
      if (chosen.length === 0 || chosen.length !== choice.ids.length) throw new Error("Choose at least one recording from this folder.");
      const reason = overLimits(chosen);
      if (reason !== null) throw new Error(reason);
      manifest.chosen = choice.ids;
      parts.writeManifest(dir, manifest);
    } else if (choice.kind === "no_transcript" && decision?.kind === "no_speech") script.noSpeech = true;
    else if (choice.kind === "replace") replaceSource(dir, script, choice.id ?? null, choice.url.trim());
    else if (choice.kind !== "retry") throw new Error("That answer doesn't fit what this import asked.");
    delete script.decision;
    delete script.dismissedAt;
    script.status = "processing";
    script.error = null;
    script.updatedAt = Date.now();
    store.write(dir, script);
    result = await run(app, dir, script);
  } finally {
    done();
  }
  buildWhenReady(app, data, result);
  return result;
}

/**
 * A video that failed, given another link: a compilation's video `id` (its
 * index), or the script's own video. A YouTube video that won't download is
 * often on the team's Drive (the user, Oct 30: "if it's a YouTube video, you
 * can then enter a Google Drive video as a replacement, or you can then retry").
 */
function replaceSource(dir: string, script: Script, id: string | null, url: string): void {
  const kind = drive.isDrive(url) ? "drive" : youtube.isYoutube(url) ? "youtube" : null;
  if (kind === null) throw new Error("Give a YouTube or Google Drive link to the video.");
  if (kind === "drive") drive.parse(url);
  else youtube.checkUrl(url);
  if (script.sourceKind === "compilation") {
    const videos = parts.readVideos(dir);
    const index = Number(id);
    if (videos === null || !Number.isInteger(index) || videos.videos[index] === undefined) throw new Error("That video isn't one of this compilation's.");
    note(script, `${videos.videos[index]!.title || videos.videos[index]!.url} replaced by ${url}`);
    videos.videos[index] = { ...videos.videos[index]!, url };
    videos.skipped = videos.skipped.filter((one) => one !== String(index));
    parts.writeVideos(dir, videos);
    return;
  }
  if (script.sourceKind !== "youtube" && script.sourceKind !== "drive") throw new Error("Only a video link can be replaced.");
  note(script, `${script.sourceUrl} replaced by ${url}`);
  script.sourceKind = kind;
  script.sourceUrl = url;
}

/** Runs the pipeline. A failure, or even a bug, ends as a failed import that says so and can be retried; it never leaves the script stuck importing. */
async function run(app: App, dir: string, script: Script): Promise<Script> {
  const began = Date.now();
  const name = jobs.named(script.id, script.title);
  const from = script.sourceKind === "file" ? `the file ${script.originalPath.split("/").pop()}` : script.sourceKind === "compilation" ? `${script.sourceUrl.split("\n").length} videos` : `${script.sourceKind} ${script.sourceUrl.split("\n")[0]}`;
  diag.info("writer", `${name}: importing from ${from}`);
  say(script, "Starting.");
  try {
    const step = await pipeline(app, dir, script);
    const seconds = `${Math.round((Date.now() - began) / 1000)} s`;
    // Its recordings and words, shared with Edit mode in the background.
    if (step === "done") handoff.shareSoon(store.dataDir(app.store.home), script.id);
    const spent = stageTimes(script.id);
    if (step === "done") diag.info("writer", `${jobs.named(script.id, script.title)}: imported in ${seconds}: ${clock(script.durationMs)} of footage, ${script.words.length} words, ${new Set(script.words.map((word) => word.speaker).filter(Boolean)).size} voices${spent ? ` (${spent})` : ""}`);
    else diag.warn("writer", `${jobs.named(script.id, script.title)}: paused after ${seconds}${spent ? ` (${spent})` : ""} for a choice: ${script.decision?.summary ?? ""}`);
    return script;
  } catch (error) {
    const message = diag.messageOf(error);
    const spent = stageTimes(script.id);
    diag.error("writer", `${jobs.named(script.id, script.title)}: stopped after ${Math.round((Date.now() - began) / 1000)} s${spent ? ` (${spent})` : ""}: ${message}`);
    script.status = "error";
    script.error = message;
    delete script.decision;
    script.updatedAt = Date.now();
    try {
      store.write(dir, script);
    } catch {
      // The failure is said either way.
    }
    say(script, message);
    throw new Error(message);
  }
}

/** Saves a question and ends the import without failing it. */
function pause(dir: string, script: Script, decision: Decision): "paused" {
  script.status = "needs_choice";
  script.stage = "waiting";
  script.error = null;
  script.decision = decision;
  script.updatedAt = Date.now();
  store.write(dir, script);
  say(script, "Waiting for your choice.");
  return "paused";
}

/** A preview still to make, made beside the words. */
/** Makes the preview, saying how far it is (0–100). */
type Build = (onPercent: (percent: number) => void) => Promise<void>;
type Fetched = "paused" | "one" | { joined: Build | null };

async function pipeline(app: App, dir: string, script: Script): Promise<"done" | "paused"> {
  // The footage.
  let build: Build | null = null;
  let joined = false;
  if (script.sourceKind === "youtube" || script.sourceKind === "drive" || script.sourceKind === "compilation") {
    const fetched = script.sourceKind === "youtube" ? await fetchYoutube(app, dir, script) : script.sourceKind === "drive" ? await fetchDrive(dir, script) : await fetchCompilation(app, dir, script);
    if (fetched === "paused") return "paused";
    if (fetched !== "one") {
      build = fetched.joined;
      joined = true;
    }
  } else if (!isFile(script.originalPath)) throw new Error(`The video is no longer at ${script.originalPath}. Put it back, then retry.`);

  // Its length and sound.
  script.stage = "processing";
  script.progress = Math.max(script.progress, 20);
  say(script, "Reading the footage.");
  const found: media.Streams =
    build !== null
      ? // A joined preview still to make: as long as its recordings, with picture and sound.
        { durationMs: (script.parts ?? []).reduce((sum, part) => sum + part.durationMs, 0), video: true, audio: true }
      : await media.streams(script.originalPath).catch(() => {
          throw new Error("This file can't be read as video or audio.");
        });
  if (found.durationMs === 0) throw new Error("This file has no length to play.");
  const duration = joined ? found.durationMs : await media.playableMs(script.originalPath, found.durationMs);
  if (duration > media.MAX_CASE_MS || (!joined && duration > MAX_FILE_MS)) throw new Error("This footage runs longer than Edit imports at once (ten hours a file).");
  if (duration + 2_000 < found.durationMs) note(script, `The file is cut short: it claims ${clock(found.durationMs)} but holds ${clock(duration)}. Edit imported what it holds.`);
  script.durationMs = duration;
  store.write(dir, script);
  if (!found.audio && !script.noSpeech) {
    return pause(dir, script, { kind: "no_speech", summary: "This video has no sound, so there is nothing to transcribe. Open it without a transcript to cut it by time, or cancel.", reason: "no_audio" });
  }
  // The preview, made beside the words: transcription reads the recordings themselves. Sound with no picture plays over black.
  if (!found.video && !joined) {
    build = await audioPreview(dir, script, found);
    joined = true;
  }
  if (!joined) build = await singlePreview(dir, script);
  // How far the preview is, said while the import waits on it (the user, Oct 30: it sat at 60% through a long join).
  let previewPercent = 0;
  const preview: Promise<void> = build === null ? Promise.resolve() : build((percent) => (previewPercent = percent));
  const waitOn = async (words: string) => {
    // From where the import is toward 59 (transcription starts at 60); past that already, it holds.
    const from = script.progress;
    const to = Math.max(from, 59);
    const tell = () => say(script, `${words}: ${previewPercent}%.`, script.stage, from + Math.floor(((to - from) * previewPercent) / 100));
    tell();
    const ticker = setInterval(tell, 2000);
    try {
      await preview;
    } finally {
      clearInterval(ticker);
    }
  };
  // Its failure is said where it's waited for.
  preview.catch(() => {});
  let made = false;
  void preview.then(() => (made = true), () => (made = true));
  if ((await words(app, dir, script, waitOn)) === "paused") return "paused";
  // Ready once its preview is: the words were heard beside it.
  if (!made) {
    script.stage = "processing";
    await waitOn("Finishing the preview");
  }
  await preview;
  // A joined preview made beside the words gives the overview after them.
  if (script.overview.length === 0) {
    const peaks = await media.peaks(script.originalPath).catch(() => new Float32Array());
    if (peaks.length > 0) script.overview = media.overview(peaks, 800);
  }
  script.status = "ready";
  script.stage = "ready";
  script.progress = 100;
  script.error = null;
  delete script.decision;
  script.updatedAt = Date.now();
  store.write(dir, script);
  say(script, "Ready.");
  return "done";
}

/** The case's PDFs, the words and who says them, while `preview` is made. */
async function words(app: App, dir: string, script: Script, waitOn: (words: string) => Promise<void>): Promise<"done" | "paused"> {
  // A Drive case folder's PDFs (reports, court papers), read for the case's facts before the footage is heard: their names are what the transcriber listens for.
  if (script.sourceKind === "drive") {
    const link = drive.parse(script.sourceUrl);
    if (link.kind === "folder") {
      const fresh = !casefiles.load(dir)?.complete;
      const began = Date.now();
      const documents = await casefiles.run(
        dir,
        async () => drive.pdfs(await drive.hooks.accessToken(), link.id),
        async (pdf, dest) => drive.download(await drive.hooks.accessToken(), { ...pdf, audio: false }, dest),
        (done, count) => say(script, `Reading the case's PDFs: ${done} of ${count}.`, "researching", 58),
      );
      diag.info("writer", `${jobs.named(script.id, script.title)}: case PDFs read in ${Math.round((Date.now() - began) / 1000)} s: ${documents.read.length} read, ${documents.skipped.length} passed over`);
      if (fresh && documents.skipped.length > 0) {
        const more = documents.skipped.length - 3;
        note(script, `${documents.skipped.length} of the folder's PDFs ${documents.skipped.length === 1 ? "was" : "were"} passed over: ${documents.skipped.slice(0, 3).join("; ")}${more > 0 ? `; and ${more} more.` : ""}`);
      }
    }
  }
  if (script.noSpeech) {
    script.words = [];
    if (script.clips.length === 0) script.clips = [{ id: crypto.randomUUID(), startMs: 0, endMs: script.durationMs }];
    return "done";
  }
  // A recording heard only from the preview (none of its own here) waits for it.
  if (transcription.recordings(dir, script).some((recording) => !isFile(recording.file))) {
    await waitOn("Making the preview");
  }
  script.stage = "transcribing";
  script.progress = 60;
  say(script, "Transcribing.");
  store.write(dir, script);
  const began = Date.now();
  diag.info("writer", `${jobs.named(script.id, script.title)}: transcribing ${clock(script.durationMs)} of footage`);
  try {
    await transcription.transcribe(app, script, dir, (done, count) => say(script, `Transcribing: ${Math.floor((done * 100) / Math.max(count, 1))}%.`, "transcribing", 60 + Math.floor((done * 30) / Math.max(count, 1))));
    diag.info("writer", `${jobs.named(script.id, script.title)}: transcribed in ${Math.round((Date.now() - began) / 1000)} s: ${script.words.length} words`);
  } catch (error) {
    if (diag.messageOf(error) === transcription.NO_WORDS) return pause(dir, script, { kind: "no_speech", summary: "Speech to text heard no words in this footage. Open it without a transcript to cut it by time, or cancel.", reason: "no_words" });
    throw error;
  }
  // The transcript is kept before the optional visual check, so a stopped import has its words on disk too.
  store.write(dir, script);
  // Who speaks each line, by watching the footage, then names for the voices. Neither can stop the import: a failure leaves the voices as heard, and the build names them again.
  // Words from YouTube's captions have turns, not voices: who says each is read, not watched.
  if (script.captions) await readTurns(script, dir, (detail, percent) => say(script, detail, "transcribing", percent));
  else {
    // The watcher watches the preview, or the video itself: a joined case has only its preview.
    if (!isFile(script.originalPath)) {
      await waitOn("Making the preview");
    }
    const watched = await watchSpeakers(script, dir);
    if (watched || Object.keys(script.speakers ?? {}).length === 0) {
      say(script, "Naming the speakers.");
      try {
        await nameVoices(script, watched);
        diag.info("writer", `${jobs.named(script.id, script.title)}: speakers named: ${Object.values(script.speakers ?? {}).join(", ")}`);
      } catch (error) {
        diag.warn("writer", `${jobs.named(script.id, script.title)}: speakers not named: ${diag.messageOf(error)}`);
      }
    }
  }
  // Words that spilled across a change of speaker go back to who said them.
  say(script, "Putting each word with its speaker.");
  await fixSpills(script, dir).catch((error: unknown) => diag.warn("writer", `${script.title}: spilled words weren't fixed: ${diag.messageOf(error)}`));
  return "done";
}

/** The case's notes for the turns pass: the research's articles, briefly. */
const notesOf = (dir: string): string => (research.load(dir)?.articles ?? []).map((one) => `${one.title}: ${[...one.summary].slice(0, 1_500).join("")}`).join("\n\n");

/**
 * Who says each line of words from YouTube's captions (caption_turns.ts). A
 * failure is a note: the turns stay unnamed, and Retry unfinished speaker
 * checks reads them again, paying only for what wasn't answered.
 */
export async function readTurns(script: Script, dir: string, onStep: ((detail: string, percent: number) => void) | null, signal?: AbortSignal): Promise<boolean> {
  onStep?.("Reading who says each line.", 90);
  const names = await caseNames(dir, script).catch(() => []);
  // Caption turns replace visual speaker checks, including warnings left by an earlier audio import.
  watch.clearNotes(script);
  script.notes = (script.notes ?? []).filter((one) => !one.startsWith("Who says each line"));
  const before = structuredClone(script);
  const began = Date.now();
  try {
    const report = await caption_turns.run(script, dir, names, notesOf(dir), (done, count) => onStep?.(`Reading who says each line: ${done} of ${count} stretches.`, 90 + Math.floor((done * 8) / Math.max(count, 1))), signal);
    diag.info("writer", `${jobs.named(script.id, script.title)}: who says each line read in ${Math.round((Date.now() - began) / 1000)} s: ${report.lines} lines, ${report.windows} stretches (${report.cached} kept, ${report.failed} unfinished), ${report.people} people`);
    if (report.failed > 0) note(script, `Who says each line couldn't be read for ${report.failed} of ${report.windows} stretches; their lines keep the speaker before them. Retry unfinished speaker checks to read them again.`);
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    Object.assign(script, before);
    diag.warn("writer", `${jobs.named(script.id, script.title)}: who says each line couldn't be read: ${diag.messageOf(error)}`);
    note(script, `Who says each line couldn't be read (${diag.messageOf(error)}): the transcript is YouTube's captions, its turns unnamed. Retry unfinished speaker checks to read them again.`);
    return false;
  }
}

/** The watcher, right after transcription: whether it corrected any of the footage. Whatever goes wrong is a note and the transcript as heard. */
async function watchSpeakers(script: Script, dir: string): Promise<boolean> {
  script.progress = 90;
  say(script, "Checking who speaks.");
  const before = structuredClone(script);
  try {
    const report = await watch.run(script, dir, (done, count, cached) => say(script, `Checking who speaks: ${done} of ${count} stretches checked.${cached > 0 ? ` ${cached} saved checks reused.` : ""}`, "transcribing", 90 + Math.floor((done * 8) / Math.max(count, 1))));
    if (report === null) return false;
    diag.info("writer", `${jobs.named(script.id, script.title)}: speaker check: ${report.windows} stretches, ${report.cached} saved answers reused, ${report.failed.length} unchecked, ${report.linesChanged} lines corrected`);
    if (report.failed.length > 0) {
      note(script, `The transcript is ready. Visual speaker checks couldn't finish for ${report.failed.length} of ${report.windows} footage stretches (${report.failed[0]}). Those stretches keep their audio-based speaker labels, which may combine or split voices incorrectly; no transcript words were removed.`);
    }
    store.write(dir, script);
    watch.applied(dir);
    return true;
  } catch (error) {
    Object.assign(script, before);
    note(script, `Edit couldn't watch the footage to check who speaks (${diag.messageOf(error)}). The speakers are as heard.`);
    return false;
  }
}

/** Where a preview is written until it's whole, so nothing reads half of it. */
const making = (proxy: string): string => join(proxy.slice(0, proxy.lastIndexOf("/")), ".proxy-making.mp4");

async function previewFits(proxy: string, durationMs: number): Promise<boolean> {
  if (!isFile(proxy)) return false;
  return media.streams(proxy).then((found) => found.video && Math.abs(found.durationMs - durationMs) <= 1_500, () => false);
}

/** Keeps a preview that matches the footage; otherwise what encodes it again (VideoToolbox first). */
async function singlePreview(dir: string, script: Script): Promise<Build | null> {
  const proxy = store.proxyPath(dir);
  if (await previewFits(proxy, script.durationMs)) return null;
  const [source, duration, label] = [script.originalPath, script.durationMs, jobs.named(script.id, script.title)];
  return async (onPercent) => {
    fs.rmSync(proxy, { force: true });
    const partial = making(proxy);
    const began = Date.now();
    try {
      await media.encodeProxy(source, partial, duration, onPercent);
      fs.renameSync(partial, proxy);
      diag.info("writer", `${label}: 480p preview made: ${clock(duration)} of footage in ${Math.round((Date.now() - began) / 1000)} s`);
    } catch (error) {
      fs.rmSync(partial, { force: true });
      diag.error("writer", `${label}: the preview couldn't be made: ${diag.messageOf(error)}`);
      throw error;
    }
  };
}

/** An audio file's preview: its sound over black. */
async function audioPreview(dir: string, script: Script, found: media.Streams): Promise<Build | null> {
  const proxy = store.proxyPath(dir);
  if (await previewFits(proxy, script.durationMs)) return null;
  const [source, streams] = [script.originalPath, { ...found, durationMs: script.durationMs }];
  return async (onPercent) => {
    const partial = making(proxy);
    try {
      await media.join([{ path: source, streams }], partial, onPercent);
      fs.renameSync(partial, proxy);
    } catch (error) {
      fs.rmSync(partial, { force: true });
      throw error;
    }
  };
}

/**
 * YouTube: streamed to Edit's originals in the cloud and only its 480p
 * preview made here (streamed.ts), a case of one recording; else (streaming
 * off, or a download kept from before) once into Edit's media folder, the
 * script's folder holding it as `original.mp4`.
 */
async function fetchYoutube(app: App, dir: string, script: Script): Promise<Fetched> {
  const dest = join(dir, "original.mp4");
  if (await media.readable(dest)) {
    script.originalPath = dest;
    return "one";
  }
  script.stage = "downloading";
  if (script.title === "YouTube video") {
    say(script, "Looking up the video.");
    script.title = await youtube.title(app, script.sourceUrl);
    store.write(dir, script);
  }
  if (streamed.on()) {
    const proxy = store.proxyPath(dir);
    const one = script.parts?.length === 1 ? script.parts[0]! : null;
    if (one !== null && (await previewFits(proxy, one.durationMs))) {
      script.originalPath = proxy;
      return { joined: null };
    }
    const began = Date.now();
    const inCloud = await streamed.fromYoutube(app, dir, script.sourceUrl, (bytes) => say(script, `Streaming from YouTube to the cloud: ${Math.round(bytes / 1e6)} MB.`, "downloading", 10));
    diag.info("writer", `${jobs.named(script.id, script.title)}: YouTube video streamed to the cloud in ${Math.round((Date.now() - began) / 1000)} s`);
    say(script, "Making the preview.", "downloading", 15);
    await encodePiece(dir, inCloud.url, jobs.named(script.id, script.title));
    return { joined: await joinPreview(dir, script, [[script.title, inCloud.url, script.sourceUrl]], "video") };
  }
  const began = Date.now();
  const shared = await youtube.fetch(app, script.sourceUrl, (percent) => say(script, `Downloading from YouTube: ${Math.floor(percent)}%.`, "downloading", 5 + Math.floor((percent * 14) / 100)));
  script.originalPath = youtube.place(shared, dest);
  diag.info("writer", `${jobs.named(script.id, script.title)}: YouTube video downloaded in ${Math.round((Date.now() - began) / 1000)} s`);
  store.write(dir, script);
  return "one";
}

/** One video, from YouTube or a Drive file or folder link, to `dest`: a compilation's, or a reused case's brought in later. One already downloaded is kept. */
export async function fetchVideo(app: App, url: string, dest: string, onPercent: (percent: number, said: string | null) => void = () => {}, signal?: AbortSignal): Promise<void> {
  if (await media.readable(dest)) return;
  if (!url.includes("drive.google.com")) {
    // A compilation's videos are joined from the script's folder: linked there, or copied across disks.
    const shared = await youtube.fetch(app, url, (percent) => onPercent(percent, null));
    if (youtube.place(shared, dest) !== dest) fs.copyFileSync(shared, dest);
    return;
  }
  const token = await drive.hooks.accessToken();
  const link = drive.parse(url);
  const folder = dest.replace(/\.[^./]+$/, ".recordings");
  const manifest = join(folder, "manifest.json");
  const recordings: drive.Recording[] = link.kind === "folder" && isFile(manifest) ? (JSON.parse(fs.readFileSync(manifest, "utf8")) as drive.Recording[]) : (await drive.recordings(token, link))[1];
  if (recordings.length === 0) throw new Error("That Drive link has no recordings.");
  const problem = overLimits(recordings);
  if (problem !== null) throw new Error(problem);
  if (link.kind === "file") {
    const size = Math.max(recordings[0]!.size, 1);
    return drive.download(token, recordings[0]!, dest, (bytes) => onPercent(Math.floor((Math.min(bytes, size) * 100) / size), null), signal);
  }
  // One folder is one case: its name-ordered recordings share one case clock. Every original and its manifest stay for retries.
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify(recordings, null, 2));
  const paths: string[] = [];
  for (const [index, recording] of recordings.entries()) {
    const path = parts.driveFile(folder, index, recording);
    if (!downloaded(path, recording)) {
      await drive.download(token, recording, path, (bytes) => onPercent(Math.floor(((index * 100 + Math.floor((Math.min(bytes, Math.max(recording.size, 1)) * 100) / Math.max(recording.size, 1))) * 70) / (recordings.length * 100)), null), signal);
    }
    paths.push(path);
  }
  const joinParts = await Promise.all(paths.map(async (path) => ({ path, streams: await media.streams(path) })));
  const partial = dest.replace(/\.[^./]+$/, ".joining.mp4");
  try {
    await media.joinOriginal(joinParts, partial, (percent) => onPercent(70 + Math.floor((percent * 3) / 10), "Joining the case's recordings."), signal);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  fs.renameSync(partial, dest);
}

const tooLong = (recording: drive.Recording): boolean => (recording.claimedMs ?? 0) > MAX_FILE_MS || recording.size > MAX_FILE_BYTES;

export function overLimits(recordings: drive.Recording[]): string | null {
  const total = recordings.reduce((sum, recording) => sum + (recording.claimedMs ?? 0), 0);
  if (recordings.length > MAX_FILES) return `A case takes at most ${MAX_FILES} recordings.`;
  if (total > media.MAX_CASE_MS) return "A case takes at most twenty hours of footage.";
  if (recordings.some(tooLong)) return "A recording over ten hours or 30 GB can't be imported.";
  return null;
}

function downloaded(path: string, recording: drive.Recording): boolean {
  const size = isFile(path) ? fs.statSync(path).size : 0;
  return recording.size > 0 ? size === recording.size : size > 0;
}

/** Stops before a download this Mac has no room for. */
function checkSpace(dir: string, needed: number): void {
  let free: number;
  try {
    const stats = fs.statfsSync(dir);
    free = stats.bavail * stats.bsize;
  } catch {
    return;
  }
  if (free < needed) throw new Error(`This needs about ${(needed / 1e9).toFixed(1)} GB free on this Mac, and ${(free / 1e9).toFixed(1)} GB is free. Make room, then retry.`);
}

/** Runs `work` on each item, `lanes` at a time. */
async function lanes<T>(items: T[], count: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) await work(items[index]!, index);
  }));
}

/** The question a Drive folder or compilation asks when some of its recordings failed. */
function failedQuestion(dir: string, script: Script, failed: { id: string; title: string; error: string }[], total: number, what: string): "paused" {
  if (failed.length === total) throw new Error(`None of the ${what} came through. ${failed[0]!.title}: ${failed[0]!.error}`);
  const ready = total - failed.length;
  const verb = ready === 1 ? "is" : "are";
  const summary = failed.length === 1 ? `${failed[0]!.title} couldn't be imported; the other ${ready} ${verb} ready. Go on without it, try it again, or cancel.` : `${failed.length} ${what} couldn't be imported; the other ${ready} ${verb} ready. Go on without them, try them again, or cancel.`;
  return pause(dir, script, { kind: "failed_recordings", summary, failed, total });
}

async function fetchDrive(dir: string, script: Script): Promise<Fetched> {
  const folder = join(dir, "drive");
  fs.mkdirSync(folder, { recursive: true });
  script.stage = "downloading";
  let manifest = parts.readManifest(dir);
  if (manifest === null) {
    say(script, "Signing in to Google Drive.");
    const [title, recordings] = await drive.recordings(await drive.hooks.accessToken(), drive.parse(script.sourceUrl));
    if (script.title === "Google Drive footage") script.title = title;
    manifest = { recordings, skipped: [] };
    parts.writeManifest(dir, manifest);
    store.write(dir, script);
  }
  // A joined case whose preview is already made needs nothing more.
  const proxy = store.proxyPath(dir);
  if ((script.parts ?? []).length > 1 && (await previewFits(proxy, (script.parts ?? []).reduce((sum, part) => sum + part.durationMs, 0)))) {
    script.originalPath = proxy;
    return { joined: null };
  }
  if (manifest.chosen == null) {
    const reason = overLimits(manifest.recordings);
    if (reason !== null) {
      return pause(dir, script, {
        kind: "too_much",
        summary: `This folder holds more footage than one import takes. ${reason} Choose the recordings to bring in.`,
        files: manifest.recordings.map((recording) => ({ id: recording.id, title: recording.name, size: recording.size, durationMs: recording.claimedMs ?? null, audio: recording.audio, tooLong: tooLong(recording) })),
        maxFiles: MAX_FILES,
        maxMs: media.MAX_CASE_MS,
      });
    }
  }
  const wanted = parts.wanted(manifest);
  if (wanted.length === 0) throw new Error("No recordings are left to import from this folder.");
  // Streamed, only the previews take room here (about a tenth of the footage); downloaded, the recordings too.
  const stream = streamed.on();
  const needed = wanted.reduce((sum, [index, recording]) => {
    const path = parts.driveFile(folder, index, recording);
    return sum + Math.max(recording.size - (isFile(path) ? fs.statSync(path).size : 0), 0);
  }, 0);
  checkSpace(dir, stream ? needed / 5 + 1_000_000_000 : needed + needed / 5 + 1_000_000_000);
  // Each recording's original in the cloud, by its place among the wanted (streamed).
  const inCloud: (string | null)[] = wanted.map(() => null);
  // Three recordings come down at once; the progress shown is their sum.
  const totalBytes = Math.max(wanted.reduce((sum, [, recording]) => sum + recording.size, 0), 1);
  const pulled = wanted.map(() => 0);
  let finished = 0;
  const report = () => {
    const bytes = pulled.reduce((sum, value) => sum + value, 0);
    const share = `${Math.min(100, Math.floor((bytes * 100) / Math.max(totalBytes, 1)))}%`;
    say(script, wanted.length === 1 ? `Downloading from Google Drive: ${share}.` : `Downloading recordings from Google Drive: ${share} (${finished} of ${wanted.length} done).`, "downloading", 5 + Math.min(Math.floor((bytes * 33) / totalBytes), 33));
  };
  const failed: [number, { id: string; title: string; error: string }][] = [];
  await lanes(wanted, DOWNLOADS, async ([index, recording], step) => {
    const dest = parts.driveFile(folder, index, recording);
    let problem: string | null = null;
    const began = Date.now();
    if (stream && !downloaded(dest, recording)) {
      try {
        const put = await streamed.drive(dir, recording, (bytes) => {
          pulled[step] = Math.min(bytes, recording.size);
          report();
        });
        const found = await media.streams(put.url).catch(() => null);
        if (found === null || found.durationMs <= 0 || !(found.video || found.audio)) problem = "Couldn't be read as video or audio, so it was dropped.";
        else {
          inCloud[step] = put.url;
          await encodePiece(dir, put.url, `${jobs.named(script.id, script.title)} · ${recording.name}`);
        }
      } catch (error) {
        problem = diag.scrub(diag.messageOf(error));
      }
    } else if (!downloaded(dest, recording)) {
      const onBytes = (bytes: number) => {
        pulled[step] = Math.min(bytes, recording.size);
        report();
      };
      // One that comes down short is fetched again once, from where it stopped; short twice, it is dropped so a retry starts it clean.
      try {
        await drive.download(await drive.hooks.accessToken(), recording, dest, onBytes);
      } catch (error) {
        problem = diag.messageOf(error);
        if (problem.includes("came down short")) {
          try {
            await drive.download(await drive.hooks.accessToken(), recording, dest, onBytes);
            problem = null;
          } catch (again) {
            fs.rmSync(dest, { force: true });
            problem = diag.messageOf(again);
          }
        }
      }
    }
    if (problem === null && inCloud[step] === null) {
      const found = await media.streams(dest).catch(() => null);
      if (found === null || found.durationMs <= 0 || !(found.video || found.audio)) {
        fs.rmSync(dest, { force: true });
        problem = "Couldn't be read as video or audio, so it was dropped.";
      }
    }
    // Its piece of the preview, while the other recordings still come down; one recording alone is the footage itself.
    if (problem === null && inCloud[step] === null && wanted.length > 1) await encodePiece(dir, dest, `${jobs.named(script.id, script.title)} · ${recording.name}`);
    pulled[step] = recording.size;
    finished++;
    if (problem === null) diag.info("writer", `${jobs.named(script.id, script.title)}: Drive recording ${finished} of ${wanted.length} ready: ${recording.name} in ${Math.round((Date.now() - began) / 1000)} s`);
    else {
      diag.error("writer", `${jobs.named(script.id, script.title)}: Drive recording ${recording.name} didn't come through: ${problem}`);
      failed.push([step, { id: recording.id, title: recording.name, error: problem }]);
    }
    report();
  });
  if (failed.length > 0) return failedQuestion(dir, script, failed.sort((a, b) => a[0] - b[0]).map(([, item]) => item), wanted.length, "recordings");
  const [[firstIndex, first]] = wanted as [[number, drive.Recording]];
  if (wanted.length === 1 && !first.audio && inCloud[0] === null) {
    script.originalPath = parts.driveFile(folder, firstIndex, first);
    script.parts = [];
    store.write(dir, script);
    return "one";
  }
  // Joined, each recording at the length it actually holds. The recordings stay: each is heard from its own file, and they're the full-quality footage Edit cuts from.
  const items: [string, string, string | null][] = wanted.map(([index, recording], step) => [drive.stem(recording.name), inCloud[step] ?? parts.driveFile(folder, index, recording), drive.fileLink(recording.id)]);
  return { joined: await joinPreview(dir, script, items, "recordings") };
}

/** A recording's own 480p piece of the preview, encoded as soon as it lands, so the preview is copied together at the end. */
const piecePath = (dir: string, source: string): string =>
  join(dir, "pieces", isUrl(source) ? new URL(source).pathname.split("/").slice(-2).map(decodeURIComponent).join("-").replace(/[^\w. -]+/g, "_") : (source.split("/").pop() ?? "piece.mp4"));

/** Encodes one recording's piece as `joinPreview` would encode it in the whole; a piece that fails is only logged, and the preview is then encoded whole. */
async function encodePiece(dir: string, source: string, label: string): Promise<void> {
  const found = await media.streams(source).catch(() => null);
  if (found === null) return;
  const held = await media.playableMs(source, found.durationMs);
  const piece = piecePath(dir, source);
  if (await previewFits(piece, held)) return;
  const began = Date.now();
  const partial = piece.replace(/\.[^./]+$/, ".partial.mp4");
  try {
    fs.mkdirSync(join(dir, "pieces"), { recursive: true });
    const encoder = await media.join([{ path: source, streams: { ...found, durationMs: held } }], partial);
    fs.renameSync(partial, piece);
    const took = Math.max(1, Date.now() - began);
    // Which encoder and how fast: a piece at a few times real time is libx264, or a slow read from the cloud.
    diag.info("writer", `${label}: its preview piece (${clock(held)}) encoded in ${Math.round(took / 1000)} s on ${encoder}, ${(held / took).toFixed(1)}× real time${media.isRemote(source) ? ", read from the cloud" : ""}`);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    diag.warn("writer", `${label}: its preview piece couldn't be encoded, so the preview is encoded whole: ${diag.messageOf(error)}`);
  }
}

/**
 * Records where each recording, or compilation video, sits in the case, at
 * the length it actually holds, and gives what joins them into one preview
 * (null: it's joined). Pieces encoded while the downloads ran are copied end
 * to end; without them all, the preview is encoded whole.
 */
async function joinPreview(dir: string, script: Script, items: [string, string, string | null][], what: string): Promise<Build | null> {
  const made: NonNullable<Script["parts"]> = [];
  const toJoin: media.JoinPart[] = [];
  let startMs = 0;
  for (const [title, path, url] of items) {
    const found = await media.streams(path).catch(() => {
      throw new Error(`Could not read ${title}.`);
    });
    const held = await media.playableMs(path, found.durationMs);
    if (held < found.durationMs) note(script, `${title} is cut short: it claims ${clock(found.durationMs)} but holds ${clock(held)}. Edit joined what it holds.`);
    made.push({ title, startMs, durationMs: held, audio: !found.video, ...(held < found.durationMs ? { claimedMs: found.durationMs } : {}), ...(url !== null ? { url } : {}) });
    startMs += held;
    toJoin.push({ path, streams: { ...found, durationMs: held } });
  }
  const proxy = store.proxyPath(dir);
  script.parts = made;
  script.originalPath = proxy;
  store.write(dir, script);
  if (await previewFits(proxy, startMs)) {
    fs.rmSync(join(dir, "pieces"), { recursive: true, force: true });
    return null;
  }
  const pieces = items.map(([, path]) => piecePath(dir, path));
  const label = jobs.named(script.id, script.title);
  return async (onPercent) => {
    const partial = making(proxy);
    const began = Date.now();
    try {
      const whole = await Promise.all(pieces.map((piece, index) => previewFits(piece, made[index]!.durationMs)));
      diag.info("writer", `${label}: joining ${items.length} ${what} into the preview (${clock(startMs)}), ${whole.filter(Boolean).length} of ${pieces.length} already encoded as pieces`);
      const copied =
        pieces.length > 1 && whole.every(Boolean)
          ? await media.append(pieces[0]!, pieces.slice(1), partial, onPercent, undefined, false, label)
          : pieces.length === 1 && whole[0] === true
            ? (fs.renameSync(pieces[0]!, partial), true)
            : (await media.join(toJoin, partial, onPercent), false);
      fs.renameSync(partial, proxy);
      diag.info("writer", `${label}: ${items.length} ${what} joined into the preview (${clock(startMs)}) in ${Math.round((Date.now() - began) / 1000)} s${copied ? ", copied from the pieces encoded as they came down" : ""}`);
      fs.rmSync(join(dir, "pieces"), { recursive: true, force: true });
    } catch (error) {
      fs.rmSync(partial, { force: true });
      diag.error("writer", `${label}: the preview couldn't be joined: ${diag.messageOf(error)}`);
      throw error;
    }
  };
}

/** A compilation: several videos, each its own case, from YouTube or Drive links, joined in the order given. One that fails pauses the import with the question a Drive folder asks. */
async function fetchCompilation(app: App, dir: string, script: Script): Promise<Fetched> {
  const folder = join(dir, "compilation");
  fs.mkdirSync(folder, { recursive: true });
  script.stage = "downloading";
  let videos = parts.readVideos(dir);
  if (videos === null) {
    say(script, "Looking up the videos.");
    const listed: parts.Videos["videos"] = [];
    for (const url of script.sourceUrl.split("\n").map((one) => one.trim()).filter((one) => one !== "")) {
      const title = url.includes("drive.google.com") ? await drive.recordings(await drive.hooks.accessToken(), drive.parse(url)).then(([name]) => name, () => "Drive video") : await youtube.title(app, url);
      listed.push({ url, title });
    }
    videos = { videos: listed, skipped: [] };
    parts.writeVideos(dir, videos);
  }
  // A reused case is never downloaded; its title is what its transition is written from.
  const reuses = script.reuses ?? [];
  const unread = (one: Reuse) => one.title === "" || (one.scriptText === undefined && (trello.isDoc(one.url) || one.earlier !== undefined));
  if (reuses.some(unread)) {
    for (const one of reuses.filter(unread)) {
      // An earlier script's Doc: its title, footage and narration, read once.
      if (trello.isDoc(one.url)) {
        const doc = await reuse.readDoc(one.url).catch((error: unknown) => {
          throw new Error(`The reused case's Doc couldn't be read: ${diag.messageOf(error)}`);
        });
        Object.assign(one, { title: doc.title === "" ? "Reused case" : doc.title, script: one.url, scriptTitle: doc.title === "" ? "Reused case" : doc.title, scriptText: doc.scriptText });
        if (doc.footage !== null) one.footage = doc.footage;
        if (doc.narration.trim() !== "") one.narration = doc.narration;
        continue;
      }
      one.title = one.url.includes("drive.google.com") ? await drive.recordings(await drive.hooks.accessToken(), drive.parse(one.url)).then(([name]) => name, () => "Reused case") : await youtube.title(app, one.url);
      // The card named the earlier compilation it was a case of: its own part of that script, read once.
      if (one.earlier !== undefined) {
        try {
          const found = await reuse.readEarlier(one.earlier, one.url);
          Object.assign(one, { scriptText: found.scriptText, script: found.doc, scriptTitle: found.title, narration: found.narration });
          diag.info("writer", `${jobs.named(script.id, script.title)}: reused case ${one.url}'s script read from “${found.title}” (${found.narration.length} characters)`);
        } catch (error) {
          diag.warn("writer", `${jobs.named(script.id, script.title)}: reused case ${one.url}'s earlier script (${one.earlier}) couldn't be read: ${diag.messageOf(error)}`);
        }
      }
    }
    store.write(dir, script);
  }
  const proxy = store.proxyPath(dir);
  if ((script.parts ?? []).length > 1 && (await previewFits(proxy, (script.parts ?? []).reduce((sum, part) => sum + part.durationMs, 0)))) {
    script.originalPath = proxy;
    return { joined: null };
  }
  const kept = videos;
  const wanted = kept.videos.flatMap((video, index): [number, (typeof kept.videos)[number]][] => (kept.skipped.includes(String(index)) ? [] : [[index, video]]));
  if (wanted.length === 0 || (!script.compilation && wanted.length < 2)) throw new Error(script.compilation ? "A compilation needs new footage." : "A case across videos needs at least two of them.");
  // Up to three come down together, each tied to its place in the order.
  const percents = wanted.map(() => 0);
  const results: (string | Error)[] = wanted.map(() => new Error("The download stopped."));
  await lanes(wanted, DOWNLOADS, async ([index, video], step) => {
    const dest = join(folder, `${String(index).padStart(2, "0")}.mp4`);
    try {
      // A YouTube video or one Drive file goes to the cloud without a copy here; a Drive folder (one case, joined into a master) comes down as before.
      const link = video.url.includes("drive.google.com") ? drive.parse(video.url) : null;
      if (streamed.on() && !(await media.readable(dest)) && (link === null || link.kind === "file")) {
        const onBytes = () => say(script, `Streaming videos to the cloud: ${percents.filter((value) => value === 100).length} of ${wanted.length} ready.`, "downloading", 5 + Math.floor((percents.reduce((sum, value) => sum + value, 0) * 33) / (wanted.length * 100)));
        const put = link !== null ? await streamed.drive(dir, (await drive.recordings(await drive.hooks.accessToken(), link))[1][0]!, onBytes) : await streamed.fromYoutube(app, dir, video.url, onBytes);
        if (!(await media.readable(put.url))) throw new Error("Couldn't be read as video, so it was dropped.");
        percents[step] = 100;
        await encodePiece(dir, put.url, `${jobs.named(script.id, script.title)} · video ${index + 1}`);
        results[step] = put.url;
        return;
      }
      await fetchVideo(app, video.url, dest, (percent, said) => {
        percents[step] = Math.max(percents[step]!, percent);
        const done = percents.filter((value) => value === 100).length;
        say(script, `Downloading videos: ${done} of ${wanted.length} ready.${said === null ? "" : ` ${said}`}`, "downloading", 5 + Math.floor((percents.reduce((sum, value) => sum + value, 0) * 33) / (wanted.length * 100)));
      });
      if (!(await media.readable(dest))) throw new Error("Couldn't be read as video, so it was dropped.");
      // Its piece of the preview, while the other videos still come down.
      await encodePiece(dir, dest, `${jobs.named(script.id, script.title)} · video ${index + 1}`);
      results[step] = dest;
    } catch (error) {
      results[step] = error instanceof Error ? error : new Error(String(error));
    }
  });
  const failed: { id: string; title: string; error: string }[] = [];
  const items: [string, string, string | null][] = [];
  wanted.forEach(([index, video], step) => {
    const result = results[step]!;
    if (typeof result === "string") items.push([video.title, result, video.url]);
    else failed.push({ id: String(index), title: video.title, error: result.message });
  });
  if (failed.length > 0) return failedQuestion(dir, script, failed, wanted.length, "videos");
  // The videos stay: each is heard from its own file, and they're the full-quality footage Edit cuts from.
  return { joined: await joinPreview(dir, script, items, "videos") };
}

/**
 * Completes an existing project's transcription, including one with only some
 * words, as a job: each recording is kept, and only transcript fields are
 * applied to the script as it is now; cuts, narration and corrections stay.
 */
export async function complete(app: App, data: string, id: string, job: jobs.Job): Promise<jobs.Outcome> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  if (script.status !== "ready" || script.commentary) throw new Error("Finish or retry the import before completing its transcription.");
  if (script.noSpeech) throw new Error("This project was opened without speech. It has no transcription to complete.");
  const revision = script.revision;
  const before = script.words.length;
  // Hearing needs the footage: back from the cloud if it was left there.
  await storage.bringBack(app, data, id, job);
  await transcription.transcribe(app, script, dir, (done, total) => job.stage(`Completing transcription: ${Math.floor((done * 100) / Math.max(total, 1))}%`), job.signal);
  jobs.checkStopped(job);
  if (script.captions) {
    job.stage("Reading who says each line");
    await readTurns(script, dir, null, job.signal);
  } else if (Object.keys(script.speakers ?? {}).length === 0) await nameVoices(script, false, job.signal).catch(() => {});
  jobs.checkStopped(job);
  const fresh = store.read(dir);
  if (fresh.revision !== revision) throw new Error("The project changed during transcription. The transcripts are saved; complete transcription again to apply them.");
  const kept = structuredClone(fresh);
  // Newly recovered speech needs exact timing before it's used in a cut, even where a region had been checked before.
  const known = new Set(fresh.words.map((word) => word.id));
  fresh.exact = (fresh.exact ?? []).filter(([from, to]) => !script.words.some((word) => !known.has(word.id) && word.startMs < to && word.endMs > from));
  Object.assign(fresh, { words: script.words, speakers: script.speakers ?? {}, captions: script.captions ?? false, notes: script.notes ?? [] });
  if (script.suspects) fresh.suspects = script.suspects;
  fresh.revision++;
  fresh.updatedAt = Date.now();
  store.write(dir, fresh);
  versions.keep(dir, "claude", kept, fresh);
  store.libraryChanged();
  return [`Transcription completed: ${Math.max(fresh.words.length - before, 0)} words added; ${fresh.words.length} words in total. Existing cuts, narration and spelling corrections kept.`, 0];
}

/** Retry unfinished speaker checks, as a job: completed answers are reused; only unfinished checks ask again. */
export async function retrySpeakers(app: App, data: string, id: string, job: jobs.Job): Promise<jobs.Outcome> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  const revision = script.revision;
  let said: string;
  let cost = 0;
  if (script.captions) {
    // Words from YouTube's captions: who speaks is read, not watched.
    const names = await caseNames(dir, script).catch(() => []);
    const report = await caption_turns.run(script, dir, names, notesOf(dir), (done, total) => job.stage(`Reading who says each line: ${done} of ${total}`), job.signal);
    script.notes = (script.notes ?? []).filter((one) => !one.startsWith("Who says each line"));
    if (report.failed > 0) script.notes.push(`Who says each line couldn't be read for ${report.failed} of ${report.windows} stretches; their lines keep the speaker before them. Retry unfinished speaker checks to read them again.`);
    said = `Read who says each line in ${report.windows - report.failed} of ${report.windows} stretches (${report.cached} kept); ${report.people} people.`;
  } else {
    const status = watch.status(dir);
    if (!(status !== null && (status.failed.length > 0 || status.needsApply))) throw new Error("There are no unfinished speaker checks.");
    // Watching needs the footage: back from the cloud if it was left there.
    await storage.bringBack(app, data, id, job);
    const report = await watch.run(script, dir, (done, total, cached) => job.stage(`Checking speakers: ${done} of ${total}; ${cached} saved checks reused`), job.signal);
    if (report === null) throw new Error("There is no video speech to check.");
    watch.clearNotes(script);
    if (report.failed.length > 0) script.notes!.push(`Visual speaker checks couldn't finish for ${report.failed.length} of ${report.windows} stretches. Retry unfinished speaker checks to continue; the transcript is kept.`);
    said = `Checked ${report.windows - report.failed.length} of ${report.windows} footage stretches. ${report.cached} saved checks reused; ${report.failed.length} still unfinished.`;
    cost = report.cost;
  }
  jobs.checkStopped(job);
  job.stage("Putting each word with its speaker");
  await fixSpills(script, dir).catch(() => 0);
  const fresh = store.read(dir);
  if (fresh.revision !== revision) throw new Error("The script changed while checking speakers. The check results are saved; retry to apply them.");
  const before = structuredClone(fresh);
  Object.assign(fresh, { words: script.words, speakers: script.speakers ?? {}, notes: script.notes ?? [] });
  if (script.suspects) fresh.suspects = script.suspects;
  fresh.revision++;
  fresh.updatedAt = Date.now();
  store.write(dir, fresh);
  watch.applied(dir);
  versions.keep(dir, "claude", before, fresh);
  store.libraryChanged();
  return [said, cost];
}
