// The FFmpeg Edit runs. Releases ship it beside the `edit` binary as
// `edit-ffmpeg` / `edit-ffprobe` (named so they never shadow the user's own on
// PATH), or in Edit.app's Resources; a dev run falls back to the ones on PATH.
// `EDIT_FFMPEG` / `EDIT_FFPROBE` point at others.

import * as fs from "node:fs";

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

/** Whether the FFmpeg in use is the one shipped with Edit. */
export function bundled(): boolean {
  return isAbsolute(ffmpeg());
}

/** Forgets what was found (tests that change the environment). */
export function forget(): void {
  found.clear();
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

/**
 * Runs FFmpeg (or any tool) to the end, stdin closed. Its stdout, or why it
 * failed: the last line it wrote (as the engine's media.rs `run` says it).
 */
export async function run(command: string[]): Promise<Uint8Array> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new Error(`ffmpeg is not available (${(error as Error).message}); install FFmpeg`);
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(lastLine(stderr));
  return stdout;
}
