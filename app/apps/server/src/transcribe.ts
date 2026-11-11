// Transcription through Edit's relay (apps/relay/), which holds the ElevenLabs
// key. Edit sends small mono Opus audio and keeps Scribe's words, cached per
// source file so the same footage is never paid for twice.
//
// Every transcript in Edit comes from here (media.ts's `transcribe`), so this
// is the one transcription system: Scribe v3 hears a file once, whole, for
// its words, their times and who speaks (Sphe, Nov 10: one transcriber, not
// Scribe and pyannote). Scribe v2 had placed words late on a long file (a
// line at 5:50 of a 25-minute bodycam came out 26 s late), so until Nov 10 a
// long file was heard twice: in 40-second pieces for its words and whole for
// its voices. v3 doesn't drift: on Nov 10's bench (five recordings, 27 to 112
// minutes, ~/.edit-dev/bench-scribe-v3) a file heard whole put 0.15–0.6% of
// its words more than half a second from where 10-minute pieces put them,
// and 0.7% against 40-second pieces, and its voices held from start to end.
// Then cameras.ts splits a voice heard on two bodycams (two officers Scribe
// heard as one), and speakers.ts names the voices. While the relay's flag is
// on, pyannote's voices are laid over Scribe's (voices.ts, from media.ts);
// it's off from Nov 10, kept to turn back on if speakers get worse.
//
// A file longer than `ByLinkFrom` goes by link (`jobHearing`): no connection
// held open while Scribe works. A file longer than Scribe hears in one go
// (`Longest`, 9½ hours) is heard in parts that long at most, joined where
// both heard the same word (`join`); each part's voices are its own.
//
// What's heard is kept as it comes in (`saved`), so a run cut short (the
// day's allowance, a restart) never pays for it again.
//
// In Effect since Nov 1 (docs/plans/2026-11-01-effect.md, part 1). Every way
// the relay can answer is its own error, and whether it's asked again is the
// retry policy's (`Retries`), not an `if` in a loop: the busy relay, the
// gateway and a dropped connection are asked again; the day's allowance, a
// refusal and a request too big for the relay are not, since asking again
// gets the same answer. Sent in one request, a file is encoded to fit the
// relay's limit (`wholeBitrate`): at 32 kbps, a recording over ~3 h 7 min was
// refused with a 413 every time (Nov 1, Mathias's FOIA interviews of 4 h 39
// min and 5 h 1 min).

import * as fs from "node:fs";

import { Cause, Clock, Context, Duration, Effect, Option, Predicate, Schedule, Schema } from "effect";

import * as cameras from "./cameras.ts";
import * as diag from "./diag.ts";
import * as proc from "./effect/proc.ts";
import { inArea, runPromise } from "./effect/runtime.ts";
import * as service from "./effect/service.ts";
import { ioMessage, writeAtomic } from "./files.ts";
import { fileName, withExtension } from "./paths.ts";
import * as paidWork from "./paid.ts";
import * as relay from "./relay.ts";
import { serdeParse } from "./rust.ts";
import * as tools from "./tools.ts";

/** One spoken word. Times are seconds into the source. */
export interface Word {
  text: string;
  start: number;
  end: number;
  /** Scribe's voice number, if it heard more than one person. */
  speaker?: string;
}

/** The model every hearing is made with (the relay asks Scribe for it). */
export const MODEL = "scribe_v3";

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
  /**
   * Whose voices these are when they aren't Scribe's: "pyannote-precision-3"
   * (voices.ts), so a transcript is given pyannote's voices once.
   */
  voices?: string;
  /**
   * The stretches (seconds) Scribe heard, when it heard only those: a
   * script's chosen footage, heard in Script mode (writer/exact.ts) and
   * handed to Edit (writer/handoff.ts), the rest of the file unheard and
   * without words. Absent: the whole file was heard.
   */
  heard?: [number, number][];
}

/** How far a use may reach past what was heard (seconds) and still be taken as heard: a cut's word boundary moved. */
const HEARD_SLACK = 0.25;

/**
 * Whether `transcript` has Scribe's words for every range (seconds) in
 * `uses`: always for a file heard whole; a script's stretches only where
 * the uses stay inside them.
 */
export function hearsAll(transcript: Pick<Transcript, "heard">, uses: readonly (readonly [number, number])[]): boolean {
  if (transcript.heard === undefined) return true;
  // Stretches that touch are one: a use may run across both.
  const heard: [number, number][] = [];
  for (const [a, b] of [...transcript.heard].sort((x, y) => x[0] - y[0])) {
    const last = heard.at(-1);
    if (last !== undefined && a <= last[1] + HEARD_SLACK) last[1] = Math.max(last[1], b);
    else heard.push([a, b]);
  }
  return uses.every(([from, to]) => to - from <= 2 * HEARD_SLACK || heard.some(([a, b]) => from >= a - HEARD_SLACK && to <= b + HEARD_SLACK));
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
  if (typeof transcript.voices === "string" && transcript.voices !== "") text += `,"voices":${JSON.stringify(transcript.voices)}`;
  if (Array.isArray(transcript.heard)) text += `,"heard":${JSON.stringify(transcript.heard)}`;
  return `${text}}`;
}

