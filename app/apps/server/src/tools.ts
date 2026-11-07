// The FFmpeg Edit runs. Releases ship it beside the `edit` binary as
// `edit-ffmpeg` / `edit-ffprobe` (named so they never shadow the user's own on
// PATH), or in Edit.app's Resources; a dev run falls back to the ones on PATH.
// `EDIT_FFMPEG` / `EDIT_FFPROBE` point at others.

import * as fs from "node:fs";

import { Effect } from "effect";

import * as proc from "./effect/proc.ts";
import { runPromise } from "./effect/runtime.ts";

import { native } from "./native/index.ts";
import { isAbsolute, isFile, join, parent } from "./paths.ts";

const found = new Map<string, string>();

export function ffmpeg(): string {
  return cached("ffmpeg", "EDIT_FFMPEG");
}

export function ffprobe(): string {
  return cached("ffprobe", "EDIT_FFPROBE");
}

/**
 * The qjs (QuickJS-ng) Edit ships beside `edit` as yt-dlp's JavaScript
 * runtime (`youtube.ts`): `EDIT_QJS`, else `qjs-<target>` beside the binary
 * or in Edit.app's Resources, fetched by `scripts/fetch-quickjs.sh`; null on
 * a Mac with no bundled copy (a dev run), where an installed runtime serves.
 */
