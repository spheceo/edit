// Cached transcript coverage, so a model need not compare
// thousands of words against hundreds of subtitle clips by hand, and quote
// callouts away from the words that point to them. No transcription or paid
// calls: the transcripts given are the ones already made.

import { intro } from "./captions.ts";
import type { Clip, Project } from "./model.ts";
import { clipEnd, duration as durationOf, fps as fpsOf, trackOf } from "./project.ts";
import { byteLength, charCount, chars, isAlphanumeric, round, splitWhitespace, toI64, trim } from "./rust.ts";
import * as seams from "./seams.ts";
import { compareKeys } from "./stable.ts";
import type { Transcript } from "./transcribe.ts";

export function subtitleCoverage(project: Project, transcripts: Map<string, Transcript>): unknown {
  const fps = fpsOf(project);
  const from = project.script !== undefined && project.script !== null ? (intro(project)?.[1] ?? 0) : 0;
  const sound = seams.subtitles.footageSound(project, from, durationOf(project));
  const spans = project.clips
    .filter((clip) => {
      if (clip.type !== "text") return false;
      const track = trackOf(project, clip.track);
      return track !== undefined && track.subtitles === true && !track.hidden;
    })
    .map((clip) => [clip.start, clipEnd(clip)] as [number, number]);
  let checked = 0;
  const missing: [number, number, string, string, string, string][] = [];
  const unavailable: string[] = [];
  for (const clip of sound) {
    if (clip.type !== "audio") continue;
    const transcript = transcripts.get(clip.media);
    if (transcript === undefined) {
      unavailable.push(clip.media);
      continue;
    }
    const sourceEnd = clip.source_in + (clip.duration / fps) * clip.speed;
    for (const word of transcript.words) {
      const source = (word.start + word.end) / 2.0;
      if (source < clip.source_in || source >= sourceEnd || seams.subtitles.tokens(word.text).length === 0) continue;
      const frame = toI64(Math.floor(clip.start + ((source - clip.source_in) / clip.speed) * fps));
      if (
        frame < from ||
        (project.segments ?? []).some((segment) => segment.start <= frame && frame < segment.end && segment.kind !== "footage")
      ) {
        continue;
      }
      const voice = word.speaker ?? null;
      const named = voice !== null && transcript.speakers !== undefined && Object.hasOwn(transcript.speakers, voice) ? transcript.speakers[voice]! : null;
      const name = named ?? "Speaker";
      const given = voice !== null && transcript.roles !== undefined && Object.hasOwn(transcript.roles, voice) ? transcript.roles[voice]! : null;
      const role = seams.subtitles.roleOf(given, name);
      if (seams.subtitles.hiddenRole(role)) continue;
      checked += 1;
      if (spans.some(([start, end]) => start <= frame && frame < end)) continue;
      const start = clip.start / fps + (word.start - clip.source_in) / clip.speed;
      const end = clip.start / fps + (word.end - clip.source_in) / clip.speed;
      missing.push([start, end, clip.id, clip.media, name, word.text]);
    }
  }
  const count = missing.length;
  missing.sort((a, b) => a[0] - b[0]);
  const groups: [number, number, string, string, string, string][] = [];
  for (const [start, end, clip, media, speaker, word] of missing) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last[2] === clip && last[4] === speaker && start - last[1] <= 0.5 && byteLength(last[5]) < 240) {
      last[1] = Math.max(last[1], end);
      last[5] += ` ${word}`;
    } else {
      groups.push([start, end, clip, media, speaker, word]);
    }
  }
  const missingTranscripts = [...new Set(unavailable)].sort(compareKeys);
  const examples = groups.slice(0, 20).map(([start, end, clip, media, speaker, words]) => ({ start, end, clip, media, speaker, words }));
  return {
    checked_words: checked,
    uncovered_words: count,
    uncovered_spans: groups.length,
    examples_seconds: examples,
    missing_transcripts: missingTranscripts,
    scope: "Temporal coverage of cached, visible footage speech after the intro; does not verify subtitle wording or speaker correctness.",
  };
}

