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
//
// What's heard is kept as it comes in (`saved`): each piece beside the
// transcript until the file is done, so a run cut short (the day's allowance,
// a restart) pays only for the pieces it hadn't heard; and the whole file's
// hearing for good, so hearing it again for the case's names asks only for
// the pieces (voices don't change with the names).
//
// In Effect since Nov 1 (docs/plans/2026-11-01-effect.md, part 1). Every way
// the relay can answer is its own error, and whether it's asked again is the
// retry policy's (`Retries`), not an `if` in a loop: the busy relay, the
// gateway and a dropped connection are asked again; the day's allowance, a
// refusal and a request too big for the relay are not, since asking again
// gets the same answer. The pieces and the whole hearing run together, and
// one failing interrupts the other (its FFmpeg killed, its request
// abandoned). The whole hearing is encoded to fit the relay's limit for one
// request (`wholeBitrate`): sent at 32 kbps, a recording over ~3 h 7 min was
// refused with a 413 every time (Nov 1, Mathias's FOIA interviews of 4 h 39
// min and 5 h 1 min: two imports of ~41 minutes each stopped, then resumed 13
// times). A file too long even for that keeps its words from the pieces and
// goes without voices (the watch names who speaks) rather than stop.

import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { Clock, Context, Duration, Effect, Option, Predicate, Schedule, Schema } from "effect";

import * as cameras from "./cameras.ts";
import * as diag from "./diag.ts";
import * as proc from "./effect/proc.ts";
import { inArea, runPromise } from "./effect/runtime.ts";
import * as service from "./effect/service.ts";
import { ioMessage, writeAtomic } from "./files.ts";
import { withExtension } from "./paths.ts";
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

/** Every way asking the relay can fail. */
export type AskError = RelayBusy | GatewayDown | RelayUnreachable | RelayTimedOut | AllowanceUsedUp | TooLongForOneRequest | NamesRefused | TranscriptionRefused | AnswerUnreadable;

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
});

// ── When to ask again ───────────────────────────────────────────────────────

