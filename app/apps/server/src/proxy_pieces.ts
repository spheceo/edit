// Pieced proxies (off Modal, step 6): a long file's proxy made a minute at a
// time, when something reads that stretch, instead of whole before the
// import answers (a ten-hour file's proxy took hours: every frame read and
// encoded first).
//
// Every reader still sees one MP4 at one address (the preview path, a
// cloud media's `proxy` key): this server answers its byte ranges from the
// pieces (`serve`). It's a fragmented MP4 laid out ahead of time, every
// piece at a place fixed by the layout whether it's made yet or not:
//
//   head    ftyp, moov (no samples; mehd: the whole duration), a sidx per
//           track (FFmpeg's index), `free` to `layout.head`
//   sound   a fragment per piece's stretch, each in a slot of `audio.slot`
//           bytes (`free` after it): encoded from that stretch of the
//           original alone (a second or two wherever it is in the file), on
//           one grid of AAC frames so the stretches join without a seam
//   picture a fragment per piece (`perPiece` frames), each in a slot of
//           `slot` bytes (about 10 s to make on its own)
//   tail    mfra (mediabunny's index: each fragment's time and place)
//
// A slot not made yet is made when a range touches it, so a reader waits
// for its stretch only (the viewer, the agent's looks, a render); behind
// the viewer the fill makes the timeline's in its order, giving the encoder
// up to anyone waiting. Transcription, the waveform and loudness read the
// original, never these. Pieces are kept in the cache and in R2 at
// `edit/pieces/<source>/…`, so another Mac fetches them rather than making
// them again.

import * as fs from "node:fs";

import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import * as fmp4 from "./fmp4.ts";
import { Semaphore } from "./media.ts";
import { isFile, join, parent } from "./paths.ts";
import * as tools from "./tools.ts";

/** Seconds of the source in a piece. */
export const PIECE_SECONDS = 60;
/** The picture's timescale (any frame rate lands on it within a tick). */
export const VIDEO_TIMESCALE = 90_000;
/** The sound: AAC at 48 kHz, 1024 samples a frame. */
export const AUDIO_RATE = 48_000;
const AAC_FRAME = 1024;
const AUDIO_BITRATE = 160_000;
const MIB = 1 << 20;
/** The picture fits in this (the whole proxy's limit). */
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
/** The track ids in the virtual file. */
const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;

/** A pieced proxy's layout (`layout.json`): everything needed to answer any byte of it. */
export interface Layout {
  v: 1;
  /** The registry source (`drive:<id>`) and the original's R2 key. */
  source: string;
  original: string;
  duration: number;
  fps: number;
  /** The picture's frames, in pieces of `perPiece`. */
  frames: number;
  perPiece: number;
  pieces: number;
  width: number;
  height: number;
  bitrate: number;
  /** Bytes a picture piece may take (its slot). */
  slot: number;
  /** The sound (null: none). `frames`: AAC frames in all. */
  audio: { frames: number; slot: number } | null;
  /** Bytes of the head region. */
  head: number;
  /** The whole virtual file's size. */
  total: number;
}

const roundUp = (bytes: number, unit: number) => Math.ceil(bytes / unit) * unit;
/**
 * The last bytes of every slot are its free box's whatever the piece: a read
 * only of those is answered without the piece. mediabunny reads the last
 * 64 KiB of the file for its index, which took in the end of the last
 * picture slot and made that piece as the file opened (40 s on Robyn).
 */
export const QUIET = MIB;

/** The picture's size: the source fitted in 1080p, even. */
export function pictureSize(width: number, height: number): [number, number] {
  const fit = Math.min(MAX_WIDTH / Math.max(width, 2), MAX_HEIGHT / Math.max(height, 2), 1);
  const even = (size: number) => Math.max(Math.floor(Math.round(size * fit) / 2) * 2, 2);
  return [even(width), even(height)];
}

/** The whole proxy's bitrate for a picture of this size (media.rs `cloud_proxy_bitrate`). */
export function bitrateFor(width: number, height: number): number {
  return Math.min(Math.max(Math.floor((4_000_000 * width * height) / (MAX_WIDTH * MAX_HEIGHT)), 800_000), 4_000_000);
}

/** The layout of a proxy of a source this long (seconds), at `fps`, its picture `width`×`height`; `head` bytes still to be set. */
export function plan(source: string, original: string, duration: number, fps: number, width: number, height: number, sound: boolean): Layout {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const frames = Math.max(1, Math.round(duration * rate));
  const perPiece = Math.max(1, Math.round(PIECE_SECONDS * rate));
  const pieces = Math.ceil(frames / perPiece);
  const [w, h] = pictureSize(width, height);
  const bitrate = bitrateFor(width, height);
  // Twice the rate (VideoToolbox holds to 1.25 times it): a piece over it is made again at less.
  const slot = roundUp((PIECE_SECONDS * bitrate * 2) / 8 + MIB, MIB);
  const audio = sound ? { frames: Math.ceil((duration * AUDIO_RATE) / AAC_FRAME), slot: roundUp((PIECE_SECONDS * AUDIO_BITRATE * 1.5) / 8 + MIB, MIB) } : null;
  return { v: 1, source, original, duration, fps: rate, frames, perPiece, pieces, width: w, height: h, bitrate, slot, audio, head: 0, total: 0 };
}

/** Piece `n`'s frames: [first, end). */
export function framesOf(layout: Layout, n: number): [number, number] {
  return [n * layout.perPiece, Math.min((n + 1) * layout.perPiece, layout.frames)];
}

/** Frame `k`'s decode time in the picture's timescale. */
export function videoTime(layout: Layout, frame: number): number {
  return Math.round((frame * VIDEO_TIMESCALE) / layout.fps);
}