// ── How the relay can answer ────────────────────────────────────────────────

/** The relay or Scribe is busy (a 429 that isn't the day's allowance): asked again. */
export class RelayBusy extends Schema.TaggedError<RelayBusy>()("RelayBusy", { message: Schema.String }) {}

/** Cloudflare's gateway answered instead of the relay (502, 503, 504, 520, 522, 524): asked again. */
export class GatewayDown extends Schema.TaggedError<GatewayDown>()("GatewayDown", { status: Schema.Number, message: Schema.String }) {}

/** The relay couldn't be reached (the connection dropped, no network): asked again, as the gateway is. */
export class RelayUnreachable extends Schema.TaggedError<RelayUnreachable>()("RelayUnreachable", { message: Schema.String }) {}

/** The relay didn't answer within `RequestTimeoutMs`: the request is abandoned and asked again, as the gateway is. */
export class RelayTimedOut extends Schema.TaggedError<RelayTimedOut>()("RelayTimedOut", { message: Schema.String }) {}

/** The day's transcription allowance is used up: asking again only waits for the same answer. */
export class AllowanceUsedUp extends Schema.TaggedError<AllowanceUsedUp>()("AllowanceUsedUp", { message: Schema.String }) {}

/** More audio than the relay takes in one request (a 413, or found too big before sending): never asked again as it is. */
export class TooLongForOneRequest extends Schema.TaggedError<TooLongForOneRequest>()("TooLongForOneRequest", {
  bytes: Schema.Number,
  message: Schema.String,
}) {}

/** Scribe refused the case's names (a 400 or 422 with names: nothing heard or billed); asked once without them. */
export class NamesRefused extends Schema.TaggedError<NamesRefused>()("NamesRefused", { status: Schema.Number, message: Schema.String }) {}

/** Any other answer that isn't words (a quota, a refusal): not asked again. */
export class TranscriptionRefused extends Schema.TaggedError<TranscriptionRefused>()("TranscriptionRefused", {
  status: Schema.Number,
  message: Schema.String,
}) {}

/** The relay answered 200 with something that isn't Scribe's words. */
export class AnswerUnreadable extends Schema.TaggedError<AnswerUnreadable>()("AnswerUnreadable", { message: Schema.String }) {}

/** FFmpeg couldn't make the audio to send (no sound in the file, a damaged file). */
export class AudioUnreadable extends Schema.TaggedError<AudioUnreadable>()("AudioUnreadable", { message: Schema.String }) {}

/** The transcript couldn't be written (a full disk, a folder gone). */
export class TranscriptUnwritable extends Schema.TaggedError<TranscriptUnwritable>()("TranscriptUnwritable", { message: Schema.String }) {}

/** The relay can't hear a recording by link (an older relay, or not set up there): sent in one request instead. */
export class JobsUnavailable extends Schema.TaggedError<JobsUnavailable>()("JobsUnavailable", { message: Schema.String }) {}

/** Scribe said a recording heard by link failed. */
export class JobFailed extends Schema.TaggedError<JobFailed>()("JobFailed", { message: Schema.String }) {}

/** Every way asking the relay can fail. */
export type AskError = RelayBusy | GatewayDown | RelayUnreachable | RelayTimedOut | AllowanceUsedUp | TooLongForOneRequest | NamesRefused | TranscriptionRefused | AnswerUnreadable;
/** And hearing one by link. */
export type JobError = AskError | JobsUnavailable | JobFailed;

/** Every way hearing a file can fail. */
export type TranscribeError = Exclude<AskError, NamesRefused> | AudioUnreadable | TranscriptUnwritable;

/** Whether asking again, later, could answer differently (what Retry should be offered for). */
export const retryable = (error: { readonly _tag: string }): boolean => service.isTemporary(error);

// Each failure's kind (effect/service.ts): what Edit asks again by itself, what Try again is offered for.
service.kinds({
  RelayBusy: "temporary",
  GatewayDown: "temporary",
  RelayUnreachable: "temporary",
  RelayTimedOut: "temporary",
  // The day's allowance comes back tomorrow; a quota or a sign-in is a person's to change.
  AllowanceUsedUp: "later",
  TooLongForOneRequest: "permanent",
  NamesRefused: "permanent",
  TranscriptionRefused: (error) => service.kindOfStatus(Predicate.hasProperty(error, "status") && typeof error.status === "number" ? error.status : 400),
  AnswerUnreadable: "permanent",
  AudioUnreadable: "permanent",
  TranscriptUnwritable: "later",
  JobsUnavailable: "permanent",
  // Scribe failing one hearing: another try may hear it.
  JobFailed: "temporary",
});

// ── When to ask again ───────────────────────────────────────────────────────

export interface RetryPolicy {
  /** A busy relay (429): 15, 30, then 60 s, six times in all. */
  readonly busy: Schedule.Schedule<Duration.Duration>;
  /**
   * The gateway or the connection: after 20 and 60 s. Oct 30, one 524 on one
   * request stopped a 6.7-hour import after every other recording was heard.
   * The request may have been billed; asking again costs its hearing once
   * more, far less than an import stopped for it.
   */
  readonly gateway: Schedule.Schedule<Duration.Duration>;
}

