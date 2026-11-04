// Pieced proxies (off Modal, step 6; behind EDIT_PROXY_PIECES=1): a long
// Drive file's proxy made five minutes at a time, when something reads that
// stretch, instead of whole before the import answers (a ten-hour file's
// proxy took hours: every frame read from R2 and encoded first).
//
// Every reader still sees one MP4 at one address (the preview path, a
// cloud media's `proxy` key): this server answers its byte ranges from the
// pieces (`serve`). It's a fragmented MP4 laid out ahead of time, every
// piece at a place fixed by the layout whether it's made yet or not:
//
//   head    ftyp, moov (no samples; mehd: the whole duration), a sidx per
//           track (FFmpeg's index), `free` to `layout.head`
//   sound   a fragment per piece's stretch, each in a slot of `audio.slot`
//           bytes (`free` after it): made all at once from the original's
//           sound as the import starts, so transcription, the waveform and
//           loudness never wait for the picture
//   picture a fragment per piece (`perPiece` frames), each in a slot of
//           `slot` bytes: made when a read reaches it (the viewer, the
//           agent's looks, a render), or in timeline order behind the viewer
//   tail    mfra (mediabunny's index: each fragment's time and place)
//
// A slot not made yet is made when a range touches it, so a reader waits
// for its stretch only. Pieces are kept in the cache and in R2 at
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
export const PIECE_SECONDS = 300;
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

/** Whether long imports get pieced proxies. */
export function enabled(): boolean {
  return process.env.EDIT_PROXY_PIECES === "1";
}

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

/** Where things are in the virtual file. */
export function audioSlotAt(layout: Layout, n: number): number {
  return layout.head + n * (layout.audio?.slot ?? 0);
}

/**
 * The picture's segment index (sidx) sits right before its first slot:
 * FFmpeg takes an index as whole only when its first fragment follows it
 * at once (`first_offset` 0; FFmpeg 8.1 `mov_read_sidx`), and otherwise
 * walks every fragment in the file as it opens it, which made every piece.
 */
export function indexAt(layout: Layout): number {
  return layout.head + layout.pieces * (layout.audio?.slot ?? 0);
}

export function indexSize(layout: Layout): number {
  return 40 + 12 * layout.pieces;
}

export function videoSlotAt(layout: Layout, n: number): number {
  return indexAt(layout) + indexSize(layout) + n * layout.slot;
}

/** The picture's sidx, from the layout alone. */
export function index(layout: Layout): Uint8Array {
  return fmp4.sidx(VIDEO_TRACK, VIDEO_TIMESCALE, 0, Array.from({ length: layout.pieces }, (_, n) => {
    const [a, b] = framesOf(layout, n);
    return { size: layout.slot, duration: videoTime(layout, b) - videoTime(layout, a) };
  }));
}

export function tailAt(layout: Layout): number {
  return videoSlotAt(layout, layout.pieces);
}

/** The piece the timeline's time `seconds` of the source is in. */
export function pieceAt(layout: Layout, seconds: number): number {
  return Math.min(layout.pieces - 1, Math.max(0, Math.floor(Math.floor(seconds * layout.fps + 1e-6) / layout.perPiece)));
}

