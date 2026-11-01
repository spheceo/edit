// Signing in to Edit with the team's accounts (accounts.spheceo.com, its
// `docs/plan.md` "contract"), so the relay answers a person, not a token
// every copy of Edit carries.
//
// As RFC 8252 has native apps do it: the authorization code with PKCE (S256)
// and `state`, the browser sent to `/app/authorize`, and the code back on
// this server's own loopback address (`http://127.0.0.1:<port>/callback`),
// exchanged at `/app/token`. The refresh token lives in the macOS Keychain
// (keychain.ts), one per Edit home; the access token (a JWT, an hour) only
// in memory, renewed quietly a few minutes before it runs out. Refresh
// tokens rotate on every use, so one refresh runs at a time. Signing out
// revokes the refresh token there and forgets it here.
//
// While the team moves over, a signed-out Edit still uses the shared token
// (relay.ts); once that goes, signing in is the only way in. Nothing here
// ever logs or prints a token.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, Option, Queue, Schedule, Schema } from "effect";

import type { App } from "./app.ts";
import type { Creator } from "./model.ts";
import * as diag from "./diag.ts";
import { idle, inArea, runPromise, runtime } from "./effect/runtime.ts";
import * as service from "./effect/service.ts";
import { readJson, type Router } from "./http/router.ts";
import * as keychain from "./keychain.ts";
import * as windowFocus from "./window_focus.ts";
import { BUILD } from "./version.ts";

const DEFAULT_ACCOUNTS = "https://accounts.spheceo.com";
const CLIENT = "edit";
/** Renewed this long before it runs out. */
const EARLY_MS = 5 * 60_000;
/** A sign-in started and never finished is forgotten after this. */
const PENDING_MS = 10 * 60_000;

export function accountsUrl(): string {
  return (process.env.EDIT_ACCOUNTS_URL ?? DEFAULT_ACCOUNTS).replace(/\/+$/u, "");
}

export interface Person {
  /** The account's id (the token's `sub`). */
  sub: string;
  email: string;
  name: string;
  image: string | null;
}

interface State {
  home: string | null;
  access: string | null;
  /** When the access token runs out (ms). */
  expires: number;
  person: Person | null;
  perms: string[];
  admin: boolean;
  /** A refresh token was found kept (or one was just taken): a session, even while its access token is renewed. */
  kept: boolean;
  /** The sign-in in progress: its state and PKCE verifier. */
  pending: { state: string; verifier: string; redirect: string; at: number } | null;
  /** A device sign-in in progress (RFC 8628): what the person types or opens, and when it runs out. */
  device: { userCode: string; uri: string; complete: string | null; expires: number; via: string } | null;
  /** Why the last sign-in or renewal failed, for the UI. */
  problem: string | null;
}

/** Whether the accounts site answers (its JWKS): signing in is offered only then, so a build out before the site is never stuck on it. */
let available = false;

async function checkAvailable(): Promise<void> {
  try {
    const answer = await fetch(`${accountsUrl()}/.well-known/jwks.json`, { signal: AbortSignal.timeout(10_000) });
    available = answer.ok;
  } catch {
    available = false;
  }
}

const state: State = { home: null, access: null, expires: 0, person: null, perms: [], admin: false, kept: false, pending: null, device: null, problem: null };

/** Session observers close authenticated connections on sign-out or account changes. */
const sessionObservers = new Set<() => void>();
export function onSessionChange(observer: () => void): () => void {
  sessionObservers.add(observer);
  return () => sessionObservers.delete(observer);
}
function sessionChanged(): void {
  for (const observer of sessionObservers) {
    try { observer(); } catch (error) { diag.warn("accounts", diag.messageOf(error)); }
  }
}

