// A script's footage: what a file holds, the 480p preview the page plays
// (one recording, or a case's recordings joined on one clock), the sound's
// 20 ms peaks the cut is tightened by, and the overview the timeline draws.
// Previews are made on the Mac's video hardware (VideoToolbox), falling back
// on libx264 for footage it can't decode.

import * as fs from "node:fs";

import * as diag from "../diag.ts";
import { isFile } from "../paths.ts";
import * as encoder from "../encoder.ts";
import { ffmpeg, ffprobe, hardwareDecode, isUrl, protocols, urlArgs, videoHardware } from "../tools.ts";
import { ProgramTimedOut, run } from "./proc.ts";

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
/** Read from a link (the cloud's copy), not a file here. */
export const isRemote = (path: string): boolean => isUrl(path);

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

/** The encoder that makes previews on this machine's video hardware (tools.ts), or null. */
function hardwareEncoder(): string | null {
  const found = videoHardware();
  return found === "videotoolbox" ? "h264_videotoolbox" : found === "nvenc" ? "h264_nvenc" : null;
}
/**
 * Decode on the video hardware, the frames handed on in memory. Kept on the
 * hardware (videotoolbox_vld and scale_vt), a recording whose frames changed
 * format part-way made FFmpeg rebuild its filters and fail ("Function not
 * implemented"): every Axon and redacted bodycam file of Oct 30's imports
 * fell to libx264, two to three times real time on a Mac loaded to 40, where
 * the hardware encoder is many times that.
 */
const HARDWARE_DECODE = (): string[] => hardwareDecode();
/** The hardware encoder at a quality close to libx264's CRF 27, a key frame a second, High profile, TV range (`RANGE`). */
function hardwareEncode(): string[] {
  const quality = videoHardware() === "nvenc" ? ["-preset", "p4", "-rc", "vbr", "-cq", "28", "-b:v", "0"] : ["-q:v", "65"];
  return ["-c:v", hardwareEncoder() ?? "none", "-profile:v", "high", ...quality, "-g", "30", "-pix_fmt", "yuv420p", "-color_range", "tv"];
}
/**
 * Every piece in TV range, whatever its recording was. Axon bodycam files are
 * full range (yuvj420p), and `format=yuv420p` alone kept their range flag, so
 * their pieces never matched the rest: the join re-encoded them to match, they
 * still didn't, and it encoded the whole case again with libx264 (Oct 30, 591):
 * 10 h of footage, 95 minutes, the Mac at load 30).
 */
const RANGE = ":out_range=tv";

