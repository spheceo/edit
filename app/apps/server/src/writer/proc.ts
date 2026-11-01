// Running a program for Script mode (ffmpeg, ffprobe, yt-dlp): its output a
// line at a time or whole, stopped by a deadline or the job's stop.
//
// In Effect since Nov 1 (docs/plans/2026-11-01-effect.md, part 3): the
// program runs in its own process group, owned by the scope that started it.
// A stop, a deadline or a failure of the work around it ends the whole
// group (SIGTERM, then SIGKILL after 5 s): the old runner SIGKILLed only the
// program it started, so yt-dlp's own FFmpeg (it merges and remuxes with
// one) went on downloading after its import was stopped.

import { Effect, Fiber, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { runPromise } from "../effect/runtime.ts";
import { lastLine } from "../tools.ts";

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: Uint8Array | string;
  onLine?: (line: string) => void;
  /** The output's bytes as they come (a pipe of samples), instead of lines. */
  onBytes?: (chunk: Uint8Array) => void;
  env?: Record<string, string | undefined>;
}

/** What a stopped job's programs say, the same for every step. */
export const STOPPED = "Stopped by you. Completed work is saved.";

/** The program couldn't be started (not found, not executable). */
export class ProgramNotStarted extends Schema.TaggedError<ProgramNotStarted>()("ProgramNotStarted", { message: Schema.String }) {}
/** The program ran past its deadline and was stopped. */
export class ProgramTimedOut extends Schema.TaggedError<ProgramTimedOut>()("ProgramTimedOut", { message: Schema.String }) {}
/** The program exited with a code other than 0: its last line of errors. */
export class ProgramFailed extends Schema.TaggedError<ProgramFailed>()("ProgramFailed", { exitCode: Schema.Number, message: Schema.String }) {}

export type ProgramError = ProgramNotStarted | ProgramTimedOut | ProgramFailed;

/** The lines of a stream of text, as the old runner cut them: at "\n", a trailing "\r" taken off (yt-dlp's "\r" progress stays one line). */
function eachLine(onLine: (line: string) => void) {
  let pending = "";
  return {
    take: (text: string) =>
      Effect.sync(() => {
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) onLine(line.replace(/\r$/, ""));
      }),
    end: Effect.sync(() => {
      if (pending !== "") onLine(pending);
    }),
  };
}

/** Runs `program` to its end: its standard output (empty when it's given to `onLine` or `onBytes`). */
export const runProgram = Effect.fn("writer.proc.run")(function* (program: string, args: readonly string[], options: Omit<RunOptions, "signal"> = {}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const work = Effect.gen(function* () {
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(program, [...args], {
          stdin: options.stdin === undefined ? "ignore" : Stream.make(typeof options.stdin === "string" ? new TextEncoder().encode(options.stdin) : options.stdin),
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: "5 seconds",
          // As Bun.spawn's `env`: the whole environment, not added to this one.
          ...(options.env ? { env: options.env, extendEnv: false } : {}),
        }),
      )
      .pipe(Effect.mapError((error) => new ProgramNotStarted({ message: `${program} failed to start (${error.message}).` })));
    const errors = yield* Stream.mkString(Stream.decodeText(handle.stderr)).pipe(Effect.orElseSucceed(() => ""), Effect.forkScoped);
    let out = "";
    if (options.onBytes) {
      const onBytes = options.onBytes;
      yield* Stream.runForEach(handle.stdout, (chunk) => Effect.sync(() => onBytes(chunk))).pipe(Effect.ignore);
    } else if (options.onLine) {
      const lines = eachLine(options.onLine);
      yield* Stream.runForEach(Stream.decodeText(handle.stdout), lines.take).pipe(Effect.ignore);
      yield* lines.end;
    } else {
      out = yield* Stream.mkString(Stream.decodeText(handle.stdout)).pipe(Effect.orElseSucceed(() => ""));
    }
    const code = Number(yield* handle.exitCode.pipe(Effect.orElseSucceed(() => -1)));
    const stderr = yield* Fiber.join(errors);
    if (code !== 0) return yield* new ProgramFailed({ exitCode: code, message: lastLine(stderr, `${program} failed (exit ${code})`) });
    return out;
  }).pipe(Effect.scoped);
  return yield* work.pipe(
    Effect.timeoutOrElse({
      duration: options.timeoutMs ?? 3_600_000,
      orElse: () => Effect.fail(new ProgramTimedOut({ message: `${program} took too long and was stopped.` })),
    }),
  );
});

/** Runs `program` to its end: its standard output, or an Error saying why it failed (its last line of errors). */
export function run(program: string, args: string[], options: RunOptions = {}): Promise<string> {
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(new Error(STOPPED));
  return runPromise(runProgram(program, args, options), signal ? { signal } : undefined).catch((error: unknown) => {
    // Interrupted by the job's stop: its group was ended on the way out.
    if (signal?.aborted) throw new Error(STOPPED);
    throw error;
  });
}