/** Whether this Edit has a sign-in (signed in, or a kept one being renewed): the cloud is on. */
export function hasSession(): boolean {
  return state.access !== null || state.kept;
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** The access token's claims, read (not verified: the relay does that) for who and what. */
function claims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Who's signed in, as a new project records its creator (`Project::created_by`); null signed out. */
export function creator(): Creator | null {
  const person = state.person;
  if (person === null || person.sub === "") return null;
  return { sub: person.sub, name: person.name || person.email.split("@")[0] || "", ...(person.image !== null ? { picture: person.image } : {}) };
}

/** The signed-in person's email (the Fixing page names a computer's person by it); null signed out. */
export const email = (): string | null => state.person?.email || null;

/** The signed-in person's access token while it's good for another half minute, else null. */
export function accessToken(): string | null {
  if (state.access === null) return null;
  if (Date.now() >= state.expires - 30_000) {
    void renew();
    return null;
  }
  return state.access;
}

/** What the UI shows: who's signed in (or not), what they may use, and why a sign-in failed. */
export function status(): Record<string, unknown> {
  return {
    signed_in: state.person !== null && state.access !== null,
    available: available || state.person !== null,
    person: state.person,
    perms: state.perms,
    admin: state.admin,
    signing_in: (state.pending !== null && Date.now() - state.pending.at < PENDING_MS) || state.device !== null,
    device:
      state.device === null
        ? null
        : { user_code: state.device.userCode, verification_uri: state.device.uri, verification_uri_complete: state.device.complete, expires_in: Math.max(0, Math.round((state.device.expires - Date.now()) / 1000)) },
    problem: state.problem,
    accounts: accountsUrl(),
    // Tests and local relays (EDIT_RELAY_TOKEN) work without signing in.
    required: (process.env.EDIT_RELAY_TOKEN ?? "") === "",
  };
}

// ── The accounts site's answers (in Effect: docs/plans/2026-11-01-effect.md, round 2, area 5) ──

const ACCOUNTS = "the accounts site";

/** How long one call to the accounts site may take (tests make it short). */
export const ACCOUNTS_MS = { value: 20_000 };

/**
 * What the accounts site answers `/app/token`, `/app/device` and
 * `/app/revoke` with: tokens, a device code, or an error and its
 * description. Every field may be missing; what each use needs is checked
 * where it's used (`Granted` for tokens).
 */
const TokensSchema = Schema.Struct({
  device_code: Schema.optional(Schema.String),
  user_code: Schema.optional(Schema.String),
  verification_uri: Schema.optional(Schema.String),
  verification_uri_complete: Schema.optional(Schema.NullOr(Schema.String)),
  interval: Schema.optional(Schema.Number),
  access_token: Schema.optional(Schema.String),
  token_type: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  refresh_token: Schema.optional(Schema.String),
  user: Schema.optional(Schema.Struct({ email: Schema.optional(Schema.NullOr(Schema.String)), name: Schema.optional(Schema.NullOr(Schema.String)), image: Schema.optional(Schema.NullOr(Schema.String)) })),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});
type Tokens = typeof TokensSchema.Type;

/** A token answer that grants a sign-in: both tokens there. */
const Granted = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String, expires_in: Schema.optional(Schema.Number) });

/** What one POST answered: its status, its body read as `Tokens` (empty when it isn't JSON, as an error page), its Retry-After. */
interface Posted {
  readonly status: number;
  readonly value: Tokens;
  readonly retryAfter: number | null;
}

/**
 * One POST to the accounts site, JSON both ways, within `ACCOUNTS_MS`: a
 * dropped connection or the time running out is a typed (temporary) failure;
 * a success that isn't the site's answer is `AnswerInvalid`; an error page
 * that isn't JSON reads as an empty answer with its status.
 */
const postEffect = Effect.fn("accounts.post")(function* (path: string, body: Record<string, string>, via = "") {
  const answer = yield* service.request(
    ACCOUNTS,
    `${accountsUrl()}${path}`,
    // What admins see as "where" on the person's page.
    { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "user-agent": userAgent(via) }, body: JSON.stringify(body) },
    ACCOUNTS_MS.value,
  );
  const value: Tokens =
    answer.status === 200
      ? yield* service.decodeJson(ACCOUNTS, TokensSchema, answer.text())
      : yield* service.decodeJson(ACCOUNTS, TokensSchema, answer.text()).pipe(Effect.orElseSucceed((): Tokens => ({})));
  return { status: answer.status, value, retryAfter: service.retryAfterOf(answer.headers) } satisfies Posted;
});

