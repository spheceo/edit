// The server's Effect runtime: what every part written in Effect runs on
// (docs/plans/2026-11-01-effect.md). Parts keep their Promise functions for
// the code that isn't Effect yet; those call `runPromise` here, which turns a
// typed failure back into the `Error` its message has always been, so the
// UI, the log and the problem reports read the same words.
//
// Effect's log lines go where every other line goes (diag.ts: edit.log, the
// recent log, the reports), under the `area` annotation (`inArea`).

import { BunServices } from "@effect/platform-bun";
import { Cause, Duration, Effect, Layer, Logger, LogLevel, ManagedRuntime, References } from "effect";

import * as diag from "../diag.ts";

/** Lines with no `area` annotation are the server's own. */
const DEFAULT_AREA = "server";

const text = (message: unknown): string => (Array.isArray(message) ? message.map(String).join(" ") : String(message));

/** Effect's logger, writing through diag: info and debug as info, warnings as warn, errors and fatals as error. */
export const diagLogger = Logger.make(({ message, logLevel, cause, fiber }) => {
  const annotations = fiber.getRef(References.CurrentLogAnnotations);
  const area = typeof annotations["area"] === "string" ? annotations["area"] : DEFAULT_AREA;
  const failure = cause.reasons.length === 0 ? "" : `: ${Cause.pretty(cause)}`;
  const line = `${text(message)}${failure}`;
  if (LogLevel.isGreaterThanOrEqualTo(logLevel, "Error")) diag.error(area, line);
  else if (LogLevel.isGreaterThanOrEqualTo(logLevel, "Warn")) diag.warn(area, line);
  else diag.info(area, line);
});

/** Log lines inside `effect` are under `area` ("media", "writer"…), as diag's are. */
export const inArea =
  (area: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.annotateLogs(effect, "area", area);

/**
 * A background wait that never keeps the process alive by itself, as an
 * unref'd timer doesn't: a short `edit` command that renewed a sign-in on
 * the way exits when it's done, not when the next renewal is due. Work that
 * must finish uses `Effect.sleep`.
 */
export const idle = (duration: Duration.Input): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(Duration.fromInputUnsafe(duration)));
    timer.unref?.();
    return Effect.sync(() => clearTimeout(timer));
  });

/** Everything a part may need from the platform: child processes, files, paths. */
export const ServerLive = Layer.mergeAll(BunServices.layer, Logger.layer([diagLogger]));

export const runtime = ManagedRuntime.make(ServerLive);

/** The services the runtime provides. */
export type Services = ManagedRuntime.ManagedRuntime.Services<typeof runtime>;

/**
 * Runs `effect` for code that isn't Effect yet. A failure rejects with an
 * `Error` carrying the failure's own message (a typed error is one already),
 * so callers and their tests see the words they always have; a defect
 * rejects with the defect itself.
 */
export function runPromise<A, E extends { readonly message: string }>(effect: Effect.Effect<A, E, Services>, options?: { readonly signal?: AbortSignal }): Promise<A> {
  return runtime.runPromise(effect, options);
}