export function qjs(): string | null {
  const given = process.env.EDIT_QJS;
  if (given !== undefined && given !== "") return given;
  const triple =
    process.platform === "darwin" && process.arch === "arm64"
      ? "aarch64-apple-darwin"
      : process.platform === "darwin" && process.arch === "x64"
        ? "x86_64-apple-darwin"
        : null;
  if (triple === null) return null;
  let beside: string | null = null;
  try {
    beside = parent(fs.realpathSync(process.execPath));
  } catch {
    beside = null;
  }
  if (beside === null) return null;
  const name = `qjs-${triple}`;
  for (const candidate of [join(beside, name), join(beside, "../Resources", name)]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** The video hardware FFmpeg encodes H.264 on here. */
export type VideoHardware = "videotoolbox" | "nvenc";
let hardware: VideoHardware | null | undefined;

/**
 * This machine's video hardware: VideoToolbox on a Mac; NVENC where an NVIDIA
 * card's driver answers, tried once with a one-frame encode (FFmpeg lists
 * h264_nvenc with no card or driver at all: Nov 7, Ubuntu on nouveau); else
 * null, and libx264 encodes.
 */
export function videoHardware(): VideoHardware | null {
  if (hardware !== undefined) return hardware;
  if (process.platform === "darwin") return (hardware = "videotoolbox");
  try {
    const tried = Bun.spawnSync([ffmpeg(), "-hide_banner", "-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=black:s=256x144:r=30:d=0.1", "-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "/dev/null"], { stdout: "ignore", stderr: "ignore", timeout: 20_000 });
    hardware = tried.exitCode === 0 ? "nvenc" : null;
  } catch {
    hardware = null;
  }
  return hardware;
}

/**
 * `-c:v` for H.264 on the video hardware, with its speed setting (the rate
 * options are the caller's: `-b:v`, `-maxrate`, `-g` and `-bf` mean the same to
 * each); null where there's none.
 */
export function hardwareH264(): string[] | null {
  const found = videoHardware();
  if (found === "videotoolbox") return ["-c:v", "h264_videotoolbox"];
  if (found === "nvenc") return ["-c:v", "h264_nvenc", "-preset", "p4"];
  return null;
}

/** As `hardwareH264`, else libx264 at `veryfast`. */
export function h264(): string[] {
  return hardwareH264() ?? ["-c:v", "libx264", "-preset", "veryfast"];
}

/** Decoding on the video hardware, frames handed back in memory (the filters are FFmpeg's): `-hwaccel …`, or none. */
export function hardwareDecode(): string[] {
  const found = videoHardware();
  if (found === "videotoolbox") return ["-hwaccel", "videotoolbox"];
  if (found === "nvenc") return ["-hwaccel", "cuda"];
  return [];
}

/** Whether the FFmpeg in use is the one shipped with Edit. */
export function bundled(): boolean {
  return isAbsolute(ffmpeg());
}

/** Forgets what was found (tests that change the environment). */
export function forget(): void {
  found.clear();
  hardware = undefined;
}

function cached(tool: string, variable: string): string {
  let path = found.get(tool);
  if (path === undefined) {
    path = find(tool, variable);
    found.set(tool, path);
  }
  return path;
}

function find(tool: string, variable: string): string {
  const given = process.env[variable];
  if (given !== undefined && given !== "") return given;
  // The binary that was started (process.execPath: the compiled `edit`, or bun in dev).
  let beside: string | null = null;
  try {
    beside = parent(fs.realpathSync(process.execPath));
  } catch {
    beside = null;
  }
  const shipped = `edit-${tool}`;
  const candidates = beside === null ? [] : [join(beside, shipped), join(beside, "../Resources", shipped)];
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return tool;
}

/**
 * A media file's cache folder (where `media.Processor.paths` keeps its
 * previews and waveform), for work that has no `App` at hand; null before the
 * addon knows the cache folder.
 */
export function mediaCache(source: string): string | null {
  return native().mediaCache(source);
}

/**
 * Whether `path` is an http(s) URL (a cloud original read through a
 * presigned URL, `cloud_media`) rather than a file.
 */
export function isUrl(path: string): boolean {
  return path.startsWith("https://") || path.startsWith("http://");
}

/**
 * The protocols FFmpeg may use to read `path`: files and pipes, plus HTTPS for
 * a URL (never for a file, so a crafted playlist can't reach the network).
 */
export function protocols(path: string): string {
  return isUrl(path) ? "file,pipe,http,https,tcp,tls,crypto" : "file,pipe";
}

const SYSTEM_CERTIFICATES = "/etc/ssl/cert.pem";
// A read that gets nothing for 30 s fails (and reconnects) rather than waiting forever.
const RECONNECT = [
  "-reconnect",
  "1",
  "-reconnect_on_network_error",
  "1",
  "-reconnect_delay_max",
  "10",
  "-rw_timeout",
  "30000000",
];
let certificates: boolean | null = null;

/**
 * FFmpeg's input options for reading `path` over HTTPS: the system's
 * certificates (the shipped static FFmpeg's OpenSSL doesn't know where macOS
 * keeps them, so without them every HTTPS read fails verification), and
 * picking a long read from R2 back up when the connection drops.
 */
export function urlArgs(path: string): string[] {
  if (!isUrl(path)) return [];
  certificates ??= isFile(SYSTEM_CERTIFICATES);
  // Plain HTTP (a local stand-in) has no TLS to give certificates to.
  return certificates && path.startsWith("https:") ? ["-ca_file", SYSTEM_CERTIFICATES, ...RECONNECT] : [...RECONNECT];
}

/** The last non-empty line of FFmpeg's stderr: what it says went wrong. */
export function lastLine(stderr: string, fallback = "ffmpeg failed"): string {
  const line = stderr
    .split("\n")
    .reverse()
    .find((text) => text.trim() !== "");
  return (line ?? fallback).trim();
}

/** How long a tool may run before it's taken as stuck and ended (a review copy of a long edit takes a while; none takes this long). */
export const TOOL_MS = 4 * 3600_000;

/**
 * Runs FFmpeg (or any tool) to the end within `timeoutMs`, stdin closed: its
 * stdout, or why it failed, the last line it wrote (as the engine's
 * media.rs `run` says it). In Effect since Nov 1 (docs/plans/2026-11-01-effect.md,
 * round 2, area 4): the tool's whole process group is the run's, ended when
 * its time runs out or the work around it is interrupted, and its failures
 * are typed with kinds (`proc.failureKind`: a network read that dropped is
 * temporary, a damaged file permanent).
 */
export const runTool = Effect.fn("tools.run")(function* (command: readonly string[], timeoutMs: number = TOOL_MS) {
  const [program = "", ...args] = command;
  const done = yield* proc.capture(program, args, timeoutMs).pipe(
    Effect.mapError((error) =>
      error._tag === "ProcessNotStarted" ? new proc.ProcessNotStarted({ command: error.command, message: `ffmpeg is not available (${error.message}); install FFmpeg` }) : error,
    ),
  );
  if (done.exitCode !== 0) {
    return yield* new proc.ProcessFailed({ command: program.slice(program.lastIndexOf("/") + 1), exitCode: done.exitCode, stderr: done.stderr, message: lastLine(done.stderr) });
  }
  return done.stdout;
});

/** `runTool` for code that isn't Effect yet; `signal` ends the tool's group. */
export function run(command: string[], options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<Uint8Array> {
  return runPromise(runTool(command, options.timeoutMs), options.signal ? { signal: options.signal } : undefined);
}
