// A recording (or a stretch of it) heard by Scribe, through Edit's one
// transcription system (transcribe.ts), kept in `work/transcript.json`: one
// already there that listened for these names is used as it is.
//
// In Effect since Nov 1 (docs/plans/2026-11-01-effect.md, round 2, area 1):
// the stretch is cut by an FFmpeg and into a file the hearing's scope owns,
// so a stop, a failure or a deadline ends the FFmpeg and removes the file,
// and the hearing's failures are transcribe.ts's typed ones, which the
// import's Try again reads (`kindOf`).

import * as fs from "node:fs";

import { Effect, Schema } from "effect";

import { runPromise } from "../effect/runtime.ts";
import * as service from "../effect/service.ts";
import { covers } from "../names.ts";
import { join } from "../paths.ts";
import { ffmpeg } from "../tools.ts";
import * as transcribe from "../transcribe.ts";
import { runProgram, STOPPED } from "./proc.ts";

export type Heard = transcribe.Word;

/** FFmpeg couldn't take the stretch's sound out of the footage. */
export class StretchUncut extends Schema.TaggedError<StretchUncut>()("StretchUncut", { message: Schema.String }) {}

service.kinds({ StretchUncut: "permanent" });

/** A cut of the sound may take this long. */
const CUT_MS = 600_000;

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
export const hearing = Effect.fn("writer.hear")(function* (file: string, span: [number, number] | null, work: string, keyterms: readonly string[]) {
  fs.mkdirSync(work, { recursive: true });
  const kept = cached(work);
  if (kept !== null && covers(kept.keyterms, keyterms)) return kept;
  yield* Effect.gen(function* () {
    let source = file;
    if (span !== null) {
      const cut = yield* Effect.acquireRelease(Effect.succeed(join(work, "stretch.m4a")), (path) => Effect.sync(() => fs.rmSync(path, { force: true })));
      yield* runProgram(
        ffmpeg(),
        ["-hide_banner", "-loglevel", "error", "-y", "-ss", (span[0] / 1000).toFixed(3), "-t", ((span[1] - span[0]) / 1000).toFixed(3), "-i", file, "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "96k", cut],
        { timeoutMs: CUT_MS },
      ).pipe(Effect.mapError((error) => new StretchUncut({ message: `Could not take the sound out of the footage: ${error.message}` })));
      source = cut;
    }
    yield* transcribe.transcribeFile(source, join(work, "transcript.json"), keyterms);
  }).pipe(Effect.scoped);
  const heard = cached(work);
  if (heard === null) return yield* new transcribe.AnswerUnreadable({ message: "Scribe's answer couldn't be read." });
  return heard;
});

/** `hearing` for code that isn't Effect yet; a stop (`signal`) ends its FFmpeg and its request and says so. */
export function hear(file: string, span: [number, number] | null, work: string, keyterms: readonly string[], signal?: AbortSignal): Promise<transcribe.Transcript> {
  if (signal?.aborted) return Promise.reject(new Error(STOPPED));
  return runPromise(transcribe.asConfigured(hearing(file, span, work, keyterms)), signal ? { signal } : undefined).catch((error: unknown) => {
    if (signal?.aborted) throw new Error(STOPPED);
    throw error;
  });
}

/** A word as compared across hearings: lower case, letters and digits only. */
export const normal = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