const capped = (base: Duration.Input, factor: number, cap: Duration.Input, times: number): Schedule.Schedule<Duration.Duration> =>
  Schedule.exponential(base, factor).pipe(
    Schedule.modifyDelay((meta) => Effect.succeed(Duration.min(meta.duration, Duration.fromInputUnsafe(cap)))),
    Schedule.upTo({ times }),
  );

/** When transcription asks again; tests provide `Retries.instant`'s. */
export class Retries extends Context.Reference<RetryPolicy>("edit/transcribe/Retries", {
  defaultValue: () => ({ busy: capped("15 seconds", 2, "60 seconds", 6), gateway: capped("20 seconds", 3, "60 seconds", 2) }),
}) {
  /** The same number of tries, without the waits. */
  static readonly instant: RetryPolicy = { busy: capped(0, 1, 0, 6), gateway: capped(0, 1, 0, 2) };
}

/** The Promise side's switch for tests that call `run`: no waits between tries. */
export const timing = { instant: false };

// ── What's sent ─────────────────────────────────────────────────────────────

/** Seconds heard either side of a part of a very long file, so a word across its edge is heard whole by one of them. */
export const CONTEXT = 4;
/** The longest Scribe hears in one hearing (it takes up to 10 h); a longer file is heard in parts this long at most. Tests make it short. */
export const Longest = Context.Reference<number>("edit/transcribe/Longest", { defaultValue: () => 9.5 * 3600 });
/** Parts of a very long file heard at once. */
const PARTS_AT_ONCE = 2;

/** The most the relay takes in one request: its `MAX_UPLOAD_BYTES` (apps/relay/wrangler.toml; a test keeps the two the same). */
export const RELAY_MAX_BYTES = 45_000_000;
/** The relay's limit as the hearing reads it: `RELAY_MAX_BYTES`, or a test's smaller one so a short file takes the long file's road. */
export const RelayMaxBytes = Context.Reference<number>("edit/transcribe/RelayMaxBytes", { defaultValue: () => RELAY_MAX_BYTES });
/** The audio sent, normally (Opus, mono, 16 kHz): ~14.4 MB an hour. */
const KBPS = 32;
/** The least a file sent in one request is sent at: still clear speech for telling voices apart. */
const MIN_WHOLE_KBPS = 8;
/** Room left under the limit for Opus going over its target rate and the Ogg pages around it. */
const HEADROOM = 0.85;

/**
 * The rate a file of `seconds` is sent at so it fits in one request:
 * 32 kbps up to ~2 h 39 min, less for longer files, down to 8 kbps (~10 h 38
 * min); null for a file too long even for that.
 */
export function wholeBitrate(seconds: number, maxBytes: number = RELAY_MAX_BYTES): number | null {
  const fits = Math.floor((maxBytes * HEADROOM * 8) / Math.max(seconds, 1) / 1000);
  if (fits < MIN_WHOLE_KBPS) return null;
  return Math.min(KBPS, fits);
}

const hours = (seconds: number) => {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
};

/** Mono 16 kHz Opus at `kbps` of what `input` (FFmpeg's input arguments) names, into `out`; nothing left at `out` when it fails. */
const encode = Effect.fn("transcribe.encode")(function* (input: readonly string[], out: string, failure: string, kbps: number = KBPS) {
  yield* proc
    .run(tools.ffmpeg(), ["-hide_banner", "-loglevel", "error", "-y", ...input, "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", `${kbps}k`, "-application", "voip", out], { stdout: "ignore" })
    .pipe(
      Effect.mapError((error) => new AudioUnreadable({ message: `${failure}: ${diag.gist(error._tag === "ProcessFailed" ? error.stderr : error.message)}` })),
      Effect.onError(() => Effect.sync(() => fs.rmSync(out, { force: true }))),
    );
});

/** How long an audio file is, in seconds (0 when FFprobe can't say: heard whole). */
const lengthOf = Effect.fn("transcribe.lengthOf")(function* (audio: string) {
  const probed = yield* proc.output(tools.ffprobe(), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audio]).pipe(Effect.option);
  const seconds = Option.match(probed, { onNone: () => Number.NaN, onSome: (done) => Number.parseFloat(done.stdout.trim()) });
  return Number.isFinite(seconds) ? seconds : 0;
});

/** A file that's removed when the scope it was made in closes, whatever happened. */
const temporary = (path: string) => Effect.acquireRelease(Effect.succeed(path), () => Effect.sync(() => fs.rmSync(path, { force: true })));

// ── Asking the relay ────────────────────────────────────────────────────────

const GATEWAY = new Set([502, 503, 504, 520, 522, 524]);

/** What the relay said went wrong: its `error`, Scribe's `detail.message`, else the body. */
function said(body: string): string {
  let value: unknown = null;
  try {
    value = serdeParse(body);
  } catch {
    value = null;
  }
  const object = (typeof value === "object" && value !== null ? value : {}) as { error?: unknown; detail?: { message?: unknown } };
  return typeof object.error === "string" ? object.error : typeof object.detail?.message === "string" ? object.detail.message : body.trim();
}

