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

/** Every word heard on the timeline from the footage's own sound: its frame and stem. */
function heardWords(project: Project, transcripts: Map<string, Transcript>): [number, string][] {
  const fps = fpsOf(project);
  const heard: [number, string][] = [];
  for (const clip of project.clips) {
    if (clip.type !== "audio" || trackOf(project, clip.track)?.muted === true) continue;
    if (project.media.find((media) => media.id === clip.media)?.kind !== "video") continue;
    const transcript = transcripts.get(clip.media);
    if (transcript === undefined) continue;
    const to = clip.source_in + (clip.duration / fps) * clip.speed;
    for (const word of transcript.words) {
      const middle = (word.start + word.end) / 2.0;
      if (middle < clip.source_in || middle >= to) continue;
      heard.push([clip.start + toI64(round(((middle - clip.source_in) / clip.speed) * fps)), stem(word.text)]);
    }
  }
  return heard;
}

/**
 * Captions and subtitles whose words aren't what's said while they're up
 * (Mom & Teen's "Come on. Come out here." over "Come on, baby."; Mom Leaves 5
 * Kids' "fault. It's your"): of the line's words and those said under it, at
 * least two and 40% don't match (a word of the line matches one said within a
 * second of it; starred words aren't counted).
 */
export function textNotSaid(project: Project, transcripts: Map<string, Transcript>): unknown[] {
  const fps = fpsOf(project);
  const heard = heardWords(project, transcripts);
  if (heard.length === 0) return [];
  const second = toI64(round(fps));
  const edge = toI64(round(0.15 * fps));
  const issues: unknown[] = [];
  for (const clip of project.clips) {
    if (clip.type !== "text") continue;
    const name = clip.name ?? "";
    if (!(name.startsWith("Caption") || name.startsWith("Subtitle"))) continue;
    const shown = splitWhitespace(clip.text)
      .filter((word) => !word.includes("*"))
      .map(stem)
      .filter((word) => word !== "");
    if (shown.length < 3) continue;
    const near = heard.filter(([frame]) => frame >= clip.start - second && frame < clipEnd(clip) + second).map(([, word]) => word);
    if (near.length === 0) continue;
    const unheard = shown.filter((word) => !near.includes(word)).length;
    const under = heard.filter(([frame]) => frame >= clip.start + edge && frame < clipEnd(clip) - edge).map(([, word]) => word);
    const unshown = under.filter((word) => !shown.includes(word)).length;
    const off = unheard + unshown;
    if (off >= 2 && off / (shown.length + unshown) >= 0.4) {
      issues.push({ kind: "text_not_said", clip: clip.id, start: clip.start, text: clip.text });
    }
  }
  return issues;
}

/**
 * Footage that doesn't play its script range whole (Mom & Teen's first teaser
 * stopped before "Yeah, there it is. Goddamn it.": "It is really important
 * that we ensure that the intro and all clips in the video are exactly
 * according to the script"): each range's first and last words found again in
 * the transcript, and more than 0.4 s of it not played by any
 * clip of that media on the footage track (realign_script fixes the cut).
 */
export function offScript(project: Project, transcripts: Map<string, Transcript>): unknown[] {
  const fps = fpsOf(project);
  const base = project.tracks.find((track) => track.kind === "video")?.id;
  const issues: unknown[] = [];
  for (const block of project.script?.blocks ?? []) {
    if (block.kind !== "footage" || block.media == null || block.words == null || block.clip == null) continue;
    const transcript = transcripts.get(block.media);
    if (transcript === undefined) continue;
    const offset = block.media_start ?? 0;
    const [cutIn, cutOut] = seams.script.align(transcript.words, null, block.words, block.start - offset, block.end - offset);
    if (cutIn === null || cutOut === null) continue;
    // The range's clip and the footage clips that carry it on, butted on the
    // timeline (a cut for B-roll over it), each picking up within a second of
    // where the last left off: the same moment played elsewhere doesn't count.
    const footage = project.clips.filter((clip) => clip.type === "video" && clip.track === base && clip.media === block.media);
    const span = (clip: Clip): [number, number] => {
      const from = clip.type === "video" ? clip.source_in : 0;
      const speed = clip.type === "video" ? clip.speed : 1;
      return [from, from + (clip.duration / fps) * speed];
    };
    let current = footage.find((clip) => clip.id === block.clip);
    if (current === undefined) continue;
    const played: [number, number][] = [];
    while (current !== undefined) {
      played.push(span(current));
      const [, ends] = span(current);
      const after: Clip = current;
      current = footage.find((clip) => clip.start === clipEnd(after) && Math.abs(span(clip)[0] - ends) < 1);
    }
    played.sort((a, b) => a[0] - b[0]);
    let at = cutIn;
    let missing = 0;
    for (const [from, to] of played) {
      missing += Math.max(from - at, 0);
      at = Math.max(at, to);
    }
    missing += Math.max(cutOut - at, 0);
    if (missing > 0.4) {
      issues.push({
        kind: "off_script",
        range: block.label,
        clip: block.clip,
        script_seconds: [round(cutIn * 100) / 100, round(cutOut * 100) / 100],
        seconds_not_played: round(missing * 10) / 10,
        fix: "realign_script, or put the range back whole",
      });
    }
  }
  return issues;
}
