// A review copy is checked before it's shared (Nov 1: four went up with each
// piece's last frame held to the export's end, Kroger's 82.5 minutes as 17
// hours, and nothing said so). Its picture plays as long as the export's,
// frame for frame, and its sound as long as its picture. The edit's own
// length isn't asked: an export can differ from it (Off-Duty Officer's,
// Oct 29), and the copy stands for the export. The cloud's copy is checked by
// the worker before it goes up (review_runtime.copy_problem, the same rule).
// Since Nov 8 the sound counts as the picture does (a copy without the
// export's sound, or with sound of another length, is refused) and the copy
// is decoded at its ends and a few points between: Female Police Captain v2
// (Nov 7) had every length right and wouldn't play in Chrome ("Failed to send
// audio packet").

import * as tools from "./tools.ts";

/** A file's picture (seconds and frames) and sound (seconds), as its streams declare them. */
export interface Lengths {
  video: number | null;
  frames: number | null;
  audio: number | null;
}

const NONE: Lengths = { video: null, frames: null, audio: null };

const numberOf = (value: unknown): number | null => {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** `value` as lengths when it's one (the cloud's answer), else null. */
export function asLengths(value: unknown): Lengths | null {
  if (typeof value !== "object" || value === null) return null;
  const { video, frames, audio } = value as Record<string, unknown>;
  return { video: numberOf(video), frames: numberOf(frames), audio: numberOf(audio) };
}

export async function lengthsOf(path: string): Promise<Lengths> {
  try {
    const out = new TextDecoder().decode(await tools.run([tools.ffprobe(), "-v", "error", "-print_format", "json", "-show_streams", path]));
    const streams = (JSON.parse(out) as { streams?: Record<string, unknown>[] }).streams ?? [];
    const video = streams.find((one) => one.codec_type === "video");
    const audio = streams.find((one) => one.codec_type === "audio");
    return { video: numberOf(video?.duration), frames: numberOf(video?.nb_frames), audio: numberOf(audio?.duration) };
  } catch {
    return NONE;
  }
}

/** Why `copy` can't stand for the export (`exported`), or null. */
export function copyProblem(copy: Lengths, exported: Lengths, fps: number): string | null {
  if (copy.video === null) return "it has no picture";
  if (exported.video !== null && Math.abs(copy.video - exported.video) > Math.max(2 / fps, 0.1)) return `its picture runs ${copy.video.toFixed(1)} s, the export's ${exported.video.toFixed(1)} s`;
  if (copy.frames !== null && exported.frames !== null && Math.abs(copy.frames - exported.frames) > 1) return `it has ${copy.frames} frames, the export ${exported.frames}`;
  if (copy.audio === null && exported.audio !== null) return "it has no sound, the export has";
  if (copy.audio !== null && exported.audio !== null && Math.abs(copy.audio - exported.audio) > Math.max(2 / fps, 0.1)) return `its sound runs ${copy.audio.toFixed(1)} s, the export's ${exported.audio.toFixed(1)} s`;
  if (copy.audio !== null && Math.abs(copy.audio - copy.video) > 0.5) return `its sound runs ${copy.audio.toFixed(1)} s and its picture ${copy.video.toFixed(1)} s`;
  return null;
}

/** What FFmpeg said went wrong: the first line of its stderr, without its "[aac @ 0x…]" tags. */
function ffmpegSaid(error: unknown): string {
  const stderr = typeof error === "object" && error !== null && typeof (error as { stderr?: unknown }).stderr === "string" ? (error as { stderr: string }).stderr : "";
  const line = stderr
    .split("\n")
    .map((text) => text.replace(/^(\s*\[[^\]]*\]\s*)+/, "").trim())
    .find((text) => text !== "");
  return line ?? (error instanceof Error ? error.message : String(error));
}

/** Seconds decoded at each point. */
const SPAN = 2;
/** A copy this short is decoded whole. */
const WHOLE = 12;
/** How long one point's decode may take. */
const DECODE_MS = 60_000;

/**
 * Why `path` (`seconds` long) doesn't decode, or null: its picture and sound
 * decoded for 2 s at its start, its end and three points between (whole when
 * it's short), FFmpeg stopping at the first error (`-xerror`). A few seconds
 * on a 60-minute copy: each point seeks to the keyframe before it.
 */
export async function decodeProblem(path: string, seconds: number): Promise<string | null> {
  const points = seconds <= WHOLE ? [null] : [0, seconds / 4, seconds / 2, (3 * seconds) / 4, Math.max(0, seconds - SPAN)];
  const failures = await Promise.all(
    points.map(async (at) => {
      const input = at === null ? ["-i", path] : ["-ss", at.toFixed(3), "-i", path, "-t", String(SPAN)];
      try {
        await tools.run([tools.ffmpeg(), "-v", "error", "-nostdin", "-xerror", ...input, "-map", "0:v:0?", "-map", "0:a:0?", "-f", "null", "-"], { timeoutMs: DECODE_MS });
        return null;
      } catch (error) {
        return `it doesn't decode ${at === null ? "" : `at ${at.toFixed(1)} s `}(${ffmpegSaid(error)})`;
      }
    }),
  );
  return failures.find((one) => one !== null) ?? null;
}

/** Why the review copy at `path` can't stand for the export (`exported`): its lengths, then whether it decodes. */
export async function reviewCopyProblem(path: string, exported: Lengths, fps: number): Promise<string | null> {
  const copy = await lengthsOf(path);
  return copyProblem(copy, exported, fps) ?? (await decodeProblem(path, copy.video ?? 0));
}

/** A piece's encoder setup: its codec, profile, level, size, pixel format and SPS/PPS (extradata). */
export async function setupOf(path: string): Promise<string> {
  const out = new TextDecoder().decode(
    await tools.run([tools.ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_data_hash", "md5", "-show_entries", "stream=codec_name,profile,level,width,height,pix_fmt,extradata_hash", "-of", "json", path]),
  );
  const stream = (JSON.parse(out) as { streams?: Record<string, unknown>[] }).streams?.[0] ?? {};
  return ["codec_name", "profile", "level", "width", "height", "pix_fmt", "extradata_hash"].map((key) => String(stream[key] ?? "")).join(" ");
}

/**
 * The pieces whose setup isn't the one most of them share: joined without
 * re-encoding, every piece plays with the first's SPS/PPS, so one made on
 * libx264 among Video Toolbox ones (encodeReview's fallback) can't decode.
 */
export async function oddPieces(paths: string[]): Promise<string[]> {
  const setups: string[] = [];
  for (let at = 0; at < paths.length; at += 8) setups.push(...(await Promise.all(paths.slice(at, at + 8).map(setupOf))));
  const counts = new Map<string, number>();
  for (const one of setups) counts.set(one, (counts.get(one) ?? 0) + 1);
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return paths.filter((_, at) => setups[at] !== common);
}
