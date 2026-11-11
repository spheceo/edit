// Scribe on what's kept, for both modes (Sphe, Nov 11: "we need the robust
// apple first hearing, then removal which cuts down the hours sent to scribe
// significantly. we need a shared system between scripts and edit").
//
// A file's first words are free and rough (first_hearing.ts: YouTube's
// word-timed captions, else Apple's on-device recogniser). The agent chooses
// on them: Script mode's build its clips, Edit's agent its cut. Then Scribe
// hears only what's kept: each kept stretch with 3 s either side, neighbours
// closer than 6 s joined, less what was heard before, cut from the footage
// and joined into one recording with a second of quiet between them, heard
// once, whole (one voice is one letter across every stretch), and split back
// onto each stretch. What was heard is kept, so a cut that grows hears only
// its new footage and nothing is paid for twice.
//
// Script mode lines the rough words up with Scribe's (writer/exact.ts). Edit
// mode keeps Scribe's words over each stretch heard and the rough ones
// elsewhere, the transcript's `heard` saying which (`merged`; media.ts
// `refine`). Footage kept almost whole is heard whole, one request.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { covers } from "./names.ts";
import { join } from "./paths.ts";
import { ffmpeg, isUrl, protocols, urlArgs } from "./tools.ts";
import type { Transcript, Word } from "./transcribe.ts";
import { cached, hear } from "./writer/hearing.ts";
import { STOPPED } from "./writer/proc.ts";

/** Heard either side of a kept stretch, so its first and last words are heard whole. */
export const PAD_MS = 3_000;
/** Kept stretches closer than this are heard as one. */
export const JOIN_MS = 6_000;
/** What's left of a stretch beside one heard before, shorter than this, is inside the earlier one's 3 s either side already. */
export const LEFTOVER_MS = 2_000;
/** Kept footage this much of its file is heard whole, as one request: joining it would save nothing. */
export const WHOLE_SHARE = 0.85;
/** A heard word this close to its stretch's cut (ms) may be cut off: the words heard before stand there. */
const EDGE_MS = 80;
/** Quiet between stretches joined into one recording, so no word runs from one into the next. */
const GAP_S = 1;
/** The joined recording's sound: 16 kHz mono 16-bit, 32,000 bytes a second. */
const RATE = 16_000;
const BYTES_PER_S = RATE * 2;
/** Stretches cut from the footage at once. */
const AT_ONCE = 4;

type Span = [number, number];

/** The model YouTube's captions were kept as before Nov 11: rough words with no `heard` of their own. */
const CAPTIONS = "youtube-captions";

/**
 * A transcript kept before Nov 11 as YouTube's captions (no `heard`) is
 * rough words like any first pass: none of it heard, its ">>" voices
 * dropped. Others as they are.
 */
export function asKept(transcript: Transcript): Transcript {
  // Free words with no `heard` (captions kept before Nov 11, or a file an older build stripped of it): none heard.
  if ((transcript.model !== CAPTIONS && transcript.model !== "apple-speech") || transcript.heard !== undefined) return transcript;
  return { ...transcript, words: transcript.words.map(({ text, start, end }) => ({ text, start, end })), speakers: {}, roles: {}, colors: {}, heard: [], rough: transcript.model };
}

/** An Edit file's transcript, or null when it's not there or unreadable. */
export function readKept(path: string): Transcript | null {
  try {
    const found = JSON.parse(fs.readFileSync(path, "utf8")) as Transcript;
    if (typeof found.model !== "string" || !Array.isArray(found.words)) return null;
    if (!Array.isArray(found.heard)) delete found.heard;
    return asKept(found);
  } catch {
    return null;
  }
}

/** `spans` less what `heard` already has (both ms): a leftover shorter than LEFTOVER_MS is in a heard stretch's padding already. */
export function less(spans: readonly Span[], heard: readonly Span[]): Span[] {
  const left: Span[] = [];
  for (const span of spans) {
    let pieces: Span[] = [[span[0], span[1]]];
    for (const [a, b] of heard) {
      pieces = pieces.flatMap(([x, y]): Span[] => (b <= x || a >= y ? [[x, y]] : ([[x, a], [b, y]] as Span[]).filter(([p, q]) => q > p && q - p >= LEFTOVER_MS)));
    }
    left.push(...pieces);
  }
  return left;
}

