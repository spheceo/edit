// Running a program for Script mode (ffmpeg, ffprobe, yt-dlp): its output a
// line at a time or whole, stopped by a deadline or the job's stop.

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

/** Runs `program` to its end: its standard output, or an Error saying why it failed (its last line of errors). */
export async function run(program: string, args: string[], options: RunOptions = {}): Promise<string> {
  if (options.signal?.aborted) throw new Error("Stopped by you. Completed work is saved.");
  let child: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([program, ...args], {
      stdin: options.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...(options.env ? { env: options.env } : {}),
    }) as Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  } catch (error) {
    throw new Error(`${program} failed to start (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (options.stdin !== undefined) {
    const sink = child.stdin as Bun.FileSink;
    void sink.write(options.stdin);
    void sink.end();
  }
  let killed: "time" | "stop" | null = null;
  const kill = (why: "time" | "stop") => {
    killed ??= why;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => kill("time"), options.timeoutMs ?? 3_600_000);
  const stop = () => kill("stop");
  options.signal?.addEventListener("abort", stop, { once: true });
  const errors = new Response(child.stderr).text();
  let out = "";
  try {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of child.stdout) {
      if (options.onBytes) {
        options.onBytes(chunk);
        continue;
      }
      const text = decoder.decode(chunk, { stream: true });
      if (options.onLine) {
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) options.onLine(line.replace(/\r$/, ""));
      } else out += text;
    }
    if (options.onLine && pending !== "") options.onLine(pending);
    const code = await child.exited;
    if (killed === "stop") throw new Error("Stopped by you. Completed work is saved.");
    if (killed === "time") throw new Error(`${program} took too long and was stopped.`);
    if (code !== 0) throw new Error(lastLine(await errors, `${program} failed (exit ${code})`));
    return out;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
  }
}
