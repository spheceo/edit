// Transcription through Edit's relay (apps/relay/), which holds the ElevenLabs
// key. Edit sends small mono Opus audio and keeps Scribe's words, cached per
// source file so the same footage is never paid for twice.
//
// Every transcript in Edit comes from here (media.ts's `transcribe`), so this
// is the one transcription system: a long file is heard twice at once.
// Scribe places words late on a long file (a line at 5:50 of a 25-minute
// bodycam came out 26 s late), so its words and times come from 40-second
// pieces heard on their own (`plan`, `join`); but a piece only numbers the
// voices in it, so who speaks comes from the whole file heard in one go,
// whose voice numbers hold from start to end (`voicesFrom`). Then
// cameras.ts splits a voice heard on two bodycams (two officers Scribe heard
// as one), and speakers.ts names the voices.

import * as fs from "node:fs";

import * as cameras from "./cameras.ts";
import * as diag from "./diag.ts";
import { ioMessage, writeAtomic } from "./files.ts";
import { withExtension } from "./paths.ts";
import * as relay from "./relay.ts";
import * as tools from "./tools.ts";
import { serdeParse } from "./rust.ts";

/** One spoken word. Times are seconds into the source. */
export interface Word {
  text: string;
  start: number;
  end: number;
  /** Scribe's voice number, if it heard more than one person. */
  speaker?: string;
}

export interface Transcript {
  model: string;
  language?: string | null;
  words: Word[];
  /**
   * Who each voice is ("speaker_0" → "Officer", "Jane Doe (Mother)"), read
   * from the conversation by a model once the words are in.
   */
  speakers?: Record<string, string>;
  /** Each voice's role in Repack's colour code (officer, suspect, witness…). */
  roles?: Record<string, string>;
  /** Each voice's colour ("#00e5c7"), from its role (see speakers.ts). */
  colors?: Record<string, string>;
  /**
   * How each voice's person looks and where they sit, as the watch saw them
   * across the whole video (cast.ts), so the seats find that face rather
   * than guess who is who again.
   */
  looks?: Record<string, string>;
  /**
   * The bodycam each voice is heard on ("speaker_7" → "D01A2379M", the ID
   * burned into the picture; cameras.ts), when the file shows more than one:
   * each camera's wearer is one officer, which naming is told.
   */
  cameras?: Record<string, string>;
  /**
   * The case's names Scribe was told to listen for (names.ts), so a later ask
   * with names it wasn't given hears the file again.
   */
  keyterms?: string[];
}

/**
 * A transcript as it's always been written: its fields in order, the maps
 * sorted (BTreeMaps) and left out when empty, and each word's speaker only
 * when it has one.
 */
export function serialize(transcript: Transcript): string {
  const sortedMap = (map: Record<string, string> | undefined) => {
    const keys = Object.keys(map ?? {}).sort();
    return keys.length === 0 ? undefined : Object.fromEntries(keys.map((key) => [key, map![key]!]));
  };
  // Integer-like keys ("0") would be listed first by the JS object, so the
  // maps are written by hand.
  const writeMap = (map: Record<string, string>) =>
    `{${Object.keys(map)
      .map((key) => `${JSON.stringify(key)}:${JSON.stringify(map[key])}`)
      .join(",")}}`;
  const words = transcript.words.map((word) => {
    const out: Word = { text: word.text, start: word.start, end: word.end };
    if (word.speaker !== undefined && word.speaker !== null) out.speaker = word.speaker;
    return JSON.stringify(out);
  });
  let text = `{"model":${JSON.stringify(transcript.model)},"language":${JSON.stringify(transcript.language ?? null)},"words":[${words.join(",")}]`;
  for (const field of ["speakers", "roles", "colors", "looks", "cameras"] as const) {
    const map = sortedMap(transcript[field]);
    if (map !== undefined) text += `,${JSON.stringify(field)}:${writeMap(map)}`;
  }
  if (transcript.keyterms !== undefined && transcript.keyterms.length > 0) text += `,"keyterms":${JSON.stringify(transcript.keyterms)}`;
  return `${text}}`;
}

/** Waits before asking a busy relay again (a 429), then gives up. */
const BUSY_WAITS = [15, 30, 60, 60, 60, 60];

/** How long a wait before asking again lasts (tests make it instant). */
export const timing = { sleep: (seconds: number) => Bun.sleep(seconds * 1000) };

/** Seconds of speech each piece of a long file is heard for, besides its context. */
export const PIECE = 40;
/** Seconds heard either side of a piece, so a word across its edge is heard whole by one of them. */
export const CONTEXT = 4;
/** Files up to this long are heard in one go: short enough not to drift. */
export const WHOLE_UP_TO = 90;
/** Pieces heard at once (the relay takes 60 a minute from one connection). */
const PIECES_AT_ONCE = 4;

