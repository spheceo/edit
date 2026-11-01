// Child processes owned by the work that started them (plan part 3). A
// process runs inside a scope: when the effect that wanted it ends, fails or
// is interrupted (a sibling failed, a request was cancelled, Edit is
// quitting), its whole process group is sent SIGTERM, then SIGKILL after
// `FORCE_KILL_AFTER`. FFmpegs, Chromes and claudes left running after the
// work that wanted them was gone came back four times (533b9804, acf1941a,
// 897fbeef, 224ab730); Bun.spawn left that to each caller.

import { Effect, Predicate, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as service from "./service.ts";

/** How long a process may take to end after SIGTERM before it's killed. */
const FORCE_KILL_AFTER = "5 seconds";

/** The program couldn't be started at all (not found, not executable). */
export class ProcessNotStarted extends Schema.TaggedError<ProcessNotStarted>()("ProcessNotStarted", {
  command: Schema.String,
  message: Schema.String,
}) {}

/** The program ran and exited with a code other than 0. */
export class ProcessFailed extends Schema.TaggedError<ProcessFailed>()("ProcessFailed", {
  command: Schema.String,
  exitCode: Schema.Number,
  stderr: Schema.String,
  message: Schema.String,
}) {}

/** The program ran past the time it was given and was ended (its whole group). */
export class ProcessTimedOut extends Schema.TaggedError<ProcessTimedOut>()("ProcessTimedOut", {
  command: Schema.String,
  afterMs: Schema.Number,
  message: Schema.String,
}) {}

/**
 * What a program's last words say about its failure (FFmpeg's above all,
 * reading R2 or Drive over the network): a connection dropped, reset or
 * timed out, or a 5xx from the server it read, is temporary; anything else
 * (a damaged file, a missing stream, a bad option) is permanent.
 */
export function failureKind(stderr: string): service.Kind {
  return /connection (reset|refused|timed out)|\btimed out\b|Server returned 5\d\d|HTTP error 5\d\d|Broken pipe|network is unreachable|could not resolve host|temporary failure in name resolution/i.test(stderr)
    ? "temporary"
    : "permanent";
}

service.kinds({
  ProcessNotStarted: "permanent",
  ProcessTimedOut: "temporary",
  ProcessFailed: (error) => failureKind(Predicate.hasProperty(error, "stderr") && typeof error.stderr === "string" ? error.stderr : ""),
});

export interface Output {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** What `capture` answers: the output as bytes. */
export interface Captured {
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Runs `command` to its end within `timeoutMs` (its whole group ended when
 * the time runs out, or when the work around it is interrupted), its output
 * as bytes, whatever its exit code. stdin is closed.
 */
export const capture = Effect.fn("proc.capture")(function* (command: string, args: readonly string[], timeoutMs: number) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(command, [...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", forceKillAfter: FORCE_KILL_AFTER }));
      const [chunks, stderr, exitCode] = yield* Effect.all([Stream.runCollect(handle.stdout), Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode], { concurrency: "unbounded" });
      const parts = [...chunks];
      const stdout = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let at = 0;
      for (const part of parts) {
        stdout.set(part, at);
        at += part.length;
      }
      return { stdout, stderr, exitCode: Number(exitCode) } satisfies Captured;
    }),
  ).pipe(
    Effect.mapError((cause) => new ProcessNotStarted({ command: name(command), message: `${name(command)} could not be started: ${cause.message}` })),
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new ProcessTimedOut({ command: name(command), afterMs: timeoutMs, message: `${name(command)} ran for more than ${Math.round(timeoutMs / 60_000)} min and was stopped` })),
    }),
  );
});

const name = (command: string) => command.slice(command.lastIndexOf("/") + 1);

/**
 * Runs `command` with `args` to its end and answers what it wrote and its
 * exit code, whatever the code. stdin is closed; stdout is read only when
 * `stdout` is "pipe" (the default), else ignored.
 */
export const output = Effect.fn("proc.output")(function* (
  command: string,
  args: readonly string[],
  options: { readonly stdout?: "pipe" | "ignore" } = {},
): Effect.fn.Return<Output, ProcessNotStarted, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const piped = (options.stdout ?? "pipe") === "pipe";
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], { stdin: "ignore", stdout: piped ? "pipe" : "ignore", stderr: "pipe", forceKillAfter: FORCE_KILL_AFTER }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [piped ? Stream.mkString(Stream.decodeText(handle.stdout)) : Effect.succeed(""), Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode: Number(exitCode) };
    }),
  ).pipe(Effect.mapError((cause) => new ProcessNotStarted({ command: name(command), message: `${name(command)} could not be started: ${cause.message}` })));
});

/** `output`, failing with `ProcessFailed` (its stderr in the message) unless the program exits 0. */
export const run = Effect.fn("proc.run")(function* (command: string, args: readonly string[], options: { readonly stdout?: "pipe" | "ignore" } = {}) {
  const done = yield* output(command, args, options);
  if (done.exitCode !== 0) {
    const stderr = done.stderr.trim();
    return yield* new ProcessFailed({
      command: name(command),
      exitCode: done.exitCode,
      stderr,
      message: stderr === "" ? `${name(command)} exited with code ${done.exitCode}` : stderr,
    });
  }
  return done;
});
