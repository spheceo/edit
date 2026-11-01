// Child processes owned by the work that started them (plan part 3). A
// process runs inside a scope: when the effect that wanted it ends, fails or
// is interrupted (a sibling failed, a request was cancelled, Edit is
// quitting), its whole process group is sent SIGTERM, then SIGKILL after
// `FORCE_KILL_AFTER`. FFmpegs, Chromes and claudes left running after the
// work that wanted them was gone came back four times (533b9804, acf1941a,
// 897fbeef, 224ab730); Bun.spawn left that to each caller.

import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

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

export interface Output {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

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