/** Piece `n`'s sound: AAC frames [first, end) (the piece's stretch, on one grid for the whole file). */
export function audioFramesOf(layout: Layout, n: number): [number, number] {
  const total = layout.audio?.frames ?? 0;
  const at = (piece: number) => (piece >= layout.pieces ? total : Math.min(total, Math.round((framesOf(layout, piece)[0] / layout.fps) * AUDIO_RATE / AAC_FRAME)));
  return [at(n), at(n + 1)];
}

/**
 * Where things are in the virtual file: the head, the picture's segment
 * index (sidx), then a region per piece holding one fragment of its picture
 * and its sound together (`join`), as a muxer interleaves them, so a reader
 * that seeks has both: with each sound in its own fragment, FFmpeg read a
 * minute of picture before it found any sound, and with all the sound first
 * (v2, Nov 4) a cut of the first 30 s walked the sound of all 633 pieces,
 * making each, before it reached a picture.
 *
 * The sidx sits right before the first piece: FFmpeg takes an index as
 * whole only when its first fragment follows it at once (`first_offset` 0;
 * FFmpeg 8.1 `mov_read_sidx`), and otherwise walks every fragment in the
 * file as it opens it, which made every piece.
 */
export function indexAt(layout: Layout): number {
  return layout.head;
}

export function indexSize(layout: Layout): number {
  return 40 + 12 * layout.pieces;
}

/** Bytes of a piece's region: room for its picture and its sound. */
export function pieceSize(layout: Layout): number {
  return layout.slot + (layout.audio?.slot ?? 0);
}

export function pieceSlotAt(layout: Layout, n: number): number {
  return indexAt(layout) + indexSize(layout) + n * pieceSize(layout);
}

/** The picture's sidx, from the layout alone. */
export function index(layout: Layout): Uint8Array {
  return fmp4.sidx(VIDEO_TRACK, VIDEO_TIMESCALE, 0, Array.from({ length: layout.pieces }, (_, n) => {
    const [a, b] = framesOf(layout, n);
    return { size: pieceSize(layout), duration: videoTime(layout, b) - videoTime(layout, a) };
  }));
}

export function tailAt(layout: Layout): number {
  return pieceSlotAt(layout, layout.pieces);
}

/** The piece the timeline's time `seconds` of the source is in. */
export function pieceAt(layout: Layout, seconds: number): number {
  return Math.min(layout.pieces - 1, Math.max(0, Math.floor(Math.floor(seconds * layout.fps + 1e-6) / layout.perPiece)));
}

/** The index at the file's end (mfra), from the layout alone. */
export function tail(layout: Layout): Uint8Array {
  const tracks = [
    { id: VIDEO_TRACK, entries: Array.from({ length: layout.pieces }, (_, n) => ({ time: videoTime(layout, framesOf(layout, n)[0]), offset: pieceSlotAt(layout, n) })) },
  ];
  if (layout.audio !== null) {
    tracks.push({ id: AUDIO_TRACK, entries: Array.from({ length: layout.pieces }, (_, n) => ({ time: audioFramesOf(layout, n)[0] * AAC_FRAME, offset: pieceSlotAt(layout, n) })) });
  }
  return fmp4.mfra(tracks);
}

/**
 * The head's bytes (ftyp and moov) for the sample entries the pieces were
 * made with; sets `layout.head` and `layout.total`.
 */
export function headOf(layout: Layout, videoEntry: Uint8Array, audioEntry: Uint8Array | null): Uint8Array {
  const tracks: fmp4.InitTrack[] = [{ id: VIDEO_TRACK, handler: "vide", timescale: VIDEO_TIMESCALE, entry: videoEntry, width: layout.width, height: layout.height }];
  if (layout.audio !== null && audioEntry !== null) tracks.push({ id: AUDIO_TRACK, handler: "soun", timescale: AUDIO_RATE, entry: audioEntry, width: 0, height: 0 });
  const init = fmp4.initSegment(layout.duration, tracks);
  layout.head = roundUp(init.length + 8, MIB);
  layout.total = tailAt(layout) + tail(layout).length;
  return init;
}

// ---------------------------------------------------------------------------
// Keys and files.

/** Where a source's pieces are (R2 and, under `cloud/`, the cache): `edit/pieces/<drive/<id>>`. */
export function baseKey(source: string): string {
  const [scheme, ...rest] = source.split(":");
  // v3 (Nov 4): one-minute pieces, each one's sound beside its picture, on the file's clock; the five-minute ones before
  // (no version) stay where they are, never mixed in (v2 was the 10-hour trial's alone).
  return `edit/pieces/v3/${scheme}/${rest.join(":").replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** The address readers use for a pieced proxy (its media's `cloud.proxy`): no object is there. */
export function proxyKeyOf(source: string): string {
  return `${baseKey(source)}/proxy.mp4`;
}

/** The base of a pieced proxy's key, or null for any other key. */
export function baseOf(key: string): string | null {
  return key.startsWith("edit/pieces/") && key.endsWith("/proxy.mp4") ? key.slice(0, -"/proxy.mp4".length) : null;
}

const layoutKey = (base: string) => `${base}/layout.json`;
const headKey = (base: string) => `${base}/head.mp4`;
const audioKey = (base: string, n: number) => `${base}/audio/${n}.m4s`;
const videoKey = (base: string, n: number) => `${base}/video/${n}.m4s`;
/** A piece's picture and sound joined (`ensurePiece`): made from those on each Mac, never shared. */
const joinedKey = (base: string, n: number) => `${base}/joined/${n}.m4s`;

/** What a Mac needs to make and serve pieces: its cache, R2's calls and the original's address. */
export interface Context {
  cache: string;
  /** This Mac's file for a key (cloud_media `localPath`). */
  local: (key: string) => string;
  /** A presigned GET of the original, for FFmpeg. */
  originalUrl: (key: string) => Promise<string>;
  /** R2: whether a key is there, fetch one, put one. */
  head: (key: string) => Promise<{ size: number } | null>;
  fetch: (key: string, local: string) => Promise<void>;
  upload: (local: string, key: string) => Promise<void>;
  /** Whether a local export holds the encoder (background making waits). */
  exporting: () => boolean;
}

const layouts = new Map<string, Layout>();
/** Layouts the cloud didn't have, and when it said so: not asked for again within MISSING_MS. */
const missing = new Map<string, { at: number; message: string }>();
const MISSING_MS = 60_000;

/** The layout of pieced proxy `base`: here, or R2's. */
export async function layoutOf(context: Context, base: string): Promise<Layout> {
  const known = layouts.get(base);
  if (known !== undefined) return known;
  const file = context.local(layoutKey(base));
  if (!isFile(file)) {
    // A layout the cloud just said it hasn't is not asked for again for a minute: every read of the proxy asked
    // for it, several times a second, and logged each failure (Killer Pastor copied to dev without its pieces, Nov 8).
    const missed = missing.get(base);
    if (missed !== undefined && Date.now() - missed.at < MISSING_MS) throw new Error(missed.message);
    try {
      await context.fetch(layoutKey(base), file);
    } catch (error) {
      missing.set(base, { at: Date.now(), message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    missing.delete(base);
  }
  const layout = JSON.parse(fs.readFileSync(file, "utf8")) as Layout;
  if (layout.v !== 1 || !(layout.total > 0)) throw new Error(`${base}: not a pieced proxy's layout`);
  layouts.set(base, layout);
  return layout;
}

