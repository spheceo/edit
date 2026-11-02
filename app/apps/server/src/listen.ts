// listen: what's heard over a stretch of a file, for the agent's questions
// about sound (who speaks, when the shouting starts, where it goes quiet),
// with times. Nothing in Edit hears sound itself any more (the watcher looks
// at frames since Oct 30, the user: "I just wanna get rid of gemini"), so it
// answers from what Edit already has, free and on this Mac: the cached
// transcript with its named voices, and the media's loudness analysis (the
// engine's loudness.rs, 10 ms blocks) every half second, marked where it's
// well over the file's own speech. Kept per stretch in the media's cache dir.
// Sphe's Nov 2 list, item 5 (from Diffusion Studio's listen).

import * as fs from "node:fs";

import type { App } from "./app.ts";
import type { Media } from "./model.ts";
import { native } from "./native/index.ts";
import { join, parent } from "./paths.ts";
import { fixed, serdeParse } from "./rust.ts";
import type { Transcript, Word } from "./transcribe.ts";

/** The longest stretch one call listens to (s). */
export const MOST = 300;
/** The loudness strip's step (s). */
const STEP = 0.5;
/** Over the file's own speech by this much (LU): shouting, a bang, a siren. */
const LOUD = 8;
/** Under this (LUFS) for a second or more: silence. */
const SILENT = -50;
/** The strip's levels, quiet to loud. */
const BARS = "▁▂▃▄▅▆▇█";
/** A new layout is a new version. */
const VERSION = "listen-v1";

export interface Heard {
  /** Momentary loudness every STEP s from `from` (LUFS; -70 for silence). */
  levels: number[];
  /** The file's speech level here (LUFS): the median under its words. */
  speech: number | null;
  /** Stretches well over the speech: [from, to, peak dBFS]. */
  loud: [number, number, number][];
  /** Stretches of silence: [from, to]. */
  quiet: [number, number][];
  /** Who says what: [from, to, who, words]. */
  lines: [number, number, string, string][];
}

function readTranscript(path: string): Transcript | null {
  try {
    const value = serdeParse(fs.readFileSync(path, "utf8")) as Transcript;
    return Array.isArray(value?.words) ? value : null;
  } catch {
    return null;
  }
}

/** Words into lines: one voice, no gap over 0.8 s. */
export function linesOf(transcript: Transcript, from: number, to: number): [number, number, string, string][] {
  const words = transcript.words.filter((word) => word.end > from && word.start < to);
  const out: [number, number, string, string][] = [];
  let run: Word[] = [];
  const who = (word: Word) => {
    const voice = word.speaker ?? "";
    const named = transcript.speakers?.[voice];
    return named ?? (voice === "" ? "someone" : voice.replace("speaker_", "voice "));
  };
  const flush = () => {
    if (run.length === 0) return;
    out.push([run[0]!.start, run[run.length - 1]!.end, who(run[0]!), run.map((word) => word.text).join(" ")]);
    run = [];
  };
  for (const word of words) {
    const last = run[run.length - 1];
    if (last !== undefined && ((word.speaker ?? "") !== (last.speaker ?? "") || word.start - last.end > 0.8)) flush();
    run.push(word);
  }
  flush();
  return out;
}

