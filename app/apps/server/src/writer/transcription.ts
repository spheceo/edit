// A script's words: each recording's YouTube captions where it has them,
// else heard as Edit hears it (hearing.ts), listening for the case's names
// (names.ts), then put on the script's clock. A joined case is heard
// recording by recording, from each one's own file where it's kept (else
// its stretch of the joined footage), so no piece spans two. Each
// recording's hearing is kept under `transcript/<recording>/`, so a retry
// never pays twice.

import * as fs from "node:fs";

import type { Clip, Script, Word } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { writeAtomic } from "../files.ts";
import { isFile, join } from "../paths.ts";
import type { Transcript } from "../transcribe.ts";
import * as captions from "./captions.ts";
import * as hearing from "./hearing.ts";
import * as media from "./media.ts";
import { caseNames } from "./names.ts";
import { partFiles } from "./parts.ts";
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

/**
 * The script's words, heard (or read from captions) recording by recording;
 * `onProgress` gets how far it has got, in thousandths of the whole. A
 * script that had words keeps them (their ids, text and corrections), and
 * gains only what was missing.
 */
export async function transcribe(app: App, script: Script, dir: string, onProgress: (done: number, total: number) => void = () => {}, signal?: AbortSignal): Promise<void> {
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
  const wantCaptions = captions.wanted(script);
  let captioned = 0;
  const heard: Word[] = [];
  for (const [index, recording] of all.entries()) {
    if (signal?.aborted) throw new Error("Stopped by you. Completed work is saved.");
    const work = join(dir, "transcript", recording.key);
    // A completion asks for captions even for an older audio import; ordinary retries reuse a completed hearing first.
    const local = hearing.cached(work);
    const kept = local !== null && local.words.length > 0 ? local : null;
    const url = wantCaptions ? (youtube[index] ?? null) : null;
    let transcript: Transcript | null = script.status !== "ready" ? kept : null;
    transcript ??= url === null ? null : await captions.transcript(app, url, work, signal);
    transcript ??= script.status === "ready" ? kept : null;
    if (transcript === null) {
      if (!isFile(recording.file)) throw new Error("The original video is missing, so it can't be transcribed.");
      transcript = await hearing.hear(recording.file, recording.span, work, await keyterms(), signal);
    }
    if (transcript.model === captions.MODEL) {
      captioned++;
      diag.info("writer", `${recording.key}: ${transcript.words.length} words from YouTube's captions`);
    }
    onProgress(((index + 1) * 1000) / count, 1000);
    // A joined case's voices are its recordings' own: one recording's speaker_0 is not the next one's.
    const recovered = onClock(transcript, recording.offsetMs, recording.lengthMs, count > 1 ? String(index + 1) : null);
    const saved = script.words.filter((word) => word.startMs >= recording.offsetMs && word.startMs < recording.offsetMs + recording.lengthMs);
    heard.push(...fillMissing(saved, recovered, script.corrections ?? {}));
  }
  if (heard.length === 0) throw new Error(NO_WORDS);
  script.captions = (script.captions ?? false) || captioned > 0;
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

/** One recording already joined onto a compilation; captions stay on that recording's own clock until mapped onto `span` in the joined footage. */
export async function transcribeSpan(app: App, file: string, span: [number, number], url: string | null, work: string, keyterms: readonly string[], tag: string, signal?: AbortSignal): Promise<[Word[], boolean]> {
  if (url !== null && isYoutube(url)) {
    const found = await captions.transcript(app, url, work, signal);
    if (found !== null) return [onClock(found, span[0], Math.max(span[1] - span[0], 1), tag), true];
  }
  // A span that covers the whole file is heard as the file.
  const whole = (await media.streams(file).catch(() => null))?.durationMs ?? 0;
  const part: [number, number] | null = span[0] > 0 || span[1] < whole ? span : null;
  const transcript = await hearing.hear(file, part, work, keyterms, signal);
  const [from, to] = part ?? [0, Math.max(whole, 1)];
  return [onClock(transcript, from, Math.max(to - from, 1), tag), false];
}

/** Keeps a recording's hearing beside the script, as hearing.ts reads it back. */
export function keep(work: string, transcript: Transcript): void {
  fs.mkdirSync(work, { recursive: true });
  writeAtomic(join(work, "transcript.json"), JSON.stringify(transcript));
}
