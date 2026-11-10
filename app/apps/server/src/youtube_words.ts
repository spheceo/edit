// A YouTube video's words, read one way by everything that needs them: an
// idea's case, an import's footage, a script's recording, Find clips (Sphe,
// Nov 10: "a shared transcription system that has toggles for each use
// case"). Each use is one line of `USES`: how YouTube is asked, whether
// captions timed only by the line will do, and whether a video with no
// captions is heard instead. Until then there were four readers, each with
// its own yt-dlp call, its own idea of a failure and its own track choice.
//
// YouTube's captions first: free, and seconds where a hearing is minutes.
// The best English track is the original word-timed one (`en-orig`), then
// any word-timed, then a manual track, whose cues time a line, not a word
// (each word's time is spread over its cue: fine to read, never to cut on);
// an automatic translation never. ">>" (`isSpeakerChange`) marks a change of
// speaker but not who: each opens a turn of its own, which the watcher, the
// cast or caption_turns.ts gives to people.
//
// A word has no end: it ends at the next word's start or after the time it
// takes to say (`spokenMs`), whichever comes first, so the pauses between
// words are there for the edges and the tightening. Measured on Oct 25 2026
// against ElevenLabs on a 20-minute hearing (3,042 words matched): starts 49
// ms from ElevenLabs' (110 ms for nine words in ten); ends 58 ms late (140
// ms), where the next word's start would be 373 ms; 93% of ">>" marks fall
// on a change of speaker, but they mark only about two thirds of the changes.
//
// With no captions, a use that says `hear` fetches the video's sound alone
// and hears it: Apple's recogniser on a Mac that has it (mac_speech.ts, free),
// Scribe where there's none (Linux, an older macOS). What's heard is kept
// apart from the captions (`heard-v1.json`), never taken for them.
//
// The transcript's model stays explicit: these are captions, not Scribe voices.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import * as macSpeech from "./mac_speech.ts";
import { join, parent } from "./paths.ts";
import * as transcribe from "./transcribe.ts";
import { serialize, type Transcript, type Word } from "./transcribe.ts";
import * as youtube from "./youtube.ts";
import { THIS_MACHINE } from "./machine.ts";

/** What a transcript made from captions is called (`Transcript.model`). */
export const MODEL = "youtube-captions";

/** What one use of a video's words needs. */
export interface Use {
  /** Where its log lines go. */
  area: string;
  /** How YouTube is asked, in order: a way it turns away gives way to the next. */
  ways: readonly youtube.Way[];
  /** Captions timed by the line will do (a manual track): yes to read, no to cut on a word. */
  cues: boolean;
  /** With no captions, the video's sound is fetched and heard. */
  hear: boolean;
  /** This machine's own address is kept for when it's needed (`youtube.ask`): the proxy first every time, straight asks one at a time with a rest between, none for ten minutes once YouTube refuses the address, and never the person's YouTube sign-in. */
  sparing: boolean;
}

export const USES = {
  /**
   * An idea's case: read for its titles, never cut. Nobody's own footage, and
   * many cases a sitting, so sparing of the person's address (Sphe, Oct 31:
   * "try not to do research locally to not risk ip bans"; Nov 10: "we can use
   * the Mac ip but sparingly, only if needed we don't want to get users banned
   * for any reason"): through the proxy, straight only when YouTube turns the
   * proxy's address away.
   */
  idea: { area: "ideas", ways: ["proxy", "straight"], cues: true, hear: true, sparing: true },
  /** An import's footage: cut on the word, so word-timed tracks only. With none, the file here is heard (media.ts). The video itself was downloaded straight, so its captions are asked the same way. */
  footage: { area: "transcribe", ways: ["straight", "proxy"], cues: false, hear: false, sparing: false },
  /** Script mode: a recording's rough words, and Find clips' videos. With none, the recording here is heard (writer/transcription.ts); chosen footage is heard exactly before it's cut. */
  script: { area: "writer", ways: ["straight", "straight", "proxy"], cues: true, hear: false, sparing: false },
} as const satisfies Record<string, Use>;

export type Json3 = { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string; tOffsetMs?: number; isSpeakerChange?: number }[] }[] };