/** Fitted to `height` (a cheap software scale; the encoding is the hardware's), padded and set to the rate; `width` null keeps the shape as it shows. */
function hardwarePicture(width: number | null, height: number): string {
  const fit = width === null ? `scale=w='trunc(iw*sar*${height}/ih/2)*2':h=${height}${RANGE}` : `scale=${width}:${height}:force_original_aspect_ratio=decrease${RANGE},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  return `${fit},setsar=1,fps=30,format=yuv420p`;
}

/** A command at nice 10 where the system has `nice`, else as it is. */
const NICE = process.platform !== "win32" && fs.existsSync("/usr/bin/nice");
const lowered = (command: string, args: string[]): [string, string[]] => (NICE ? ["/usr/bin/nice", ["-n", "10", command, ...args]] : [command, args]);

/** How long an encode runs before its pace is judged, and how often after. */
export const PACE = { afterMs: 5 * 60_000, everyMs: 30_000 };

/**
 * A piece made in stretches (`joinStretched`) is judged by its pace across
 * them all, as the one encode it replaces was: each stretch alone is too short
 * to be judged, and a crawl would otherwise run on stretch after stretch.
 * `totalMs` is what this run has to make; `ranMs` and `doneMs` add up as
 * stretches finish.
 */
interface Paced {
  totalMs: number;
  ranMs: number;
  doneMs: number;
}

/**
 * Runs an ffmpeg encode, reporting 0–100 of `totalMs` from its progress clock;
 * a failed one leaves no file. At a lower priority (nice 10): an import's
 * encode is background work, and at full priority a long libx264 join held the
 * Mac at load 30 and Edit's own answers took seconds (Oct 30).
 *
 * Judged by its pace from five minutes in: one far from finishing within its
 * time at the pace it's going (or that hasn't moved at all) is stopped then,
 * not left to run out the hour. Nov 5, JJ's Mac: a recording read from the cloud
 * crawled, and its piece, the libx264 try and the whole preview each ran
 * their full time, 3 h 30 min before the import said anything.
 */
async function encode(args: string[], dest: string, totalMs: number, onPercent: (percent: number) => void, signal?: AbortSignal, paced?: Paced): Promise<void> {
  const judgedMs = paced?.totalMs ?? totalMs;
  const limitMs = toolTime(judgedMs);
  const began = Date.now();
  let doneMs = 0;
  const slow = new AbortController();
  let why = "";
  // On the hardware encoder while it runs (encoder.ts). Time it shares the encoder with an export or another
  // encode isn't its pace: JJ's Mac, Nov 8, two imports stopped as "too slow" while a 51-minute export held it.
  const hold = encoder.hold("a script's preview piece");
  let sharedMs = 0;
  let lastLook = began;
  const judge = setInterval(() => {
    const now = Date.now();
    if (encoder.shared(hold.token)) sharedMs += now - lastLook;
    lastLook = now;
    if (encoder.shared(hold.token)) return;
    const ran = (paced?.ranMs ?? 0) + now - began - sharedMs;
    const done = (paced?.doneMs ?? 0) + doneMs;
    if (judgedMs <= 0 || ran < PACE.afterMs) return;
    const projected = done <= 0 ? Number.POSITIVE_INFINITY : (ran * judgedMs) / done;
    // Half again its time to spare: a start slowed by a busy Mac or a slow first read isn't judged as its pace.
    if (projected <= limitMs * 1.5) return;
    why =
      done <= 0
        ? `FFmpeg made no progress in ${Math.round(ran / 60_000)} min and was stopped.`
        : `FFmpeg was going too slowly to finish (${Math.round((done / judgedMs) * 100)}% in ${Math.round(ran / 60_000)} min, about ${Math.round(projected / 60_000)} min in all) and was stopped.`;
    slow.abort();
  }, PACE.everyMs);
  try {
    await run(...lowered(ffmpeg(), args), {
      // A stretch has its own length's time, as any encode; the whole piece's pace is the judge's.
      timeoutMs: toolTime(totalMs),
      signal: signal ? AbortSignal.any([signal, slow.signal]) : slow.signal,
      onLine: (line) => {
        const micros = /^out_time_(?:us|ms)=(\d+)/.exec(line)?.[1];
        if (micros === undefined || totalMs <= 0) return;
        doneMs = Math.max(doneMs, Number(micros) / 1000);
        onPercent(Math.min(100, Math.floor((doneMs * 100) / totalMs)));
      },
    });
  } catch (error) {
    fs.rmSync(dest, { force: true });
    if (slow.signal.aborted && !signal?.aborted) throw new ProgramTimedOut({ message: why });
    throw error;
  } finally {
    clearInterval(judge);
    hold.release();
  }
  if (!fs.existsSync(dest)) throw new Error("The footage was not written.");
  if (paced !== undefined) {
    paced.ranMs += Date.now() - began - sharedMs;
    paced.doneMs += totalMs;
  }
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);

/**
 * A part's FFmpeg inputs (from input number `first`) and where its picture and
 * sound are read. One in the cloud with both is opened twice, the picture read
 * from one and the sound from the other, so each reads straight through the
 * file. Read once, FFmpeg takes them in time order, and a recording whose
 * sound is stored apart from its picture (Nov 5, JJ's redacted bodycam: 100 s
 * of sound in one block at 61 MB, its picture at 75–95 MB) sent it back and
 * forth across the file, each jump a new request to R2: a 3:24 recording
 * crawled at a few seconds a minute from 2:04 on, its piece and then the whole
 * preview stopped at their hour, twice. Opened twice, 45 s. A file here jumps
 * for nothing, so it's opened once.
 */
export function inputsOf(part: JoinPart, first: number, decode: string[] = [], fromMs = 0): { args: string[]; video: string; audio: string; count: number } {
  // Each opening is sought on its own (a stretch of a long recording), before its `-i`.
  const seek = fromMs > 0 ? ["-ss", seconds(fromMs)] : [];
  const one = [...decode, ...seek, ...input(part.path), "-i", part.path];
  if (!isUrl(part.path) || !part.streams.video || !part.streams.audio) return { args: one, video: `${first}:v`, audio: `${first}:a`, count: 1 };
  return { args: [...one, ...seek, ...input(part.path), "-i", part.path], video: `${first}:v`, audio: `${first + 1}:a`, count: 2 };
}

async function joinHardware(part: JoinPart, dest: string, onPercent: (percent: number) => void, signal?: AbortSignal): Promise<void> {
  const total = part.streams.durationMs;
  if (total === 0 || total > MAX_CASE_MS) throw new Error("Use footage between a second and twenty hours in all.");
  const read = inputsOf(part, 0, HARDWARE_DECODE());
  const picture = `[${read.video}]${hardwarePicture(854, 480)},trim=duration=${seconds(total)},setpts=PTS-STARTPTS[v]`;
  const sound = part.streams.audio
    ? `[${read.audio}]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${seconds(total)},asetpts=PTS-STARTPTS[a]`
    : `anullsrc=r=48000:cl=stereo,atrim=duration=${seconds(total)}[a]`;
  await encode(
    ["-hide_banner", "-y", ...read.args, "-filter_complex", `${picture};${sound}`, "-map", "[v]", "-map", "[a]", ...hardwareEncode(), "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", dest],
    dest,
    total,
    onPercent,
    signal,
  );
}

/** Which encoder made a piece, for the logs: the Mac's video hardware, or libx264 (several times slower). */
export type Encoder = "the video hardware" | "libx264";

/** One video's 480p piece, on the video hardware where it can, else libx264: which did. */
async function joinOne(part: JoinPart, dest: string, onPercent: (percent: number) => void, hardware: boolean, signal?: AbortSignal): Promise<Encoder> {
  if (hardware && hardwareEncoder() !== null) {
    try {
      await joinHardware(part, dest, onPercent, signal);
      return "the video hardware";
    } catch (error) {
      if (signal?.aborted) throw error;
      diag.warn("writer", `the video hardware couldn't encode ${shown(part.path)}, so libx264 does: ${diag.scrub(diag.messageOf(error))}`);
    }
  }
  await joinSized([part], dest, onPercent, 854, 480, "27", signal);
  return "libx264";
}

