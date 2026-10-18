// Edit's relay (apps/relay/): the Cloudflare Worker that holds every API key,
// so Edit installs never do. `EDIT_RELAY_URL` points at another relay (e.g.
// `wrangler dev`), and `EDIT_RELAY_TOKEN` is sent as `Authorization: Bearer`.
// The Rust server went through curl to have no TLS stack of its own; Bun's
// fetch has one, so requests go straight out. Nothing secret is ever put in a
// child process's arguments: what still runs curl gets `authConfig` on stdin.

import * as fs from "node:fs";

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

/** The token saved in Settings → Cloud (`cloud_projects`). */
let savedToken: string | null = null;

/** `EDIT_RELAY_TOKEN`, when set and not empty, else the token saved in Settings → Cloud. */
export function token(): string | null {
  return envToken() ?? savedToken;
}

/** `EDIT_RELAY_TOKEN`, when set and not empty (it wins over the setting). */
export function envToken(): string | null {
  const value = process.env.EDIT_RELAY_TOKEN;
  return value !== undefined && value !== "" ? value : null;
}

/** The token to use when `EDIT_RELAY_TOKEN` isn't set (Settings → Cloud). */
export function setSavedToken(value: string | null): void {
  savedToken = value !== null && value !== "" ? value : null;
}

/**
 * Whether cloud calls can work: a relay token is set (`EDIT_RELAY_TOKEN`, else
 * the one saved in Settings → Cloud). Cloud is always on with one (here,
 * not in cloud.ts, because the store and import ask it).
 */
export function cloudEnabled(): boolean {
  return token() !== null;
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