/** Milliseconds a letter: the 75th percentile of 89k words ElevenLabs timed in Writer's scripts (2 letters 120 ms, 8 letters 459, 12 letters 740). */
const MS_A_LETTER = 60;
/** A digit is said in a word or more ("$8,320"). */
const MS_A_DIGIT = 250;
const SHORTEST_MS = 60;

/** How long `word` takes to say, at most, in ms. */
export function spokenMs(word: string): number {
  const letters = [...word].filter((c) => /\p{L}/u.test(c)).length;
  const digits = [...word].filter((c) => /[0-9]/.test(c)).length;
  return Math.max(letters * MS_A_LETTER + digits * MS_A_DIGIT, SHORTEST_MS);
}

/** An English track's language code: "en", "en-orig", or "en-" and a region; never a translation named with another video's id. */
export function english(language: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(language)) return false;
  const lower = language.toLowerCase().replaceAll("_", "-");
  if (lower === "en" || lower === "en-orig") return true;
  const parts = lower.split("-").filter((part) => part !== "");
  if (parts[0] !== "en") return false;
  const rest = parts.slice(1);
  return rest.length > 0 && rest.every((part) => part.length >= 2 && part.length <= 4 && /^[a-z]+$/.test(part));
}

/** Whether a track times its words (most of them a segment of their own), not only its lines. */
export function wordTimed(value: Json3): boolean {
  let total = 0;
  let timed = 0;
  for (const event of value.events ?? []) {
    for (const segment of event.segs ?? []) {
      const count = (segment.utf8 ?? "").replace(/^>+/, "").split(/\s+/).filter((word) => word !== "").length;
      total += count;
      if (count === 1 && typeof segment.tOffsetMs === "number") timed++;
    }
  }
  return total > 0 && timed * 2 >= total;
}

/** A track as it was chosen: its language, whether its words are timed, and YouTube's json3. */
export interface Track {
  language: string;
  timed: boolean;
  value: Json3;
}

/**
 * The best English track in `folder` (yt-dlp's `captions.<language>.json3`):
 * the original word-timed one, then any word-timed, then, when `cues` will
 * do, manual cues and other line-timed tracks; an automatic translation
 * never. `info` is yt-dlp's `subtitles` and `requested_subtitles`, which
 * say which tracks are manual and which translated.
 */