/** How long one request may take before it's abandoned and asked again (tests make it short). */
export const RequestTimeoutMs = Context.Reference<number>("edit/transcribe/RequestTimeoutMs", { defaultValue: () => 30 * 60_000 });

/**
 * Scribe's answer as the relay passes it on: its words (spacing and sound
 * events among them, `parseScribe` keeps the words) and the language. Read
 * through this, an answer that isn't Scribe's is `AnswerUnreadable` at once,
 * never a transcript of nothing.
 */
const ScribeAnswer = Schema.Struct({
  language_code: Schema.optional(Schema.NullOr(Schema.String)),
  words: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optional(Schema.NullOr(Schema.String)),
      start: Schema.optional(Schema.NullOr(Schema.Number)),
      end: Schema.optional(Schema.NullOr(Schema.Number)),
      speaker_id: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

/** One request: `audio` with the names to listen for. */
const askOnce = Effect.fn("transcribe.askOnce")(function* (audio: string, names: readonly string[], again: boolean) {
  const query = [...names.map((name) => `keyterm=${encodeURIComponent(name)}`), ...(again ? ["again=1"] : [])].join("&");
  const timeout = yield* RequestTimeoutMs;
  const answer = yield* service
    .request("the transcription relay", `${relay.url()}/v1/transcribe${query === "" ? "" : `?${query}`}`, { method: "POST", headers: { ...relay.authHeaders(), "content-type": "audio/ogg" }, body: Bun.file(audio) }, timeout)
    .pipe(
      Effect.catchTags({
        ServiceUnreachable: (error) => Effect.fail(new RelayUnreachable({ message: error.message })),
        ServiceTimedOut: (error) => Effect.fail(new RelayTimedOut({ message: error.message })),
      }),
    );
  const status = answer.status;
  const body = answer.text();
  if (status === 200) {
    const decoded = yield* service.decodeJson("Scribe", ScribeAnswer, body).pipe(Effect.mapError((error) => new AnswerUnreadable({ message: error.message })));
    return parseScribe(decoded);
  }
  return yield* refusalOf(status, body, Bun.file(audio).size, names.length > 0);
});

/** What a status that isn't an answer means, as a typed failure. */
function refusalOf(status: number, body: string, bytes: number, withNames: boolean): Effect.Effect<never, AskError> {
  const message = `transcription failed (${status}): ${said(body)}`;
  if ((status === 400 || status === 422) && withNames) return Effect.fail(new NamesRefused({ status, message: `${status}: ${body.trim().slice(0, 200)}` }));
  if (GATEWAY.has(status)) return Effect.fail(new GatewayDown({ status, message }));
  if (status === 429) return Effect.fail(/allowance/i.test(body) ? new AllowanceUsedUp({ message }) : new RelayBusy({ message }));
  if (status === 413) return Effect.fail(new TooLongForOneRequest({ bytes, message }));
  return Effect.fail(new TranscriptionRefused({ status, message }));
}

/** `audio` heard with the case's names (`keyterms`), asked again as `Retries` says; names Scribe refuses are dropped and it's asked once without them. */
const ask = Effect.fn("transcribe.ask")(function* (audio: string, keyterms: readonly string[], again: boolean) {
  const policy = yield* Retries;
  // Each schedule says which failures it's for (`while`) before it says it's
  // asking again (`tap`), so only a failure that is asked again is logged as one.
  const busy = policy.busy.pipe(
    Schedule.setInputType<AskError>(),
    Schedule.while(({ input }) => input._tag === "RelayBusy"),
    Schedule.tap((meta) => Effect.logWarning(`transcription busy (429): asking again in ${Math.round(Duration.toSeconds(meta.duration))} s`)),
  );
  const gateway = policy.gateway.pipe(
    Schedule.setInputType<AskError>(),
    Schedule.while(({ input }) => input._tag === "GatewayDown" || input._tag === "RelayUnreachable" || input._tag === "RelayTimedOut"),
    Schedule.tap((meta) =>
      Effect.logWarning(
        meta.input._tag === "GatewayDown"
          ? `transcription answered ${meta.input.status} at the gateway: asking again in ${Math.round(Duration.toSeconds(meta.duration))} s`
          : `${meta.input.message}: asking again in ${Math.round(Duration.toSeconds(meta.duration))} s`,
      ),
    ),
  );
  const hear = (names: readonly string[]) =>
    askOnce(audio, names, again).pipe(Effect.retry(busy), Effect.retry(gateway));
  return yield* hear(keyterms).pipe(
    Effect.catchTag("NamesRefused", (refused) =>
      Effect.logWarning(`transcription refused the case's names (${refused.message}); asking without them`).pipe(
        Effect.andThen(hear([])),
        // Without names a 400 or 422 can't be about them: it's a refusal like any other.
        Effect.catchTag("NamesRefused", (again) => Effect.fail(new TranscriptionRefused({ status: again.status, message: `transcription failed (${again.message})` }))),
      ),
    ),
  );
});

/**
 * What `hear` answers, kept in `file` once heard (with `tag`: what it must
 * match to be used again, the audio's length for the whole file), so a later
 * run reads it rather than paying for it again.
 */
const saved = <E, R>(file: string, tag: string, hear: Effect.Effect<Transcript, E, R>): Effect.Effect<Transcript, E, R> =>
  Effect.gen(function* () {
    const kept = yield* Effect.sync(() => {
      try {
        const found = JSON.parse(fs.readFileSync(file, "utf8")) as { tag?: unknown; transcript?: Transcript };
        return found.tag === tag && found.transcript !== undefined && Array.isArray(found.transcript.words) ? found.transcript : null;
      } catch {
        // Not heard yet.
        return null;
      }
    });
    if (kept !== null) return kept;
    // Paid from the moment it's sent until it's kept: a restart Edit makes itself waits for it (paid.ts).
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.promise(() => paidWork.enter()), () => Effect.sync(() => paidWork.leave()));
        const transcript = yield* hear;
        yield* Effect.try(() => {
          fs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
          writeAtomic(file, JSON.stringify({ tag, transcript }));
        }).pipe(Effect.catch((error) => Effect.logWarning(`keeping what was heard in ${file}: ${ioMessage(error.cause)}`)));
        return transcript;
      }),
    );
  });