export interface RetryPolicy {
  /** A busy relay (429): 15, 30, then 60 s, six times in all. */
  readonly busy: Schedule.Schedule<Duration.Duration>;
  /**
   * The gateway or the connection: after 20 and 60 s. Oct 30, one 524 on one
   * 40-second piece stopped a 6.7-hour import after every other recording was
   * heard. The request may have been billed; asking again costs a piece (or,
   * for a whole file, its hearing) once more, far less than an import stopped
   * for it.
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

/** Seconds of speech each piece of a long file is heard for, besides its context. */
export const PIECE = 40;
/** Seconds heard either side of a piece, so a word across its edge is heard whole by one of them. */
export const CONTEXT = 4;
/** Files up to this long are heard in one go: short enough not to drift. */
export const WHOLE_UP_TO = 90;
/** Pieces heard at once (the relay takes 60 a minute from one connection). */
const PIECES_AT_ONCE = 4;

/** The most the relay takes in one request: its `MAX_UPLOAD_BYTES` (apps/relay/wrangler.toml; a test keeps the two the same). */
export const RELAY_MAX_BYTES = 45_000_000;
/** The relay's limit as the hearing reads it: `RELAY_MAX_BYTES`, or a test's smaller one so a short file takes the long file's road. */
export const RelayMaxBytes = Context.Reference<number>("edit/transcribe/RelayMaxBytes", { defaultValue: () => RELAY_MAX_BYTES });
/** The audio sent, normally (Opus, mono, 16 kHz): ~14.4 MB an hour. */
const KBPS = 32;
/** The least a whole hearing is sent at: still clear speech for telling voices apart. */
const MIN_WHOLE_KBPS = 8;
/** Room left under the limit for Opus going over its target rate and the Ogg pages around it. */
const HEADROOM = 0.85;

/**
 * The rate a whole hearing of `seconds` is sent at so it fits in one request:
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
      Effect.mapError((error) => new AudioUnreadable({ message: `${failure}: ${error._tag === "ProcessFailed" ? error.stderr : error.message}` })),
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
  const message = `transcription failed (${status}): ${said(body)}`;
  if ((status === 400 || status === 422) && names.length > 0) return yield* new NamesRefused({ status, message: `${status}: ${body.trim().slice(0, 200)}` });
  if (GATEWAY.has(status)) return yield* new GatewayDown({ status, message });
  if (status === 429) return yield* /allowance/i.test(body) ? new AllowanceUsedUp({ message }) : new RelayBusy({ message });
  if (status === 413) return yield* new TooLongForOneRequest({ bytes: Bun.file(audio).size, message });
  return yield* new TranscriptionRefused({ status, message });
});

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
    const transcript = yield* hear;
    yield* Effect.try(() => {
      fs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
      writeAtomic(file, JSON.stringify({ tag, transcript }));
    }).pipe(Effect.catch((error) => Effect.logWarning(`keeping what was heard in ${file}: ${ioMessage(error.cause)}`)));
    return transcript;
  });

// ── Hearing a file ──────────────────────────────────────────────────────────

/** Times into the file, not the piece. */
const shifted = (words: readonly Word[], by: number): Word[] => words.map((word) => ({ text: word.text, start: round3(word.start + by), end: round3(word.end + by) }));

/**
 * A long file heard in pieces for its words and whole for its voices, both
 * at once: the pieces four at a time, any failure interrupting the rest.
 */
const hearLong = Effect.fn("transcribe.hearLong")(function* (source: string, audio: string, seconds: number, target: string, keyterms: readonly string[], again: boolean) {
  const pieces = plan(seconds);
  const piecesDir = withExtension(target, "pieces");
  const names = createHash("sha256").update(keyterms.join("\n")).digest("hex").slice(0, 12);
  // How long each hearing took, for the log: the whole file's, and each piece's.
  const began = yield* Clock.currentTimeMillis;
  let wholeMs = 0;
  const pieceMs: number[] = [];

  // Any earlier hearing of the whole file will do: only its voices are used,
  // so it's asked without the names (which cost a fifth more: the audit, Oct
  // 23); the pieces spell them. Sent at the rate that fits one request.
  const wholeHearing = Effect.gen(function* () {
    const maxBytes = yield* RelayMaxBytes;
    const kbps = wholeBitrate(seconds, maxBytes);
    if (kbps === null) {
      return yield* new TooLongForOneRequest({ bytes: Math.round((seconds * KBPS * 1000) / 8), message: `${hours(seconds)} is too long to hear whole in one request` });
    }
    if (kbps === KBPS && Bun.file(audio).size <= maxBytes) return yield* ask(audio, [], again);
    const smaller = yield* temporary(withExtension(target, "whole.ogg"));
    // Opus can run over its rate (a steady tone at "32k" is ~44 kbps), so a
    // file that still comes out too big is made once more, smaller by as much
    // as it was over.
    let rate = kbps;
    let bytes = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      yield* encode(["-i", audio], smaller, "could not make the whole file's audio smaller", rate);
      bytes = Bun.file(smaller).size;
      if (bytes <= maxBytes) break;
      rate = Math.floor((rate * maxBytes * 0.95) / bytes);
      if (rate < MIN_WHOLE_KBPS) break;
    }
    if (bytes > maxBytes) return yield* new TooLongForOneRequest({ bytes, message: `${hours(seconds)} is ${bytes} bytes even at ${kbps} kbps, more than the relay's ${maxBytes}` });
    yield* Effect.logInfo(`${source}: heard whole at ${rate} kbps for its voices (${hours(seconds)}: at ${KBPS} kbps it's more than one request takes)`);
    return yield* ask(smaller, [], again);
  }).pipe(Effect.scoped);

  const whole = saved(withExtension(target, "whole.json"), fixed3(seconds), wholeHearing).pipe(
    Effect.map(Option.some),
    // Too long even at the least rate: its words still come from the pieces.
    Effect.catchTag("TooLongForOneRequest", (refused) =>
      Effect.logWarning(`${source}: ${refused.message}; its words are from the pieces and who speaks is left for the watch`).pipe(Effect.as(Option.none<Transcript>())),
    ),
    Effect.ensuring(Effect.sync(() => (wholeMs = Date.now() - began))),
  );

  const piece = (stretch: Piece, index: number) =>
    saved(
      `${piecesDir}/${names}-${index}-${fixed3(stretch.from)}-${fixed3(stretch.to)}.json`,
      "",
      Effect.gen(function* () {
        const file = yield* temporary(withExtension(target, `piece-${index}.ogg`));
        const asked = yield* Clock.currentTimeMillis;
        yield* encode(["-ss", fixed3(stretch.from), "-t", fixed3(stretch.to - stretch.from), "-i", audio], file, "could not cut the audio");
        return yield* ask(file, keyterms, again).pipe(Effect.ensuring(Effect.sync(() => pieceMs.push(Date.now() - asked))));
      }).pipe(Effect.scoped),
    );

  const [voices, parts] = yield* Effect.all([whole, Effect.forEach(pieces, piece, { concurrency: PIECES_AT_ONCE })], { concurrency: 2 });
  const heard = parts.map((part, index) => shifted(part.words, pieces[index]!.from));

  // A piece heard as gibberish (Helpful Wife's m91 at 6:39–7:16 came back in
  // a dozen scripts, the same each time with the case's names): asked again
  // without them, else the whole file's words for that stretch.
  const latin = Option.match(voices, { onNone: () => true, onSome: (found) => garbledShare(found.words) < 0.2 });
  for (const [index, stretch] of pieces.entries()) {
    if (!latin || garbledShare(heard[index]!) < 0.2) continue;
    const heardAgain = yield* Effect.gen(function* () {
      const file = yield* temporary(withExtension(target, `piece-${index}-again.ogg`));
      yield* encode(["-ss", fixed3(stretch.from), "-t", fixed3(stretch.to - stretch.from), "-i", audio], file, "could not cut the audio");
      return shifted((yield* ask(file, [], false)).words, stretch.from);
    }).pipe(Effect.scoped);
    const clear = garbledShare(heardAgain) < 0.2;
    const wholeWords = Option.match(voices, {
      onNone: () => null,
      onSome: (found) => found.words.filter((word) => word.start >= stretch.from && word.end <= stretch.to).map((word) => ({ text: word.text, start: word.start, end: word.end })),
    });
    heard[index] = clear ? heardAgain : (wholeWords ?? heard[index]!);
    yield* Effect.logWarning(
      `${source}: piece ${index} (${fixed3(stretch.from)}–${fixed3(stretch.to)} s) came back garbled; heard again${clear ? "" : wholeWords === null ? ", still garbled: kept as heard" : ", still garbled: the whole file's words stand"}`,
    );
  }

  const words = join(pieces, heard);
  if (Option.isSome(voices)) voicesFrom(words, voices.value.words);
  yield* Effect.sync(() => fs.rmSync(piecesDir, { recursive: true, force: true }));
  const now = yield* Clock.currentTimeMillis;
  const sorted = [...pieceMs].sort((a, b) => a - b);
  const secs = (ms: number) => `${Math.round(ms / 1000)} s`;
  const timing =
    sorted.length === 0
      ? "all saved from before"
      : `pieces typically ${secs(sorted[Math.floor(sorted.length / 2)]!)}, the slowest ${secs(sorted.at(-1)!)}${sorted.length < pieces.length ? `, ${pieces.length - sorted.length} saved from before` : ""}; the whole ${secs(wholeMs)}`;
  yield* Effect.logInfo(
    `${source}: heard in ${pieces.length} pieces for its words and ${Option.isSome(voices) ? "whole for its voices" : "not whole (no voices)"} (${words.length} words) in ${secs(now - began)}: ${timing}`,
  );
  const first = Option.getOrElse(voices, () => parts[0]!);
  return { model: first.model, language: first.language ?? null, words } satisfies Transcript;
});

