// What can go wrong with any outside call (Scribe, Drive, R2, the relay,
// the accounts site), and the one rule for what each failure is
// (docs/plans/2026-11-01-effect.md, round 2):
//
// - temporary: a dropped connection, a timeout, 408, 425, 429, 5xx and
//   Cloudflare's 52x. Edit asks again by itself, on a schedule
//   (`temporaryRetries`), honouring a Retry-After.
// - later: something a person can change (a sign-in, a quota, the day's
//   allowance): Edit doesn't loop on it, and Try again is offered.
// - permanent: the same build gets the same answer however often it's
//   asked (a 413, a 400, an answer that isn't what the service says it
//   sends): neither Edit nor Try again asks again until an update.
//
// An area's own errors are given a kind with `kinds` beside their classes,
// so `kindOf` is the one place the split is read, by the retries and by Try
// again alike.

import { Duration, Effect, Predicate, Schedule, Schema } from "effect";

import * as diag from "../diag.ts";

/** The service couldn't be reached at all (no network, a reset, DNS). */
export class ServiceUnreachable extends Schema.TaggedError<ServiceUnreachable>()("ServiceUnreachable", {
  service: Schema.String,
  message: Schema.String,
}) {}

/** The service didn't answer within the time given. */
export class ServiceTimedOut extends Schema.TaggedError<ServiceTimedOut>()("ServiceTimedOut", {
  service: Schema.String,
  afterMs: Schema.Number,
  message: Schema.String,
}) {}

/** The service answered with a status that isn't success; `retryAfterMs` from its Retry-After. */
export class ServiceRefused extends Schema.TaggedError<ServiceRefused>()("ServiceRefused", {
  service: Schema.String,
  status: Schema.Number,
  retryAfterMs: Schema.NullOr(Schema.Number),
  message: Schema.String,
}) {}

/** The service answered, but not with what it says it sends (its Schema). */
export class AnswerInvalid extends Schema.TaggedError<AnswerInvalid>()("AnswerInvalid", {
  service: Schema.String,
  message: Schema.String,
}) {}

export type ServiceError = ServiceUnreachable | ServiceTimedOut | ServiceRefused | AnswerInvalid;

export type Kind = "temporary" | "later" | "permanent";

/** Statuses worth asking again for: the service busy, down for a moment, or slow. */
const TEMPORARY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
/** Statuses a person can change: a sign-in, a payment or quota, a permission. */
const LATER_STATUS = new Set([401, 402, 403]);

/** The kind of a status a service answered with. */
export function kindOfStatus(status: number): Kind {
  if (TEMPORARY_STATUS.has(status)) return "temporary";
  if (LATER_STATUS.has(status)) return "later";
  return "permanent";
}

const table = new Map<string, Kind | ((error: unknown) => Kind)>([
  ["ServiceUnreachable", "temporary"],
  ["ServiceTimedOut", "temporary"],
  ["AnswerInvalid", "permanent"],
]);

/** Gives an area's own errors, by tag, their kind, or how to read it from the error (each module, beside its classes). */
export function kinds(entries: Record<string, Kind | ((error: unknown) => Kind)>): void {
  for (const [tag, kind] of Object.entries(entries)) table.set(tag, kind);
}

/**
 * The kind of any failure. A `ServiceRefused` by its status; a tagged error
 * by the table; anything else (a plain Error, a bug) is "later": never
 * looped on, and Try again is still offered, since nobody knows it won't help.
 */
export function kindOf(error: unknown): Kind {
  if (!Predicate.hasProperty(error, "_tag") || typeof error._tag !== "string") return "later";
  if (error._tag === "ServiceRefused" && Predicate.hasProperty(error, "status") && typeof error.status === "number") return kindOfStatus(error.status);
  const kind = table.get(error._tag) ?? "later";
  return typeof kind === "function" ? kind(error) : kind;
}

export const isTemporary = (error: unknown): boolean => kindOf(error) === "temporary";

/** Whether Try again is worth offering for `error`: anything but permanent. */
export const tryAgainHelps = (error: unknown): boolean => kindOf(error) !== "permanent";