/** `postEffect` for the code that isn't Effect yet. */
function post(path: string, body: Record<string, string>, via = ""): Promise<Posted> {
  return runPromise(postEffect(path, body, via).pipe(inArea("accounts")));
}

/** `Edit/<build> (macOS)`, or `(macOS; edit serve)` for a device sign-in: what admins and the approval page show. */
function userAgent(via: string): string {
  const system = process.platform === "darwin" ? "macOS" : process.platform;
  return `Edit/${BUILD.replace(/^v/u, "")} (${via === "" ? system : `${system}; ${via}`})`;
}

/** Takes a token answer: the access token in memory, the new refresh token in the Keychain. */
async function take(home: string, value: Tokens): Promise<void> {
  const granted = Schema.decodeUnknownOption(Granted)(value);
  if (Option.isNone(granted)) throw new Error("the accounts site's answer had no tokens");
  const { access_token: access, refresh_token: refreshToken } = granted.value;
  const seconds = typeof value.expires_in === "number" && value.expires_in > 0 ? value.expires_in : 3600;
  // Kept before it's used: a rotated token lost here would sign the person out.
  await keychain.set(home, refreshToken);
  state.kept = true;
  const found = claims(access);
  state.access = access;
  state.expires = Date.now() + seconds * 1000;
  state.perms = Array.isArray(found.perms) ? found.perms.filter((one): one is string => typeof one === "string") : [];
  state.admin = found.admin === true;
  const user = value.user ?? {};
  state.person = {
    sub: typeof found.sub === "string" ? found.sub : "",
    email: typeof user.email === "string" ? user.email : typeof found.email === "string" ? found.email : "",
    name: typeof user.name === "string" ? user.name : typeof found.name === "string" ? found.name : "",
    image: typeof user.image === "string" ? user.image : typeof found.picture === "string" ? found.picture : null,
  };
  state.problem = null;
  // The renewer renews this token five minutes before it runs out.
  ask(home, null);
  sessionChanged();
}

function forget(problem: string | null): void {
  state.kept = false;
  state.access = null;
  state.expires = 0;
  state.person = null;
  state.perms = [];
  state.admin = false;
  state.problem = problem;
  sessionChanged();
}

// ── Renewing (in Effect: docs/plans/2026-11-01-effect.md, part 2) ───────────
//
// The policy was fixed three times on Oct 23 (81614d69, 8eda3b50, 8a793d7d)
// and again on Oct 30 (4a10063f), each time in timers and a failure counter
// spread through `renew`. Now each answer is a typed error, the policy is one
// Schedule (`renewalRetries`, tested on its own), and one fiber owns renewing
// (`renewer`): it sleeps until the token is due (five minutes before it runs
// out) or a retry is (the schedule says when), or until someone asks
// (`renew`), and then asks the site once. Everyone who asked while it was
// asking is answered by that one request, as a refresh token rotates on use.

/** The site ended the sign-in (`invalid_grant`: signed out elsewhere, removed by an admin, gone stale): the only answer that signs out here. */
export class SignInEnded extends Schema.TaggedError<SignInEnded>()("SignInEnded", { message: Schema.String }) {}

/** The site answered, but not with tokens (its per-minute limit's 429, a 5xx): the refresh token is kept and it's asked again, after its Retry-After when it gives one. */
export class AccountsSaidLater extends Schema.TaggedError<AccountsSaidLater>()("AccountsSaidLater", {
  status: Schema.Number,
  retryAfterMs: Schema.NullOr(Schema.Number),
  message: Schema.String,
}) {}

/** The site couldn't be reached, or the Keychain read or written, or the answer had no tokens: asked again. */
export class RenewalFailed extends Schema.TaggedError<RenewalFailed>()("RenewalFailed", { message: Schema.String }) {}

export type RenewError = SignInEnded | AccountsSaidLater | RenewalFailed;

/**
 * After a failed renewal (offline, the site down), the next tries: three
 * 15 s apart (at 15, 30 and 45 s), all inside the 60 s in which the accounts
 * site still takes a refresh token it has just rotated (its answer may have
 * been lost on the way), then once a minute; a Retry-After the site gives is
 * waited instead.
 */
