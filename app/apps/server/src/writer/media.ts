// A script's footage: what a file holds, the 480p preview the page plays
// (one recording, or a case's recordings joined on one clock), the sound's
// 20 ms peaks the cut is tightened by, and the overview the timeline draws.
// Previews are made on the Mac's video hardware (VideoToolbox), falling back
// on libx264 for footage it can't decode.

import * as fs from "node:fs";

import * as diag from "../diag.ts";
import { isFile } from "../paths.ts";
import { ffmpeg, ffprobe, isUrl, protocols, urlArgs } from "../tools.ts";
import { run } from "./proc.ts";

/** A joined case may run as long as Repack lets one run. */
export const MAX_CASE_MS = 20 * 3_600_000;

/** What a file holds: its length and whether it has picture and sound. */
export interface Streams {
  durationMs: number;
  video: boolean;
  audio: boolean;
}

/** What FFmpeg needs before `-i` to read `path`: for a cloud original's address (streamed imports), HTTPS with the Mac's certificates and reconnects. */
export function input(path: string): string[] {
  return isUrl(path) ? [...urlArgs(path), "-protocol_whitelist", protocols(path)] : [];
}

/** A path fit for a log line: a cloud original's address is a credential. */
const shown = (path: string): string => (isUrl(path) ? "the footage in the cloud" : path);

export async function streams(path: string): Promise<Streams> {
  const text = await run(ffprobe(), ["-v", "error", ...input(path), "-show_entries", "stream=codec_type", "-show_entries", "format=duration", "-of", "json", path], { timeoutMs: 60_000 });
  let value: { format?: { duration?: string | number }; streams?: { codec_type?: string }[] };
  try {
    value = JSON.parse(text) as typeof value;
  } catch {
    throw new Error("Could not read this file.");
  }
  const duration = Number(value.format?.duration ?? 0);
  const has = (kind: string) => (value.streams ?? []).some((stream) => stream.codec_type === kind);
  return { durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : 0, video: has("video"), audio: has("audio") };
}

/** Time for ffmpeg to work through footage: an hour, or ten minutes plus half its length, whichever is longer. */
/** A file that plays: there, and with a length. */
export async function readable(path: string): Promise<boolean> {
  if (!isUrl(path) && !isFile(path)) return false;
  return streams(path).then((found) => found.durationMs > 0, () => false);
}

export const toolTime = (durationMs: number): number => Math.max(600_000 + durationMs / 2, 3_600_000);

/**
 * How much of a file actually plays, from its last packet. An interrupted
 * upload keeps the header of the whole recording, so the length it claims can
 * be hours longer than what it holds.
 */
export async function heldMs(path: string, claimedMs: number): Promise<number | null> {
  // A cloud original would be read whole, twice, to find it: its claimed length stands.
  if (isUrl(path)) return null;
  // One stream at a time: ffprobe takes a single specifier.
  const lastOf = async (stream: string): Promise<number> => {
    let last = 0;
    try {
      await run(ffprobe(), ["-v", "error", "-select_streams", stream, "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", path], {
        timeoutMs: toolTime(claimedMs),
        onLine: (line) => {
          const [pts, duration] = line.split(",").map((field) => Number(field.trim()));
          if (Number.isFinite(pts) && Number.isFinite(duration)) last = Math.max(last, pts! + duration!);
        },
      });
    } catch {
      return 0;
    }
    return last;
  };
  const last = Math.max(await lastOf("a:0"), await lastOf("v:0"));
  return last > 0 ? Math.round(last * 1000) : null;
}

/** The length to use: what the file holds when it's cut short by more than two seconds, otherwise what it claims. */
export async function playableMs(path: string, claimedMs: number): Promise<number> {
  const held = await heldMs(path, claimedMs);
  return held !== null && held > 0 && held + 2_000 < claimedMs ? held : claimedMs;
}

/** One recording of a case to be joined. */
export interface JoinPart {
  path: string;
  streams: Streams;
}

/** The encoder that makes previews on the Mac's video hardware. */
const HARDWARE = "h264_videotoolbox";
/**
 * Decode on the video hardware, the frames handed on in memory. Kept on the
 * hardware (videotoolbox_vld and scale_vt), a recording whose frames changed
 * format part-way made FFmpeg rebuild its filters and fail ("Function not
 * implemented"): every Axon and redacted bodycam file of Oct 30's imports
 * fell to libx264, two to three times real time on a Mac loaded to 40, where
 * the hardware encoder is many times that.
 */