/** A Retry-After a refusal carried, in ms. */
function retryAfter(error: unknown): number | null {
  return Predicate.hasProperty(error, "retryAfterMs") && typeof error.retryAfterMs === "number" ? error.retryAfterMs : null;
}

/**
 * Asks again only after a temporary failure: `times` more tries, `base`
 * doubling (2, 4, 8 s by default), a Retry-After waited instead, each retry
 * logged as `what`.
 */
export const temporaryRetries = (what: string, options: { readonly times?: number; readonly base?: Duration.Input } = {}) =>
  Schedule.exponential(options.base ?? "2 seconds").pipe(
    Schedule.upTo({ times: options.times ?? 3 }),
    Schedule.setInputType<unknown>(),
    Schedule.while(({ input }) => isTemporary(input)),
    Schedule.modifyDelay(({ input, duration }) => Effect.succeed(retryAfter(input) ?? Duration.toMillis(duration))),
    Schedule.tap(({ input, duration, attempt }) =>
      Effect.logWarning(`${what} failed (try ${attempt}): ${diag.messageOf(input)}; asking again in ${Math.round(Duration.toMillis(duration) / 1000)} s`),
    ),
  );

/** "Retry-After: 60" (seconds) or an HTTP date, in ms; null when there's none. */
export function retryAfterOf(headers: Headers): number | null {
  const said = headers.get("retry-after");
  if (said === null || said.trim() === "") return null;
  const seconds = Number(said);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(said);
  return Number.isFinite(at) ? Math.max(at - Date.now(), 0) : null;
}

/** An answer, read whole. */
export interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly text: () => string;
}

/**
 * One request to `service`, its answer read whole within `timeoutMs`: a
 * dropped connection is `ServiceUnreachable`, the time running out
 * `ServiceTimedOut` (the request abandoned). Any status is answered; `ok`
 * turns the ones that aren't success into `ServiceRefused`.
 */
export const request = Effect.fn("service.request")(function* (service: string, url: string, init: RequestInit, timeoutMs: number) {
  return yield* Effect.tryPromise({
    try: async (signal): Promise<Answer> => {
      const response = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
      const body = await response.bytes();
      return { status: response.status, headers: response.headers, body, text: () => new TextDecoder().decode(body) };
    },
    catch: (error) => {
      // A stopped caller (its signal fired) is not a service failure:
      // rethrowing keeps it a defect/interruption, so retries never re-ask it.
      const name = (error as { name?: unknown } | null)?.name;
      if (name === "AbortError" || name === "TimeoutError") throw error;
      return new ServiceUnreachable({ service, message: `could not reach ${service}: ${diag.scrub(diag.messageOf(error))}` });
    },
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new ServiceTimedOut({ service, afterMs: timeoutMs, message: `${service} didn't answer within ${Math.round(timeoutMs / 1000)} s` })),
    }),
  );
});

/** `answer`, or `ServiceRefused` when its status isn't in `accepted` (200 by default), saying `said(answer)` (the body's start by default). */
export function ok(service: string, answer: Answer, said: (answer: Answer) => string = (one) => one.text().trim().slice(0, 300), accepted: readonly number[] = [200]) {
  return accepted.includes(answer.status)
    ? Effect.succeed(answer)
    : Effect.fail(new ServiceRefused({ service, status: answer.status, retryAfterMs: retryAfterOf(answer.headers), message: `${service} answered ${answer.status}: ${said(answer)}` }));
}

/** `text` as JSON checked against `schema`, or `AnswerInvalid` saying what didn't match. */
export function decodeJson<S extends Schema.Top>(service: string, schema: S, text: string) {
  return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError((error) => new AnswerInvalid({ service, message: `${service}'s answer wasn't what it sends: ${error.message.slice(0, 300)}` })),
  ) as Effect.Effect<S["Type"], AnswerInvalid, S["DecodingServices"]>;
}

/** `value` checked against `schema`, or `AnswerInvalid`. */
export function decodeValue<S extends Schema.Top>(service: string, schema: S, value: unknown) {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((error) => new AnswerInvalid({ service, message: `${service}'s answer wasn't what it sends: ${error.message.slice(0, 300)}` })),
  ) as Effect.Effect<S["Type"], AnswerInvalid, S["DecodingServices"]>;
}
