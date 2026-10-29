// A recording (or a stretch of it) heard by Scribe, through Edit's one
// transcription system (transcribe.ts), kept in `work/transcript.json`: one
// already there that listened for these names is used as it is.

import * as fs from "node:fs";

import { covers } from "../names.ts";
import { join } from "../paths.ts";
import { ffmpeg } from "../tools.ts";
import * as transcribe from "../transcribe.ts";
import { run } from "./proc.ts";

export type Heard = transcribe.Word;

/** A transcript kept from an actual hearing (never captions). */
export function cached(work: string): transcribe.Transcript | null {
  try {
    const found = JSON.parse(fs.readFileSync(join(work, "transcript.json"), "utf8")) as transcribe.Transcript;
    return found.model?.startsWith("scribe") && Array.isArray(found.words) ? found : null;
  } catch {
    return null;
  }
}

/** Hears `file` (its `span` in ms, or all of it) listening for `keyterms`; times in the transcript are seconds into what was heard. */
export async function hear(file: string, span: [number, number] | null, work: string, keyterms: readonly string[], signal?: AbortSignal): Promise<transcribe.Transcript> {
  fs.mkdirSync(work, { recursive: true });
  const kept = cached(work);
  if (kept !== null && covers(kept.keyterms, keyterms)) return kept;
  let source = file;
  const cut = join(work, "stretch.m4a");
  if (span !== null) {
    await run(ffmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-ss", (span[0] / 1000).toFixed(3), "-t", ((span[1] - span[0]) / 1000).toFixed(3), "-i", file, "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "96k", cut], {
      timeoutMs: 600_000,
      ...(signal ? { signal } : {}),
    }).catch((error: unknown) => {
      throw new Error(`Could not take the sound out of the footage: ${error instanceof Error ? error.message : String(error)}`);
    });
    source = cut;
  }
  try {
    await transcribe.run(source, join(work, "transcript.json"), keyterms);
  } finally {
    fs.rmSync(cut, { force: true });
  }
  const heard = cached(work);
  if (heard === null) throw new Error("Scribe's answer couldn't be read.");
  return heard;
}

/** A word as compared across hearings: lower case, letters and digits only. */
export const normal = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