// ── Heard by link ───────────────────────────────────────────────────────────
//
// A long recording heard as a job on the relay (apps/relay/src/
// transcribe_jobs.ts): the audio put in R2, Scribe fetching it itself and the
// result asked for on a schedule, so no connection is held open while Scribe
// works (Nov 1: Mathias's 6 h 20 min and 7 h 43 min recordings, sent whole,
// lost their connection three times each and both imports stopped). It's sent
// at the usual rate (no 45 MB cap), so voices are told apart as well as in a
// short file. The job is kept beside the transcript, so an import a restart
// cut off asks for the same job again instead of paying for a new one.

export interface JobsService {
  /** Puts the recording at `path` in R2 at `key`. */
  readonly upload: (path: string, key: string) => Effect.Effect<void, RelayUnreachable>;
  /** Files longer than this (seconds) are heard by link; shorter ones in one request, which answers sooner. */
  readonly longerThan: number;
  /** How often the result is asked for. */
  readonly pollEvery: Duration.Input;
  /** How long a job may take before it's given up (Scribe takes up to 10 h of audio). */
  readonly deadline: Duration.Input;
}

/** How a recording is heard by link; tests give their own. */
export class Jobs extends Context.Reference<JobsService>("edit/transcribe/Jobs", {
  defaultValue: () => ({
    upload: (path, key) =>
      Effect.tryPromise({
        try: async () => (await import("./cloud.ts")).uploadFile(path, key),
        catch: (error) => new RelayUnreachable({ message: `putting the recording in the cloud: ${diag.messageOf(error)}` }),
      }),
    longerThan: 20 * 60,
    pollEvery: "15 seconds",
    deadline: "4 hours",
  }),
}) {}

/** A job as kept beside the transcript: Scribe's ids, the audio's key, the file's length it's for and when it began. */
const KeptJob = Schema.Struct({ id: Schema.String, request: Schema.String, key: Schema.String, tag: Schema.String, at: Schema.Number });
type KeptJob = typeof KeptJob.Type;
const JobStarted = Schema.Struct({ id: Schema.String, request: Schema.String });
/** A job older than this isn't asked about again: a new one is started. */
const JOB_KEPT_MS = 24 * 3600_000;

const startJob = Effect.fn("transcribe.startJob")(function* (key: string, keyterms: readonly string[], again: boolean) {
  const answer = yield* service
    .request(
      "the transcription relay",
      `${relay.url()}/v1/transcribe/jobs`,
      { method: "POST", headers: { ...relay.authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ key, again, ...(keyterms.length > 0 ? { keyterms } : {}) }) },
      120_000,
    )
    .pipe(
      Effect.catchTags({
        ServiceUnreachable: (error) => Effect.fail(new RelayUnreachable({ message: error.message })),
        ServiceTimedOut: (error) => Effect.fail(new RelayTimedOut({ message: error.message })),
      }),
    );
  // An older relay (no such route), one not set up for it, or a job refused for itself (Nov 1, the first live
  // test: "The webhook ID … is not configured for speech-to-text", a 400 that stopped the import): heard the old
  // way. A busy relay, the gateway or a used-up allowance are said as they are.
  if (answer.status === 200 || answer.status === 202) {
    return yield* service.decodeJson("the transcription relay", JobStarted, answer.text()).pipe(Effect.mapError((error) => new AnswerUnreadable({ message: error.message })));
  }
  if (answer.status === 429 || GATEWAY.has(answer.status)) return yield* refusalOf(answer.status, answer.text(), 0, false);
  return yield* new JobsUnavailable({ message: `${answer.status}: ${said(answer.text())}` });
});