export const renewalRetries: Schedule.Schedule<unknown, RenewError> = Schedule.concat(Schedule.spaced("15 seconds").pipe(Schedule.upTo({ times: 3 })), Schedule.spaced("60 seconds")).pipe(
  Schedule.setInputType<RenewError>(),
  Schedule.modifyDelay(({ input, duration }) => Effect.succeed(input._tag === "AccountsSaidLater" && input.retryAfterMs !== null ? Duration.millis(input.retryAfterMs) : duration)),
);

/** One request to the site with the Keychain's refresh token; "signed-out" when there's none kept. */
const attempt = Effect.fn("accounts.renew")(function* (home: string) {
  const refresh = yield* Effect.tryPromise({
    try: () => keychain.get(home),
    catch: (error) => new RenewalFailed({ message: `reading the Keychain: ${diag.messageOf(error)}` }),
  });
  if (refresh === null) return "signed-out" as const;
  state.kept = true;
  const answer = yield* postEffect("/app/token", { grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT }).pipe(
    Effect.mapError((error) => new RenewalFailed({ message: error.message })),
  );
  if (answer.status === 200) {
    yield* Effect.tryPromise({ try: () => take(home, answer.value), catch: (error) => new RenewalFailed({ message: diag.messageOf(error) }) });
    return "renewed" as const;
  }
  // Only `invalid_grant` ends a sign-in (signed out elsewhere, removed, gone stale): anything
  // else, the per-minute limit's 429 above all, keeps the refresh token and tries again.
  if (answer.value.error === "invalid_grant") {
    return yield* new SignInEnded({ message: typeof answer.value.error_description === "string" ? answer.value.error_description : "Your sign-in ended: sign in again." });
  }
  return yield* new AccountsSaidLater({
    status: answer.status,
    retryAfterMs: answer.retryAfter,
    message: `the accounts site answered ${answer.status}${typeof answer.value.error === "string" ? ` (${answer.value.error})` : ""}`,
  });
});

/** Someone asking for a renewal now (`done`: answered once it's been asked), or only telling the renewer a new token came in (null). */
interface Request {
  readonly home: string;
  readonly done: Deferred.Deferred<void> | null;
}

const requests = Effect.runSync(Queue.unbounded<Request>());

/** The fiber that renews: started by the first ask, stopped only by `resetForTests`. */
const renewer = Effect.gen(function* () {
  let retry = yield* Schedule.toStep(renewalRetries);
  // When to renew without being asked: the token's due time, or a retry's; null, only when asked.
  let due: number | null = null;
  let home: string | null = null;
  for (;;) {
    const before = yield* Clock.currentTimeMillis;
    const asked: readonly Request[] = yield* Effect.raceFirst(
      Queue.takeAll(requests),
      due === null ? Effect.never : idle(Math.max(due - before, 0)).pipe(Effect.as([])),
    );
    home = asked.at(-1)?.home ?? home ?? state.home;
    const now = yield* Clock.currentTimeMillis;
    // Only told of a new token (a sign-in, or the renewal just made): no request, its due time noted.
    if (home === null || (asked.length > 0 && asked.every((request) => request.done === null))) {
      due = state.access === null ? null : Math.max(state.expires - EARLY_MS, now + 5_000);
      continue;
    }
    const exit = yield* Effect.exit(attempt(home));
    const answered = [...asked, ...(yield* Queue.clear(requests))];
    if (Exit.isSuccess(exit)) {
      retry = yield* Schedule.toStep(renewalRetries);
      if (exit.value === "signed-out") forget(null);
      due = state.access === null ? null : Math.max(state.expires - EARLY_MS, now + 5_000);
    } else {
      const failure = Cause.squash(exit.cause);
      const error: RenewError = failure instanceof SignInEnded || failure instanceof AccountsSaidLater || failure instanceof RenewalFailed ? failure : new RenewalFailed({ message: diag.messageOf(failure) });
      if (error._tag === "SignInEnded") {
        yield* Effect.tryPromise(() => keychain.remove(home!)).pipe(Effect.ignore);
        forget(error.message);
        yield* Effect.logInfo("sign-in ended (invalid_grant); signed out");
        due = null;
      } else {
        state.problem = `Couldn't renew the sign-in: ${error.message}`;
        const wait = yield* retry(now, error).pipe(
          Effect.map(([, delay]) => Duration.toMillis(delay)),
          Effect.catch(() => Effect.succeed(60_000)),
        );
        yield* Effect.logWarning(`renewing the sign-in: ${error.message}; trying again in ${Math.round(wait / 1000)} s`);
        due = now + wait;
      }
    }
    for (const request of answered) if (request.done !== null) Deferred.doneUnsafe(request.done, Exit.void);
  }
}).pipe(inArea("accounts"));

