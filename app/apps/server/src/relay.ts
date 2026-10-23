// Edit's relay (apps/relay/): the Cloudflare Worker that holds every API key,
// so Edit installs never do. It answers signed-in people only: every call
// carries the person's access token (accounts.ts). `EDIT_RELAY_URL` points at
// another relay (e.g. `wrangler dev`), and `EDIT_RELAY_TOKEN`, for tests and
// local relays only, is sent as the bearer instead.
// Requests go out through Bun's fetch. Nothing secret is ever put in a
// child process's arguments: what still runs curl gets `authConfig` on stdin.

import * as fs from "node:fs";

import * as accounts from "./accounts.ts";
import { messageOf } from "./diag.ts";
import { serdeParse } from "./rust.ts";

const DEFAULT_RELAY = "https://edit-relay.sphe-g-personal.workers.dev";

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
  return new Response(answer.body, { status: answer.status, headers });
}

/** Sends one request to the relay; a network failure is `UNREACHABLE: <why>`. */
async function send(method: string, route: string, body: unknown, timeoutSeconds: number): Promise<Response> {
  const headers: Record<string, string> = authHeaders();
  let payload: string | undefined;
  if (body !== undefined && body !== null) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  try {
    return await fetch(`${url()}${route}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
  } catch (error) {
    throw new Error(`${UNREACHABLE}: ${messageOf(error)}`);
  }
}

/**
 * One relay request: the answer goes to `out`; a failure comes back with the
 * relay's (or the service behind it's) reason. On success, the request id the
 * relay passed on (`x-request-id`), if any.
 */
export async function call(
  method: string,
  route: string,
  body: unknown,
  out: string,
  feature: string,
): Promise<string | null> {
  const response = await send(method, route, body, 300);
  let answer: Uint8Array;
  try {
    answer = await response.bytes();
  } catch (error) {
    throw new Error(`${UNREACHABLE}: ${messageOf(error)}`);
  }
  if (response.status === 200) {
    fs.writeFileSync(out, answer);
    const request = (response.headers.get("x-request-id") ?? "").trim();
    return request === "" ? null : request;
  }
  fs.rmSync(out, { force: true });
  throw new Error(failure(String(response.status), answer, feature));
}

/** A relay request whose answer is JSON. `timeout` is in seconds. */
export async function json<T = unknown>(
  method: string,
  route: string,
  body: unknown,
  feature: string,
  timeout: number,
): Promise<T> {
  const response = await send(method, route, body, timeout);
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new Error(`${UNREACHABLE}: ${messageOf(error)}`);
  }
  if (response.status !== 200) throw new Error(failure(String(response.status), text, feature));
  try {
    return serdeParse(text) as T;
  } catch (error) {
    throw new Error(`the relay's answer: ${messageOf(error)}`);
  }
}