/** The stretches (ms) of a file `length` ms long to hear for the `kept` ones: padded, neighbours joined, less what was `heard`. */
export function toHear(kept: readonly Span[], heard: readonly Span[], length: number): Span[] {
  const padded = kept
    .map(([from, to]): Span => [Math.max(from - PAD_MS, 0), Math.min(to + PAD_MS, length)])
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const joined: Span[] = [];
  for (const [from, to] of padded) {
    const last = joined.at(-1);
    if (last !== undefined && from <= last[1] + JOIN_MS) last[1] = Math.max(last[1], to);
    else joined.push([from, to]);
  }
  return less(joined, heard);
}

/** `spans` joined into one sorted list where they touch. */
export function union(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * The stretches (ms into `footage`) joined into one recording, a second of
 * quiet between them, and heard by Scribe once, whole: each stretch's words,
 * in ms into the footage. Kept under `root/joined-<stretches>/`, so a retry
 * never pays again.
 */
export async function hearJoined(root: string, footage: string, spans: Span[], keyterms: string[], signal?: AbortSignal): Promise<Word[][]> {
  const name = new Bun.CryptoHasher("sha256").update(JSON.stringify(spans)).digest("hex").slice(0, 16);
  const work = join(root, `joined-${name}`);
  const lengthsFile = join(work, "lengths.json");
  const audio = join(work, "joined.wav");
  fs.mkdirSync(work, { recursive: true });
  let lengths: number[] | null = null;
  try {
    lengths = JSON.parse(fs.readFileSync(lengthsFile, "utf8")) as number[];
  } catch {
    // Not joined yet.
  }
  const kept = cached(work);
  try {
    if (lengths === null || lengths.length !== spans.length || kept === null || !covers(kept.keyterms, keyterms)) {
      lengths = await joined(footage, spans, work, audio, signal);
      fs.writeFileSync(lengthsFile, JSON.stringify(lengths));
    }
    const heard = await hear(audio, null, work, keyterms, signal);
    return split(heard.words, spans, lengths);
  } finally {
    fs.rmSync(audio, { force: true });
  }
}

/** Each stretch's sound cut from the footage and joined, in order, into `audio` (WAV), a second of quiet between them: the seconds each stretch runs. */
async function joined(footage: string, spans: Span[], work: string, audio: string, signal?: AbortSignal): Promise<number[]> {
  const cuts = spans.map((_, index) => join(work, `cut-${index}.raw`));
  try {
    let next = 0;
    // A cut that fails stops the others taking more.
    let failed = false;
    const lane = async () => {
      for (let index = next++; index < spans.length && !failed; index = next++) {
        if (signal?.aborted) throw new Error(STOPPED);
        const [from, to] = spans[index]!;
        const child = Bun.spawn(
          [
            ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
            // The footage may be the cloud's preview (exact_after.ts, a cloud proxy in Edit): only this stretch's bytes are read.
            ...(isUrl(footage) ? ["-protocol_whitelist", protocols(footage), ...urlArgs(footage)] : []),
            "-ss", (from / 1000).toFixed(3), "-t", ((to - from) / 1000).toFixed(3), "-i", footage,
            "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", cuts[index]!,
          ],
          { stdout: "ignore", stderr: "pipe", ...(signal ? { signal } : {}) },
        );
        const stderr = await new Response(child.stderr).text();
        if (signal?.aborted) throw new Error(STOPPED);
        if ((await child.exited) !== 0) throw new Error(`Could not take the sound out of the footage: ${diag.gist(stderr)}`);
      }
    };
    // Every lane settled before the cuts are removed either way: one still cutting would write after them.
    const lanes = await Promise.allSettled(
      Array.from({ length: Math.min(AT_ONCE, spans.length) }, () =>
        lane().catch((error: unknown) => {
          failed = true;
          throw error;
        }),
      ),
    );
    const first = lanes.find((settled) => settled.status === "rejected");
    if (first !== undefined) throw first.reason;
    const sizes = cuts.map((cut) => fs.statSync(cut).size);
    const gap = Buffer.alloc(GAP_S * BYTES_PER_S);
    const data = sizes.reduce((sum, size) => sum + size, 0) + gap.length * Math.max(spans.length - 1, 0);
    const out = fs.openSync(audio, "w");
    try {
      fs.writeSync(out, wavHeader(data));
      cuts.forEach((cut, index) => {
        if (index > 0) fs.writeSync(out, gap);
        fs.writeSync(out, fs.readFileSync(cut));
      });
    } finally {
      fs.closeSync(out);
    }
    return sizes.map((size) => size / BYTES_PER_S);
  } finally {
    for (const cut of cuts) fs.rmSync(cut, { force: true });
  }
}

/** A 16 kHz mono 16-bit WAV file's header for `data` bytes of sound. */
function wavHeader(data: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(BYTES_PER_S, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data, 40);
  return header;
}

/** The joined recording's words back on each stretch, in ms into the footage: a word belongs to the stretch it's mostly in. */
export function split(words: readonly Word[], spans: readonly Span[], lengths: readonly number[]): Word[][] {
  const starts: number[] = [];
  let at = 0;
  for (const length of lengths) {
    starts.push(at);
    at += length + GAP_S;
  }
  const out: Word[][] = spans.map(() => []);
  for (const word of words) {
    const middle = (word.start + word.end) / 2;
    let index = starts.length - 1;
    while (index > 0 && starts[index]! > middle) index -= 1;
    const length = lengths[index]!;
    const from = spans[index]![0];
    const start = Math.min(Math.max(word.start - starts[index]!, 0), length);
    const end = Math.min(Math.max(word.end - starts[index]!, start), length);
    out[index]!.push({ ...word, start: from + start * 1000, end: from + end * 1000 });
  }
  return out;
}

/**
 * Edit's transcript with Scribe's words over the stretches just heard (`spans`
 * and each one's `words`, ms into the file): the words there before are
 * replaced, the rest stay, and `heard` gains the stretches. A later round's
 * voices are its own (`h2:speaker_0`): Scribe's numbers mean nothing across
 * two hearings, and naming (speakers.ts) and the watch give each its person.
 */
export function merged(transcript: Transcript, spans: readonly Span[], words: readonly Word[][], keyterms: readonly string[], model: string, again = false): Transcript {
  // A word the cut runs through ("there-" at a stretch's last instant) is half a word: the earlier words stand
  // there, and Scribe's take over only between its first and last whole words (the Mac's check, Nov 11).
  const whole = spans.map(([from, to], index) => (words[index] ?? []).filter((word) => word.start > from + EDGE_MS && word.end < to - EDGE_MS));
  // Scribe's over the stretch, less the time of a word cut off at either end.
  const inner = spans.map(([from, to], index): Span => {
    const heard = words[index] ?? [];
    const first = heard.find((word) => word.start <= from + EDGE_MS);
    const last = [...heard].reverse().find((word) => word.end >= to - EDGE_MS);
    return [first === undefined ? from : first.end, last === undefined ? to : last.start];
  });
  const inside = (at: number) => inner.some(([from, to]) => at * 1000 >= from && at * 1000 < to);
  const voices = transcript.words.map((word) => word.speaker).filter((voice): voice is string => typeof voice === "string");
  const rounds = voices.length === 0 ? 0 : Math.max(1, ...voices.map((voice) => Number(/^h(\d+):/u.exec(voice)?.[1] ?? 1)));
  const tag = rounds === 0 ? "" : `h${rounds + 1}:`;
  const fresh = whole.flatMap((list) =>
    list.map((word): Word => ({ text: word.text, start: word.start / 1000, end: word.end / 1000, ...(typeof word.speaker === "string" ? { speaker: `${tag}${word.speaker}` } : {}) })),
  );
  const kept = transcript.words.filter((word) => !inside((word.start + word.end) / 2));
  const before = transcript.heard ?? [];
  const had = new Set((transcript.keyterms ?? []).map((name) => name.toLowerCase()));
  // The names every stretch was heard with; heard all again (`again`), the ones it was just heard with.
  const names = before.length === 0 || again ? [...keyterms] : keyterms.filter((name) => had.has(name.toLowerCase()));
  const { keyterms: _old, ...rest } = transcript;
  // Who the rest is still from: the rough words' model, said apart from Scribe's.
  const rough = transcript.rough ?? (before.length === 0 && transcript.model !== model ? transcript.model : undefined);
  return {
    ...rest,
    model,
    ...(rough !== undefined ? { rough } : {}),
    words: [...kept, ...fresh].sort((a, b) => a.start - b.start || a.end - b.end),
    ...(names.length > 0 ? { keyterms: names } : {}),
    heard: union([...before, ...spans.map(([from, to]): Span => [from / 1000, to / 1000])]),
  };
}
