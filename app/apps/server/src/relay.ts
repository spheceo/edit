// Edit's relay (apps/relay/): the Cloudflare Worker that holds every API key,
// so Edit installs never do. It answers signed-in people only: every call
// carries the person's access token (accounts.ts). `EDIT_RELAY_URL` points at
// another relay (e.g. `wrangler dev`), and `EDIT_RELAY_TOKEN`, for tests and
// local relays only, is sent as the bearer instead.
// Requests go out through Bun's fetch. Nothing secret is ever put in a
// child process's arguments: what still runs curl gets `authConfig` on stdin.

import * as fs from "node:fs";

import { Effect, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import * as accounts from "./accounts.ts";
import { messageOf } from "./diag.ts";
import { runPromise } from "./effect/runtime.ts";
import * as service from "./effect/service.ts";
import { serdeParse } from "./rust.ts";

export const DEFAULT_RELAY = "https://edit-relay.sphe-g-personal.workers.dev";

/** The relay's base URL. */
export function url(): string {
  return process.env.EDIT_RELAY_URL ?? DEFAULT_RELAY;
}

/**
 * The start of every error that means the relay couldn't be reached at all
 * (offline), as opposed to one it answered.
 */
export const UNREACHABLE = "could not reach Edit's relay";

/** The signed-in person's access token (accounts.ts), else `EDIT_RELAY_TOKEN` (tests, a local relay), else none. */
export function token(): string | null {
  return accounts.accessToken() ?? envToken();
}

/** `EDIT_RELAY_TOKEN`, when set and not empty: for tests and local relays (the team's relay takes only people). */
export function envToken(): string | null {
  const value = process.env.EDIT_RELAY_TOKEN;
  return value !== undefined && value !== "" ? value : null;
}

/**
 * Whether cloud calls can work: someone is signed in (a sign-in kept, even
 * while its access token is being renewed), or `EDIT_RELAY_TOKEN` is set.
 * Here, not in cloud.ts, because the store and import ask it.
 */
export function cloudEnabled(): boolean {
  return envToken() !== null || accounts.hasSession();
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * curl config lines that authenticate with `token` (none without one).
 * Rejects a token that could add config or headers.
 */
export function authConfig(value: string | null): string {
  if (value === null || value === "") return "";
  if (CONTROL.test(value)) throw new Error("EDIT_RELAY_TOKEN contains a control character");
  return `header = "Authorization: Bearer ${quote(value)}"\n`;
}

/** The relay's auth header (none without a token); refuses a token that could add headers. */
export function authHeaders(value: string | null = token()): Record<string, string> {
  if (value === null || value === "") return {};
  if (CONTROL.test(value)) throw new Error("EDIT_RELAY_TOKEN contains a control character");
  return { authorization: `Bearer ${value}` };
}

/** Escapes a value for a double-quoted curl config string. */
export function quote(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * The relay's reason for a failed request: its `{error}`, else the start of
 * the body. A 404 `not found` from the relay itself means it predates
 * `feature` (it needs deploying).
 */
export function failure(code: string, answer: Uint8Array | string, feature: string): string {
  const text = typeof answer === "string" ? answer : new TextDecoder().decode(answer);
  let message: string | null = null;
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === "object" && value !== null && typeof (value as { error?: unknown }).error === "string") {
      message = (value as { error: string }).error;
    }
  } catch {
    message = null;
  }
  message ??= [...text].slice(0, 300).join("");
  if (code === "404" && message === "not found") return `Edit's relay doesn't do ${feature} yet (it needs deploying).`;
  return `${message} (${code})`;
}

/**
 * The map page's tiles (`GET /v1/3dtiles/…` on Edit's own server, where
 * the page fetches them): passed on to the relay with this Edit's token, so
 * headless Chrome never holds one and a long render outlives the hour a
 * token lasts.
 */
export async function forwardTiles(request: Request, from: URL): Promise<Response> {
  let answer: Response;
  try {
    answer = await fetch(`${url()}${from.pathname}${from.search}`, {
      headers: { ...authHeaders(), accept: request.headers.get("accept") ?? "*/*" },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: `${UNREACHABLE}: ${messageOf(error)}` }), { status: 502, headers: { "content-type": "application/json" } });
  }
  const headers = new Headers();
  for (const name of ["content-type", "content-length", "cache-control", "etag"]) {
    const value = answer.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // The map page asks from its own address (checked by `mapSibling`).
  const origin = request.headers.get("origin");
  if (origin !== null) headers.set("access-control-allow-origin", origin);
  return new Response(answer.body, { status: answer.status, headers });
}

/**
 * One relay request: the answer goes to `out`; a failure comes back with the
 * relay's (or the service behind it's) reason. On success, the request id the
 * relay passed on (`x-request-id`), if any. On `ask` (below): a timed
 * request, a refused token renewed once.
 */
export function call(method: string, route: string, body: unknown, out: string, feature: string): Promise<string | null> {
  return runPromise(
    Effect.gen(function* () {
      const answer = yield* ask(method, route, body, 300_000);
      if (answer.status === 200) {
        fs.writeFileSync(out, answer.body);
        const request = (answer.headers.get("x-request-id") ?? "").trim();
        return request === "" ? null : request;
      }
      fs.rmSync(out, { force: true });
      return yield* new service.ServiceRefused({ service: SERVICE, status: answer.status, retryAfterMs: service.retryAfterOf(answer.headers), message: failure(String(answer.status), answer.body, feature) });
    }),
  );
}

// ── The relay as an Effect (docs/plans/2026-11-01-effect.md, round 2) ──
//
// One request (`ask`): timed, a dropped connection and a timeout both said
// as "could not reach Edit's relay" (what the sync loops read as offline),
// a 401 with a person's token renewed once and asked again. Its JSON
// (`askJson`): a status other than 200 is `ServiceRefused` in the relay's own
// words (`failure`), an answer that isn't JSON or not what `schema` says is
// `AnswerInvalid`. Its errors' kinds are effect/service.ts's: temporary
// (unreachable, timed out, 408/429/5xx) or by status.

export const SERVICE = "Edit's relay";

/** One request to the relay; any status is answered. */
export const ask = Effect.fn("relay.ask")(function* (method: string, route: string, body: unknown, timeoutMs: number) {
  for (let again = false; ; again = true) {
    const used = token();
    const headers: Record<string, string> = authHeaders(used);
    let payload: string | undefined;
    if (body !== undefined && body !== null) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const answer = yield* service.request(SERVICE, `${url()}${route}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) }, timeoutMs).pipe(
      Effect.mapError((error) =>
        error._tag === "ServiceUnreachable"
          ? new service.ServiceUnreachable({ service: SERVICE, message: `${UNREACHABLE}: ${error.message.replace(/^could not reach Edit's relay: /, "")}` })
          : new service.ServiceTimedOut({ service: SERVICE, afterMs: error.afterMs, message: `${UNREACHABLE}: it didn't answer within ${Math.round(error.afterMs / 1000)} s` }),
      ),
    );
    // Refused with a person's token: renewed once (a cut-off refuses tokens made before it).
    if (answer.status === 401 && !again && used !== null && used !== envToken() && (yield* Effect.promise(() => accounts.renewRefused(used)))) continue;
    return answer;
  }
});

/** `ask` with a JSON answer checked against `schema` (anything, by default). */
export const askJson = <S extends Schema.Top = typeof Schema.Unknown>(method: string, route: string, body: unknown, feature: string, timeoutMs: number, schema?: S) =>
  Effect.gen(function* () {
    const answer = yield* ask(method, route, body, timeoutMs);
    if (answer.status !== 200) {
      return yield* new service.ServiceRefused({ service: SERVICE, status: answer.status, retryAfterMs: service.retryAfterOf(answer.headers), message: failure(String(answer.status), answer.body, feature) });
    }
    const value = yield* Effect.try({ try: () => serdeParse(answer.text()) as unknown, catch: (error) => new service.AnswerInvalid({ service: SERVICE, message: `the relay's answer: ${messageOf(error)}` }) });
    return yield* service.decodeValue(SERVICE, schema ?? Schema.Unknown, value);
  }) as Effect.Effect<S["Type"], service.ServiceError, S["DecodingServices"] | ChildProcessSpawner.ChildProcessSpawner>;

/** A relay request whose answer is JSON. `timeout` is in seconds. */
export function json<T = unknown>(method: string, route: string, body: unknown, feature: string, timeout: number): Promise<T> {
  return runPromise(askJson(method, route, body, feature, timeout * 1000)) as Promise<T>;
}
