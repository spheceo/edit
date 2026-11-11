// A script's words, rough first (Sphe, Nov 9: one Mac sent Scribe 120 hours
// in five days, and the plan ran out). Each recording takes, in order: a
// hearing kept from before; YouTube's captions when it's a YouTube video;
// Apple's on-device recogniser on a Mac that has it (mac_speech.ts: free, ~45x
// real time, no voices, rare names its weak point); and only where neither
// exists (Linux, an older macOS) Scribe, as Edit hears it (hearing.ts),
// listening for the case's names (names.ts). Rough words mark the script
// `rough`, and once a build has chosen its clips Scribe hears only those
// stretches (exact.ts): a 5.6-hour FOIA case pays for about an hour. Every
// source goes onto the script's clock the same way (`onClock`). A joined
// case is heard recording by recording, from each one's own file where it's
// kept (else its stretch of the joined footage), so no piece spans two. Each
// recording's words are kept under `transcript/<recording>/` (Scribe's as
// transcript.json, captions as captions.json, Apple's as apple.json, so rough
// words are never handed to Edit as heard), so a retry never pays twice.

import * as fs from "node:fs";

import type { Clip, Script, Word } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as log from "../hearing_log.ts";
import { writeAtomic } from "../files.ts";
import { isFile, join } from "../paths.ts";
import * as macSpeech from "../mac_speech.ts";
import { appleCached, appleHear } from "../first_hearing.ts";
import * as editCloud from "../cloud.ts";
import { asKept } from "../kept_hearing.ts";

export { appleCached, appleHear, appleStage } from "../first_hearing.ts";
import type { Transcript } from "../transcribe.ts";
import * as captions from "./captions.ts";
import * as hearing from "./hearing.ts";
import * as media from "./media.ts";
import { caseNames } from "./names.ts";
import { partFiles, partSources } from "./parts.ts";
import { keepPeaks } from "./tidy.ts";
import { isYoutube } from "./youtube.ts";

/** What transcription says when the footage holds no speech at all. */
export const NO_WORDS = "Speech to text heard no words. Nothing was invented.";

/** One recording of a script: its own file (or a stretch of the joined footage), where it starts on the script's clock, how much of it plays, and where its hearing is kept. */
export interface Recording {
  file: string;
  span: [number, number] | null;
  offsetMs: number;
  lengthMs: number;
  key: string;
}

/** The script's recordings, in play order. */
export function recordings(dir: string, script: Script): Recording[] {
  const footage = script.originalPath;
  const parts = script.parts ?? [];
  if (parts.length < 2) {
    // A compilation with one new case plus reuses still has its own full-quality case file: never its 480p preview.
    const file = script.sourceKind === "compilation" ? (partFiles(dir, script)[0] ?? footage) : footage;
    return [{ file, span: null, offsetMs: 0, lengthMs: script.durationMs, key: "whole" }];
  }
  const own = partFiles(dir, script);
  return parts.map((part, index) => {
    const end = Math.min(part.startMs + part.durationMs, script.durationMs);
    const key = recordingKey(dir, script, index, part.reuse ?? null);
    const file = own[index] ?? null;
    return file !== null
      ? { file, span: null, offsetMs: part.startMs, lengthMs: end - part.startMs, key }
      : { file: footage, span: [part.startMs, end], offsetMs: part.startMs, lengthMs: end - part.startMs, key };
  });
}

/** Reused cases are kept as `reuse-NN`, as the import that brought them in names them; an older completion's `part-NN` hearing is used until captions are kept, so it isn't bought again. */
function recordingKey(dir: string, script: Script, index: number, reuse: string | null): string {
  const legacy = `part-${String(index + 1).padStart(2, "0")}`;
  const slot = reuse === null ? -1 : (script.reuses ?? []).findIndex((known) => known.url === reuse);
  if (slot < 0) return legacy;
  const reuseKey = `reuse-${String(slot).padStart(2, "0")}`;
  const has = (key: string) => ["captions.json", "transcript.json"].some((name) => isFile(join(dir, "transcript", key, name)));
  return has(reuseKey) || !has(legacy) ? reuseKey : legacy;
}

/** Whether a recording's words here are rough (captions or Apple's, or Edit's with stretches heard) with no paid hearing beside them. */
export function roughOnly(work: string): boolean {
  return hearing.cached(work) === null && (captions.cached(work) !== null || appleCached(work) !== null || editCached(work) !== null);
}

/** Where Edit's words of a recording are kept when Edit heard only some of it (its kept stretches, `heard`). */
const EDIT = "edit.json";