/** The job's transcript once Scribe has it; none while it's still hearing. */
const pollJob = Effect.fn("transcribe.pollJob")(function* (job: KeptJob) {
  const query = new URLSearchParams({ request: job.request, key: job.key });
  const answer = yield* service
    .request("the transcription relay", `${relay.url()}/v1/transcribe/jobs/${encodeURIComponent(job.id)}?${query}`, { headers: relay.authHeaders() }, 120_000)
    .pipe(
      Effect.catchTags({
        ServiceUnreachable: (error) => Effect.fail(new RelayUnreachable({ message: error.message })),
        ServiceTimedOut: (error) => Effect.fail(new RelayTimedOut({ message: error.message })),
      }),
    );
  if (answer.status === 202) return Option.none<Transcript>();
  if (answer.status === 502 && /couldn't hear/i.test(answer.text())) return yield* new JobFailed({ message: said(answer.text()) });
  if (answer.status !== 200) return yield* refusalOf(answer.status, answer.text(), 0, false);
  const decoded = yield* service.decodeJson("Scribe", ScribeAnswer, answer.text()).pipe(Effect.mapError((error) => new AnswerUnreadable({ message: error.message })));
  return Option.some(parseScribe(decoded));
});

/** Whether the relay hears recordings by link (its /health says `jobs`), asked before any upload. */
const jobsAvailable = Effect.fn("transcribe.jobsAvailable")(function* () {
  const answer = yield* service.request("the transcription relay", `${relay.url()}/health`, {}, 20_000).pipe(Effect.orElseSucceed(() => null));
  if (answer === null || answer.status !== 200) return false;
  return yield* service.decodeJson("the transcription relay", Schema.Struct({ jobs: Schema.optional(Schema.Boolean) }), answer.text()).pipe(
    Effect.map((health) => health.jobs === true),
    Effect.orElseSucceed(() => false),
  );
});

/** `audio` (`seconds` long) heard by link, kept as `job`; `JobsUnavailable` when the relay can't. */
const jobHearing = Effect.fn("transcribe.jobHearing")(function* (source: string, audio: string, seconds: number, file: string, keyterms: readonly string[], again: boolean) {
  const jobs = yield* Jobs;
  // The file it's for, by its whole seconds (its audio is made again on a restart, a few ms either way), and the names asked with.
  const tag = [String(Math.round(seconds)), ...keyterms].join("|");
  const now = yield* Clock.currentTimeMillis;
  const kept = yield* Effect.sync(() => {
    try {
      return Schema.decodeUnknownOption(KeptJob)(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return Option.none<KeptJob>();
    }
  });
  let job: KeptJob;
  if (Option.isSome(kept) && kept.value.tag === tag && now - kept.value.at < JOB_KEPT_MS) {
    job = kept.value;
    yield* Effect.logInfo(`${source}: carrying on its hearing by link (job ${job.id})`);
  } else {
    if (!(yield* jobsAvailable())) return yield* new JobsUnavailable({ message: "its /health has no jobs" });
    const key = `edit/transcribe/${crypto.randomUUID()}.ogg`;
    yield* jobs.upload(audio, key);
    const started = yield* startJob(key, keyterms, again);
    job = { ...started, key, tag, at: now };
    yield* Effect.try(() => writeAtomic(file, JSON.stringify(job))).pipe(Effect.catch((error) => Effect.logWarning(`keeping its job in ${file}: ${ioMessage(error.cause)}`)));
    yield* Effect.logInfo(`${source}: heard by link (${hours(seconds)}, job ${job.id})`);
  }
  const forget = Effect.sync(() => fs.rmSync(file, { force: true }));
  // A look that fails for a moment (offline, the gateway) is waited out; the job goes on in the cloud.
  const look = pollJob(job).pipe(
    Effect.catchIf(service.isTemporary, (failed) =>
      failed._tag === "JobFailed" ? Effect.fail(failed) : Effect.logWarning(`${source}: asking for its hearing by link: ${failed.message}; asking again`).pipe(Effect.as(Option.none<Transcript>())),
    ),
  );
  const heard = yield* look.pipe(
    Effect.repeat({ schedule: Schedule.spaced(jobs.pollEvery), until: Option.isSome }),
    Effect.timeoutOrElse({
      duration: jobs.deadline,
      orElse: () => Effect.fail(new RelayTimedOut({ message: `its hearing by link didn't finish within ${Math.round(Duration.toMinutes(Duration.fromInputUnsafe(jobs.deadline)))} min` })),
    }),
    // However it ends but stopped, the job is done with: a new run starts afresh.
    Effect.onError((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : forget)),
  );
  yield* forget;
  if (Option.isNone(heard)) return yield* new JobFailed({ message: "its hearing by link came back empty" });
  return heard.value;
});

// ── Hearing a file ──────────────────────────────────────────────────────────

/** A part's words on the file's clock; with more than one part, each part's voices are its own (`2:speaker_0`). */
const shifted = (words: readonly Word[], by: number, part: string | null): Word[] =>
  words.map((word) => ({
    text: word.text,
    start: round3(word.start + by),
    end: round3(word.end + by),
    ...(word.speaker === undefined ? {} : { speaker: part === null ? word.speaker : `${part}:${word.speaker}` }),
  }));

/**
 * `audio` (`seconds` long) in one hearing: by link when it's long (kept as
 * `target`'s `.job.json` while Scribe works), else in one request at the
 * rate that fits the relay's limit.
 */
const hearOnce = Effect.fn("transcribe.hearOnce")(function* (source: string, audio: string, seconds: number, target: string, keyterms: readonly string[], again: boolean) {
  const jobs = yield* Jobs;
  if (seconds > jobs.longerThan) {
    const byLink = yield* jobHearing(source, audio, seconds, withExtension(target, "job.json"), keyterms, again).pipe(
      Effect.map(Option.some),
      Effect.catchTag("JobsUnavailable", (unavailable) =>
        Effect.logInfo(`${source}: the relay can't hear it by link (${unavailable.message}); sending it in one request`).pipe(Effect.as(Option.none<Transcript>())),
      ),
    );
    if (Option.isSome(byLink)) return byLink.value;
  }
  const maxBytes = yield* RelayMaxBytes;
  if (Bun.file(audio).size <= maxBytes) return yield* ask(audio, keyterms, again);
  const kbps = wholeBitrate(seconds, maxBytes);
  if (kbps === null) return yield* new TooLongForOneRequest({ bytes: Math.round((seconds * KBPS * 1000) / 8), message: `${hours(seconds)} is too long to hear in one request` });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const smaller = yield* temporary(withExtension(target, "smaller.ogg"));
      // Opus can run over its rate (a steady tone at "32k" is ~44 kbps), so a
      // file that still comes out too big is made once more, smaller by as much
      // as it was over.
      let rate = kbps;
      let bytes = 0;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        yield* encode(["-i", audio], smaller, "could not make the audio smaller", rate);
        bytes = Bun.file(smaller).size;
        if (bytes <= maxBytes) break;
        rate = Math.floor((rate * maxBytes * 0.95) / bytes);
        if (rate < MIN_WHOLE_KBPS) break;
      }
      if (bytes > maxBytes) return yield* new TooLongForOneRequest({ bytes, message: `${hours(seconds)} is ${bytes} bytes even at ${kbps} kbps, more than the relay's ${maxBytes}` });
      yield* Effect.logInfo(`${source}: sent at ${rate} kbps (${hours(seconds)}: at ${KBPS} kbps it's more than one request takes)`);
      return yield* ask(smaller, keyterms, again);
    }),
  );
});