// ---------------------------------------------------------------------------
// Making pieces.

/** Pieced proxies whose footage VideoToolbox's scaler refused once (FFmpeg scales theirs). */
const softwareScaled = new Set<string>();
/** Picture pieces made at once on this Mac (VideoToolbox's encoder is shared). */
const making = new Semaphore(1);
const inFlight = new Map<string, Promise<string>>();

function once(key: string, work: () => Promise<string>): Promise<string> {
  const running = inFlight.get(key);
  if (running !== undefined) return running;
  const promise = work().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

function scratch(context: Context, ext: string): string {
  const dir = join(context.cache, "cloud", "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return join(dir, `piece-${process.pid}-${crypto.randomUUID().slice(0, 8)}.${ext}`);
}

/** Puts a made file in R2 behind the reader, unless another Mac's is there (theirs stays: a reader may hold its bytes). */
function share(context: Context, local: string, key: string): void {
  void (async () => {
    if ((await context.head(key).catch(() => null)) !== null) return;
    await context.upload(local, key);
  })().catch((error: unknown) => diag.warn("pieces", `sharing ${key}: ${diag.messageOf(error)}`));
}

/**
 * FFmpeg's command for piece `n`'s picture from `url` into `out` (an
 * ordinary MP4): decoded and scaled in VideoToolbox as the whole proxy is
 * (media.rs `hardware_video`), or with `hardware` false, scaled by FFmpeg
 * (footage whose tags VideoToolbox's scaler refuses: Robyn in custody's
 * "gbr" matrix), encoded by VideoToolbox. Off a Mac FFmpeg decodes and
 * scales, and NVENC encodes where there's one, else libx264 (tools.ts).
 */
export function videoCommand(layout: Layout, n: number, url: string, out: string, bitrate = layout.bitrate, hardware = true): string[] {
  const [first, end] = framesOf(layout, n);
  const gop = String(Math.max(1, Math.round(layout.fps / 2)));
  const mac = tools.videoHardware() === "videotoolbox";
  hardware &&= mac;
  return [
    tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", hardware ? "2" : "4",
    ...(hardware ? ["-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld"] : []),
    ...(first > 0 ? ["-ss", (first / layout.fps).toFixed(6)] : []),
    "-protocol_whitelist", tools.protocols(url), ...tools.urlArgs(url), "-i", url,
    "-map", "0:v:0", "-an", "-sn", "-dn",
    ...(hardware
      ? ["-vf", `scale_vt=w=${layout.width}:h=${layout.height}:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709`]
      : ["-vf", `scale=w=${layout.width}:h=${layout.height}:out_color_matrix=bt709:out_range=tv,format=yuv420p`, "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]),
    "-fps_mode", "cfr", "-r", String(layout.fps), "-frames:v", String(end - first),
    ...(mac ? ["-c:v", "h264_videotoolbox", "-prio_speed", "1"] : tools.h264()),
    "-b:v", `${Math.round(bitrate / 1000)}k`, "-maxrate", `${Math.round((bitrate * 1.25) / 1000)}k`, "-bufsize", `${Math.round((bitrate * 2) / 1000)}k`,
    "-g", gop, "-bf", "0", "-movflags", "+faststart", out,
  ];
}

/**
 * Makes piece `n`'s picture from the original into its fragment file; its
 * sample entry (the decoder's setup: every piece's must be the head's).
 */
export async function makeVideo(context: Context, base: string, layout: Layout, n: number, expected: Uint8Array | null, signal?: AbortSignal, from?: { url: string; out: string }): Promise<{ file: string; entry: Uint8Array }> {
  const url = from?.url ?? (await context.originalUrl(layout.original));
  const out = from?.out ?? context.local(videoKey(base, n));
  let bitrate = layout.bitrate;
  for (let attempt = 0; ; attempt++) {
    const encoded = scratch(context, "mp4");
    const partial = `${out}.partial`;
    try {
      const began = performance.now();
      const hardware = tools.videoHardware() === "videotoolbox" && !softwareScaled.has(base);
      const options = { timeoutMs: 30 * 60_000, ...(signal ? { signal } : {}) };
      // Stopped (the fill's piece giving way): why, not FFmpeg's end.
      const stopped = (error: unknown) => (signal?.aborted ? (signal.reason as Error) : new Error(`piece ${n}'s picture: ${diag.scrub(diag.messageOf(error))}`));
      try {
        await tools.run(videoCommand(layout, n, url, encoded, bitrate, hardware), options);
      } catch (error) {
        if (!hardware || signal?.aborted) throw stopped(error);
        diag.warn("pieces", `${base}: VideoToolbox couldn't scale piece ${n} (${diag.scrub(diag.messageOf(error))}); FFmpeg scales it`);
        softwareScaled.add(base);
        await tools.run(videoCommand(layout, n, url, encoded, bitrate, false), options).catch((again: unknown) => {
          throw stopped(again);
        });
      }
      const track = fmp4.readMp4(encoded).find((one) => one.handler === "vide");
      if (track === undefined) throw new Error(`piece ${n} came out with no picture`);
      if (expected !== null && !sameBytes(decoderSetup(track.entry), decoderSetup(expected))) throw new Error(`piece ${n}'s picture was encoded with another decoder setup than the head's`);
      const [first, end] = framesOf(layout, n);
      const samples = track.samples.slice(0, end - first);
      if (samples.length === 0 || !samples[0]!.sync) throw new Error(`piece ${n} doesn't start on a keyframe`);
      // A short source (the last piece, or a file shorter than its probe): its last frame held.
      while (samples.length < end - first) samples.push(samples[samples.length - 1]!);
      fs.mkdirSync(parent(out)!, { recursive: true });
      const size = fmp4.writeFragment(partial, layout.pieces + n + 1, [
        {
          id: VIDEO_TRACK,
          baseTime: videoTime(layout, first),
          samples: samples.map((sample, index) => ({
            size: sample.size,
            duration: videoTime(layout, first + index + 1) - videoTime(layout, first + index),
            sync: sample.sync,
            cts: 0,
            from: encoded,
            offset: sample.offset,
          })),
        },
      ]);
      if (size + 8 + QUIET > layout.slot) {
        if (attempt >= 2) throw new Error(`piece ${n} takes ${size} bytes, more than its slot's ${layout.slot}`);
        bitrate = Math.floor(bitrate * 0.6);
        continue;
      }
      fs.renameSync(partial, out);
      diag.info("pieces", `${base}: picture piece ${n} of ${layout.pieces} (${Math.round((end - first) / layout.fps)} s) made in ${diag.human(performance.now() - began)}, ${Math.round(size / MIB)} MB`);
      return { file: out, entry: track.entry };
    } finally {
      fs.rmSync(encoded, { force: true });
      fs.rmSync(partial, { force: true });
    }
  }
}

/**
 * A sample entry's decoder setup: its avcC (SPS and PPS), what every piece
 * must share with the head. The rest may differ (btrt, the bitrate it
 * reports, does from piece to piece) without changing a decoded frame.
 */
export function decoderSetup(entry: Uint8Array): Uint8Array {
  for (let at = 4; at + 4 <= entry.length; at++) {
    if (entry[at] === 0x61 && entry[at + 1] === 0x76 && entry[at + 2] === 0x63 && entry[at + 3] === 0x43) {
      const size = new DataView(entry.buffer, entry.byteOffset).getUint32(at - 4);
      if (size > 8 && at - 4 + size <= entry.length) return entry.subarray(at - 4, at - 4 + size);
    }
  }
  return entry;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * AAC frames encoded before a stretch's first and after its last, and
 * dropped: FFmpeg's encoder takes a few seconds of sound to settle (a pure
 * tone's first 3 s came out ten times further off than the rest), so each
 * stretch starts already settled and joins the one before without a seam.
 */
const PRE_ROLL = 240;
const POST_ROLL = 2;
/**
 * An encode starts on a multiple of this many AAC frames: a time on a sample
 * of the source at every usual rate (44.1 kHz, 32, 22.05, 16…), so each
 * stretch is resampled from the same instants and none is a few µs off the
 * next (a tick at the join of a pure tone).
 */
const SEEK_GRID = 15;

/**
 * FFmpeg's command for piece `n`'s sound from `url` as AAC (ADTS) on its
 * stdout, and how many of its frames come before the stretch's first (the
 * encoder's delay, then the pre-roll). Every stretch is on one grid of AAC
 * frames counted from the file's start (where the picture's times are
 * counted from too): a sound starting late is padded to it with silence
 * (aresample's first_pts), one ending early after it (apad).
 */
export function audioCommand(layout: Layout, n: number, url: string): { command: string[]; skip: number } {
  const [first, end] = audioFramesOf(layout, n);
  const from = Math.max(0, Math.floor((first - PRE_ROLL) / SEEK_GRID) * SEEK_GRID);
  const skip = 1 + (first - from);
  return {
    command: [
      tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      ...(from > 0 ? ["-ss", ((from * AAC_FRAME) / AUDIO_RATE).toFixed(6)] : []),
      "-protocol_whitelist", tools.protocols(url), ...tools.urlArgs(url), "-i", url,
      "-map", "0:a:0", "-vn", "-sn", "-dn", "-af", `aresample=${AUDIO_RATE}:async=1:first_pts=0,apad`,
      "-c:a", "aac", "-b:a", String(AUDIO_BITRATE), "-ac", "2", "-ar", String(AUDIO_RATE),
      "-frames:a", String(skip + (end - first) + POST_ROLL), "-f", "adts", "pipe:1",
    ],
    skip,
  };
}

/** The sound's sample entry: AAC-LC, 48 kHz stereo (what `audioCommand` makes). */
export const AUDIO_ENTRY = fmp4.aacEntry(AUDIO_RATE, 2, AUDIO_BITRATE);

/** Piece `n`'s sound: its stretch's AAC frames, encoded from the original now (a minute's in about a second, wherever it is in the file). */
export async function soundOf(context: Pick<Context, "originalUrl">, layout: Layout, n: number, signal?: AbortSignal, given?: string): Promise<Uint8Array[]> {
  const url = given ?? (await context.originalUrl(layout.original));
  const { command, skip } = audioCommand(layout, n, url);
  const [first, end] = audioFramesOf(layout, n);
  let out: Uint8Array;
  try {
    out = await tools.run(command, { timeoutMs: 10 * 60_000, ...(signal ? { signal } : {}) });
  } catch (error) {
    throw new Error(`piece ${n}'s sound: ${diag.scrub(diag.messageOf(error))}`);
  }
  const frames = fmp4.adtsFrames(out).frames.slice(skip, skip + (end - first));
  if (frames.length < end - first) throw new Error(`piece ${n}'s sound came out ${frames.length} frames of ${end - first}`);
  return frames;
}

/** Sounds made at once (a stretch's is a second or two of one core). */
const sounding = new Semaphore(2);

/** Makes piece `n`'s sound into its fragment file. */
async function makeAudio(context: Context, base: string, layout: Layout, n: number, from?: { url: string; out: string }, signal?: AbortSignal): Promise<string> {
  if (layout.audio === null) throw new Error("no sound to make");
  const began = performance.now();
  const own = await sounding.with(() => soundOf(context, layout, n, signal, from?.url));
  const [first] = audioFramesOf(layout, n);
  const out = from?.out ?? context.local(audioKey(base, n));
  fs.mkdirSync(parent(out)!, { recursive: true });
  const partial = `${out}.partial`;
  try {
    const size = fmp4.writeFragment(partial, n + 1, [
      { id: AUDIO_TRACK, baseTime: first * AAC_FRAME, samples: own.map((bytes) => ({ size: bytes.length, duration: AAC_FRAME, sync: true, cts: 0, from: "", offset: 0, bytes })) },
    ]);
    if (size + 8 + QUIET > layout.audio.slot) throw new Error(`piece ${n}'s sound takes ${size} bytes, more than its slot's ${layout.audio.slot}`);
    fs.renameSync(partial, out);
  } finally {
    fs.rmSync(partial, { force: true });
  }
  diag.info("pieces", `${base}: sound piece ${n} of ${layout.pieces} made in ${diag.human(performance.now() - began)}`);
  return out;
}

/** How long R2 has to say whether another Mac made a piece before it's made here (the relay once took 2 min to fail to). */
const SHARED_MS = 5_000;

/** R2's object at `key`, or null: none, or no answer in `SHARED_MS`. */
async function shared(context: Context, key: string): Promise<{ size: number } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), SHARED_MS)));
  try {
    return await Promise.race([context.head(key).catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** This Mac's file of `key`: here, fetched from R2 (another Mac made it), or `make`d now. */
function obtain(context: Context, key: string, make: () => Promise<string>): Promise<string> {
  const local = context.local(key);
  if (isFile(local)) return Promise.resolve(local);
  return once(key, async () => {
    if ((await shared(context, key)) !== null) {
      try {
        await context.fetch(key, local);
        if (isFile(local)) return local;
      } catch (error) {
        diag.warn("pieces", `fetching ${key}: ${diag.messageOf(error)}; making it here`);
      }
    }
    return make();
  });
}

/** The background fill's picture piece being made now: stopped (and made again later) when a read someone waits on needs the encoder. */
let background: { key: string; stop: AbortController } | null = null;
/** Picture pieces someone is waiting on (a fill's piece one of them is, is never stopped), and how many wait on each. */
const waitedOn = new Map<string, number>();

/** What's being made now (an admin's `edit remote ask … work`): the fill's piece, those someone waits on, everything in flight. */
export function status(): { background: string | null; waitedOn: string[]; inFlight: string[] } {
  return { background: background?.key ?? null, waitedOn: [...waitedOn.keys()], inFlight: [...inFlight.keys()] };
}

/** Why a background piece stopped: someone needed the encoder first. */
export class GaveWay extends Error {
  constructor() {
    super("gave way to a piece someone is waiting on");
  }
}

/**
 * This Mac's file of a picture piece: here, R2's, or made now. `urgent` (a
 * read someone waits on: the viewer jumping to an hour in) stops the piece
 * the background fill is making, if it's another, and goes first; on the
 * 10-hour trial (Nov 4) a jump waited 2 min 27 s, most of it behind the
 * fill's piece.
 */
export async function ensureVideo(context: Context, base: string, layout: Layout, n: number, urgent = true): Promise<string> {
  const key = videoKey(base, n);
  // Behind the viewer: one that gave way is made again once those waited on are.
  if (!urgent) {
    for (;;) {
      try {
        return await makePicture(context, base, layout, n, false);
      } catch (error) {
        if (!(error instanceof GaveWay)) throw error;
      }
    }
  }
  if (isFile(context.local(key))) return Promise.resolve(context.local(key));
  waitedOn.set(key, (waitedOn.get(key) ?? 0) + 1);
  // One that joined the fill's piece as another stopped it asks again, first in line.
  return makePicture(context, base, layout, n, true)
    .catch((error: unknown) => (error instanceof GaveWay ? makePicture(context, base, layout, n, true) : Promise.reject(error)))
    .finally(() => {
      const left = (waitedOn.get(key) ?? 1) - 1;
      if (left > 0) waitedOn.set(key, left);
      else waitedOn.delete(key);
    });
}

function makePicture(context: Context, base: string, layout: Layout, n: number, urgent: boolean): Promise<string> {
  const key = videoKey(base, n);
  return obtain(context, key, async () => {
    const expected = videoEntryOf(fs.readFileSync(await ensureHead(context, base)));
    if (urgent && background !== null && background.key !== key && !waitedOn.has(background.key)) background.stop.abort(new GaveWay());
    const made = await making.with(async () => {
      if (urgent) return makeVideo(context, base, layout, n, expected);
      const own = { key, stop: new AbortController() };
      background = own;
      try {
        return await makeVideo(context, base, layout, n, expected, own.stop.signal);
      } finally {
        if (background === own) background = null;
      }
    }, urgent);
    share(context, made.file, key);
    return made.file;
  });
}

/** This Mac's file of a sound piece: here, R2's, or made now from the original. */
export function ensureAudio(context: Context, base: string, layout: Layout, n: number): Promise<string> {
  const key = audioKey(base, n);
  return obtain(context, key, async () => {
    const made = await makeAudio(context, base, layout, n);
    share(context, made, key);
    return made;
  });
}

/** Whether piece `n`'s picture and sound are both on this Mac. */
/** Whether piece `n`'s picture is on this Mac (made here or fetched). */
export function pictureHere(context: Context, base: string, n: number): boolean {
  return isFile(context.local(videoKey(base, n)));
}

function made(context: Context, base: string, layout: Layout, n: number): boolean {
  return isFile(context.local(videoKey(base, n))) && (layout.audio === null || isFile(context.local(audioKey(base, n))));
}

/**
 * This Mac's file of piece `n` as the virtual file holds it: one fragment
 * of its picture and its sound (made, or fetched, apart), joined here and
 * kept beside them; a piece with no sound is its picture's.
 */
export function ensurePiece(context: Context, base: string, layout: Layout, n: number, urgent = true): Promise<string> {
  if (layout.audio === null) return ensureVideo(context, base, layout, n, urgent);
  const out = context.local(joinedKey(base, n));
  if (isFile(out)) return Promise.resolve(out);
  // The picture is asked for apart from the join, so a read someone waits on is first in line even when one behind the viewer started the join.
  const picture = ensureVideo(context, base, layout, n, urgent);
  picture.catch(() => {});
  return once(joinedKey(base, n), async () => {
    const [, sound] = await Promise.all([picture, ensureAudio(context, base, layout, n)]);
    const tracks = [...fmp4.readFragment(await picture), ...fmp4.readFragment(sound)];
    fs.mkdirSync(parent(out)!, { recursive: true });
    const partial = `${out}.partial`;
    try {
      const size = fmp4.writeFragment(partial, n + 1, tracks);
      if (size + 8 + QUIET > pieceSize(layout)) throw new Error(`piece ${n} takes ${size} bytes, more than its slot's ${pieceSize(layout)}`);
      fs.renameSync(partial, out);
    } finally {
      fs.rmSync(partial, { force: true });
    }
    return out;
  });
}

async function ensureHead(context: Context, base: string): Promise<string> {
  const local = context.local(headKey(base));
  if (!isFile(local)) await context.fetch(headKey(base), local);
  return local;
}

/** The video sample entry in a head (its moov's first trak's stsd entry). */
export function videoEntryOf(head: Uint8Array): Uint8Array | null {
  // The head is what headOf wrote: find the avc1 box's header and take it whole.
  for (let at = 4; at + 4 <= head.length; at++) {
    if (head[at] === 0x61 && head[at + 1] === 0x76 && head[at + 2] === 0x63 && head[at + 3] === 0x31) {
      const size = new DataView(head.buffer, head.byteOffset).getUint32(at - 4);
      if (size > 8 && at - 4 + size <= head.length) return head.slice(at - 4, at - 4 + size);
    }
  }
  return null;
}

type Probe = { duration: number; fps: number; width: number; height: number; has_audio: boolean };

/** Piece 0's picture and sound, made from the file before the pieced proxy has a place (the import hashing it meanwhile). */
export interface FirstPiece {
  made: Promise<{ picture: { file: string; entry: Uint8Array }; sound: string | null }>;
  /** Its files gone, when the import doesn't piece the file after all (a whole proxy was there already). */
  discard(): void;
}

/**
 * Starts piece 0 of the file at `path` (this Mac's, probed as `probe`) while
 * the import reads it for its hash: the layout depends only on the probe,
 * so `create` takes these as they are (the 10-hour trial's playable 13-18
 * s after its 9-min hash would be about 0 s after it).
 */
export function startFirst(context: Context, path: string, probe: Probe): FirstPiece {
  const layout = plan("", "", probe.duration, probe.fps, probe.width, probe.height, probe.has_audio);
  // Not wanted after all: its FFmpeg stopped, the encoder free at once (a Drive import's ran 12 s for nothing).
  const stop = new AbortController();
  const picture = making.with(() => makeVideo(context, "(first piece)", layout, 0, null, stop.signal, { url: path, out: scratch(context, "m4s") }), true);
  const sound = layout.audio === null ? Promise.resolve(null) : makeAudio(context, "(first piece)", layout, 0, { url: path, out: scratch(context, "m4s") }, stop.signal);
  const made = Promise.all([picture, sound]).then(([picture, sound]) => ({ picture, sound }));
  made.catch(() => {});
  return {
    made,
    discard: () => {
      stop.abort(new Error("the first piece isn't wanted"));
      void made.then(
        ({ picture, sound }) => {
          fs.rmSync(picture.file, { force: true });
          if (sound !== null) fs.rmSync(sound, { force: true });
        },
        () => {},
      );
    },
  };
}

/**
 * A pieced proxy for `source`, made now: its first piece's picture and
 * sound (`first`'s when it was started while the file was read), its layout
 * and head put in R2 before it's answered, the pieces behind. One already
 * in R2 is taken as it is.
 */
export async function create(context: Context, source: string, original: string, probe: Probe, first: FirstPiece | null = null): Promise<Layout> {
  const base = baseKey(source);
  // One laid out already, here or by another Mac (asked of R2 first: a missing one isn't an error).
  if (layouts.has(base) || isFile(context.local(layoutKey(base))) || (await context.head(layoutKey(base)).catch(() => null)) !== null) {
    try {
      const known = await layoutOf(context, base);
      first?.discard();
      return known;
    } catch (error) {
      diag.warn("pieces", `${base}: its layout couldn't be read (${diag.messageOf(error)}); laid out again here`);
    }
  }
  const layout = plan(source, original, probe.duration, probe.fps, probe.width, probe.height, probe.has_audio);
  const began = performance.now();
  const early = first === null ? null : await first.made.catch((error: unknown) => {
    diag.warn("pieces", `${base}: the first piece made beside the hash failed (${diag.messageOf(error)}); made again`);
    return null;
  });
  let picture: { file: string; entry: Uint8Array };
  let sound: string | null;
  if (early !== null) {
    // Into place: made from this very file, the layout's own (it depends on the probe alone).
    const into = (file: string, key: string) => {
      const out = context.local(key);
      fs.mkdirSync(parent(out)!, { recursive: true });
      fs.renameSync(file, out);
      return out;
    };
    picture = { file: into(early.picture.file, videoKey(base, 0)), entry: early.picture.entry };
    sound = early.sound === null ? null : into(early.sound, audioKey(base, 0));
  } else {
    // The first piece's picture and sound are all the import waits for.
    [picture, sound] = await Promise.all([making.with(() => makeVideo(context, base, layout, 0, null), true), layout.audio === null ? null : makeAudio(context, base, layout, 0)]);
  }
  const head = headOf(layout, picture.entry, sound === null ? null : AUDIO_ENTRY);
  const headFile = context.local(headKey(base));
  fs.mkdirSync(parent(headFile)!, { recursive: true });
  fs.writeFileSync(headFile, head);
  const layoutFile = context.local(layoutKey(base));
  fs.writeFileSync(layoutFile, JSON.stringify(layout));
  layouts.set(base, layout);
  // The head and layout first: another Mac reads nothing without them.
  await context.upload(headFile, headKey(base));
  await context.upload(layoutFile, layoutKey(base));
  share(context, picture.file, videoKey(base, 0));
  if (sound !== null) share(context, sound, audioKey(base, 0));
  diag.info("pieces", `${source}: a pieced proxy of ${layout.pieces} pieces (${Math.round(layout.duration / 60)} min) playable in ${diag.human(performance.now() - began)}${early !== null ? " after its hash (its first piece made beside it)" : ""}`);
  return layout;
}

/**
 * Makes the pieces at `wants` (each a pieced proxy's base and a time of its
 * source, in the timeline's order) one at a time behind the viewer, never
 * beside a local export. Stops when `stop()` says so; the pieces made.
 */
export async function fill(context: Context, wants: { base: string; seconds: number }[], stop: () => boolean = () => false): Promise<number> {
  const seen = new Set<string>();
  let made = 0;
  for (const want of wants) {
    if (stop()) break;
    let layout: Layout;
    try {
      layout = await layoutOf(context, want.base);
    } catch (error) {
      diag.warn("pieces", `${want.base}: ${diag.messageOf(error)}`);
      continue;
    }
    const n = pieceAt(layout, want.seconds);
    const key = videoKey(want.base, n);
    if (seen.has(key)) continue;
    seen.add(key);
    const sound = layout.audio !== null && !isFile(context.local(audioKey(want.base, n)));
    if (isFile(context.local(key)) && !sound) continue;
    for (let waited = 0; waited < 3600 && context.exporting() && !stop(); waited += 5) await Bun.sleep(5000);
    if (stop()) break;
    try {
      await Promise.all([ensureVideo(context, want.base, layout, n, false), sound ? ensureAudio(context, want.base, layout, n) : null]);
      made++;
    } catch (error) {
      diag.warn("pieces", `${want.base}: piece ${n}: ${diag.messageOf(error)}`);
    }
  }
  return made;
}

/** `create`, or null (said why) when it can't be made: the import makes the whole proxy instead. */
export async function tryCreate(context: Context, source: string, original: string, probe: Probe, first: FirstPiece | null = null): Promise<Layout | null> {
  try {
    return await create(context, source, original, probe, first);
  } catch (error) {
    diag.warn("pieces", `${source}: a pieced proxy failed (${diag.scrub(diag.messageOf(error))}); making the whole proxy`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Serving the virtual file.

/** The parts of the virtual file a range covers: [start, end) of each region. */
type Region =
  | { kind: "head"; at: number; size: number }
  | { kind: "piece"; n: number; at: number; size: number }
  | { kind: "index"; at: number; size: number }
  | { kind: "tail"; at: number; size: number };

export function regions(layout: Layout, from: number, to: number): Region[] {
  const out: Region[] = [];
  const add = (region: Region) => {
    if (region.at < to && region.at + region.size > from) out.push(region);
  };
  add({ kind: "head", at: 0, size: layout.head });
  add({ kind: "index", at: indexAt(layout), size: indexSize(layout) });
  const first = Math.max(0, Math.floor((from - pieceSlotAt(layout, 0)) / pieceSize(layout)));
  for (let n = first; n < layout.pieces && pieceSlotAt(layout, n) < to; n++) add({ kind: "piece", n, at: pieceSlotAt(layout, n), size: pieceSize(layout) });
  add({ kind: "tail", at: tailAt(layout), size: layout.total - tailAt(layout) });
  return out;
}

/** The bytes [from, to) of a region whose content is `content` (a file or bytes), `free` after it to the region's end. */
type Part = Uint8Array | { file: string; at: number; length: number } | { zeros: number };

function* regionBytes(content: { file: string } | { bytes: Uint8Array }, size: number, from: number, to: number): Generator<Part> {
  const length = "bytes" in content ? content.bytes.length : fs.statSync(content.file).size;
  if (length > size) throw new Error("a piece is bigger than its slot");
  if (from < length) {
    const end = Math.min(to, length);
    if ("bytes" in content) yield content.bytes.subarray(from, end);
    else yield { file: content.file, at: from, length: end - from };
  }
  if (to > length && length < size) {
    if (size - length < 8) throw new Error("no room for the free box after a piece");
    const header = fmp4.freeHeader(size - length);
    const a = Math.max(from, length);
    if (a < length + 8) yield header.subarray(a - length, Math.min(to, length + 8) - length);
    const zeros = Math.max(0, to - Math.max(a, length + 8));
    if (zeros > 0) yield { zeros };
  }
}

/** Where an open-ended read from `from` ends: the end of the region it starts in, then of each made one after it. */
function readyUpTo(context: Context, base: string, layout: Layout, from: number, asked: number): number {
  const all = regions(layout, from, asked);
  let end = Math.min(asked, all[0] === undefined ? asked : all[0].at + all[0].size);
  for (const region of all.slice(1)) {
    const here = region.kind === "tail" || region.kind === "index" || (region.kind === "piece" && made(context, base, layout, region.n));
    if (!here) break;
    end = Math.min(asked, region.at + region.size);
  }
  return end;
}

/** Parses `bytes=a-b` (or `a-`, or none) against `size`; null when it can't be met. */
export function parseRange(header: string | null, size: number): [number, number] | null {
  if (header === null) return [0, size];
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, a, b] = match;
  if (a === "" && b === "") return null;
  if (a === "") {
    const suffix = Number(b);
    return suffix > 0 ? [Math.max(0, size - suffix), size] : null;
  }
  const start = Number(a);
  const end = b === "" ? size : Math.min(size, Number(b) + 1);
  return start < size && end > start ? [start, end] : null;
}

/**
 * Answers a range of pieced proxy `base`, making what it touches that isn't
 * made yet. With `patience` (ms), a range not ready by then is answered 503
 * while its pieces go on being made (the page's reads give up after 20 s and
 * ask again on a 503); without, it waits (FFmpeg's reads have no deadline).
 */
export async function serve(context: Context, request: Request, base: string, patience: number | null = null, urgent = true): Promise<Response> {
  const layout = await layoutOf(context, base);
  const range = parseRange(request.headers.get("range"), layout.total);
  if (range === null) return new Response(null, { status: 416, headers: { "content-range": `bytes */${layout.total}` } });
  const [from, asked] = range;
  // An open-ended read (FFmpeg's `bytes=N-`) gets the region it starts in and
  // the made ones after it, never the rest of the file made for it: FFmpeg
  // asks again from where an answer ended.
  const openEnded = !/-\d+\s*$/.test(request.headers.get("range") ?? "");
  const to = openEnded ? readyUpTo(context, base, layout, from, asked) : asked;
  const covered = regions(layout, from, to);
  // Everything this range needs, made or fetched first: then the answer streams without waiting.
  const ready = Promise.all(
    covered.map(async (region) => {
      if (region.kind === "head") return { bytes: fs.readFileSync(await ensureHead(context, base)) };
      if (region.kind === "tail") return { bytes: tail(layout) };
      if (region.kind === "index") return { bytes: index(layout) };
      if (Math.max(from, region.at) - region.at >= region.size - QUIET && !made(context, base, layout, region.n)) return { quiet: true as const };
      return { file: await ensurePiece(context, base, layout, region.n, urgent) };
    }),
  );
  let contents: ({ bytes: Uint8Array } | { file: string } | { quiet: true })[];
  if (patience === null) {
    contents = await ready;
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), patience)));
    ready.catch(() => {});
    const first = await Promise.race([ready, late]).finally(() => clearTimeout(timer));
    if (first === null) return new Response("this stretch's proxy is being made", { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } });
    contents = first;
  }
  const parts: Part[] = [];
  covered.forEach((region, index) => {
    const content = contents[index]!;
    const a = Math.max(from, region.at) - region.at;
    const b = Math.min(to, region.at + region.size) - region.at;
    if ("quiet" in content) parts.push({ zeros: b - a });
    else for (const part of regionBytes(content, region.size, a, b)) parts.push(part);
  });
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[next++];
      if (part === undefined) {
        controller.close();
        return;
      }
      if (part instanceof Uint8Array) {
        controller.enqueue(part);
        return;
      }
      if ("zeros" in part) {
        const chunk = Math.min(part.zeros, 4 * MIB);
        controller.enqueue(new Uint8Array(chunk));
        if (chunk < part.zeros) parts.splice(next, 0, { zeros: part.zeros - chunk });
        return;
      }
      // A file's stretch, a few MB at a time.
      const fd = fs.openSync(part.file, "r");
      try {
        const chunk = Math.min(part.length, 4 * MIB);
        const buffer = new Uint8Array(chunk);
        const got = fs.readSync(fd, buffer, 0, chunk, part.at);
        if (got <= 0) {
          controller.error(new Error(`${part.file} ended early`));
          return;
        }
        controller.enqueue(buffer.subarray(0, got));
        if (got < part.length) parts.splice(next, 0, { file: part.file, at: part.at + got, length: part.length - got });
      } finally {
        fs.closeSync(fd);
      }
    },
  });
  const partial = request.headers.get("range") !== null || to < layout.total;
  // A small answer is sent whole (a streamed one goes out chunked, and FFmpeg
  // found the connection closed when it asked again on it).
  const small = to - from <= 16 * MIB;
  return new Response(small ? await new Response(body).arrayBuffer() : body, {
    status: partial ? 206 : 200,
    headers: {
      "content-type": "video/mp4",
      "content-length": String(to - from),
      "accept-ranges": "bytes",
      "cache-control": "no-cache",
      // FFmpeg's next ask on a kept connection found it closed (Bun's), so each answer closes its own.
      connection: "close",
      ...(partial ? { "content-range": `bytes ${from}-${to - 1}/${layout.total}` } : {}),
    },
  });
}

/** The context of this Mac's cloud (cloud_media fills in its parts). */
export function cloudContext(cache: string, local: (key: string) => string, originalUrl: (key: string) => Promise<string>, fetchKey: (key: string, local: string) => Promise<void>, exporting: () => boolean): Context {
  return {
    cache,
    local,
    originalUrl,
    head: (key) => cloud.head(key),
    fetch: fetchKey,
    upload: (file, key) => cloud.uploadFile(file, key),
    exporting,
  };
}