/**
 * Extracts audio, sends it to the relay with the case's names to listen for
 * (`keyterms`), writes `target` (transcript JSON). A file longer than
 * `WHOLE_UP_TO` is heard in pieces for its words and whole for its voices
 * (see the top), then its voices are split by bodycam. Names Scribe refuses
 * (a 400 or 422: nothing heard or billed) are dropped and it's asked once
 * without them rather than fail over a spelling aid.
 */
export async function run(source: string, target: string, keyterms: readonly string[] = []): Promise<void> {
  const audio = withExtension(target, "ogg");
  // Asked before the media's other work has made its cache folder.
  fs.mkdirSync(target.slice(0, target.lastIndexOf("/")) || ".", { recursive: true });
  await encode(["-protocol_whitelist", "file,pipe", "-i", source, "-map", "0:a:0"], audio, "could not extract audio");
  let transcript: Transcript;
  try {
    const seconds = await lengthOf(audio);
    if (seconds <= WHOLE_UP_TO) {
      transcript = await ask(audio, keyterms);
    } else {
      const pieces = plan(seconds);
      const [whole, heard] = await Promise.all([
        ask(audio, keyterms),
        limited(pieces, PIECES_AT_ONCE, async (piece, index) => {
          const file = withExtension(target, `piece-${index}.ogg`);
          try {
            await encode(["-ss", fixed3(piece.from), "-t", fixed3(piece.to - piece.from), "-i", audio], file, "could not cut the audio");
            const part = await ask(file, keyterms);
            // Times into the file, not the piece.
            return part.words.map((word) => ({ text: word.text, start: round3(word.start + piece.from), end: round3(word.end + piece.from) }));
          } finally {
            fs.rmSync(file, { force: true });
          }
        }),
      ]);
      const words = join(pieces, heard);
      voicesFrom(words, whole.words);
      transcript = { model: whole.model, language: whole.language, words };
      diag.info("media", `${source}: heard in ${pieces.length} pieces for its words and whole for its voices (${words.length} words)`);
    }
  } finally {
    fs.rmSync(audio, { force: true });
  }
  // The names asked with, even when refused: asked again they'd be refused again.
  if (keyterms.length > 0) transcript.keyterms = [...keyterms];
  // Two officers' bodycams: one voice to Scribe, two people. Never fails the transcript.
  try {
    await cameras.split(source, transcript);
  } catch (error) {
    diag.warn("media", `${source}: reading its bodycams: ${diag.messageOf(error)}; its voices stay as heard`);
  }
  try {
    writeAtomic(target, serialize(transcript));
  } catch (error) {
    throw new Error(ioMessage(error));
  }
}