/** Edit's words of a recording kept here, when Edit heard only some of it. */
export function editCached(work: string): Transcript | null {
  try {
    const found = JSON.parse(fs.readFileSync(join(work, EDIT), "utf8")) as Transcript;
    return Array.isArray(found.words) && found.words.length > 0 && Array.isArray(found.heard) && found.heard.length > 0 ? found : null;
  } catch {
    return null;
  }
}

/**
 * What Edit mode already heard of a recording (`source`: `youtube:<id>`,
 * `drive:<id>`, `sha256:<hex>`), from Edit's analysis: heard whole, it's this
 * recording's hearing (kept as transcript.json, nothing paid again); heard in
 * the stretches its edits kept (`heard`), its words, those stretches counted
 * as heard exactly. Null when Edit has none, or only free rough words (Script
 * mode reads its own).
 */
export async function fromEdit(source: string | null, work: string, signal?: AbortSignal): Promise<Transcript | null> {
  if (source === null || !editCloud.enabled() || signal?.aborted) return null;
  const kept = editCached(work);
  if (kept !== null) return kept;
  // A help, never a wait: the cloud slow or out of reach, the recording's own first words are read instead.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), FROM_EDIT_MS);
    signal?.addEventListener("abort", () => resolve(null), { once: true });
  });
  try {
    return await Promise.race([lookUp(source, work), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long Script mode looks for Edit's words of a recording. */
const FROM_EDIT_MS = 10_000;

async function lookUp(source: string, work: string): Promise<Transcript | null> {
  const key = `edit/analysis/${source.replace(":", "/")}/transcript.json`;
  const copy = join(work, ".from-edit.json");
  let found: Transcript;
  try {
    if (!(await editCloud.has(key))) return null;
    fs.mkdirSync(work, { recursive: true });
    await editCloud.download(key, copy);
    found = asKept(JSON.parse(fs.readFileSync(copy, "utf8")) as Transcript);
  } catch {
    return null;
  } finally {
    fs.rmSync(copy, { force: true });
    fs.rmSync(editCloud.partialPath(copy), { force: true });
  }
  if (!Array.isArray(found.words) || found.words.length === 0) return null;
  if (found.heard === undefined) {
    if (!found.model.startsWith("scribe")) return null;
    keep(work, found);
    log.line(`${source}: Edit's hearing of all of it, ${log.said(found.model)}, ${log.count(found.words.length)} words; nothing heard again`);
    return found;
  }
  if (found.heard.length === 0) return null;
  writeAtomic(join(work, EDIT), JSON.stringify(found));
  const heardS = found.heard.reduce((sum, [from, to]) => sum + to - from, 0);
  log.line(`${source}: Edit's words, ${log.said(found.model)} over ${found.heard.length} stretches (${log.clock(heardS)}), ${log.said(found.rough)} the rest; those stretches aren't heard again`);
  return found;
}

/** Each recording's YouTube link, in the order of `recordings`. */
function links(script: Script): (string | null)[] {
  const youtube = (url: string | undefined | null) => (url && isYoutube(url) ? url : null);
  const parts = script.parts ?? [];
  if (parts.length < 2) return [youtube(parts[0]?.url) ?? youtube(script.sourceUrl)];
  return parts.map((part) => youtube(part.url));
}

/** A recording's words on the script's clock: from `offsetMs`, only what plays (`lengthMs`), voices marked with `tag` when there is one. */
export function onClock(transcript: Transcript, offsetMs: number, lengthMs: number, tag: string | null): Word[] {
  return transcript.words
    .filter((word) => Math.round(word.start * 1000) < lengthMs)
    .map((word) => {
      const startMs = offsetMs + Math.round(Math.max(word.start, 0) * 1000);
      const endMs = Math.min(Math.max(offsetMs + Math.round(Math.max(word.end, 0) * 1000), startMs + 1), offsetMs + lengthMs);
      return { id: "", text: word.text, startMs, endMs, ...(word.speaker === undefined ? {} : { speaker: tag === null ? word.speaker : `${tag}:${word.speaker}` }) };
    });
}

/** Edit's stretches of a recording (`offsetMs` into the script) counted as heard exactly, with the names they were heard with: the build doesn't hear them again (exact.ts). */
export function withEditStretches(script: Script, transcript: Transcript, offsetMs: number): void {
  const before = script.exact ?? [];
  const stretches = (transcript.heard ?? []).map(([from, to]): [number, number] => [offsetMs + Math.round(from * 1000), offsetMs + Math.round(to * 1000)]);
  const had = new Set((script.exactKeyterms ?? []).map((name) => name.toLowerCase()));
  const names = transcript.keyterms ?? [];
  script.exactKeyterms = before.length === 0 ? [...names] : names.filter((name) => had.has(name.toLowerCase()));
  script.exact = [...before.filter(([a, b]) => !stretches.some(([x, y]) => a >= x && b <= y)), ...stretches].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * The script's words, heard (or read from captions) recording by recording;
 * `onProgress` gets how far it has got, in thousandths of the whole. A
 * script that had words keeps them (their ids, text and corrections), and
 * gains only what was missing.
 */
export async function transcribe(app: App, script: Script, dir: string, onProgress: (done: number, total: number) => void = () => {}, signal?: AbortSignal, onStage?: (text: string) => void): Promise<void> {
  // The waveform and quiet cut points are a help, not a need.
  if (isFile(script.originalPath)) {
    try {
      const peaks = await media.peaks(script.originalPath, signal);
      if (peaks.length > 0) {
        script.overview = media.overview(peaks, 800);
        keepPeaks(dir, peaks);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  if (script.durationMs === 0) throw new Error("This footage has no length.");
  // Caption reads and completed hearings need no new network call for names.
  let names: Promise<string[]> | null = null;
  const keyterms = () => (names ??= caseNames(dir, script).catch(() => []));
  const all = recordings(dir, script);
  const count = all.length;
  const youtube = links(script);
  const sources = partSources(dir, script).map((found) => found?.[0] ?? null);
  const wantCaptions = captions.wanted(script);
  let captioned = 0;
  let apple = 0;
  let edited = 0;
  const heard: Word[] = [];
  for (const [index, recording] of all.entries()) {
    if (signal?.aborted) throw new Error("Stopped by you. Completed work is saved.");
    const work = join(dir, "transcript", recording.key);
    // A completion asks for captions even for an older audio import; ordinary retries reuse a completed hearing first.
    const local = hearing.cached(work);
    const kept = local !== null && local.words.length > 0 ? local : null;
    const url = wantCaptions ? (youtube[index] ?? null) : null;
    let transcript: Transcript | null = script.status !== "ready" ? kept : null;
    // What Edit mode heard of it already (its kept stretches, or all of it): never paid for twice.
    transcript ??= await fromEdit(sources[index] ?? null, work, signal);
    transcript ??= url === null ? null : await captions.transcript(app, url, work, signal);
    transcript ??= script.status === "ready" ? kept : null;
    // Free rough words before paid ones: Scribe hears only what the build chooses (exact.ts).
    transcript ??= await appleHear(recording.file, recording.span, work, signal, onStage);
    if (transcript === null) {
      if (!isFile(recording.file)) throw new Error("The original video is missing, so it can't be transcribed.");
      transcript = await hearing.hear(recording.file, recording.span, work, await keyterms(), signal);
    }
    if (transcript.model === captions.MODEL) captioned++;
    else if (transcript.model === macSpeech.MODEL) apple++;
    else if (Array.isArray(transcript.heard)) {
      edited++;
      withEditStretches(script, transcript, recording.offsetMs);
    }
    log.line(
      `"${script.title}" ${recording.key}: ${log.count(transcript.words.length)} words from ${log.said(transcript.model)}${transcript.model === captions.MODEL || transcript.model === macSpeech.MODEL ? "; Scribe hears only the stretches the build chooses" : ""}`,
    );
    onProgress(((index + 1) * 1000) / count, 1000);
    // A joined case's voices are its recordings' own: one recording's speaker_0 is not the next one's.
    const recovered = onClock(transcript, recording.offsetMs, recording.lengthMs, count > 1 ? String(index + 1) : null);
    const saved = script.words.filter((word) => word.startMs >= recording.offsetMs && word.startMs < recording.offsetMs + recording.lengthMs);
    heard.push(...fillMissing(saved, recovered, script.corrections ?? {}));
  }
  if (heard.length === 0) throw new Error(NO_WORDS);
  script.captions = (script.captions ?? false) || captioned > 0;
  script.rough = (script.rough ?? false) || captioned + apple + edited > 0;
  // A recovery adds missing words without changing existing text, corrections, word ids (reuse highlights use them) or the timeline.
  if (script.words.length === 0) heard.forEach((word, index) => (word.id = `w${String(index).padStart(5, "0")}`));
  script.words = heard;
  if (script.clips.length === 0) script.clips = [{ id: crypto.randomUUID(), startMs: 0, endMs: script.durationMs } satisfies Clip];
  script.updatedAt = Date.now();
}

/**
 * Saved words matched to their recovered counterparts before gaps are
 * filled. Timing alone can't tell a duplicate from a short missing word
 * between two saved ones; matches are monotone and local in time, so
 * repeated words in another sentence can't take this sentence's missing speech.
 */
export function fillMissing(saved: Word[], recovered: Word[], corrections: Record<string, string>): Word[] {
  const DRIFT = 1_500;
  const normalized = recovered.map((word) => hearing.normal(word.text));
  const anchors: ([number, number] | null)[] = saved.map(() => null);
  const taken = recovered.map(() => false);
  const tokens = (text: string) => text.split(/\s+/).map(hearing.normal).filter((word) => word !== "");
  let first = 0;
  let floor = 0;
  for (const [index, old] of saved.entries()) {
    while (first < recovered.length && recovered[first]!.endMs + DRIFT < old.startMs) first++;
    const variants = [tokens(old.text)];
    const corrected = corrections[old.id];
    if (corrected !== undefined) variants.unshift(tokens(corrected));
    let best: [number, [number, number]] | null = null;
    for (let at = Math.max(first, floor); at < recovered.length; at++) {
      if (recovered[at]!.startMs > old.endMs + DRIFT) break;
      for (const want of variants.filter((words) => words.length > 0)) {
        const end = at + want.length;
        if (end <= recovered.length && want.every((word, offset) => normalized[at + offset] === word) && !taken.slice(at, end).some(Boolean)) {
          const distance = Math.abs(old.startMs - recovered[at]!.startMs);
          if (best === null || distance < best[0]) best = [distance, [at, end]];
        }
      }
    }
    if (best !== null) {
      const [start, end] = best[1];
      taken.fill(true, start, end);
      floor = end;
      anchors[index] = best[1];
    }
  }
  // Unmatched saved spellings still stand: each paired with at most one overlapping recovered word between the same anchors.
  const ceiling = saved.map(() => recovered.length);
  let next = recovered.length;
  for (let index = saved.length - 1; index >= 0; index--) {
    ceiling[index] = next;
    const anchor = anchors[index];
    if (anchor) next = anchor[0];
  }
  first = 0;
  floor = 0;
  for (const [index, old] of saved.entries()) {
    const anchor = anchors[index];
    if (anchor) {
      floor = anchor[1];
      continue;
    }
    while (first < recovered.length && recovered[first]!.endMs + 150 < old.startMs) first++;
    let best: number | null = null;
    for (let at = Math.max(first, floor); at < ceiling[index]! && recovered[at]!.startMs < old.endMs + 150; at++) {
      if (taken[at] || !(old.startMs < recovered[at]!.endMs + 150)) continue;
      if (best === null || Math.abs(old.startMs - recovered[at]!.startMs) < Math.abs(old.startMs - recovered[best]!.startMs)) best = at;
    }
    if (best !== null) {
      taken[best] = true;
      floor = best + 1;
    }
  }
  const out = [...saved];
  recovered.forEach((word, at) => {
    if (!taken[at]) out.push({ ...word, id: `w-${crypto.randomUUID()}` });
  });
  return out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/** Where a recording's words came from, when they're rough. */
export type Rough = "captions" | "apple" | null;

/** One recording already joined onto a compilation; captions stay on that recording's own clock until mapped onto `span` in the joined footage. */
export async function transcribeSpan(app: App, file: string, span: [number, number], url: string | null, work: string, keyterms: readonly string[], tag: string, signal?: AbortSignal): Promise<[Word[], Rough]> {
  if (url !== null && isYoutube(url)) {
    const found = await captions.transcript(app, url, work, signal);
    if (found !== null) return [onClock(found, span[0], Math.max(span[1] - span[0], 1), tag), "captions"];
  }
  // A span that covers the whole file is heard as the file.
  const whole = (await media.streams(file).catch(() => null))?.durationMs ?? 0;
  const part: [number, number] | null = span[0] > 0 || span[1] < whole ? span : null;
  const [from, to] = part ?? [0, Math.max(whole, 1)];
  const apple = hearing.cached(work) === null ? await appleHear(file, part, work, signal) : null;
  if (apple !== null) return [onClock(apple, from, Math.max(to - from, 1), tag), "apple"];
  const transcript = await hearing.hear(file, part, work, keyterms, signal);
  return [onClock(transcript, from, Math.max(to - from, 1), tag), null];
}

/** Keeps a recording's hearing beside the script, as hearing.ts reads it back. */
export function keep(work: string, transcript: Transcript): void {
  fs.mkdirSync(work, { recursive: true });
  writeAtomic(join(work, "transcript.json"), JSON.stringify(transcript));
}