/**
 * `hearOnce`, and heard again without the case's names when it came back as
 * gibberish with them (Helpful Wife's m91 at 6:39–7:16 came back in a dozen
 * scripts, the same each time with the names): the clearer of the two stands.
 */
const hearClear = Effect.fn("transcribe.hearClear")(function* (source: string, audio: string, seconds: number, target: string, keyterms: readonly string[], again: boolean) {
  const heard = yield* hearOnce(source, audio, seconds, target, keyterms, again);
  if (keyterms.length === 0 || garbledShare(heard.words) < 0.2) return heard;
  const plain = yield* hearOnce(source, audio, seconds, target, [], false);
  const clear = garbledShare(plain.words) < garbledShare(heard.words);
  yield* Effect.logWarning(`${source}: came back garbled with the case's names; heard again without them${clear ? "" : ", still garbled: kept as first heard"}`);
  return clear ? plain : heard;
});

/**
 * `audio` (`seconds` long) heard whole, or in parts no longer than Scribe
 * hears at once (`Longest`), joined where both heard the same word. Each
 * hearing is kept as it's heard (`saved`), so a run cut short never pays for
 * it again.
 */
const hearFile = Effect.fn("transcribe.hearFile")(function* (source: string, audio: string, seconds: number, target: string, keyterms: readonly string[], again: boolean) {
  const longest = yield* Longest;
  const tag = (length: number) => `${fixed3(length)} ${keyterms.join("|")} ${again}`;
  if (seconds <= longest) return yield* saved(withExtension(target, "heard.json"), tag(seconds), hearClear(source, audio, seconds, target, keyterms, again));
  const parts = plan(seconds, longest);
  yield* Effect.logInfo(`${source}: ${hours(seconds)} is longer than Scribe hears at once: heard in ${parts.length} parts`);
  const heard = yield* Effect.forEach(
    parts,
    (part, index) => {
      const own = withExtension(target, `part-${index}.json`);
      return saved(
        withExtension(own, "heard.json"),
        `${tag(part.to - part.from)} ${fixed3(part.from)}`,
        Effect.gen(function* () {
          const file = yield* temporary(withExtension(own, "ogg"));
          yield* encode(["-ss", fixed3(part.from), "-t", fixed3(part.to - part.from), "-i", audio], file, "could not cut the audio");
          return yield* hearClear(source, file, part.to - part.from, own, keyterms, again);
        }).pipe(Effect.scoped),
      );
    },
    { concurrency: PARTS_AT_ONCE },
  );
  const words = join(
    parts,
    heard.map((part, index) => shifted(part.words, parts[index]!.from, String(index + 1))),
  );
  return { model: heard[0]!.model, language: heard[0]!.language ?? null, words } satisfies Transcript;
});

/** What `hearFile` kept as it heard: no longer needed once the transcript is written. */
function forgetHeard(target: string): void {
  const dir = target.slice(0, target.lastIndexOf("/")) || ".";
  const stem = fileName(withExtension(target, "")) ?? "";
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === `${stem}.heard.json` || (name.startsWith(`${stem}.part-`) && name.endsWith(".heard.json"))) fs.rmSync(`${dir}/${name}`, { force: true });
  }
}