/** Words too common to tie a quote to the moment it's spoken. */
const COMMON = [
  "about", "after", "again", "always", "been", "because", "before", "being", "could", "didn't", "does", "doesn't",
  "doing", "don't", "even", "every", "from", "going", "gonna", "have", "here", "it's", "just", "know", "like",
  "little", "made", "make", "maybe", "much", "never", "nothing", "okay", "only", "really", "said", "says", "should",
  "some", "something", "still", "that", "that's", "their", "them", "then", "there", "there's", "these", "they",
  "they're", "thing", "think", "this", "those", "very", "wanna", "want", "well", "were", "what", "what's", "when",
  "where", "which", "while", "with", "would", "yeah", "your", "you're",
];

/** Words that say nothing about which line is meant, even two together. */
const SLIGHT = ["a", "an", "and", "the", "to", "of", "in", "on", "or", "it", "is", "at"];

/** A word as compared: lower case, letters and digits only, its ending taken off ("mopped", "mopping" → "mopp"). */
export function stem(given: string): string {
  const kept = chars(given.toLowerCase())
    .filter((c) => isAlphanumeric(c) || c === "'")
    .join("");
  const word = kept.replace(/^'+|'+$/gu, "");
  for (const ending of ["ing", "ed", "es", "s"]) {
    if (word.endsWith(ending)) {
      const root = word.slice(0, word.length - ending.length);
      if (charCount(root) >= 3) return root;
    }
  }
  return word;
}

/** Whether a text clip is a quote callout: words in quotation marks on screen, not a subtitle or a speaker caption. */
function isQuote(project: Project, clip: Clip): string | null {
  if (clip.type !== "text") return null;
  const name = clip.name ?? null;
  if (trackOf(project, clip.track)?.subtitles === true || (name !== null && (name.startsWith("Subtitle") || name.startsWith("Caption")))) {
    return null;
  }
  const text = trim(clip.text);
  const quoted = (text.startsWith("“") || text.startsWith('"')) && (text.endsWith("”") || text.endsWith('"'));
  return quoted ? text : null;
}

/**
 * Quote callouts away from the words that point to them: a callout whose
 * telling words (not "like", "something") are heard within 10 s of it, in the
 * narration or the footage, but none while it's on screen (half a second
 * either side).
 */
export function calloutTiming(project: Project, transcripts: Map<string, Transcript>): unknown[] {
  const fps = fpsOf(project);
  // Every word heard on the timeline: (frame, stem).
  const heard: [number, string][] = [];
  for (const clip of project.clips) {
    if (clip.type !== "audio") continue;
    if (trackOf(project, clip.track)?.muted === true) continue;
    const transcript = transcripts.get(clip.media);
    if (transcript === undefined) continue;
    const to = clip.source_in + (clip.duration / fps) * clip.speed;
    for (const word of transcript.words) {
      const middle = (word.start + word.end) / 2.0;
      if (middle < clip.source_in || middle >= to) continue;
      heard.push([clip.start + toI64(round(((middle - clip.source_in) / clip.speed) * fps)), stem(word.text)]);
    }
  }
  const near = toI64(round(0.5 * fps));
  const around = toI64(round(10.0 * fps));
  const issues: unknown[] = [];
  for (const clip of project.clips) {
    const text = isQuote(project, clip);
    if (text === null) continue;
    const telling = splitWhitespace(text)
      .filter((word) => !word.includes("*"))
      .map(stem)
      .filter((word) => charCount(word) >= 4 && !COMMON.includes(word));
    if (telling.length === 0) continue;
    const said = (from: number, to: number) => heard.filter(([frame, word]) => frame >= from && frame < to && telling.includes(word)).map(([frame]) => frame);
    if (said(clip.start - near, clipEnd(clip) + near).length > 0) continue;
    // The narration under it paraphrasing it shares a few of its words.
    const words = splitWhitespace(text)
      .map(stem)
      .filter((word) => charCount(word) >= 2 && !SLIGHT.includes(word));
    const shared = new Set(
      heard.filter(([frame, word]) => frame >= clip.start - near && frame < clipEnd(clip) + near && words.includes(word)).map(([, word]) => word),
    );
    if (shared.size >= 2) continue;
    let at: number | null = null;
    for (const frame of said(clip.start - around, clipEnd(clip) + around)) {
      if (at === null || Math.abs(frame - clip.start) < Math.abs(at - clip.start)) at = frame;
    }
    if (at !== null) issues.push({ kind: "callout_off_speech", clip: clip.id, start: clip.start, said_at: at, text });
  }
  return issues;
}