const HARDWARE_DECODE = ["-hwaccel", "videotoolbox"];
/** The hardware encoder at a quality close to libx264's CRF 27, a key frame a second, High profile. */
const HARDWARE_ENCODE = ["-c:v", HARDWARE, "-profile:v", "high", "-q:v", "65", "-g", "30", "-pix_fmt", "yuv420p"];

/** Fitted to `height` (a cheap software scale; the encoding is the hardware's), padded and set to the rate; `width` null keeps the shape as it shows. */
function hardwarePicture(width: number | null, height: number): string {
  const fit = width === null ? `scale=w='trunc(iw*sar*${height}/ih/2)*2':h=${height}` : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  return `${fit},setsar=1,fps=30,format=yuv420p`;
}

/** Runs an ffmpeg encode, reporting 0–100 of `totalMs` from its progress clock; a failed one leaves no file. */
async function encode(args: string[], dest: string, totalMs: number, onPercent: (percent: number) => void, signal?: AbortSignal): Promise<void> {
  try {
    await run(ffmpeg(), args, {
      timeoutMs: toolTime(totalMs),
      ...(signal ? { signal } : {}),
      onLine: (line) => {
        const micros = /^out_time_(?:us|ms)=(\d+)/.exec(line)?.[1];
        if (micros !== undefined && totalMs > 0) onPercent(Math.min(100, Math.floor((Number(micros) / 1000) * 100 / totalMs)));
      },
    });
  } catch (error) {
    fs.rmSync(dest, { force: true });
    throw error;
  }
  if (!fs.existsSync(dest)) throw new Error("The footage was not written.");
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);

async function joinHardware(part: JoinPart, dest: string, onPercent: (percent: number) => void, signal?: AbortSignal): Promise<void> {
  const total = part.streams.durationMs;
  if (total === 0 || total > MAX_CASE_MS) throw new Error("Use footage between a second and twenty hours in all.");
  const picture = `[0:v]${hardwarePicture(854, 480)},trim=duration=${seconds(total)},setpts=PTS-STARTPTS[v]`;
  const sound = part.streams.audio
    ? `[0:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${seconds(total)},asetpts=PTS-STARTPTS[a]`
    : `anullsrc=r=48000:cl=stereo,atrim=duration=${seconds(total)}[a]`;
  await encode(
    ["-hide_banner", "-y", ...HARDWARE_DECODE, ...input(part.path), "-i", part.path, "-filter_complex", `${picture};${sound}`, "-map", "[v]", "-map", "[a]", ...HARDWARE_ENCODE, "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", dest],
    dest,
    total,
    onPercent,
    signal,
  );
}