/**
 * How much of a long recording each stretch of its piece covers. A piece
 * made in one go was thrown away whole when Edit restarted (JJ's Mac, Nov
 * 10: a 1 h 43 min interview read from the cloud at 1-2× real time, cut by two
 * updates, 20-30 minutes lost each time), so a long one is made a stretch at
 * a time, each kept once it's whole, and a restart redoes one stretch at most.
 * 320 s is 9,600 frames at 30 fps and a multiple of 0.32 s, which lands on a
 * sample at every usual rate (48, 44.1, 32, 22.05, 16 kHz…): every stretch is
 * resampled from the same instants as one encode would be (proxy_pieces.ts
 * found a tick at each join otherwise).
 */
export const STRETCH_MS = 320_000;
/** A piece longer than this is made in stretches; a shorter one is quick enough to make again. */
export const STRETCHED_OVER_MS = 2 * STRETCH_MS;
/** Read before each stretch and dropped, so the sound's decoder and resampler have settled by its first sample (on the 0.32 s grid too). */
const LEAD_MS = 3_200;
/** A stretch's sound, kept as it is until the piece is joined (`joinStretched`). */
const STRETCH_SOUND = ["-c:a", "pcm_s16le"];

/** The picture's encoder for a stretch: the video hardware, or libx264 as `joinSized` encodes. */
function stretchVideo(kind: Encoder): { decode: string[]; encode: string[] } {
  return kind === "the video hardware"
    ? { decode: HARDWARE_DECODE(), encode: hardwareEncode() }
    : { decode: [], encode: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-g", "30", "-color_range", "tv"] };
}

/** Names a stretch's file by how it's made, so a stretch made another way (an update that changed the encoding, the other encoder) is never joined with this run's. */
function stretchKey(kind: Encoder, stretchMs: number): string {
  const how = JSON.stringify([kind, stretchVideo(kind).encode, hardwarePicture(854, 480), STRETCH_SOUND, stretchMs, LEAD_MS]);
  return `${kind === "the video hardware" ? "hw" : "x264"}-${Bun.hash(how).toString(36).slice(0, 8)}`;
}

/**
 * One video's 480p piece, as `join` makes it, made a stretch of `stretchMs`
 * at a time in `work` (a folder of its own): each stretch is written under a
 * name of this run's and renamed whole, so what a restart left there is
 * either whole, and kept, or a partial, and removed. The stretches are then
 * copied end to end into `dest`.
 *
 * Their sound is kept as samples (PCM) and encoded to AAC once, over the
 * whole piece, as it's joined: AAC encoded stretch by stretch would add the
 * encoder's delay and a padded last frame at every join (a gap and a jump,
 * and the sound drifting from the picture join by join). Each stretch is read
 * from `LEAD_MS` before it (sought, so a cloud original isn't read from the
 * start) and both picture and sound are trimmed to it, so its samples are
 * those one encode would give and the joins are seamless. The whole piece is
 * on one encoder: the video hardware, else libx264 for every stretch.
 */
export async function joinStretched(
  part: JoinPart,
  dest: string,
  work: string,
  onPercent: (percent: number) => void = () => {},
  signal?: AbortSignal,
  stretchMs = STRETCH_MS,
): Promise<{ encoder: Encoder; stretches: number; kept: number }> {
  const total = part.streams.durationMs;
  if (total === 0 || total > MAX_CASE_MS) throw new Error("Use footage between a second and twenty hours in all.");
  if (!part.streams.video) throw new Error("only a video is made in stretches");
  fs.mkdirSync(work, { recursive: true });
  const count = Math.ceil(total / stretchMs);
  const whole = (kind: Encoder, n: number) => `${work}/${stretchKey(kind, stretchMs)}-${String(n).padStart(4, "0")}.mov`;
  // A run whose hardware failed went on with libx264: so does this one, from what it made.
  const fellBack = fs.readdirSync(work).some((name) => name.startsWith(`${stretchKey("libx264", stretchMs)}-`) && /-\d{4}\.mov$/.test(name));
  const kinds: Encoder[] = hardwareEncoder() !== null && !fellBack ? ["the video hardware", "libx264"] : ["libx264"];
  for (const kind of kinds) {
    try {
      const kept = await makeStretches(part, kind, work, (n) => whole(kind, n), count, stretchMs, onPercent, signal);
      await joinStretches(Array.from({ length: count }, (_, n) => whole(kind, n)), dest, total, work, signal);
      onPercent(100);
      return { encoder: kind, stretches: count, kept };
    } catch (error) {
      fs.rmSync(dest, { force: true });
      if (signal?.aborted || kind === "libx264") throw error;
      diag.warn("writer", `the video hardware couldn't encode ${shown(part.path)} in stretches, so libx264 does: ${diag.scrub(diag.messageOf(error))}`);
    }
  }
  throw new Error("no encoder made the piece");
}

/** Makes the stretches not already whole in `work` (anything else there is removed); how many were kept. */
async function makeStretches(part: JoinPart, kind: Encoder, work: string, whole: (n: number) => string, count: number, stretchMs: number, onPercent: (percent: number) => void, signal?: AbortSignal): Promise<number> {
  const total = part.streams.durationMs;
  const wanted = new Set(Array.from({ length: count }, (_, n) => whole(n).slice(work.length + 1)));
  // Partials of a cut run, and stretches made another way, are never joined: removed.
  for (const name of fs.readdirSync(work)) if (!wanted.has(name)) fs.rmSync(`${work}/${name}`, { recursive: true, force: true });
  const lengthOf = (n: number) => Math.min(stretchMs, total - n * stretchMs);
  const todo: number[] = [];
  for (let n = 0; n < count; n++) {
    const file = whole(n);
    // Renamed into place only once whole; read again in case the disk lost it.
    const ok = isFile(file) && (await streams(file).then((found) => found.video && found.audio && Math.abs(found.durationMs - lengthOf(n)) <= 100, () => false));
    if (ok) continue;
    fs.rmSync(file, { force: true });
    todo.push(n);
  }
  const kept = count - todo.length;
  const todoMs = todo.reduce((sum, n) => sum + lengthOf(n), 0);
  const paced: Paced = { totalMs: todoMs, ranMs: 0, doneMs: 0 };
  const { decode, encode: video } = stretchVideo(kind);
  for (const n of todo) {
    const startMs = n * stretchMs;
    const lengthMs = lengthOf(n);
    const fromMs = Math.max(0, startMs - LEAD_MS);
    const lead = startMs - fromMs;
    const read = inputsOf(part, 0, decode, fromMs);
    const trim = (filter: "trim" | "atrim") => `${filter}=${lead > 0 ? `start=${seconds(lead)}:` : ""}duration=${seconds(lengthMs)}`;
    const picture = `[${read.video}]${hardwarePicture(854, 480)},${trim("trim")},setpts=PTS-STARTPTS[v]`;
    // On the case's clock from the file's start (first_pts=0): a sound that starts late is padded, as the stretch before it would have it.
    const sound = part.streams.audio
      ? `[${read.audio}]aresample=48000:async=1:first_pts=0,aformat=channel_layouts=stereo,apad,${trim("atrim")},asetpts=PTS-STARTPTS[a]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${seconds(lengthMs)}[a]`;
    const file = whole(n);
    // This run's own name, as the store knows a partial (`store.inTheMaking`): no two runs ever write one file.
    const partial = file.replace(/\.mov$/, `.${crypto.randomUUID().slice(0, 8)}.partial.mov`);
    const before = paced.doneMs;
    try {
      await encode(
        ["-hide_banner", "-y", ...read.args, "-filter_complex", `${picture};${sound}`, "-map", "[v]", "-map", "[a]", ...video, ...STRETCH_SOUND, "-progress", "pipe:1", "-nostats", partial],
        partial,
        lengthMs,
        (percent) => onPercent(Math.min(99, Math.floor(((kept * stretchMs + before + (percent * lengthMs) / 100) * 100) / total))),
        signal,
        paced,
      );
      fs.renameSync(partial, file);
    } finally {
      fs.rmSync(partial, { force: true });
    }
  }
  return kept;
}

/** A picture's decoder setup, hashed; null when unreadable. */
async function setupOf(path: string): Promise<string | null> {
  try {
    const text = (await run(ffprobe(), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=extradata_hash", "-show_data_hash", "SHA256", "-of", "csv=p=0", path], { timeoutMs: 60_000 })).trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/** Copies the stretches' pictures end to end into `dest` and encodes their sound to AAC in one go, as `join` encodes a piece's. */
async function joinStretches(files: string[], dest: string, totalMs: number, work: string, signal?: AbortSignal): Promise<void> {
  // The decoder's setup (SPS and PPS) too: a copy keeps the first stretch's, so one made with another would play broken.
  const formats = await Promise.all(files.map(async (file) => `${await formatOf(file)}${await setupOf(file)}`));
  if (formats.some((format) => format.startsWith("null") || format.endsWith("null") || format !== formats[0])) throw new Error("the stretches came out in different formats");
  const list = `${work}/join-${crypto.randomUUID().slice(0, 8)}.txt`;
  fs.writeFileSync(list, files.map((file) => `file '${file.replaceAll("'", "'\\''")}'\n`).join(""));
  try {
    await run(...lowered(ffmpeg(), ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", list, "-map", "0:v", "-map", "0:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", dest]), {
      timeoutMs: toolTime(totalMs),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    fs.rmSync(dest, { force: true });
    throw error;
  } finally {
    fs.rmSync(list, { force: true });
  }
  const found = await streams(dest).catch(() => null);
  if (found === null || !found.video || !found.audio || Math.abs(found.durationMs - totalMs) > 1_000) {
    fs.rmSync(dest, { force: true });
    throw new Error(`the stretches joined came out ${found === null ? "unreadable" : `${Math.round(found.durationMs / 1000)} s long, not ${Math.round(totalMs / 1000)} s`}`);
  }
}

/**
 * Joins a case's recordings, in order, into one 480p preview with sound,
 * which is also the footage transcribed. Recordings of any size are fitted to
 * 854×480; an audio recording plays over black and a silent video gets
 * silence, so picture and sound stay in step at every join.
 */
export async function join(parts: JoinPart[], dest: string, onPercent: (percent: number) => void = () => {}, signal?: AbortSignal): Promise<Encoder> {
  if (parts.length === 1 && parts[0]!.streams.video) return joinOne(parts[0]!, dest, onPercent, true, signal);
  await joinSized(parts, dest, onPercent, 854, 480, "27", signal);
  return "libx264";
}

/** As `join`, encoded as `like` was (the hardware or libx264), so it copies onto `like` end to end. */
export async function joinLike(parts: JoinPart[], dest: string, like: string, onPercent: (percent: number) => void = () => {}, signal?: AbortSignal): Promise<Encoder> {
  if (parts.length === 1 && parts[0]!.streams.video) return joinOne(parts[0]!, dest, onPercent, ((await encoderOf(like)) ?? "").includes(hardwareEncoder() ?? "\0"), signal);
  await joinSized(parts, dest, onPercent, 854, 480, "27", signal);
  return "libx264";
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
  let opened = 0;
  for (const [index, part] of parts.entries()) {
    const read = inputsOf(part, opened);
    args.push(...read.args);
    opened += read.count;
    const length = seconds(part.streams.durationMs);
    filters.push(
      part.streams.video
        ? `[${read.video}]scale=${width}:${height}:force_original_aspect_ratio=decrease${RANGE},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,trim=duration=${length},setpts=PTS-STARTPTS[v${index}]`
        : `color=c=black:s=${width}x${height}:r=30:d=${length},format=yuv420p,setsar=1[v${index}]`,
      part.streams.audio
        ? `[${read.audio}]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${length},asetpts=PTS-STARTPTS[a${index}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${length}[a${index}]`,
    );
    joined += `[v${index}][a${index}]`;
  }
  filters.push(`${joined}concat=n=${parts.length}:v=1:a=1[v][a]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-g", "30", "-color_range", "tv", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", dest);
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
export async function append(base: string, more: string[], dest: string, onPercent: (percent: number) => void = () => {}, signal?: AbortSignal, matched = false, label = "the preview"): Promise<boolean> {
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
      // The slow way, every piece encoded again: said, with what still differed, so a long join is never a mystery.
      const odd = all.map((format, index) => (format === most ? null : `${shown(pieces[index]!.path)}: ${(format ?? "unreadable").replaceAll("\n", " ")}`)).filter(Boolean);
      diag.warn("writer", `${label}: the pieces still don't match after encoding the odd ones again, so all ${pieces.length} are encoded again with libx264 (most are ${most?.replaceAll("\n", " ") ?? "unreadable"}; ${odd.join("; ")})`);
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
        const began = Date.now();
        await joinLike([piece], again, like, () => {}, signal);
        diag.info("writer", `${label}: ${shown(piece.path)} (${Math.round(piece.streams.durationMs / 60_000)} min) encoded again to match the others in ${Math.round((Date.now() - began) / 1000)} s: it was ${(all[index] ?? "unreadable").replaceAll("\n", " ")}, they are ${most.replaceAll("\n", " ")}`);
        fixed.push(again);
      }
      return await append(fixed[0]!, fixed.slice(1), dest, onPercent, signal, true, label);
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
    diag.warn("writer", `${label}: the pieces copied end to end came out ${found === null ? "unreadable" : `${Math.round(found.durationMs / 1000)} s long, not ${Math.round(total / 1000)} s`}, so all ${pieces.length} are encoded again with libx264`);
  } else diag.warn("writer", `${label}: the pieces couldn't be copied end to end, so all ${pieces.length} are encoded again with libx264`);
  await join(pieces, dest, onPercent, signal);
  return false;
}

/** A 480p preview with sound: on the Mac's video hardware, else by libx264. */
export async function encodeProxy(source: string, dest: string, durationMs: number, onPercent: (percent: number) => void = () => {}, signal?: AbortSignal): Promise<void> {
  fs.mkdirSync(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
  if (hardwareEncoder() !== null) try {
    return await encode(
      ["-hide_banner", "-y", ...HARDWARE_DECODE(), "-i", source, "-vf", hardwarePicture(null, 480), ...hardwareEncode(), "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", dest],
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
    ["-hide_banner", "-y", "-i", source, "-vf", `scale=-2:480${RANGE},fps=30`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-pix_fmt", "yuv420p", "-color_range", "tv", "-g", "30", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", dest],
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
