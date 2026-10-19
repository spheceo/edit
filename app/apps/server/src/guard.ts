// Containing bugs. A bug in one request or job must not take the server down
// or leave the job "working" forever: it becomes an ordinary error on the path
// that already handles failure.
//
// Rust tells a failure (`Err(String)`, text meant for the user or agent) from
// a bug (a panic) by type. Here everything throws, so the line is drawn by what
// was thrown: a plain `Error` (or a string) is a failure, passed on as it is;
// the engine's own error types (TypeError for "cannot read properties of
// undefined", RangeError, ReferenceError, SyntaxError…) are what a bug throws,
// and those become "<what> crashed (…); this is a bug in Edit". Code that means
// to fail throws `new Error(text)`.

import * as diag from "./diag.ts";

const BUGS = [TypeError, RangeError, ReferenceError, SyntaxError, EvalError, URIError];

/** Whether `error` is a bug (the JS counterpart of a panic) rather than a failure. */
export function isBug(error: unknown): boolean {
  return BUGS.some((kind) => error instanceof kind);
}

/** What a crash said, for logs and the job's error. */
export function message(payload: unknown): string {
  if (payload instanceof Error) return payload.message;
  if (typeof payload === "string") return payload;
  return "unknown panic";
}

/** Logs a crash and says what crashed (the error text for whoever asked). */
export function crashed(what: string, payload: unknown): string {
  const said = message(payload);
  diag.error("crash", `${what} crashed: ${said}`);
  if (payload instanceof Error && payload.stack !== undefined) diag.info("crash", payload.stack);
  return `${what} crashed (${said}); this is a bug in Edit`;
}

/** Runs `work`; a bug in it throws an Error naming `what`, a failure is thrown as it is. */
export function catchBugs<T>(what: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (isBug(error)) throw new Error(crashed(what, error));
    throw error;
  }
}

/** `catchBugs` for async work. */
export async function catchBugsAsync<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isBug(error)) throw new Error(crashed(what, error));
    throw error;
  }
}

/** Answers a request whose handler had a bug: a JSON error instead of a dropped connection. */
export function panicResponse(payload: unknown): Response {
  return Response.json({ error: crashed("this request", payload) }, { status: 500 });
}