/** One video's 480p piece, on the video hardware where it can, else libx264. */
async function joinOne(part: JoinPart, dest: string, onPercent: (percent: number) => void, hardware: boolean, signal?: AbortSignal): Promise<void> {
  if (hardware) {
    try {
      return await joinHardware(part, dest, onPercent, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      diag.warn("writer", `the video hardware couldn't encode ${shown(part.path)}, so libx264 does: ${diag.scrub(diag.messageOf(error))}`);
    }
  }
  await joinSized([part], dest, onPercent, 854, 480, "27", signal);
}

/**
 * Joins a case's recordings, in order, into one 480p preview with sound,
 * which is also the footage transcribed. Recordings of any size are fitted to
 * 854×480; an audio recording plays over black and a silent video gets
 * silence, so picture and sound stay in step at every join.
 */
export function join(parts: JoinPart[], dest: string, onPercent: (percent: number) => void = () => {}, signal?: AbortSignal): Promise<void> {
  return parts.length === 1 && parts[0]!.streams.video ? joinOne(parts[0]!, dest, onPercent, true, signal) : joinSized(parts, dest, onPercent, 854, 480, "27", signal);
}

/** As `join`, encoded as `like` was (the hardware or libx264), so it copies onto `like` end to end. */
export async function joinLike(parts: JoinPart[], dest: string, like: string, onPercent: (percent: number) => void = () => {}, signal?: AbortSignal): Promise<void> {
  if (parts.length === 1 && parts[0]!.streams.video) return joinOne(parts[0]!, dest, onPercent, ((await encoderOf(like)) ?? "").includes(HARDWARE), signal);
  return joinSized(parts, dest, onPercent, 854, 480, "27", signal);
}

/** The video encoder a file was made with, as ffmpeg tags it. */
async function encoderOf(path: string): Promise<string | null> {
  try {
    const text = (await run(ffprobe(), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream_tags=encoder", "-of", "csv=p=0", path], { timeoutMs: 60_000 })).trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/** A compilation case that's a folder keeps a full-size master for the edit, beside the 480p preview. */
export async function joinOriginal(parts: JoinPart[], dest: string, onPercent: (percent: number) => void = () => {}, signal?: AbortSignal): Promise<void> {
  let width = 854;
  let height = 480;
  for (const part of parts.filter((one) => one.streams.video)) {
    const text = await run(ffprobe(), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", part.path], { timeoutMs: 30_000 });
    const value = JSON.parse(text) as { streams?: { width?: number; height?: number }[] };
    width = Math.max(width, value.streams?.[0]?.width ?? 854);
    height = Math.max(height, value.streams?.[0]?.height ?? 480);
  }
  await joinSized(parts, dest, onPercent, Math.ceil(width / 2) * 2, Math.ceil(height / 2) * 2, "18", signal);
}

async function joinSized(parts: JoinPart[], dest: string, onPercent: (percent: number) => void, width: number, height: number, crf: string, signal?: AbortSignal): Promise<void> {
  const total = parts.reduce((sum, part) => sum + part.streams.durationMs, 0);
  if (total === 0 || total > MAX_CASE_MS) throw new Error("Use footage between a second and twenty hours in all.");
  const args = ["-hide_banner", "-y"];
  const filters: string[] = [];
  let joined = "";
  for (const [index, part] of parts.entries()) {
    args.push(...input(part.path), "-i", part.path);
    const length = seconds(part.streams.durationMs);
    filters.push(
      part.streams.video
        ? `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,trim=duration=${length},setpts=PTS-STARTPTS[v${index}]`
        : `color=c=black:s=${width}x${height}:r=30:d=${length},format=yuv420p,setsar=1[v${index}]`,
      part.streams.audio
        ? `[${index}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${length},asetpts=PTS-STARTPTS[a${index}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${length}[a${index}]`,
    );
    joined += `[v${index}][a${index}]`;
  }
  filters.push(`${joined}concat=n=${parts.length}:v=1:a=1[v][a]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-g", "30", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", dest);
  await encode(args, dest, total, onPercent, signal);
}

/** A file's streams as a copy must match them (codecs, encoder, size, rate, sound); null when unreadable. */
async function formatOf(path: string): Promise<string | null> {
  try {
    const text = await run(
      ffprobe(),
      ["-v", "error", "-show_entries", "stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,sample_rate,channels:stream_tags=encoder", "-of", "csv=p=0", path],
      { timeoutMs: 60_000 },
    );
    return text.trim() === "" ? null : text;
  } catch {
    return null;
  }
}

/**
 * Adds recordings to the end of a joined preview, each encoded alone by
 * `join`, so the streams are copied end to end and what's joined is never
 * encoded again; pieces that don't match, or a copy the wrong length, are
 * joined afresh. Says whether the streams were copied.
 */
export async function append(base: string, more: string[], dest: string, onPercent: (percent: number) => void = () => {}, signal?: AbortSignal, matched = false): Promise<boolean> {
  const pieces = await Promise.all([base, ...more].map(async (path): Promise<JoinPart> => ({ path, streams: await streams(path) })));
  const total = pieces.reduce((sum, piece) => sum + piece.streams.durationMs, 0);
  if (total > MAX_CASE_MS) throw new Error("Use footage between a second and twenty hours in all.");
  const first = await formatOf(base);
  const formats = await Promise.all(more.map(formatOf));
  if (first === null || formats.some((format) => format !== first)) {
    // Pieces encoded two ways (some on the hardware, some by libx264 when it
    // refused them): only the odd ones out are encoded again, as most of them
    // were, and all are then copied end to end. Oct 30, a 6.7-hour case's 15
    // pieces (3 and 11) were encoded again whole, most of an hour.
    const all = [first, ...formats];
    const tally = new Map<string, number>();
    for (const format of all) if (format !== null) tally.set(format, (tally.get(format) ?? 0) + 1);
    const most = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (matched || most === null) {
      await join(pieces, dest, onPercent, signal);
      return false;
    }
    const paths = [base, ...more];
    const like = paths[all.indexOf(most)]!;
    const made: string[] = [];
    try {
      const fixed: string[] = [];
      for (const [index, piece] of pieces.entries()) {
        if (all[index] === most) {
          fixed.push(piece.path);
          continue;
        }
        const again = dest.replace(/\.[^./]+$/, `.like-${index}.mp4`);
        made.push(again);
        await joinLike([piece], again, like, () => {}, signal);
        fixed.push(again);
      }
      return await append(fixed[0]!, fixed.slice(1), dest, onPercent, signal, true);
    } finally {
      for (const path of made) fs.rmSync(path, { force: true });
    }
  }
  const list = dest.replace(/\.[^./]+$/, "") + ".txt";
  fs.writeFileSync(list, pieces.map((piece) => `file '${piece.path.replaceAll("'", "'\\''")}'\n`).join(""));
  let copied = true;
  try {
    await run(ffmpeg(), ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", dest], { timeoutMs: toolTime(total), ...(signal ? { signal } : {}) });
  } catch {
    copied = false;
  } finally {
    fs.rmSync(list, { force: true });
  }
  // Each join may drift by a frame; more than that and the copy went wrong.
  if (copied) {
    const found = await streams(dest).catch(() => null);
    if (found !== null && Math.abs(found.durationMs - total) <= 500 * pieces.length) {
      onPercent(100);
      return true;
    }
  }
  await join(pieces, dest, onPercent, signal);
  return false;
}

/** A 480p preview with sound: on the Mac's video hardware, else by libx264. */
export async function encodeProxy(source: string, dest: string, durationMs: number, onPercent: (percent: number) => void = () => {}, signal?: AbortSignal): Promise<void> {
  fs.mkdirSync(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
  try {
    return await encode(
      ["-hide_banner", "-y", ...HARDWARE_DECODE, "-i", source, "-vf", hardwarePicture(null, 480), ...HARDWARE_ENCODE, "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", dest],
      dest,
      durationMs,
      onPercent,
      signal,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    diag.warn("writer", `the video hardware couldn't encode ${source}, so libx264 does: ${diag.messageOf(error)}`);
  }
  await encode(
    ["-hide_banner", "-y", "-i", source, "-vf", "scale=-2:480,fps=30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", dest],
    dest,
    durationMs,
    onPercent,
    signal,
  );
}

/** A single video's preview from a picture already at 480p and the sound of `sound`, both copied (sound encoded only when it isn't AAC). */
export async function copyPreview(picture: string, sound: string, durationMs: number, dest: string, signal?: AbortSignal): Promise<void> {
  const codec = (await run(ffprobe(), ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", sound], { timeoutMs: 60_000 })).trim();
  if (codec === "") throw new Error("the footage has no sound to copy");
  const audio = codec === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "96k"];
  await encode(["-hide_banner", "-y", "-i", picture, "-i", sound, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", ...audio, "-t", seconds(durationMs), "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", dest], dest, durationMs, () => {}, signal);
}

/** The loudest sample of each 20 ms, from 0 to 1: pauses are cut by it, and the overview drawn from it. */
export async function peaks(source: string, signal?: AbortSignal): Promise<Float32Array> {
  const out: number[] = [];
  // 24 kHz mono s16: 480 samples (960 bytes) a window.
  const window = new Uint8Array(960);
  let filled = 0;
  const flush = (bytes: Uint8Array) => {
    let loud = 0;
    for (let i = 0; i + 1 < bytes.length; i += 2) loud = Math.max(loud, Math.abs((bytes[i]! | (bytes[i + 1]! << 8)) << 16 >> 16));
    out.push(loud / 32768);
  };
  await run(ffmpeg(), ["-hide_banner", "-loglevel", "error", "-i", source, "-vn", "-ac", "1", "-ar", "24000", "-f", "s16le", "pipe:1"], {
    timeoutMs: 3_600_000,
    ...(signal ? { signal } : {}),
    onBytes: (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(window.length - filled, chunk.length - offset);
        window.set(chunk.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === window.length) {
          flush(window);
          filled = 0;
        }
      }
    },
  }).catch((error: unknown) => {
    throw new Error(signal?.aborted ? diag.messageOf(error) : "Could not read the audio.");
  });
  if (filled >= 2) flush(window.subarray(0, filled - (filled % 2)));
  return Float32Array.from(out);
}

/** The peaks drawn in `buckets` bars (each the loudest it covers). */
export function overview(peaksGiven: ArrayLike<number>, buckets: number): number[] {
  if (peaksGiven.length === 0 || buckets === 0) return [];
  const out = new Array<number>(buckets).fill(0);
  for (let index = 0; index < peaksGiven.length; index++) {
    const bucket = Math.min(Math.floor((index * buckets) / peaksGiven.length), buckets - 1);
    if (peaksGiven[index]! > out[bucket]!) out[bucket] = peaksGiven[index]!;
  }
  return out;
}