/** The index at the file's end (mfra), from the layout alone. */
export function tail(layout: Layout): Uint8Array {
  const tracks = [
    { id: VIDEO_TRACK, entries: Array.from({ length: layout.pieces }, (_, n) => ({ time: videoTime(layout, framesOf(layout, n)[0]), offset: videoSlotAt(layout, n) })) },
  ];
  if (layout.audio !== null) {
    tracks.push({ id: AUDIO_TRACK, entries: Array.from({ length: layout.pieces }, (_, n) => ({ time: audioFramesOf(layout, n)[0] * AAC_FRAME, offset: audioSlotAt(layout, n) })) });
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
  return `edit/pieces/${scheme}/${rest.join(":").replace(/[^A-Za-z0-9._-]/g, "_")}`;
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

/** The layout of pieced proxy `base`: here, or R2's. */
export async function layoutOf(context: Context, base: string): Promise<Layout> {
  const known = layouts.get(base);
  if (known !== undefined) return known;
  const file = context.local(layoutKey(base));
  if (!isFile(file)) await context.fetch(layoutKey(base), file);
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
 * "gbr" matrix), always encoded by VideoToolbox.
 */
export function videoCommand(layout: Layout, n: number, url: string, out: string, bitrate = layout.bitrate, hardware = true): string[] {
  const [first, end] = framesOf(layout, n);
  const gop = String(Math.max(1, Math.round(layout.fps / 2)));
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
    "-c:v", "h264_videotoolbox", "-prio_speed", "1",
    "-b:v", `${Math.round(bitrate / 1000)}k`, "-maxrate", `${Math.round((bitrate * 1.25) / 1000)}k`, "-bufsize", `${Math.round((bitrate * 2) / 1000)}k`,
    "-g", gop, "-bf", "0", "-movflags", "+faststart", out,
  ];
}

/**
 * Makes piece `n`'s picture from the original into its fragment file; its
 * sample entry (the decoder's setup: every piece's must be the head's).
 */
export async function makeVideo(context: Context, base: string, layout: Layout, n: number, expected: Uint8Array | null): Promise<{ file: string; entry: Uint8Array }> {
  const url = await context.originalUrl(layout.original);
  const out = context.local(videoKey(base, n));
  let bitrate = layout.bitrate;
  for (let attempt = 0; ; attempt++) {
    const encoded = scratch(context, "mp4");
    const partial = `${out}.partial`;
    try {
      const began = performance.now();
      const hardware = !softwareScaled.has(base);
      try {
        await tools.run(videoCommand(layout, n, url, encoded, bitrate, hardware), { timeoutMs: 30 * 60_000 });
      } catch (error) {
        if (!hardware) throw new Error(`piece ${n}'s picture: ${diag.scrub(diag.messageOf(error))}`);
        diag.warn("pieces", `${base}: VideoToolbox couldn't scale piece ${n} (${diag.scrub(diag.messageOf(error))}); FFmpeg scales it`);
        softwareScaled.add(base);
        await tools.run(videoCommand(layout, n, url, encoded, bitrate, false), { timeoutMs: 30 * 60_000 }).catch((again: unknown) => {
          throw new Error(`piece ${n}'s picture: ${diag.scrub(diag.messageOf(again))}`);
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

/** FFmpeg's command for the whole sound of `url` as AAC (ADTS) on its stdout. */
export function audioCommand(url: string): string[] {
  return [
    tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-protocol_whitelist", tools.protocols(url), ...tools.urlArgs(url), "-i", url,
    "-map", "0:a:0", "-vn", "-sn", "-dn", "-c:a", "aac", "-b:a", String(AUDIO_BITRATE), "-ac", "2", "-ar", String(AUDIO_RATE),
    "-f", "adts", "pipe:1",
  ];
}

/** The sound's sample entry: AAC-LC, 48 kHz stereo (what `audioCommand` makes). */
export const AUDIO_ENTRY = fmp4.aacEntry(AUDIO_RATE, 2, AUDIO_BITRATE);

/** A sound being made: each piece's fragment written as soon as its frames are in. */
interface AudioRun {
  piece(n: number): Promise<void>;
  done: Promise<void>;
}

const audioRuns = new Map<string, AudioRun>();

/**
 * Makes every piece's sound from one encode of the original's, streamed
 * (one grid of AAC frames for the whole file, so the pieces join without a
 * seam), each piece's written as soon as its frames are in: the sound of
 * the first five minutes is there seconds after it starts, the rest
 * behind it. Pieces already here are kept.
 */
export function startAudio(context: Context, base: string, layout: Layout): AudioRun {
  const running = audioRuns.get(base);
  if (running !== undefined) return running;
  if (layout.audio === null) throw new Error("no sound to make");
  const slot = layout.audio.slot;
  const waiters = Array.from({ length: layout.pieces }, () => Promise.withResolvers<void>());
  for (const waiter of waiters) waiter.promise.catch(() => {});
  const done = (async () => {
    const url = await context.originalUrl(layout.original);
    const began = performance.now();
    const child = Bun.spawn(audioCommand(url), { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const stderr = new Response(child.stderr).text();
    let frames: Uint8Array[] = [];
    let skipped = false;
    let piece = 0;
    let [, end] = audioFramesOf(layout, 0);
    let first = 0;
    const write = (n: number, own: Uint8Array[], from: number) => {
      const key = audioKey(base, n);
      const out = context.local(key);
      if (isFile(out)) {
        waiters[n]!.resolve();
        return;
      }
      fs.mkdirSync(parent(out)!, { recursive: true });
      const partial = `${out}.partial`;
      const size = fmp4.writeFragment(partial, n + 1, [
        { id: AUDIO_TRACK, baseTime: from * AAC_FRAME, samples: own.map((bytes) => ({ size: bytes.length, duration: AAC_FRAME, sync: true, cts: 0, from: "", offset: 0, bytes })) },
      ]);
      if (size + 8 + QUIET > slot) {
        fs.rmSync(partial, { force: true });
        throw new Error(`piece ${n}'s sound takes ${size} bytes, more than its slot's ${slot}`);
      }
      fs.renameSync(partial, out);
      waiters[n]!.resolve();
      share(context, out, key);
    };
    let rest: Uint8Array = new Uint8Array(0);
    let seen = 0;
    try {
      for await (const chunk of child.stdout) {
        const joined = new Uint8Array(rest.length + chunk.length);
        joined.set(rest);
        joined.set(chunk, rest.length);
        const parsed = fmp4.adtsFrames(joined);
        rest = parsed.rest;
        for (const frame of parsed.frames) {
          // FFmpeg's AAC starts with one frame of the encoder's delay: dropped, so frame k is the source's k.
          if (!skipped) {
            skipped = true;
            continue;
          }
          frames.push(frame);
          seen++;
          while (piece < layout.pieces && first + frames.length >= end) {
            const own = frames.slice(0, end - first);
            frames = frames.slice(end - first);
            write(piece, own, first);
            first = end;
            piece++;
            if (piece < layout.pieces) end = audioFramesOf(layout, piece)[1];
          }
        }
      }
      const code = await child.exited;
      if (code !== 0) throw new Error(`the sound: ${diag.scrub((await stderr).trim().split("\n").pop() ?? `FFmpeg exited ${code}`)}`);
      // The source's sound ended before its planned last frame: the pieces left get what there is.
      for (; piece < layout.pieces; piece++) {
        write(piece, frames, first);
        first += frames.length;
        frames = [];
      }
      diag.info("pieces", `${base}: the sound of all ${layout.pieces} pieces (${Math.round(layout.duration / 60)} min, ${seen} frames) made in ${diag.human(performance.now() - began)}`);
    } catch (error) {
      child.kill();
      for (const waiter of waiters) waiter.reject(error);
      throw error;
    }
  })().finally(() => audioRuns.delete(base));
  done.catch((error: unknown) => diag.warn("pieces", `${base}: ${diag.messageOf(error)}`));
  const run: AudioRun = { piece: (n) => waiters[n]?.promise ?? Promise.reject(new Error(`no sound piece ${n}`)), done };
  audioRuns.set(base, run);
  return run;
}

/**
 * This Mac's file of a piece: here, R2's, or made now. `urgent` (a read
 * someone waits on: the viewer jumping to an hour in) is made before the
 * pieces the background fill has in line; on the 10-hour trial (Nov 4) a
 * jump waited 2 min 09 s, a minute of it behind the fill's piece.
 */
export function ensureVideo(context: Context, base: string, layout: Layout, n: number, urgent = true): Promise<string> {
  const key = videoKey(base, n);
  const local = context.local(key);
  if (isFile(local)) return Promise.resolve(local);
  return once(key, async () => {
    if ((await context.head(key).catch(() => null)) !== null) {
      try {
        await context.fetch(key, local);
        if (isFile(local)) return local;
      } catch (error) {
        diag.warn("pieces", `fetching ${key}: ${diag.messageOf(error)}; making it here`);
      }
    }
    const head = fs.readFileSync(await ensureHead(context, base));
    const expected = videoEntryOf(head);
    const made = await making.with(() => makeVideo(context, base, layout, n, expected), urgent);
    share(context, made.file, key);
    return made.file;
  });
}

export function ensureAudio(context: Context, base: string, layout: Layout, n: number): Promise<string> {
  const key = audioKey(base, n);
  const local = context.local(key);
  if (isFile(local)) return Promise.resolve(local);
  return once(key, async () => {
    if ((await context.head(key).catch(() => null)) !== null) {
      try {
        await context.fetch(key, local);
        if (isFile(local)) return local;
      } catch (error) {
        diag.warn("pieces", `fetching ${key}: ${diag.messageOf(error)}; making the sound here`);
      }
    }
    // Made here (another Mac's never reached R2): the sound streamed again, the pieces here kept.
    await startAudio(context, base, layout).piece(n);
    if (!isFile(local)) throw new Error(`${key} wasn't made`);
    return local;
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

/**
 * A pieced proxy for `source`, made now: its sound (all of it) and its
 * first picture piece, together; its layout and head put in R2 before it's
 * answered, the pieces behind. One already in R2 is taken as it is.
 */
export async function create(context: Context, source: string, original: string, probe: { duration: number; fps: number; width: number; height: number; has_audio: boolean }): Promise<Layout> {
  const base = baseKey(source);
  // One laid out already, here or by another Mac (asked of R2 first: a missing one isn't an error).
  if (layouts.has(base) || isFile(context.local(layoutKey(base))) || (await context.head(layoutKey(base)).catch(() => null)) !== null) {
    try {
      return await layoutOf(context, base);
    } catch (error) {
      diag.warn("pieces", `${base}: its layout couldn't be read (${diag.messageOf(error)}); laid out again here`);
    }
  }
  const layout = plan(source, original, probe.duration, probe.fps, probe.width, probe.height, probe.has_audio);
  const began = performance.now();
  // The sound streams from the start; the first piece's picture and sound are all the import waits for.
  const sound = layout.audio === null ? null : startAudio(context, base, layout);
  const [picture] = await Promise.all([making.with(() => makeVideo(context, base, layout, 0, null)), sound?.piece(0)]);
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
  diag.info("pieces", `${source}: a pieced proxy of ${layout.pieces} pieces (${Math.round(layout.duration / 60)} min) playable in ${diag.human(performance.now() - began)}`);
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
    if (isFile(context.local(key))) continue;
    for (let waited = 0; waited < 3600 && context.exporting() && !stop(); waited += 5) await Bun.sleep(5000);
    if (stop()) break;
    try {
      await ensureVideo(context, want.base, layout, n, false);
      made++;
    } catch (error) {
      diag.warn("pieces", `${want.base}: piece ${n}: ${diag.messageOf(error)}`);
    }
  }
  return made;
}

/** `create`, or null (said why) when it can't be made: the import makes the whole proxy instead. */
export async function tryCreate(context: Context, source: string, original: string, probe: { duration: number; fps: number; width: number; height: number; has_audio: boolean }): Promise<Layout | null> {
  try {
    return await create(context, source, original, probe);
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
  | { kind: "audio" | "video"; n: number; at: number; size: number }
  | { kind: "index"; at: number; size: number }
  | { kind: "tail"; at: number; size: number };

export function regions(layout: Layout, from: number, to: number): Region[] {
  const out: Region[] = [];
  const add = (region: Region) => {
    if (region.at < to && region.at + region.size > from) out.push(region);
  };
  add({ kind: "head", at: 0, size: layout.head });
  if (layout.audio !== null) {
    const first = Math.max(0, Math.floor((from - layout.head) / layout.audio.slot));
    for (let n = first; n < layout.pieces && audioSlotAt(layout, n) < to; n++) add({ kind: "audio", n, at: audioSlotAt(layout, n), size: layout.audio.slot });
  }
  add({ kind: "index", at: indexAt(layout), size: indexSize(layout) });
  const start = videoSlotAt(layout, 0);
  const first = Math.max(0, Math.floor((from - start) / layout.slot));
  for (let n = first; n < layout.pieces && videoSlotAt(layout, n) < to; n++) add({ kind: "video", n, at: videoSlotAt(layout, n), size: layout.slot });
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
    const made =
      region.kind === "tail" ||
      region.kind === "index" ||
      (region.kind === "audio" && isFile(context.local(audioKey(base, region.n)))) ||
      (region.kind === "video" && isFile(context.local(videoKey(base, region.n))));
    if (!made) break;
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
export async function serve(context: Context, request: Request, base: string, patience: number | null = null): Promise<Response> {
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
      const key = region.kind === "audio" ? audioKey(base, region.n) : videoKey(base, region.n);
      if (Math.max(from, region.at) - region.at >= region.size - QUIET && !isFile(context.local(key))) return { quiet: true as const };
      return { file: region.kind === "audio" ? await ensureAudio(context, base, layout, region.n) : await ensureVideo(context, base, layout, region.n) };
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