/** Runs of steps where `test` holds, at least `least` steps long, as [from, to]. */
function runs(levels: number[], from: number, least: number, test: (level: number, index: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let start: number | null = null;
  for (let index = 0; index <= levels.length; index++) {
    const on = index < levels.length && test(levels[index]!, index);
    if (on && start === null) start = index;
    if (!on && start !== null) {
      if (index - start >= least) out.push([from + start * STEP, from + index * STEP]);
      start = null;
    }
  }
  return out;
}

/** What's heard from `from` to `to` (seconds of the file), from its loudness and transcript. */
export async function hear(path: string, transcript: Transcript | null, from: number, to: number): Promise<Heard> {
  const steps = Math.max(1, Math.round((to - from) / STEP));
  const spans = Array.from({ length: steps }, (_, index) => ({ from: from + index * STEP, seconds: STEP }));
  const measured = await native().loudnessSpans(path, spans);
  const levels = measured.map((span) => (Number.isFinite(span.loudest) ? Math.max(span.loudest, -70) : -70));
  const peaks = measured.map((span) => (Number.isFinite(span.peak) ? span.peak : -90));
  const lines = transcript === null ? [] : linesOf(transcript, from, to);
  // The speech level: the median under the words said here.
  const under = levels.filter((_, index) => {
    const at = from + (index + 0.5) * STEP;
    return lines.some(([start, end]) => at >= start && at <= end);
  });
  under.sort((a, b) => a - b);
  const speech = under.length >= 4 ? under[Math.floor(under.length / 2)]! : null;
  const loudFrom = (speech ?? median(levels)) + LOUD;
  const loud = runs(levels, from, 1, (level) => level >= loudFrom).map(([start, end]): [number, number, number] => {
    const first = Math.round((start - from) / STEP);
    const last = Math.round((end - from) / STEP);
    return [start, end, Math.max(...peaks.slice(first, last))];
  });
  const quiet = runs(levels, from, Math.round(1 / STEP), (level) => level <= SILENT);
  return { levels, speech, loud, quiet, lines };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? -70;
}

/** The strip: one bar per step, 20 s a row with its time first. */
export function strip(levels: number[], from: number): string {
  const rows: string[] = [];
  const perRow = Math.round(20 / STEP);
  for (let at = 0; at < levels.length; at += perRow) {
    const bars = levels
      .slice(at, at + perRow)
      .map((level) => BARS[Math.min(BARS.length - 1, Math.max(0, Math.floor(((level + 60) / 50) * BARS.length)))]!)
      .join("");
    rows.push(`${fixed(from + at * STEP, 1).padStart(7)}s ${bars}`);
  }
  return rows.join("\n");
}

/** The reply: the strip, what's loud, what's silent, who says what. */
export function said(media: Media, from: number, to: number, heard: Heard, transcribed: boolean): string {
  const out = [
    `${media.id} "${media.name}" ${fixed(from, 1)}–${fixed(to, 1)}s, loudness every ${STEP} s (▁ under -60 LUFS … █ over -10${heard.speech === null ? "" : `; its speech here sits at ${fixed(heard.speech, 0)} LUFS`}):`,
    strip(heard.levels, from),
  ];
  out.push(
    heard.loud.length === 0
      ? `LOUD (${LOUD}+ LU over its speech: shouting, a bang, a siren): none`
      : `LOUD (${LOUD}+ LU over its speech: shouting, a bang, a siren): ${heard.loud.map(([start, end, peak]) => `${fixed(start, 1)}–${fixed(end, 1)}s (peak ${fixed(peak, 0)} dBFS)`).join(", ")}`,
  );
  out.push(heard.quiet.length === 0 ? "SILENT (1 s+): none" : `SILENT (1 s+): ${heard.quiet.map(([start, end]) => `${fixed(start, 1)}–${fixed(end, 1)}s`).join(", ")}`);
  if (!transcribed) out.push("SAID: no transcript of this file yet (media_transcript makes one)");
  else if (heard.lines.length === 0) out.push("SAID: nothing (no words in its transcript here)");
  else out.push("SAID (its transcript's voices):", ...heard.lines.map(([start, end, who, words]) => `${fixed(start, 1)}–${fixed(end, 1)}s ${who}: "${words}"`));
  out.push("What plays under the speech (music, a siren's kind, a crowd) isn't told apart here: look at the picture, or the loud marks' times.");
  return out.join("\n");
}

/** `listen` for a media of the project: cached per stretch beside the media's other analysis. */
export async function listen(app: App, media: Media, start: number, end: number): Promise<string> {
  if (media.kind === "image") throw new Error(`${media.id} is a picture: nothing to hear`);
  if (media.kind === "video" && media.has_audio === false) throw new Error(`${media.id} has no sound`);
  const from = Math.max(0, start);
  const to = Math.min(end, media.duration > 0 ? media.duration : end);
  if (!(to > from)) throw new Error("end must be after start (seconds of the file)");
  if (to - from > MOST) throw new Error(`listen to at most ${MOST} s at a time`);
  const paths = app.media.paths(media.path);
  const transcript = readTranscript(paths.transcript);
  const dir = parent(paths.transcript);
  // The transcript's voices can be renamed (the watcher): its time is in the key.
  let stamp = "none";
  try {
    stamp = String(Math.round(fs.statSync(paths.transcript).mtimeMs));
  } catch {
    // Not transcribed.
  }
  const cache = dir === null ? null : join(dir, `${VERSION}-${fixed(from, 2)}-${fixed(to, 2)}-${stamp}.txt`);
  if (cache !== null) {
    try {
      return fs.readFileSync(cache, "utf8");
    } catch {
      // Not heard yet.
    }
  }
  const heard = await hear(media.path, transcript, from, to);
  const reply = said(media, from, to, heard, transcript !== null);
  if (cache !== null) {
    try {
      fs.mkdirSync(dir!, { recursive: true });
      fs.writeFileSync(cache, reply);
    } catch {
      // The cache is a saving, not a need.
    }
  }
  return reply;
}