/**
 * Extracts audio, sends it to the relay with the case's names to listen for
 * (`keyterms`), writes `target` (transcript JSON). A file longer than
 * `WHOLE_UP_TO` is heard in pieces for its words and whole for its voices
 * (see the top), then its voices are split by bodycam. `again`: a finished
 * file heard again for the case's names, which the relay gives only a share
 * of each day's allowance (first hearings come first).
 */
export const transcribeFile = Effect.fn("transcribe.file")(function* (source: string, target: string, keyterms: readonly string[] = [], again: boolean = false) {
  // Asked before the media's other work has made its cache folder.
  yield* Effect.sync(() => fs.mkdirSync(target.slice(0, target.lastIndexOf("/")) || ".", { recursive: true }));
  const transcript: Transcript = yield* Effect.gen(function* () {
    const audio = yield* temporary(withExtension(target, "ogg"));
    yield* encode(["-protocol_whitelist", tools.protocols(source), ...tools.urlArgs(source), "-i", source, "-map", "0:a:0"], audio, "could not extract audio");
    const seconds = yield* lengthOf(audio);
    return seconds <= WHOLE_UP_TO ? yield* ask(audio, keyterms, again) : yield* hearLong(source, audio, seconds, target, keyterms, again);
  }).pipe(Effect.scoped);
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