let running: Fiber.Fiber<never> | null = null;

function ask(home: string, done: Deferred.Deferred<void> | null): void {
  running ??= runtime.runFork(renewer);
  Queue.offerUnsafe(requests, { home, done });
}

/**
 * Renews the access token with the Keychain's refresh token now, answering
 * once the site has been asked (renewed, signed out, or failed and to be
 * asked again as `renewalRetries` says). Refused (`invalid_grant`: signed out
 * elsewhere, removed by an admin, the token gone stale), the person is signed
 * out here; offline, it tries again.
 */
export function renew(home: string | null = state.home): Promise<void> {
  if (home === null) return Promise.resolve();
  const done = Deferred.makeUnsafe<void>();
  ask(home, done);
  return runtime.runPromise(Deferred.await(done));
}

/** When the relay last refused a token and a renewal was asked for (at most one a minute). */
let lastRefused = 0;

/**
 * The relay refused the access token `used`: renewed once, at most once a
 * minute, so a token made after a cut-off goes in its place rather than this
 * one being refused for the rest of its hour. On Oct 30 accounts ended one
 * Feedback sign-in of the user's and published a cut-off for all their apps:
 * every Edit of theirs was refused until its token next renewed. True when
 * there's a different token to try.
 */
export async function renewRefused(used: string | null): Promise<boolean> {
  if (state.home === null) return false;
  if (accessToken() !== used) return accessToken() !== null;
  if (Date.now() - lastRefused < 60_000) return false;
  lastRefused = Date.now();
  diag.info("accounts", "the relay refused the sign-in's token; renewing it");
  await renew();
  const now = accessToken();
  return now !== null && now !== used;
}

/** Headless `edit serve` (no window, no browser): it signs in with a code printed on the terminal. */
let headless = false;
export function signInOnTerminal(on: boolean): void {
  headless = on;
}

/** At start: signed in before (a refresh token kept), renewed quietly; headless and signed out, a code to type. */
export async function start(app: App): Promise<void> {
  state.home = app.store.home;
  void checkAvailable();
  setInterval(() => void checkAvailable(), 10 * 60_000).unref?.();
  await renew(app.store.home);
  // Signed-in team devices register automatically; saved disables stay off. A trial server
  // (EDIT_TRIALS=1) is this Mac's second Edit, never a device of its own.
  if (process.env.EDIT_TRIALS !== "1") {
    const remote = await import("./remote_support.ts");
    remote.start(app);
  }
  if (state.person !== null) diag.info("accounts", `signed in as ${state.person.email.split("@")[0]}`);
  if (headless) void codesOnTerminal(app);
}