/**
 * Extracts audio, sends it to the relay with the case's names to listen for
 * (`keyterms`), writes `target` (transcript JSON): heard whole (see the top),
 * then its voices split by bodycam. `again`: a finished file heard again for
 * the case's names, which the relay gives only a share of each day's
 * allowance (first hearings come first).
 */
export const transcribeFile = Effect.fn("transcribe.file")(function* (source: string, target: string, keyterms: readonly string[] = [], again: boolean = false) {
  // Asked before the media's other work has made its cache folder.
  yield* Effect.sync(() => fs.mkdirSync(target.slice(0, target.lastIndexOf("/")) || ".", { recursive: true }));
  const began = yield* Clock.currentTimeMillis;
  const transcript: Transcript = yield* Effect.gen(function* () {
    const audio = yield* temporary(withExtension(target, "ogg"));
    yield* encode(["-protocol_whitelist", tools.protocols(source), ...tools.urlArgs(source), "-i", source, "-map", "0:a:0"], audio, "could not extract audio");
    const seconds = yield* lengthOf(audio);
    const heard = yield* hearFile(source, audio, seconds, target, keyterms, again);
    const took = (yield* Clock.currentTimeMillis) - began;
    if (seconds > 90) yield* Effect.logInfo(`${source}: heard whole (${hours(seconds)}, ${heard.words.length} words) in ${Math.round(took / 1000)} s`);
    return heard;
  }).pipe(Effect.scoped);
  // Heard again, it never comes out much shorter than the transcript it replaces (Killer Pastor in dev, Nov 8: its
  // 1 h 52 min recording heard again through a proxy that could only play its first 3 minutes left 323 words for
  // the thousands it had, and its three excerpts, cut from it, none): the old one stands.
  if (again) {
    const before = yield* Effect.sync(() => {
      try {
        const kept = JSON.parse(fs.readFileSync(target, "utf8")) as { words?: { end?: number }[] };
        return kept.words?.at(-1)?.end ?? 0;
      } catch {
        return 0;
      }
    });
    const now = transcript.words.at(-1)?.end ?? 0;
    if (before > 60 && now < before * 0.6) {
      return yield* new AudioUnreadable({ message: `heard again it reached only ${Math.round(now)} s of the ${Math.round(before)} s it had (the audio cut short?)` });
    }
  }
  // The names asked with, even when refused: asked again they'd be refused again.
  if (keyterms.length > 0) transcript.keyterms = [...keyterms];
  // Two officers' bodycams: one voice to Scribe, two people. Never fails the transcript.
  yield* Effect.tryPromise(() => cameras.split(source, transcript)).pipe(
    Effect.catch((error) => Effect.logWarning(`${source}: reading its bodycams: ${diag.messageOf(error.cause)}; its voices stay as heard`)),
  );
  yield* Effect.try({
    try: () => writeAtomic(target, serialize(transcript)),
    catch: (error) => new TranscriptUnwritable({ message: ioMessage(error) }),
  });
  yield* Effect.sync(() => forgetHeard(target));
});

/** `effect` with the retry policy the Promise side's tests asked for (`timing.instant`). */
export const asConfigured = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => (timing.instant ? effect.pipe(Effect.provideService(Retries, Retries.instant)) : effect);

/** `transcribeFile` for code that isn't Effect yet: rejects with the same words it always has. */
export function run(source: string, target: string, keyterms: readonly string[] = [], again = false): Promise<void> {
  return runPromise(asConfigured(transcribeFile(source, target, keyterms, again).pipe(inArea("media"))));
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const fixed3 = (value: number) => value.toFixed(3);

/** The share of words' letters outside the Latin script (a Latin-script recording heard as gibberish is mostly not). */
export function garbledShare(words: readonly { text: string }[]): number {
  let letters = 0;
  let other = 0;
  for (const word of words) {
    for (const char of word.text) {
      if (!/\p{L}/u.test(char)) continue;
      letters += 1;
      if (!/\p{Script=Latin}/u.test(char)) other += 1;
    }
  }
  return letters < 20 ? 0 : other / letters;
}

/** A part of a very long file: the stretch it speaks for (`core`) and what's sent (`from`–`to`, with context). */
export interface Piece {
  coreFrom: number;
  coreTo: number;
  from: number;
  to: number;
}

/** A file of `seconds` cut into even parts of at most `size` seconds, each with `CONTEXT` either side. */
export function plan(seconds: number, size: number): Piece[] {
  const count = Math.max(Math.ceil(seconds / size), 1);
  const pieces: Piece[] = [];
  for (let index = 0; index < count; index += 1) {
    const coreFrom = (seconds * index) / count;
    const coreTo = (seconds * (index + 1)) / count;
    pieces.push({ coreFrom, coreTo, from: Math.max(coreFrom - CONTEXT, 0), to: Math.min(coreTo + CONTEXT, seconds) });
  }
  return pieces;
}

/**
 * The parts' words as one transcript. Neighbours both hear the context
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
    model: MODEL,
    language: typeof answer.language_code === "string" ? answer.language_code : null,
    words,
  };
}
