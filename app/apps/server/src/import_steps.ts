// The script import's footage pipeline rules, in one place (Nov 8 audit,
// item F): how long each step may take, what a failure means, and when Edit
// tries again by itself. The disk import and the cloud import differ only by
// where the original is (script.ts `footageToDisk` / `footageToCloud`); both
// read these.
//
// Every step is bounded. A hung FFmpeg, an addon encode that never answered
// or a relay copy polled for ever used to keep the import RUNNING with nothing
// moving, which is exactly what blocked Retry, another link and skip. Now a
// step past its time lands its file in `failed` with a passing reason, so the
// person's Retry works and Edit tries it again by itself.
//
// What a failure is, in four words (`whyOf`), read from the error's class
// first and its words only for text from outside Edit (Drive's pages, yt-dlp):
// - passing: may go if tried again (a dropped connection, a busy Google, a
//   step past its time). Edit tries again by itself (`RETRY_WAITS`), then the
//   person may Retry.
// - person: only the person can fix it (a file nobody shared, a private
//   video): another link, or go on without it.
// - quota: the transcription plan is out of credit, or the relay's allowance
//   is used up. Not an error to retry by hand: the file waits, tried again
//   every `QUOTA_RETRY_MS`, and the report's "Needs attention" says so once.
// - encoder: an encode ran out of time while an export or another encode held
//   the hardware encoder (encoder.ts). It waits until the encoder is free.

import * as diag from "./diag.ts";
import * as encoder from "./encoder.ts";

/** How long each step may take before it's taken as stuck (ms). */
export const LIMITS = {
  /** ffprobe of a file or a presigned URL: its length, its keyframes (a few range reads). */
  probe: 2 * 60_000,
  /** Cutting an excerpt (picture copied, sound encoded) over the network: a base plus a second per second cut. */
  cut: (seconds: number) => 10 * 60_000 + Math.max(seconds, 0) * 1000,
  /** A proxy encode (~200 fps at 1080p on the M1; slower from R2, slower still beside an export): a base plus two seconds per second of footage. */
  proxy: (seconds: number) => 15 * 60_000 + Math.max(seconds, 0) * 2000,
  /** The relay's Drive-to-R2 copy in all: a base plus the file at 2 MB/s (its own stall rule ends a copy standing still sooner). */
  relayCopy: (bytes: number | null) => 30 * 60_000 + Math.max(bytes ?? 0, 0) / 2_000,
  /** The relay not answering about its copy for this long counts as the copy standing still. */
  relayUnreachable: 10 * 60_000,
  /** The voice-over: every cut-in spoken and split across them. */
  voiceover: 30 * 60_000,
  /** The wait for the footage's words before the edit is laid out without them (transcription carries on). */
  transcript: 30 * 60_000,
};

/** The pauses before Edit tries a passing failure again by itself (tests make them instant). */
export const RETRY_WAITS = { value: [60_000, 5 * 60_000] };
/** A file waiting on the transcription plan's credit is tried again this often. */
export const QUOTA_RETRY_MS = { value: 30 * 60_000 };

export type Why = "passing" | "person" | "quota" | "encoder";

/** A failure only the person can fix: another link, or go on without it. */
export class NeedsPerson extends Error {
  override readonly name = "NeedsPerson";
}

/** A step past its time; `shared` when the hardware encoder was someone else's too when it ran out. */
export class StepTimedOut extends Error {
  override readonly name = "StepTimedOut";
  constructor(
    readonly what: string,
    readonly afterMs: number,
    readonly shared: boolean,
  ) {
    super(`${what} took more than ${minutes(afterMs)} and was stopped${shared ? " (the hardware encoder was busy with other work)" : ""}`);
  }
}

function minutes(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

/** The transcription plan or the relay's allowance, in its own words (ElevenLabs' 401: "exceeds your quota … credits remaining"). */
const QUOTA = /exceeds your quota|credits remaining|quota_exceeded|insufficient.credits|transcription failed \(429\)|\ballowance\b|rate.limit/i;
/** Text from outside Edit that only the person can answer (Drive's pages; posts; older builds' words kept in a job). */
const PERSON = /isn't shared|can't find this file|deleted, or in the trash|Private video|This video is private|confirm your age|age.restricted|members.only|Join this channel|not available in your country|blocked it in your country|Video unavailable|has been removed|has been terminated|no longer available|download limit for this file|isn't a Drive file|isn't a YouTube video|has no bytes|A shared folder master|is not uploaded yet|pictures only, with no video|only shown to someone signed in/i;

function tagOf(error: unknown): string | null {
  const tag = (error as { _tag?: unknown } | null)?._tag;
  return typeof tag === "string" ? tag : null;
}

/** What a failure means for the import (see the module notes); a job's saved words are read the same way. */
export function whyOf(error: unknown): Why {
  for (let at: unknown = error, depth = 0; at !== undefined && at !== null && depth < 4; at = (at as { cause?: unknown }).cause, depth++) {
    if (at instanceof NeedsPerson) return "person";
    if (at instanceof StepTimedOut) return at.shared ? "encoder" : "passing";
    const tag = tagOf(at);
    if (tag === "AllowanceUsedUp") return "quota";
    if (tag === "DownloadFailed") {
      const reason = (at as { reason?: unknown }).reason;
      if (reason === "VideoGone" || reason === "NeedsSignIn") return "person";
    }
  }
  const words = typeof error === "string" ? error : diag.messageOf(error);
  if (QUOTA.test(words)) return "quota";
  if (PERSON.test(words)) return "person";
  return "passing";
}

/** Whether Edit may try it again by itself, or Retry may help: anything but the person's. */
export function passing(error: unknown): boolean {
  return whyOf(error) !== "person";
}

/** When a failure of this kind is tried again by itself (ms since the epoch), or null (the person's, or at once). */
export function retryAt(why: Why, now: number): number | null {
  return why === "quota" ? now + QUOTA_RETRY_MS.value : null;
}

/**
 * Runs `work` within `ms`: past it, `work`'s signal is aborted (an FFmpeg
 * given it is ended) and the step fails with `StepTimedOut`, saying whether
 * the encoder was someone else's at the time (`self`: the step's own hold).
 * Work that can't be stopped (the addon's encode) is left to finish, its
 * answer ignored.
 */
export async function bounded<T>(what: string, ms: number, work: (signal: AbortSignal) => Promise<T>, self?: number): Promise<T> {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const shared = encoder.shared(self);
      stop.abort();
      reject(new StepTimedOut(what, ms, shared));
    }, ms);
  });
  try {
    return await Promise.race([work(stop.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** An encode from here: held on the encoder while it runs and bounded by `ms`, contention said if it runs out. */
export async function encoding<T>(what: string, ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const hold = encoder.hold(what);
  try {
    return await bounded(what, ms, work, hold.token);
  } finally {
    hold.release();
  }
}