/** Until someone signs in: a device code printed (on stderr, with Edit's other start-up lines: a stdout that's a file is buffered), and a new one when it runs out (or the site was unreachable). */
async function codesOnTerminal(app: App): Promise<void> {
  while (!hasSession()) {
    try {
      const device = await beginDevice(app, "edit serve");
      process.stderr.write(
        `\nedit: sign in to Edit: open ${device.uri} and enter ${device.userCode}` +
          (device.complete !== null ? `\n      (or open ${device.complete})` : "") +
          `\n      the code lasts ${Math.round((device.expires - Date.now()) / 60_000)} minutes\n\n`,
      );
      await devicePolling();
      if (hasSession()) process.stderr.write(`edit: signed in as ${state.person?.email ?? "you"}\n`);
      else if (state.problem !== null) {
        process.stderr.write(`edit: ${state.problem}\n`);
        await new Promise((resolve) => setTimeout(resolve, 30_000));
      }
    } catch (error) {
      process.stderr.write(`edit: couldn't start signing in (${diag.messageOf(error)}); trying again in a minute\n`);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }
}

/** Starts a sign-in: the authorize URL for the browser, with a fresh state and PKCE verifier. */
export function begin(app: App): string {
  state.home = app.store.home;
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const nonce = base64url(randomBytes(16));
  const redirect = `http://127.0.0.1:${app.port}/callback`;
  state.pending = { state: nonce, verifier, redirect, at: Date.now() };
  state.problem = null;
  const query = new URLSearchParams({ client_id: CLIENT, redirect_uri: redirect, response_type: "code", state: nonce, code_challenge: challenge, code_challenge_method: "S256" });
  return `${accountsUrl()}/app/authorize?${query.toString()}`;
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** The device sign-in being polled (one at a time). */
let polling: Promise<void> | null = null;

/**
 * A sign-in for an Edit with no browser of its own (headless `edit serve`,
 * Edit used over Tailscale): RFC 8628's device grant. The accounts site
 * hands out a short code; the person opens its /device page anywhere and
 * types it (or opens the link with it filled in), and this polls
 * `/app/token` every `interval` seconds until they've said yes.
 * `authorization_pending` keeps polling, `slow_down` adds 5 s,
 * `access_denied` or `expired_token` stops and says so. One at a time: a
 * second call while one is waiting returns the same code.
 */
export async function beginDevice(app: App, via: string): Promise<NonNullable<State["device"]>> {
  state.home = app.store.home;
  if (state.device !== null && state.device.expires > Date.now() + 30_000) return state.device;
  const { status: code, value, retryAfter } = await post("/app/device", { client_id: CLIENT }, via);
  if (code !== 200 || typeof value.device_code !== "string" || typeof value.user_code !== "string" || typeof value.verification_uri !== "string") {
    const why = typeof value.error_description === "string" ? value.error_description : typeof value.error === "string" ? value.error : `the accounts site answered ${code}`;
    throw new Error(code === 429 ? `The accounts site is busy: try again in ${Math.round((retryAfter ?? 60_000) / 1000)} s.` : `Couldn't start a sign-in: ${why}`);
  }
  const seconds = typeof value.expires_in === "number" && value.expires_in > 0 ? value.expires_in : 600;
  const interval = typeof value.interval === "number" && value.interval > 0 ? value.interval : 5;
  state.device = {
    userCode: value.user_code,
    uri: value.verification_uri,
    complete: typeof value.verification_uri_complete === "string" ? value.verification_uri_complete : null,
    expires: Date.now() + seconds * 1000,
    via,
  };
  state.problem = null;
  const device = value.device_code;
  const started = state.device;
  // Asks every `interval` while the code lasts: pending goes on, slow_down
  // waits 5 s longer, the per-minute limit (429) waits its Retry-After, a
  // connection that drops or times out is asked again; anything else ends it.
  const waiting = Effect.gen(function* () {
    let wait = interval * 1000;
    while (state.device === started && Date.now() < started.expires) {
      yield* idle(wait);
      if (state.device !== started) return;
      const asked = yield* postEffect("/app/token", { grant_type: DEVICE_GRANT, device_code: device, client_id: CLIENT }, via).pipe(Effect.result);
      if (asked._tag === "Failure") {
        // Offline for a moment: keep asking while the code lasts.
        yield* Effect.logWarning(`waiting for the device sign-in: ${asked.failure.message}`);
        continue;
      }
      const answer = asked.success;
      if (answer.status === 200) {
        yield* Effect.tryPromise(() => take(app.store.home, answer.value)).pipe(
          Effect.tap(() => Effect.logInfo(`signed in as ${state.person?.email.split("@")[0] ?? "?"} (with a code)`)),
          Effect.catch((error) => Effect.sync(() => (state.problem = `Signing in failed: ${diag.messageOf(error.cause)}`))),
        );
        state.device = null;
        return;
      }
      const error = answer.value.error ?? "";
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        wait += 5_000;
        continue;
      }
      if (answer.status === 429) {
        wait = Math.max(wait, answer.retryAfter ?? 60_000);
        continue;
      }
      state.problem =
        error === "access_denied"
          ? (answer.value.error_description ?? "The sign-in was turned down (or your account can't use Edit yet: ask an admin).")
          : error === "expired_token"
            ? "The code ran out before it was used: start again."
            : `Signing in failed: ${error || `the accounts site answered ${answer.status}`}`;
      state.device = null;
      return;
    }
    if (state.device === started) {
      state.device = null;
      state.problem = "The code ran out before it was used: start again.";
    }
  });
  polling = runPromise(waiting.pipe(inArea("accounts"))).finally(() => {
    polling = null;
  });
  return state.device;
}

/** The device sign-in being waited for, if any (tests wait on it). */
export function devicePolling(): Promise<void> | null {
  return polling;
}

/** Stops waiting for a device sign-in (signing in another way, or giving up). */
export function cancelDevice(): void {
  state.device = null;
}

/** The browser back with a code (or a refusal): exchanged, and the person signed in. */
export async function finish(app: App, query: URLSearchParams): Promise<{ ok: boolean; message: string }> {
  const pending = state.pending;
  if (pending === null || Date.now() - pending.at > PENDING_MS || query.get("state") !== pending.state) {
    return { ok: false, message: "This sign-in isn't the one Edit started (or it took too long). Start it again from Edit." };
  }
  state.pending = null;
  const refused = query.get("error");
  if (refused !== null) {
    const why = query.get("error_description") ?? (refused === "access_denied" ? "Your account can't use Edit yet: ask an admin." : refused);
    state.problem = why;
    return { ok: false, message: why };
  }
  const code = query.get("code");
  if (code === null || code === "") return { ok: false, message: "The accounts site sent no code back." };
  try {
    const { status: answered, value } = await post("/app/token", { grant_type: "authorization_code", code, code_verifier: pending.verifier, redirect_uri: pending.redirect, client_id: CLIENT });
    if (answered !== 200) throw new Error(typeof value.error_description === "string" ? value.error_description : typeof value.error === "string" ? value.error : `the accounts site answered ${answered}`);
    await take(app.store.home, value);
    state.device = null;
    diag.info("accounts", `signed in as ${state.person?.email.split("@")[0] ?? "?"}`);
    return { ok: true, message: `Signed in as ${state.person?.email ?? "you"}.` };
  } catch (error) {
    state.problem = `Signing in failed: ${diag.messageOf(error)}`;
    diag.warn("accounts", state.problem);
    return { ok: false, message: state.problem };
  }
}

/** What runs before signing out (the cloud's locks let go), while the token still works. */
let before: (() => Promise<void>) | null = null;
export function beforeSignOut(work: () => Promise<void>): void {
  before = work;
}

/** Signs out: the cloud's locks let go, the refresh token revoked at the accounts site (best effort) and forgotten here. */
export async function signOut(app: App): Promise<void> {
  if (before !== null) {
    try {
      await before();
    } catch (error) {
      diag.warn("accounts", `letting go of the cloud's locks before signing out: ${diag.messageOf(error)}`);
    }
  }
  const refresh = await keychain.get(app.store.home);
  if (refresh !== null) {
    try {
      const { status: code, retryAfter } = await post("/app/revoke", { token: refresh });
      // The per-minute limit: revoked once more after it, in the background (it's forgotten here now).
      if (code === 429) runtime.runFork(idle(retryAfter ?? 60_000).pipe(Effect.andThen(postEffect("/app/revoke", { token: refresh })), Effect.ignore));
    } catch (error) {
      diag.warn("accounts", `revoking the sign-in: ${diag.messageOf(error)} (forgotten here anyway)`);
    }
  }
  await keychain.remove(app.store.home);
  forget(null);
  diag.info("accounts", "signed out");
}

/** Opens a URL in the Mac's browser (the sign-in page), never with a secret in it. */
function openBrowser(url: string): void {
  // EDIT_NO_BROWSER: a test drives the sign-in itself.
  if (process.platform !== "darwin" || process.env.EDIT_NO_BROWSER === "1") return;
  const child = spawn("/usr/bin/open", [url], { stdio: "ignore", detached: true });
  child.on("error", (error) => diag.warn("accounts", `opening the browser: ${diag.messageOf(error)}`));
  child.unref();
}

const escape = (text: string) => text.replace(/[<>&"]/gu, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[ch]!);

/**
 * The page the browser lands on after signing in: in Edit's look (the spheceo
 * kit's colours, Inter where it's installed), the one-use code taken out of the address bar at once,
 * an "Open Edit" button to go back by hand, and, with Edit's window open (which
 * comes to the front by itself), a try at closing the tab (a browser may refuse:
 * Edit didn't open it).
 */
function page(ok: boolean, title: string, message: string, windowOpen: boolean): string {
  const close = ok && windowOpen;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<script>history.replaceState(null, "", "/callback");</script>
<style>
:root{color-scheme:dark}
body{margin:0;height:100vh;display:grid;place-items:center;background:#0b0b0b;color:#ededed;font:14px/1.5 "Inter",ui-sans-serif,-apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(380px,calc(100vw - 48px));padding:28px;border:1px solid #242424;border-radius:14px;background:#111111;text-align:left}
.mark{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:600}
.dot{width:8px;height:8px;border-radius:50%;background:${ok ? "#7fd18b" : "#f5a05a"}}
p{margin:10px 0 0;color:#969696}
a{display:inline-flex;margin-top:22px;height:34px;padding:0 12px;align-items:center;border-radius:8px;background:#ff0033;color:#fff;font-weight:500;text-decoration:none}
a:hover{background:#ff2a55}
</style></head><body><main>
<div class="mark"><span class="dot"></span>${escape(title)}</div>
<p>${escape(message)}</p>
<a href="/">Open Edit</a>
</main>${close ? `<script>setTimeout(() => window.close(), 1200);</script>` : ""}</body></html>`;
}

export function routes(router: Router<App>): void {
  router.get("/api/account", () => Response.json(status()));
  // Starts signing in: the browser opens on this Mac; the URL comes back too, for the page to offer.
  router.post("/api/account/sign-in", async (context) => {
    await readJson<unknown>(context).catch(() => ({}));
    const url = begin(context.app);
    openBrowser(url);
    return Response.json({ url });
  });
  // A sign-in with a code, for an Edit used from another device (Tailscale) or headless.
  router.post("/api/account/device", async (context) => {
    await readJson<unknown>(context).catch(() => ({}));
    try {
      await beginDevice(context.app, "remote");
    } catch (error) {
      return Response.json({ error: diag.messageOf(error) }, { status: 502 });
    }
    return Response.json(status());
  });
  router.post("/api/account/sign-out", async ({ app }) => {
    await signOut(app);
    return Response.json(status());
  });
  // The loopback redirect (RFC 8252): the accounts site sends the browser here with the code.
  router.get("/callback", async ({ app, request }) => {
    const done = await finish(app, new URL(request.url).searchParams);
    // Edit's window comes to the front by itself; headless, the page's button goes back.
    const windowOpen = done.ok && windowFocus.attached();
    if (done.ok) windowFocus.focus();
    const message = done.ok ? `Signed in as ${state.person?.email ?? "you"}. ${windowOpen ? "Back to Edit…" : "You can go back to Edit."}` : done.message;
    return new Response(page(done.ok, done.ok ? "Signed in to Edit" : "Couldn't sign in", message, windowOpen), {
      status: done.ok ? 200 : 400,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  });
}

/** Tests: back to signed out with nothing pending. */
/** Tests: someone signed in with these perms (kinds.ts reads them). */
export function signedInForTests(perms: string[], admin = false): void {
  state.person = { sub: "person-test", email: "test@example.com", name: "Test Person", image: null };
  state.perms = perms;
  state.admin = admin;
}

export function resetForTests(): void {
  if (running !== null) runtime.runFork(Fiber.interrupt(running));
  running = null;
  Effect.runSync(Queue.clear(requests));
  forget(null);
  state.pending = null;
  state.device = null;
  state.home = null;
}