export function select(folder: string, info: Record<string, unknown> | null, cues = true): Track | null {
  const candidates: [[number, boolean, string], Track][] = [];
  for (const name of fs.readdirSync(folder)) {
    if (!name.startsWith("captions.") || !name.endsWith(".json3")) continue;
    const language = name.slice("captions.".length, -".json3".length);
    if (!english(language)) continue;
    const subtitles = (info?.subtitles ?? {}) as Record<string, unknown>;
    const manual = Array.isArray(subtitles[language]) && (subtitles[language] as unknown[]).length > 0;
    const requested = ((info?.requested_subtitles ?? {}) as Record<string, { url?: unknown }>)[language]?.url;
    const translated = typeof requested === "string" && requested.split(/[?&]/).some((part) => part.startsWith("tlang="));
    if (translated && !manual) continue;
    let value: Json3;
    try {
      value = JSON.parse(fs.readFileSync(join(folder, name), "utf8")) as Json3;
    } catch {
      continue;
    }
    if (parse(value).words.length === 0) continue;
    const timed = wordTimed(value);
    if (!timed && !cues) continue;
    const rank = language === "en-orig" && timed ? 0 : timed ? 1 : manual ? 2 : 3;
    candidates.push([[rank, language !== "en", language], { language, timed, value }]);
  }
  candidates.sort(([a], [b]) => a[0] - b[0] || Number(a[1]) - Number(b[1]) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
  return candidates[0]?.[1] ?? null;
}

/** How a turn is named when its caller doesn't say. */
const captionTurn = (turn: number): string => `caption_turn_${turn}`;

/** A json3 track as words, each ">>" opening a turn of its own (named by `named`). */
export function parse(value: Json3, named: (turn: number) => string = captionTurn): Transcript {
  const events = value.events ?? [];
  const said: [string, number, boolean, number | null][] = [];
  for (const [eventIndex, event] of events.entries()) {
    const start = event.tStartMs;
    if (typeof start !== "number" || !Number.isFinite(start) || start < 0) continue;
    const nextEvent = events.slice(eventIndex + 1).map((next) => next.tStartMs).find((at): at is number => typeof at === "number" && at > start);
    const duration = typeof event.dDurationMs === "number" && event.dDurationMs > 0 ? start + event.dDurationMs : null;
    const eventEnd = duration !== null && nextEvent !== undefined ? Math.min(duration, nextEvent) : (duration ?? nextEvent ?? null);
    const segments = event.segs ?? [];
    for (const [segmentIndex, segment] of segments.entries()) {
      const raw = (segment.utf8 ?? "").trim();
      const change = segment.isSpeakerChange === 1 || raw.startsWith(">>");
      const text = (raw.startsWith(">>") ? raw.slice(2) : raw).trim();
      const offset = segment.tOffsetMs ?? 0;
      if (!Number.isFinite(offset) || offset < 0) continue;
      const at = start + offset;
      const nextOffset = segments.slice(segmentIndex + 1).map((next) => next.tOffsetMs).find((next): next is number => typeof next === "number" && next > offset);
      const next = nextOffset === undefined ? null : start + nextOffset;
      const bound = next !== null && eventEnd !== null ? Math.min(next, eventEnd) : (next ?? eventEnd);
      const limit = bound !== null && bound > at ? bound : null;
      const pieces = text.split(/\s+/).filter((piece) => piece !== "");
      if (pieces.length === 0) {
        if (change) said.push(["", at, true, limit]);
        continue;
      }
      const total = pieces.reduce((sum, piece) => sum + spokenMs(piece), 0);
      const span = limit === null ? total : limit - at;
      let elapsed = 0;
      for (const [index, piece] of pieces.entries()) {
        said.push([piece, at + (elapsed / total) * span, change && index === 0, limit]);
        elapsed += spokenMs(piece);
      }
    }
  }
  const words: [string, number, boolean, number | null][] = [];
  let carry = false;
  let bracket = false;
  for (const [text, at, change, limit] of said) {
    const opens = text.startsWith("[");
    if (opens || bracket || text === "") {
      carry ||= change;
      bracket = (opens || bracket) && !text.endsWith("]");
      continue;
    }
    words.push([text, at, change || carry, limit]);
    carry = false;
  }
  words.sort((a, b) => a[1] - b[1]);
  let turn = 0;
  const out: Word[] = words.map(([text, at, change, limit], index) => {
    if (change || index === 0) turn++;
    const next = words[index + 1]?.[1] ?? at + 2_000;
    const end = Math.max(Math.min(at + spokenMs(text), Math.max(next, at + 1), limit ?? Infinity), at + 1);
    return { text, start: at / 1000, end: end / 1000, speaker: named(turn) };
  });
  return { model: MODEL, language: "en", words: out };
}

/**
 * The video's best English track for `use`, asked over its ways; null when
 * YouTube answered and there is none. Throws `youtube.Unanswered` when
 * YouTube answered no way: turned away is never "no captions".
 */
export async function track(home: string, id: string, use: Use, signal?: AbortSignal): Promise<Track | null> {
  const folder = join(home, "cache", "youtube-captions", `.asking-${id}-${crypto.randomUUID()}`);
  fs.mkdirSync(folder, { recursive: true });
  const tracks = () => fs.readdirSync(folder).some((name) => name.endsWith(".json3"));
  try {
    const asked = await youtube.ask(
      home,
      id,
      // The original track first, and a track YouTube refuses is passed over for the next (`--ignore-errors`): the plain
      // `en` beside an `en-orig` is a 429 more often than not (Nov 10: 16 of 22 asks), and asked first it ended the run
      // with nothing. Only what says which tracks are manual or translated is printed (the whole details are ~12 MB).
      ["--skip-download", "--no-simulate", "--no-playlist", "--ignore-errors", "--write-subs", "--write-auto-subs", "--sub-langs", "en-orig,en.*", "--sub-format", "json3", "--print", "%(.{subtitles,requested_subtitles})j", "-o", join(folder, "captions")],
      use.ways,
      // A track that came down is an answer, whatever became of the others. Ending well with none is one too (the video
      // has none), unless a track was there and refused: that's YouTube turning this way away.
      (tried) => tracks() || (tried.code === 0 && !/Unable to download video subtitles/i.test(tried.stderr)),
      { area: use.area, sparing: use.sparing, ...(signal ? { signal } : {}) },
    );
    let info: Record<string, unknown> | null = null;
    for (const line of asked.stdout.split("\n").reverse()) {
      try {
        info = JSON.parse(line) as Record<string, unknown>;
        break;
      } catch {
        // Not the info line.
      }
    }
    const chosen = select(folder, info, use.cues);
    if (chosen !== null) diag.info(use.area, `${id}: YouTube captions ${chosen.language} (${chosen.timed ? "word-timed" : "timed by the line: each word's time is estimated"})${asked.way === "proxy" ? ", through the proxy" : ""}`);
    return chosen;
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/** How long "this video has no captions" stands before YouTube is asked again (they can come a while after an upload). */
const NONE_MS = 30 * 60_000;

const flights = new Map<string, Promise<void>>();

/**
 * The video's captions as words, kept for every later reader in
 * `cache/youtube-captions/<id>/`: word-timed ones as `transcript-v1.json`,
 * ones timed by the line apart as `cues-v1.json`, so a use that cuts on a
 * word is never handed estimated times. Null when the video has none for
 * `use`; throws `youtube.Unanswered` when YouTube couldn't be asked.
 */
export async function read(home: string, id: string, use: Use, signal?: AbortSignal): Promise<Transcript | null> {
  const dir = join(home, "cache", "youtube-captions", id);
  const kept = (name: string): Transcript | null => {
    try {
      const found = JSON.parse(fs.readFileSync(join(dir, name), "utf8")) as Transcript;
      return found.model === MODEL && Array.isArray(found.words) && found.words.length > 0 ? found : null;
    } catch {
      return null;
    }
  };
  const have = () => kept("transcript-v1.json") ?? (use.cues ? kept("cues-v1.json") : null);
  const found = have();
  if (found !== null) return found;
  const none = join(dir, "unavailable.json");
  try {
    if (Date.now() - Number(fs.readFileSync(none, "utf8")) < NONE_MS) return null;
  } catch {
    // Not asked yet.
  }
  const fetch = async () => {
    // Asked for every kind of track, whatever this use takes: the next use may read the other.
    const chosen = await track(home, id, { ...use, cues: true }, signal);
    const words = chosen === null ? null : parse(chosen.value);
    fs.mkdirSync(dir, { recursive: true });
    if (words !== null && words.words.length > 0) writeAtomic(join(dir, chosen!.timed ? "transcript-v1.json" : "cues-v1.json"), serialize(words));
    if (chosen?.timed !== true) writeAtomic(none, String(Date.now()));
  };
  // One asking a video at a time; a caller that can stop its own asks alone, so stopping it stops nobody else's.
  if (signal !== undefined) await fetch();
  else {
    const key = `${home}:${id}`;
    let flight = flights.get(key);
    if (flight === undefined) {
      flight = fetch().finally(() => flights.delete(key));
      flights.set(key, flight);
    }
    await flight;
  }
  return have();
}

/** A cloud/script source, not a path guessed from a video filename. */
export function captionRange(source: string): { id: string; start: number; end: number } | null {
  const match = /^youtube:([A-Za-z0-9_-]{11})(?:#(\d+)-(\d+))?$/u.exec(source);
  if (!match) return null;
  const start = Number(match[2] ?? 0) / 1000;
  const end = match[3] === undefined ? Infinity : Number(match[3]) / 1000;
  return end > start ? { id: match[1]!, start, end } : null;
}

/** Videos YouTube wouldn't be asked about just now: an import's other excerpts of one go on to their hearing without each waiting out every way again. */
const unanswered = new Map<string, number>();

/** An import's footage (`youtube:<id>#<ms>-<ms>`) from the video's word-timed captions, on the excerpt's own clock. False means none it can use; only then should the caller pay for Scribe. */
export async function writeCaptionTranscript(home: string, source: string, target: string): Promise<boolean> {
  const range = captionRange(source);
  if (!range) return false;
  const key = `${home}:${range.id}`;
  if (Date.now() - (unanswered.get(key) ?? -Infinity) < 10 * 60_000) return false;
  let transcript: Transcript | null;
  try {
    transcript = await read(home, range.id, USES.footage);
  } catch (error) {
    unanswered.set(key, Date.now());
    diag.warn("transcribe", `${range.id}: YouTube's captions weren't read (${diag.messageOf(error)}): it's heard instead`);
    return false;
  }
  if (!transcript) return false;
  const seconds = (value: number) => Math.round(value * 1000) / 1000;
  const words = transcript.words.filter((word) => word.end > range.start && word.start < range.end)
    .map((word) => ({ ...word, start: seconds(Math.max(0, word.start - range.start)), end: seconds(Math.min(word.end, range.end) - range.start) }));
  fs.mkdirSync(parent(target) ?? ".", { recursive: true });
  writeAtomic(target, serialize({ ...transcript, words }));
  diag.info("transcribe", `${source}: ${words.length} words from YouTube captions; subject/speaker verification still follows`);
  return true;
}

/** A video's words couldn't be had: `message` says why, for the person. */
export class NoWords extends Error {}

/** Test hook: how a captionless video is heard (its sound fetched, then Apple or Scribe). */
export const hearing = { hear };

/**
 * The video's words for `use`: its captions, else (a use that hears) its
 * sound heard here. Throws `NoWords` saying which it was: the video is gone,
 * YouTube turned Edit away for now, or there are no words to be had.
 */
export async function words(home: string, id: string, use: Use, signal?: AbortSignal, onStage?: (text: string) => void): Promise<Transcript> {
  let turnedAway = false;
  try {
    const captions = await read(home, id, use, signal);
    if (captions !== null) return captions;
  } catch (error) {
    if (!(error instanceof youtube.Unanswered)) throw error;
    if (error.gone) throw new NoWords(`YouTube doesn't give this video (${error.message}).`);
    turnedAway = true;
  }
  // Heard only when YouTube answered that there are no captions: turned away, its sound would be asked of the same addresses again.
  if (use.hear && !turnedAway) {
    const heard = await hearing.hear(home, id, use, signal, onStage).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      diag.warn(use.area, `${id}: hearing it in place of captions: ${diag.messageOf(error)}`);
      return null;
    });
    if (heard !== null) return heard;
  }
  throw new NoWords(
    turnedAway
      ? `YouTube turned ${THIS_MACHINE} away just now, so the video's words weren't read: try again in a few minutes.`
      : use.hear
        ? "This video has no English captions, and nothing was heard in its sound."
        : "This video has no English captions.",
  );
}

/** The video's sound heard on this machine, kept as `heard-v1.json`; null when nothing was said in it. */
async function hear(home: string, id: string, use: Use, signal?: AbortSignal, onStage?: (text: string) => void): Promise<Transcript | null> {
  const dir = join(home, "cache", "youtube-captions", id);
  const target = join(dir, "heard-v1.json");
  const kept = (): Transcript | null => {
    try {
      const found = JSON.parse(fs.readFileSync(target, "utf8")) as Transcript;
      return Array.isArray(found.words) && found.words.length > 0 ? found : null;
    } catch {
      return null;
    }
  };
  const before = kept();
  if (before !== null) return before;
  onStage?.("No captions: fetching the video's sound");
  const folder = join(dir, "sound");
  try {
    const sound = await youtube.downloadSound(home, id, folder, use.sparing);
    signal?.throwIfAborted();
    onStage?.("No captions: hearing the video");
    // Apple's recogniser where this Mac has it; Scribe only where there's none (Linux, an older macOS), its words alone.
    if (await macSpeech.available()) await macSpeech.hear(sound.path, target, signal);
    else await transcribe.run(sound.path, target, [], false, false);
    const heard = kept();
    diag.info(use.area, `${id}: no captions; heard ${heard?.words.length ?? 0} words (${heard?.model ?? "nothing"})`);
    return heard;
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