/** Mono 16 kHz Opus of what `input` (FFmpeg's input arguments) names, into `out`. */
async function encode(input: string[], out: string, failure: string): Promise<void> {
  const encoded = Bun.spawn(
    [tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...input, "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", out],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const [stderr, code] = await Promise.all([new Response(encoded.stderr).text(), encoded.exited]);
  if (code !== 0) {
    fs.rmSync(out, { force: true });
    throw new Error(`${failure}: ${stderr.trim()}`);
  }
}

/** How long an audio file is, in seconds (0 when FFprobe can't say: heard whole). */
async function lengthOf(audio: string): Promise<number> {
  const probe = Bun.spawn([tools.ffprobe(), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audio], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [out] = await Promise.all([new Response(probe.stdout).text(), probe.exited]);
  const seconds = Number.parseFloat(out.trim());
  return Number.isFinite(seconds) ? seconds : 0;
}

/**
 * Asks the relay for one audio file's words. The relay takes a few
 * transcriptions at once (a script import's footage and voice-over takes can
 * ask together): a 429 waits and asks again.
 */
async function ask(audio: string, keyterms: readonly string[]): Promise<Transcript> {
  const auth = relay.authHeaders();
  const waits = [...BUSY_WAITS];
  let status: number;
  let body: string;
  let names = [...keyterms];
  for (;;) {
    let response: Response;
    const query = names.map((name) => `keyterm=${encodeURIComponent(name)}`).join("&");
    try {
      response = await fetch(`${relay.url()}/v1/transcribe${query === "" ? "" : `?${query}`}`, {
        method: "POST",
        headers: { ...auth, "content-type": "audio/ogg" },
        body: Bun.file(audio),
        signal: AbortSignal.timeout(1800 * 1000),
      });
      body = await response.text();
    } catch (error) {
      throw new Error(`could not reach the transcription relay: ${diag.messageOf(error)}`);
    }
    status = response.status;
    if ((status === 400 || status === 422) && names.length > 0) {
      diag.warn("media", `transcription refused the case's names (${status}: ${body.trim().slice(0, 200)}); asking without them`);
      names = [];
      continue;
    }
    // The day's allowance used up isn't busy: asking again only waits minutes for the same answer.
    if (status === 429 && !/allowance/i.test(body)) {
      const wait = waits.shift();
      if (wait !== undefined) {
        diag.warn("media", `transcription busy (429): asking again in ${wait} s`);
        await timing.sleep(wait);
        continue;
      }
    }
    break;
  }
  let value: unknown = null;
  try {
    value = serdeParse(body);
  } catch {
    value = null;
  }
  if (status !== 200) {
    const object = (typeof value === "object" && value !== null ? value : {}) as {
      error?: unknown;
      detail?: { message?: unknown };
    };
    const message =
      typeof object.error === "string"
        ? object.error
        : typeof object.detail?.message === "string"
          ? object.detail.message
          : body.trim();
    throw new Error(`transcription failed (${status}): ${message}`);
  }
  return parseScribe(value);
}

/** A piece of a long file: the stretch it speaks for (`core`) and what's sent (`from`–`to`, with context). */
export interface Piece {
  coreFrom: number;
  coreTo: number;
  from: number;
  to: number;
}

/** A file of `seconds` cut into even pieces of at most `PIECE` seconds, each with `CONTEXT` either side. */
export function plan(seconds: number): Piece[] {
  const count = Math.max(Math.ceil(seconds / PIECE), 1);
  const pieces: Piece[] = [];
  for (let index = 0; index < count; index += 1) {
    const coreFrom = (seconds * index) / count;
    const coreTo = (seconds * (index + 1)) / count;
    pieces.push({ coreFrom, coreTo, from: Math.max(coreFrom - CONTEXT, 0), to: Math.min(coreTo + CONTEXT, seconds) });
  }
  return pieces;
}

/**
 * The pieces' words as one transcript. Neighbours both hear the context
 * around their seam: it's handed over at a word both heard at the same moment
 * (the one nearest the seam), so no word is lost or heard twice; with no such
 * word, at the seam itself.
 */
export function join(pieces: readonly Piece[], heard: readonly Word[][]): Word[] {
  const first = heard.map(() => 0);
  const last = heard.map((words) => words.length);
  for (let index = 0; index + 1 < heard.length; index += 1) {
    const seam = pieces[index]!.coreTo;
    const left = heard[index]!;
    const right = heard[index + 1]!;
    const near = CONTEXT + 0.2;
    const leftAt = indexesWhere(left, (word) => word.end >= seam - near);
    const rightAt = indexesWhere(right, (word) => word.start <= seam + near);
    const pairs = matched(
      leftAt.map((at) => normal(left[at]!.text)),
      rightAt.map((at) => normal(right[at]!.text)),
    )
      .map(([a, b]) => [leftAt[a]!, rightAt[b]!] as const)
      .filter(([a, b]) => normal(left[a]!.text) !== "" && Math.abs(left[a]!.start - right[b]!.start) <= 0.8);
    if (pairs.length > 0) {
      const middle = ([a, b]: readonly [number, number]) => Math.abs((left[a]!.end + right[b]!.end) / 2 - seam);
      const [a, b] = pairs.reduce((best, pair) => (middle(pair) < middle(best) ? pair : best));
      last[index] = a + 1;
      first[index + 1] = b + 1;
    } else {
      const before = (word: Word) => (word.start + word.end) / 2 < seam;
      last[index] = left.filter(before).length;
      first[index + 1] = right.filter(before).length;
    }
  }
  const words: Word[] = [];
  heard.forEach((piece, index) => words.push(...piece.slice(first[index], Math.max(last[index]!, first[index]!))));
  return words;
}

/**
 * Gives each word the voice the whole file heard it in: the two transcripts'
 * words are lined up by what they say (the whole file's times drift, so not
 * by time); a word only the pieces heard takes its neighbours' voice.
 */
export function voicesFrom(words: Word[], whole: readonly Word[]): void {
  const pairs = aligned(
    words.map((word) => normal(word.text)),
    whole.map((word) => normal(word.text)),
  );
  const voice: (string | undefined)[] = words.map(() => undefined);
  for (const [a, b] of pairs) voice[a] = whole[b]!.speaker;
  // Unmatched words: the voice of the nearer matched word, before or after ("Uh," before an answer is the answer's).
  let before: number | null = null;
  const after: (number | null)[] = words.map(() => null);
  let next: number | null = null;
  for (let index = words.length - 1; index >= 0; index -= 1) {
    after[index] = next;
    if (voice[index] !== undefined) next = index;
  }
  words.forEach((word, index) => {
    if (voice[index] !== undefined) {
      word.speaker = voice[index];
      before = index;
      return;
    }
    const prior: number | null = before;
    const later = after[index] ?? null;
    const gapBefore = prior === null ? Infinity : word.start - words[prior]!.end;
    const gapAfter = later === null ? Infinity : words[later]!.start - word.end;
    const chosen = gapAfter < gapBefore ? later : prior;
    if (chosen !== null && voice[chosen] !== undefined) word.speaker = voice[chosen];
    else delete word.speaker;
  });
}

/** A word as compared across transcripts: lower case, letters and digits only. */
function normal(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function indexesWhere(words: readonly Word[], keep: (word: Word) => boolean): number[] {
  const out: number[] = [];
  words.forEach((word, index) => {
    if (keep(word)) out.push(index);
  });
  return out;
}

/** The longest common subsequence of two short lists: pairs of indexes in order (a seam's few seconds). */
function matched(a: readonly string[], b: readonly string[]): [number, number][] {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] && a[i] !== "" ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j] && a[i] !== "") {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  // Only runs of two or more: one common word ("the") is chance.
  return pairs.filter(([x, y], at) => {
    const prev = pairs[at - 1];
    const next = pairs[at + 1];
    return (prev !== undefined && prev[0] === x - 1 && prev[1] === y - 1) || (next !== undefined && next[0] === x + 1 && next[1] === y + 1);
  });
}

/**
 * Two long word lists lined up (the longest common subsequence within a band
 * around the diagonal, as their lengths allow; a 25-minute file is ~7,000
 * words a side, so the whole table is too big). Pairs of indexes, in order.
 */
export function aligned(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const band = Math.max(400, Math.abs(n - m) + 200);
  // Row i keeps columns lo(i)..hi(i), the diagonal scaled to the lengths.
  const centre = (i: number) => Math.round((i * m) / n);
  const lo = (i: number) => Math.max(0, centre(i) - band);
  const hi = (i: number) => Math.min(m, centre(i) + band);
  const width = 2 * band + 2;
  // Moves: 1 match (diagonal), 2 skip a, 3 skip b. Scores two rows at a time.
  const moves = new Uint8Array((n + 1) * width);
  let previous = new Int32Array(width);
  let current = new Int32Array(width);
  const at = (row: Int32Array, i: number, j: number) => (j < lo(i) || j > hi(i) ? -1 : row[j - lo(i)]!);
  for (let j = lo(0); j <= hi(0); j += 1) previous[j - lo(0)] = 0;
  for (let i = 1; i <= n; i += 1) {
    current.fill(0);
    for (let j = lo(i); j <= hi(i); j += 1) {
      let best = -1;
      let move = 0;
      if (j > 0 && a[i - 1] === b[j - 1] && a[i - 1] !== "") {
        const diagonal = at(previous, i - 1, j - 1);
        if (diagonal >= 0) {
          best = diagonal + 1;
          move = 1;
        }
      }
      const up = at(previous, i - 1, j);
      if (up > best) {
        best = up;
        move = 2;
      }
      const left = j > lo(i) ? current[j - 1 - lo(i)]! : -1;
      if (left > best) {
        best = left;
        move = 3;
      }
      current[j - lo(i)] = Math.max(best, 0);
      moves[i * width + (j - lo(i))] = move;
    }
    [previous, current] = [current, previous];
  }
  const pairs: [number, number][] = [];
  let i = n;
  let j = Math.min(m, hi(n));
  while (i > 0 && j >= lo(i)) {
    const move = moves[i * width + (j - lo(i))];
    if (move === 1) {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (move === 3) {
      j -= 1;
    } else {
      i -= 1;
    }
  }
  return pairs.reverse();
}

/** `work` over `items`, at most `count` at a time, answers in order. */
async function limited<T, R>(items: readonly T[], count: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(count, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await work(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return out;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const fixed3 = (value: number) => value.toFixed(3);

/** Scribe's answer, keeping only spoken words (not spacing or sound events). */
export function parseScribe(value: unknown): Transcript {
  const answer = (typeof value === "object" && value !== null ? value : {}) as {
    words?: unknown;
    language_code?: unknown;
  };
  if (!Array.isArray(answer.words)) throw new Error("the transcription service returned no words");
  const words: Word[] = [];
  for (const item of answer.words as Record<string, unknown>[]) {
    if (typeof item !== "object" || item === null || item.type !== "word") continue;
    if (typeof item.text !== "string" || typeof item.start !== "number" || typeof item.end !== "number") continue;
    const text = item.text.trim();
    if (text === "") continue;
    const start = item.start;
    const word: Word = { text, start: Math.max(start, 0), end: Math.max(item.end, start) };
    if (typeof item.speaker_id === "string") word.speaker = item.speaker_id;
    words.push(word);
  }
  return {
    model: "scribe_v2",
    language: typeof answer.language_code === "string" ? answer.language_code : null,
    words,
  };
}
