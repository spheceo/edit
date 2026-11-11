// A file's first words, free, for both modes (kept_hearing.ts has the rest):
// YouTube's word-timed captions for a YouTube video, else Apple's on-device
// recogniser on a Mac that has it (mac_speech.ts: free, ~45x real time, no
// voices, rare names its weak point). Rough: Scribe hears only the stretches
// the agent keeps. Where neither exists (Linux, an older macOS, a video
// YouTube has no word-timed captions for) the caller pays for Scribe.
//
// Script mode keeps Apple's words as `apple.json` beside each recording's
// hearing (writer/transcription.ts); Edit writes the rough words as the
// file's transcript with `heard: []` (media.ts), each word without a voice:
// Apple hears none, and captions' ">>" turns are guesses (one voice a line).

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import * as macSpeech from "./mac_speech.ts";
import { isFile, join } from "./paths.ts";
import { ffmpeg, isUrl, protocols, urlArgs } from "./tools.ts";
import { serialize, type Transcript } from "./transcribe.ts";
import { captionRange, writeCaptionTranscript } from "./youtube_words.ts";

/** Where Apple's words of a recording are kept, apart from a paid hearing. */
const APPLE = "apple.json";

/** Files at most this long are heard by Scribe straight away (Edit): a first pass would save at most a cent and cost a second hearing's voices. */
export const FIRST_PASS_FROM_S = 300;

/** Apple's words heard before. */
export function appleCached(work: string): Transcript | null {
  try {
    const found = JSON.parse(fs.readFileSync(join(work, APPLE), "utf8")) as Transcript;
    return found.model === macSpeech.MODEL && Array.isArray(found.words) && found.words.length > 0 ? found : null;
  } catch {
    return null;
  }
}

/**
 * The import's stage line for what Apple's recogniser says it's doing
 * (mac_speech.ts `hear`'s progress), or null for what needs no line. Its
 * en-US model is downloaded once a Mac on first use, about a minute: said
 * as such, so the first import on a Mac isn't a transcription that looks stuck.
 */
export function appleStage(said: string): string | null {
  if (said === "downloading the en-US model") return "Downloading Apple's speech model, once for this Mac.";
  const percent = /^model (\d+)%$/u.exec(said);
  if (percent !== null) return `Downloading Apple's speech model, once for this Mac: ${percent[1]}%.`;
  if (said === "model installed") return "Transcribing.";
  return null;
}

/**
 * A recording (or its `span` of the footage, in ms) heard by Apple on this
 * Mac, kept in `work`; null where there's no Apple recogniser or it heard
 * nothing (then Scribe hears it). A cloud proxy's sound is read through its
 * URL first. `onStage` is told what the person should see meanwhile.
 */
export async function appleHear(file: string, span: [number, number] | null, work: string, signal?: AbortSignal, onStage?: (text: string) => void): Promise<Transcript | null> {
  const kept = appleCached(work);
  if (kept !== null) return kept;
  if (!(await macSpeech.available()) || (!isFile(file) && !isUrl(file))) return null;
  fs.mkdirSync(work, { recursive: true });
  const cut = join(work, "apple-stretch.m4a");
  try {
    let source = file;
    if (span !== null || isUrl(file)) {
      const range = span === null ? [] : ["-ss", (span[0] / 1000).toFixed(3), "-t", ((span[1] - span[0]) / 1000).toFixed(3)];
      const remote = isUrl(file) ? ["-protocol_whitelist", protocols(file), ...urlArgs(file)] : [];
      const child = Bun.spawn([ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...remote, ...range, "-i", file, "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "96k", cut], { stdout: "ignore", stderr: "pipe", ...(signal ? { signal } : {}) });
      const stderr = await new Response(child.stderr).text();
      if ((await child.exited) !== 0) throw new Error(`could not take the sound out of the footage: ${diag.gist(stderr)}`);
      source = cut;
    }
    const heard = await macSpeech.hear(source, join(work, APPLE), signal, (said) => {
      const text = appleStage(said);
      if (text !== null) onStage?.(text);
    });
    if (heard.words.length === 0) return null;
    writeAtomic(join(work, APPLE), JSON.stringify({ ...heard, model: macSpeech.MODEL }));
    return appleCached(work);
  } catch (error) {
    if (signal?.aborted) throw error;
    diag.warn("transcribe", `${file}: Apple's recogniser didn't hear it (${diag.messageOf(error)}); Scribe hears it`);
    return null;
  } finally {
    fs.rmSync(cut, { force: true });
  }
}

/**
 * An Edit file's first words, written to `target` as its transcript (rough,
 * `heard: []`): a YouTube video's word-timed captions on the excerpt's own
 * clock (`cloud`, `youtube:<id>#<ms>-<ms>`), else Apple's. False when there's
 * no free hearing for it: the caller pays for Scribe.
 */
export async function firstWords(home: string, cloud: string | null, input: string, target: string, work: string, signal?: AbortSignal): Promise<boolean> {
  let words: Transcript | null = null;
  if (cloud !== null && captionRange(cloud) !== null && (await writeCaptionTranscript(home, cloud, target))) {
    try {
      words = JSON.parse(fs.readFileSync(target, "utf8")) as Transcript;
    } catch {
      words = null;
    }
  }
  words ??= await appleHear(input, null, work, signal);
  if (words === null || words.words.length === 0) {
    fs.rmSync(target, { force: true });
    return false;
  }
  const rough: Transcript = { model: words.model, language: words.language ?? null, words: words.words.map(({ text, start, end }) => ({ text, start, end })), heard: [] };
  writeAtomic(target, serialize(rough));
  fs.rmSync(join(work, APPLE), { force: true });
  diag.info("transcribe", `${input}: ${rough.words.length} free first words (${rough.model}); Scribe hears only what's kept`);
  return true;
}
