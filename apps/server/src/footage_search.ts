// `find_in_footage` (footage_search.rs): where things are said across all of
// a project's footage, from the transcripts already made. Picking B-roll for a
// cut-in is finding the moments its narration talks about; one search for
// every phrase of every cut-in replaces reading transcript after transcript.

import type { App } from "./app.ts";
import { cachedTranscript } from "./captions.ts";
import type { Project } from "./model.ts";
import { byteLength, chars, isAlphanumeric, round, splitWhitespace, trim } from "./rust.ts";
import type { Transcript } from "./transcribe.ts";

/** A word as it's compared: lower case, letters and digits only. */
export function norm(word: string): string {
  return chars(word)
    .filter((c) => isAlphanumeric(c) || c === "'")
    .map((c) => c.toLowerCase())
    .join("")
    .replaceAll("'", "");
}

/** Words that say nothing on their own: a phrase is matched by the rest. */
const SMALL = [
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "is", "it", "was", "i", "you", "he", "she", "they",
  "we", "that", "this", "for", "with", "be", "are", "were", "do", "did",
];

export interface Hit {
  media: string;
  start: number;
  end: number;
  score: number;
  index: number;
}

/**
 * The best places in `words` for `phrase`: windows a little longer than the
 * phrase, scored by the share of its meaningful words they hold (exact runs
 * score highest). Overlapping windows keep only their best.
 */
export function search(words: string[], phrase: string): [number, number, number][] {
  const wanted = splitWhitespace(phrase)
    .map(norm)
    .filter((w) => w !== "");
  if (wanted.length === 0 || words.length === 0) return [];
  const big = wanted.filter((w) => !SMALL.includes(w));
  const key = big.length === 0 ? wanted : big;
  const span = Math.min(wanted.length + 3, words.length);
  const found: [number, number, number][] = [];
  const matches = (own: string, w: string) => own === w || (byteLength(w) > 4 && own.startsWith(w));
  for (let start = 0; start <= words.length - span; start++) {
    const window = words.slice(start, start + span);
    const held = key.filter((w) => window.some((own) => matches(own, w))).length;
    let score = held / key.length;
    if (score < 0.6) continue;
    // An exact run of the whole phrase beats words scattered around.
    for (let at = 0; at + wanted.length <= window.length; at++) {
      if (wanted.every((w, i) => window[at + i] === w)) {
        score += 1.0;
        break;
      }
    }
    // The hit runs from the first matching word to the last.
    const hit = (own: string) => key.some((w) => matches(own, w));
    const firstAt = window.findIndex(hit);
    let lastAt = -1;
    for (let i = window.length - 1; i >= 0; i--) {
      if (hit(window[i]!)) {
        lastAt = i;
        break;
      }
    }
    if (firstAt < 0 || lastAt < 0) continue;
    const [first, last] = [start + firstAt, start + lastAt + 1];
    const previous = found[found.length - 1];
    if (previous !== undefined && first < previous[1]) {
      if (score > previous[2]) found[found.length - 1] = [first, last, score];
    } else {
      found.push([first, last, score]);
    }
  }
  return found.sort((a, b) => b[2] - a[2]);
}

export function find(app: App, project: Project, phrases: string[], limit: number, context: number): unknown {
  // Each video's cached transcript (nothing is transcribed here).
  const sources: [string, string, Transcript, string[]][] = [];
  const missing: string[] = [];
  for (const media of project.media.filter((media) => media.kind === "video" && media.has_audio)) {
    const transcript = cachedTranscript(app.media.paths(media.path).transcript);
    if (transcript === null) {
      missing.push(media.id);
      continue;
    }
    sources.push([media.id, media.name, transcript, transcript.words.map((word) => norm(word.text))]);
  }
  const results = phrases.map((phrase) => {
    const hits: Hit[] = [];
    for (const [media, , transcript, words] of sources) {
      for (const [from, to, score] of search(words, phrase)) {
        const first = transcript.words[from];
        const last = transcript.words[Math.max(to - 1, 0)];
        if (first === undefined || last === undefined) continue;
        hits.push({ media, start: first.start, end: last.end, score, index: from });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    const shown: unknown[] = [];
    for (const hit of hits.slice(0, limit)) {
      const source = sources.find(([id]) => id === hit.media);
      if (source === undefined) continue;
      const [, name, transcript] = source;
      const from = Math.max(hit.index - context, 0);
      const to = Math.min(hit.index + context + 6, transcript.words.length);
      if (from > to) continue;
      const word = transcript.words[hit.index];
      if (word === undefined) continue;
      const said = transcript.words.slice(from, to).map((w) => trim(w.text));
      const voice = word.speaker ?? null;
      const speaker =
        voice === null ? null : transcript.speakers !== undefined && Object.hasOwn(transcript.speakers, voice) ? transcript.speakers[voice]! : voice;
      shown.push({
        media: hit.media,
        name,
        at: round(hit.start * 100.0) / 100.0,
        end: round(hit.end * 100.0) / 100.0,
        speaker,
        exact: hit.score >= 1.0,
        said: said.join(" "),
      });
    }
    return { phrase, hits: shown };
  });
  return { results, untranscribed_media: missing };
}
