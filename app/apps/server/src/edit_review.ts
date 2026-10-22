// Cached transcript coverage, so a model need not compare
// thousands of words against hundreds of subtitle clips by hand, and quote
// callouts away from the words that point to them. No transcription or paid
// calls: the transcripts given are the ones already made.

import type { Clip, Project } from "./model.ts";
import { clipEnd, duration as durationOf, fps as fpsOf, reusedSpans, trackOf } from "./project.ts";
import { byteLength, charCount, chars, isAlphanumeric, round, splitWhitespace, toI64, trim } from "./rust.ts";
import * as seams from "./seams.ts";
import { compareKeys } from "./stable.ts";
import type { Transcript } from "./transcribe.ts";

export function subtitleCoverage(project: Project, transcripts: Map<string, Transcript>): unknown {
  return coverage(project, transcripts).report;
}

type Gap = [number, number, string, string, string, string];

function coverage(project: Project, transcripts: Map<string, Transcript>): { report: unknown; groups: Gap[] } {
  const fps = fpsOf(project);
  // The intro too, its speaker captions counting: Helpful Wife's teasers,
  // split for punch-ins, left their new halves heard with nothing on screen.
  const from = 0;
  const sound = seams.subtitles.footageSound(project, from, durationOf(project));
  const spans = project.clips
    .filter((clip) => {
      if (clip.type !== "text") return false;
      const track = trackOf(project, clip.track);
      if (track === undefined || track.hidden) return false;
      return track.subtitles === true || (clip.name ?? "").startsWith("Caption");
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
  const report = {
    checked_words: checked,
    uncovered_words: count,
    uncovered_spans: groups.length,
    examples_seconds: examples,
    missing_transcripts: missingTranscripts,
    scope: "Temporal coverage of cached, visible footage speech, the intro's captions included; does not verify subtitle wording or speaker correctness.",
  };
  return { report, groups };
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
  const heard = spokenWords(project, transcripts);
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
  // A desktop profile's lines type on as the narration says them (Corrupt
  // Cop's: "Text needs to be more synced overall"): each line's marker
  // ("desktop line") against where its telling words are heard.
  const slack = toI64(round(1.0 * fps));
  for (const marker of project.markers ?? []) {
    if (marker.name !== "desktop line") continue;
    const telling = tellingWords(marker.note ?? "");
    if (telling.length === 0) continue;
    const said = heard.filter(([frame, word]) => Math.abs(frame - marker.frame) <= around && telling.some((one) => sameWord(one, word))).map(([frame]) => frame);
    if (said.length === 0 || said.some((frame) => Math.abs(frame - marker.frame) <= slack)) continue;
    // Where its phrase starts: the nearest of its words heard, back to the
    // first of them said within 3 s before it.
    const nearest = said.reduce((best, frame) => (Math.abs(frame - marker.frame) < Math.abs(best - marker.frame) ? frame : best));
    const phrase = toI64(round(3.0 * fps));
    const at = Math.min(...said.filter((frame) => frame <= nearest && nearest - frame <= phrase));
    issues.push({ kind: "profile_line_off_speech", start: marker.frame, said_at: at, text: marker.note ?? "" });
  }
  return issues;
}

/** Text that isn't a graphic of its own: subtitles, captions and the countdown follow the words on their own terms. */
const FOLLOWS_SPEECH = ["Subtitle", "Caption", "Countdown", "Film look"];

/**
 * Words on screen that come after they're said (the team, four rounds running:
 * "Whenever we are about to say something, we need to have it visually in
 * front of us a second before, or at least a little bit before"): a text
 * graphic (a name, a label, a note, a quote, a date, a File Viewer's name)
 * or a desktop line whose telling words start being heard before it shows.
 * Words said more than 4 s before it are a recap, not this. `start_by` is
 * where it should start: 0.7 s before its words.
 */
export function textLate(project: Project, transcripts: Map<string, Transcript>): unknown[] {
  const fps = fpsOf(project);
  const heard = spokenWords(project, transcripts);
  const recap = toI64(round(4.0 * fps));
  const grace = toI64(round(0.2 * fps));
  const lead = toI64(round(0.7 * fps));
  const issues: unknown[] = [];
  // A text already up within half a second of its narration's start can't come
  // any earlier: its words are the bridge's first (nothing before it to go over).
  const narrations = project.clips.filter((clip) => clip.type === "audio" && clip.name === "Voice-over").map((clip) => clip.start);
  const opening = toI64(round(0.5 * fps));
  const atItsStart = (start: number) => narrations.some((from) => start >= from && start - from <= opening);
  const check = (start: number, until: number, text: string, extra: Record<string, unknown>) => {
    if (atItsStart(start)) return;
    const telling = tellingWords(text).slice(0, 3);
    if (telling.length === 0) return;
    const said = heard.filter(([frame, word]) => frame >= start - recap && frame < until && telling.some((one) => sameWord(one, word)));
    if (said.length === 0) return;
    const first = said[0]![0];
    if (first >= start - grace) return;
    if (start - first > recap) return;
    issues.push({ kind: "text_late", ...extra, start, said_at: first, start_by: Math.max(0, first - lead), text });
  };
  for (const clip of project.clips) {
    if (clip.type !== "text") continue;
    const name = clip.name ?? "";
    if (FOLLOWS_SPEECH.some((prefix) => name.startsWith(prefix))) continue;
    if (trackOf(project, clip.track)?.subtitles === true) continue;
    check(clip.start, clipEnd(clip), clip.text, { clip: clip.id });
  }
  for (const marker of project.markers ?? []) {
    if (marker.name !== "desktop line") continue;
    check(marker.frame, marker.frame + toI64(round(3.0 * fps)), marker.note ?? "", { desktop_line: true });
  }
  return issues;
}

/** Every word heard on the timeline (narration and footage, not muted tracks): its frame and stem. */
export function spokenWords(project: Project, transcripts: Map<string, Transcript>): [number, string][] {
  const fps = fpsOf(project);
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
  return heard.sort((a, b) => a[0] - b[0]);
}

/** A line's words that tie it to where it's said: not "like" or "a", four letters or more (or a number). */
function tellingWords(text: string): string[] {
  return splitWhitespace(text)
    .filter((word) => !word.includes("*"))
    .map(stem)
    .filter((word) => (charCount(word) >= 4 || /^\d+$/u.test(word)) && !COMMON.includes(word));
}

/** One word heard as another: the same stem, or one the start of the other ("sept" for "september"). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = charCount(a) <= charCount(b) ? [a, b] : [b, a];
  return charCount(short) >= 4 && long.startsWith(short);
}

/**
 * The frames a desktop profile's `lines` type on, each where the narration
 * between `from` and `to` (frames) says it, in order: the first of its
 * telling words heard after the line before. Null for a line it never says.
 */
export function lineFrames(lines: string[], heard: [number, string][], from: number, to: number): (number | null)[] {
  let after = from;
  return lines.map((line) => {
    const telling = tellingWords(line.replace(/^[-•]\s*/u, ""));
    const found = heard.find(([frame, word]) => frame >= after && frame < to && telling.some((one) => sameWord(one, word)));
    if (found === undefined) return null;
    after = found[0] + 1;
    return found[0];
  });
}

/**
 * Footage cut inside a word: a clip of a video's own sound whose in or out
 * point falls in a word that goes on past it, unless the next clip carries
 * the same moment on (Corrupt Cop's "Unintentionally, sir." cut before "sir"
 * finished). Each with the second the word ends (or starts), to cut there.
 */
export function cutMidWord(project: Project, transcripts: Map<string, Transcript>): unknown[] {
  const fps = fpsOf(project);
  const margin = 0.06;
  const issues: unknown[] = [];
  const sounds = project.clips.filter(
    (clip) =>
      clip.type === "audio" &&
      clip.volume_db > -40 &&
      trackOf(project, clip.track)?.muted !== true &&
      project.media.find((media) => media.id === clip.media)?.kind === "video",
  );
  for (const clip of sounds) {
    if (clip.type !== "audio") continue;
    const transcript = transcripts.get(clip.media);
    if (transcript === undefined) continue;
    const from = clip.source_in;
    const to = clip.source_in + (clip.duration / fps) * clip.speed;
    const carried = (at: number, frame: number) =>
      sounds.some(
        (other) =>
          other !== clip &&
          other.type === "audio" &&
          other.media === clip.media &&
          Math.abs((frame === clip.start ? clipEnd(other) : other.start) - frame) <= 1 &&
          Math.abs((frame === clip.start ? other.source_in + (other.duration / fps) * other.speed : other.source_in) - at) <= 0.1,
      );
    for (const word of transcript.words) {
      // The transcriber can squeeze a word to a few hundredths of a second
      // ("sir." at 286.62–286.66): it's heard for at least ~0.2 s, longer by its letters.
      const letters = chars(word.text).filter((c) => isAlphanumeric(c)).length;
      const ends = word.end - word.start < 0.15 ? word.start + Math.max(0.2, 0.06 * letters) : word.end;
      if (word.start < to - margin && ends > to + margin && !carried(to, clipEnd(clip))) {
        issues.push({ kind: "cut_mid_word", clip: clip.id, at: clipEnd(clip), side: "out", word: trim(word.text), word_ends: round(ends * 100) / 100 });
      }
      if (word.start < from - margin && word.end > from + margin && !carried(from, clip.start)) {
        issues.push({ kind: "cut_mid_word", clip: clip.id, at: clip.start, side: "in", word: trim(word.text), word_starts: round(word.start * 100) / 100 });
      }
    }
  }
  return issues;
}

/** Words the house style leaves unsubtitled (throwaway sounds). */
const FILLER = new Set(["um", "uh", "umm", "uhh", "mm", "hmm", "mhm", "mmhmm", "uhhuh", "ah", "oh", "er", "so", "like", "huh"]);

/**
 * Footage speech heard with nothing on screen (`unsubtitled_speech`): runs
 * of at least two real words (not fillers) under no subtitle or caption.
 */
export function unsubtitledSpeech(project: Project, transcripts: Map<string, Transcript>): unknown[] {
  const fps = fpsOf(project);
  return coverage(project, transcripts).groups
    .filter(([, , , , , words]) => splitWhitespace(words).filter((word) => !FILLER.has(word.toLowerCase().replace(/[^a-z]/gu, ""))).length >= 2)
    .map(([start, end, clip, , speaker, words]) => ({
      kind: "unsubtitled_speech",
      clip,
      start: toI64(Math.floor(start * fps)),
      end: toI64(Math.ceil(end * fps)),
      speaker,
      words,
      fix: "heard with nothing on screen: caption it as the clips around it are (caption_speakers in the intro, add_subtitles after) over this span",
    }));
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
  const second = toI64(round(fps));
  const edge = toI64(round(0.15 * fps));
  const issues: unknown[] = [];
  // Where the footage's own sound plays (B-roll under a narration plays
  // silent): a subtitle or caption with none of it under it says words
  // nobody hears (the comp's teaser captioned Ava over the voice-over).
  const sound = project.clips.filter(
    (clip) =>
      clip.type === "audio" &&
      trackOf(project, clip.track)?.muted !== true &&
      project.media.find((media) => media.id === clip.media)?.kind === "video",
  );
  const reused = reusedSpans(project);
  for (const clip of project.clips) {
    if (clip.type !== "text") continue;
    const name = clip.name ?? "";
    if (!(name.startsWith("Caption") || name.startsWith("Subtitle"))) continue;
    const middle = clip.start + clip.duration / 2;
    if (!sound.some((audio) => audio.start <= middle && clipEnd(audio) > middle) && !reused.some(([from, to]) => from <= middle && to > middle)) {
      issues.push({ kind: "subtitle_unheard", clip: clip.id, start: clip.start, text: clip.text, fix: "delete it: no footage sound plays under it (B-roll under a narration is silent; subtitles are for what's heard)" });
      continue;
    }
    if (heard.length === 0) continue;
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
    // A pause cut out of the range (dead air in a teaser) skips only silence:
    // the next piece may pick up later as long as no word was skipped.
    const words = transcript.words.filter((word) => word.end > cutIn + 0.02 && word.start < cutOut - 0.02 && trim(word.text) !== "");
    const silent = (from: number, to: number) => !words.some((word) => word.end > from + 0.05 && word.start < to - 0.05);
    let current = footage.find((clip) => clip.id === block.clip);
    if (current === undefined) continue;
    const played: [number, number][] = [];
    while (current !== undefined) {
      played.push(span(current));
      const [, ends] = span(current);
      const after: Clip = current;
      current = footage.find((clip) => {
        if (clip.start !== clipEnd(after)) return false;
        const picks = span(clip)[0];
        return Math.abs(picks - ends) < 1 || (picks > ends && picks - ends < 15 && silent(ends, picks));
      });
    }
    played.sort((a, b) => a[0] - b[0]);
    // What's not played: the range's words (the stretch before its first and
    // after its last word count as time, as before; pauses between don't).
    let missing = 0;
    const covered = (from: number, to: number) => played.reduce((sum, [a, b]) => sum + Math.max(Math.min(b, to) - Math.max(a, from), 0), 0);
    if (words.length === 0) {
      let at = cutIn;
      for (const [from, to] of played) {
        missing += Math.max(from - at, 0);
        at = Math.max(at, to);
      }
      missing += Math.max(cutOut - at, 0);
    } else {
      for (const word of words) {
        const [from, to] = [Math.max(word.start, cutIn), Math.min(word.end, cutOut)];
        missing += Math.max(to - from - covered(from, to), 0);
      }
    }
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

/** Seconds of nothing said inside a teaser that the audit calls dead air: between two words, and at a clip's ends. */
const DEAD_BETWEEN = 0.9;
const DEAD_AT_END = 0.7;

/**
 * Dead air in the teasers (`spans`: the intro's footage stretches): a pause
 * inside a teaser clip where nothing is said (the team, on a two-second pause
 * in Helpful Wife's first teaser: "dead space like this must be removed").
 * Timeline frames to cut out (remove_time), each with its length.
 */
export function deadAir(project: Project, transcripts: Map<string, Transcript>, spans: [number, number][]): unknown[] {
  const fps = fpsOf(project);
  const issues: unknown[] = [];
  const timeline = (clip: Clip & { source_in: number; speed: number }, at: number) => clip.start + toI64(round(((at - clip.source_in) / clip.speed) * fps));
  for (const clip of project.clips) {
    if (clip.type !== "audio" || clip.volume_db <= -40 || trackOf(project, clip.track)?.muted === true) continue;
    if (project.media.find((media) => media.id === clip.media)?.kind !== "video") continue;
    if (!spans.some(([start, end]) => clip.start >= start && clipEnd(clip) <= end)) continue;
    const transcript = transcripts.get(clip.media);
    if (transcript === undefined) continue;
    const from = clip.source_in;
    const to = clip.source_in + (clip.duration / fps) * clip.speed;
    const words = transcript.words.filter((word) => word.end > from && word.start < to && trim(word.text) !== "");
    if (words.length === 0) continue;
    const gaps: [number, number, number][] = [];
    const first = words[0]!;
    const last = words[words.length - 1]!;
    if (first.start - from >= DEAD_AT_END) gaps.push([from, first.start - 0.1, first.start - from]);
    for (let index = 1; index < words.length; index++) {
      const [before, after] = [words[index - 1]!, words[index]!];
      if (after.start - before.end >= DEAD_BETWEEN) gaps.push([before.end + 0.12, after.start - 0.12, after.start - before.end]);
    }
    if (to - last.end >= DEAD_AT_END) gaps.push([last.end + 0.15, to, to - last.end]);
    for (const [start, end, seconds] of gaps) {
      issues.push({
        kind: "dead_air",
        clip: clip.id,
        from: timeline(clip, start),
        to: timeline(clip, end),
        seconds: round(seconds * 10) / 10,
        fix: "remove_time over it (a jump cut inside the teaser: change the punch-in on it so it reads as a cut)",
      });
    }
  }
  return issues;
}
