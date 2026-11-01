// A review copy is checked before it's shared (Nov 1: four went up with each
// piece's last frame held to the export's end, Kroger's 82.5 minutes as 17
// hours, and nothing said so). Its picture plays as long as the export's,
// frame for frame, and its sound as long as its picture. The edit's own
// length isn't asked: an export can differ from it (Off-Duty Officer's,
// Oct 29), and the copy stands for the export. The cloud's copy is checked by
// the worker before it goes up (review_runtime.copy_problem, the same rule).

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
  if (copy.audio !== null && Math.abs(copy.audio - copy.video) > 0.5) return `its sound runs ${copy.audio.toFixed(1)} s and its picture ${copy.video.toFixed(1)} s`;
  return null;
}
