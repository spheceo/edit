// The case's own video as pictures, for the thumbnail guide (Sphe, Nov 2:
// "usually we have the thumbnail references in our head and we then take
// frames from the youtube video"; "we pick the base frame e.g outside the
// house, inside the house, etc. and we pick the subjects, e.g the father, the
// child"). Two looks: YouTube's storyboard (the small pictures its scrubber
// shows, one every few seconds, nine to a sheet) to see the whole video
// cheaply, then a full-size frame at the moments chosen, the sharpest of the
// second and a half around each.
//
// As the case's words (youtube_words.ts' `idea` use): through the YouTube
// proxy first ("try not to do research locally to not risk ip bans", Oct 31),
// straight from this Mac only when YouTube turns the proxy's address away
// (Nov 10: it did for every question on JJ's Mac for days, and the video
// couldn't be looked at). The pictures come the way the video's details did.
// FFmpeg can't take the proxy itself (through it, it stood still for minutes
// on the first try, Nov 2), so it reads the video from a forwarder on this Mac
// that asks for each range that way: about 8 s and 1–2 MB a frame. The proxy's
// address is a credential: never in a line.

import * as fs from "node:fs";

import { join } from "../paths.ts";
import * as tools from "../tools.ts";
import * as youtube from "../youtube.ts";
import { USES } from "../youtube_words.ts";

/** A storyboard sheet: its picture, the second its first tile shows, and its tiles (left to right, then down). */
export type Sheet = { url: string; start: number; tiles: number };

export type Video = {
  id: string;
  duration: number;
  /** Seconds between two storyboard tiles. */
  every: number;
  columns: number;
  rows: number;
  /** One tile's size. */
  width: number;
  height: number;
  sheets: Sheet[];
  /** The picture alone (H.264 up to 1080p over HTTPS), for frames; null when YouTube offers none. */
  stream: string | null;
  /** How YouTube answered for it: its pictures are fetched the same way. */
  way: youtube.Way;
};

type Format = { format_id?: string; vcodec?: string; acodec?: string; protocol?: string; height?: number; width?: number; url?: string; rows?: number; columns?: number; fragments?: { url: string; duration?: number }[] };

/** What yt-dlp says of the video (its formats), asked as an idea asks YouTube. Tests give their own. */
export const looks = {
  info: async (home: string, id: string, signal?: AbortSignal): Promise<{ duration: number; formats: Format[]; way: youtube.Way }> => {
    const asked = await youtube.ask(home, id, ["--no-playlist", "--no-warnings", "-J"], USES.idea.ways, (tried) => tried.code === 0, { area: "ideas", ...(signal ? { signal } : {}) }).catch((error: unknown) => {
      if (error instanceof youtube.Unanswered) throw new Error(`YouTube didn't give the video (${error.message.slice(0, 200)})`);
      throw error;
    });
    const json = JSON.parse(asked.stdout) as { duration?: number; formats?: Format[] };
    return { duration: json.duration ?? 0, formats: json.formats ?? [], way: asked.way };
  },
  /** Bytes the way the video's details came (a storyboard sheet, or a range of the video). */
  fetch: async (url: string, init: { way: youtube.Way; range?: string; signal?: AbortSignal }): Promise<Response> => {
    const proxy = init.way === "proxy" ? await youtube.proxyUrl() : "";
    if (init.way === "proxy" && proxy === "") throw new Error("The YouTube proxy isn't available just now.");
    return fetch(url, { ...(proxy === "" ? {} : { proxy }), headers: init.range ? { range: init.range } : {}, signal: init.signal ?? AbortSignal.timeout(60_000) });
  },
};

/** The video's storyboard and its picture stream, from yt-dlp's formats. */
export function videoOf(id: string, duration: number, formats: Format[], way: youtube.Way = "proxy"): Video {
  // The largest storyboard: 320×180 tiles, nine to a sheet, about every 5 s (YouTube's "sb0").
  const boards = formats.filter((one) => one.format_id?.startsWith("sb") && (one.fragments?.length ?? 0) > 0 && (one.width ?? 0) > 0).sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  const board = boards[0];
  let sheets: Sheet[] = [];
  let every = 0;
  if (board !== undefined) {
    const per = (board.rows ?? 1) * (board.columns ?? 1);
    // A full sheet's duration over its tiles; the last sheet may hold fewer.
    const full = board.fragments![0]!.duration ?? duration / board.fragments!.length;
    every = full / per;
    let start = 0;
    sheets = board.fragments!.map((one) => {
      const span = one.duration ?? full;
      const sheet = { url: one.url, start, tiles: Math.max(1, Math.min(per, Math.round(span / every))) };
      start += span;
      return sheet;
    });
  }
  const streams = formats
    .filter((one) => one.url !== undefined && one.protocol === "https" && (one.acodec === "none" || one.acodec === undefined) && one.vcodec?.startsWith("avc1") && (one.height ?? 0) <= 1080)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  return { id, duration, every, columns: board?.columns ?? 0, rows: board?.rows ?? 0, width: board?.width ?? 0, height: board?.height ?? 0, sheets, stream: streams[0]?.url ?? null, way };
}

/** The video, looked up once a run. */
export async function video(home: string, id: string, signal?: AbortSignal): Promise<Video> {
  const info = await looks.info(home, id, signal);
  return videoOf(id, info.duration, info.formats, info.way);
}

/** "m:ss" (or "h:mm:ss"), as the transcript writes times. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** Seconds from "m:ss", "h:mm:ss", "[m:ss]" or a number; null when it's neither. */
export function secondsOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^\[|\]$/g, "");
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parts = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(text);
  if (parts === null) return null;
  return Number(parts[1] ?? 0) * 3600 + Number(parts[2]) * 60 + Number(parts[3]);
}

/** Sheets at most in one look: about thirteen minutes of a video at 5 s a tile (a ten-minute one was spread over 12 of its 14 at first, Nov 2). */
export const MAX_SHEETS = 16;

/**
 * The storyboard's sheets from `from` to `to` (seconds), at most MAX_SHEETS:
 * every one when they fit, else spread evenly over the stretch. Each saved in
 * `dir`, with the times it covers.
 */
export async function scan(found: Video, dir: string, from: number, to: number, signal?: AbortSignal): Promise<{ path: string; start: number; end: number; tiles: number }[]> {
  if (found.sheets.length === 0) throw new Error("YouTube has no storyboard for this video: grab frames at the transcript's times instead.");
  const within = found.sheets.filter((one) => one.start + one.tiles * found.every > from && one.start < to);
  const picked = within.length <= MAX_SHEETS ? within : Array.from({ length: MAX_SHEETS }, (_, n) => within[Math.round((n * (within.length - 1)) / (MAX_SHEETS - 1))]!);
  fs.mkdirSync(dir, { recursive: true });
  return Promise.all(
    picked.map(async (sheet) => {
      const path = join(dir, `storyboard-${String(found.sheets.indexOf(sheet) + 1).padStart(2, "0")}.jpg`);
      if (!fs.existsSync(path)) {
        const answer = await looks.fetch(sheet.url, { way: found.way, ...(signal ? { signal } : {}) });
        if (!answer.ok) throw new Error(`YouTube refused a storyboard sheet (${answer.status})`);
        fs.writeFileSync(path, new Uint8Array(await answer.arrayBuffer()));
      }
      return { path, start: sheet.start, end: Math.min(found.duration, sheet.start + sheet.tiles * found.every), tiles: sheet.tiles };
    }),
  );
}

/** How a sheet is read, for Claude: which second each tile shows. */
export function sheetText(found: Video, sheet: { path: string; start: number; end: number; tiles: number }): string {
  return `${sheet.path}: ${clock(sheet.start)}–${clock(sheet.end)}, ${sheet.tiles} tiles (${found.columns} across), one every ${found.every.toFixed(1)} s from ${clock(sheet.start)}, left to right then down`;
}

/** Frames at most in one grab. */
export const MAX_FRAMES = 6;
/** The stretch around each time looked through for its sharpest frame, and how many frames a second. */
const WINDOW = 1.5;
const RATE = 6;

/**
 * Full-size frames (up to 1080p) at these seconds: for each, the sharpest of
 * the frames in the second and a half around it (a bodycam's picture shakes:
 * the frame at the exact second was a blur in the first try), as a JPEG in
 * `dir`, with the second it shows.
 */
export async function grab(found: Video, times: number[], dir: string, signal?: AbortSignal): Promise<{ asked: number; at: number; path: string }[]> {
  if (found.stream === null) throw new Error("YouTube offers no picture stream for this video to take frames from.");
  const stream = found.stream;
  fs.mkdirSync(dir, { recursive: true });
  // FFmpeg reads the video from here; each range it asks for is fetched the way the video's details came.
  const forwarder = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 120,
    async fetch(request) {
      const range = request.headers.get("range") ?? undefined;
      const answer = await looks.fetch(stream, { way: found.way, ...(range === undefined ? {} : { range }), ...(signal ? { signal } : {}) });
      const headers = new Headers();
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const value = answer.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      // FFmpeg seeks with a new request on the same connection, which this server
      // never answered after a streamed body ("End of file", Nov 2): one connection each.
      headers.set("connection", "close");
      return new Response(answer.body, { status: answer.status, headers });
    },
  });
  try {
    const source = `http://127.0.0.1:${forwarder.port}/video.mp4`;
    const out: { asked: number; at: number; path: string }[] = [];
    // Three at a time: each is its own reads of the video.
    for (let index = 0; index < times.length; index += 3) {
      out.push(...(await Promise.all(times.slice(index, index + 3).map((at) => sharpest(source, at, found.duration, dir, signal)))));
    }
    return out;
  } finally {
    void forwarder.stop(true);
  }
}

/** The sharpest frame around `at`: one FFmpeg run writes the frames full size and a small grey copy of each to measure. */
async function sharpest(source: string, asked: number, duration: number, dir: string, signal?: AbortSignal): Promise<{ asked: number; at: number; path: string }> {
  const start = Math.max(0, Math.min(asked - WINDOW / 2, Math.max(0, duration - WINDOW)));
  const stem = join(dir, `frame-${Math.round(asked * 10)}`);
  const W = 160;
  const H = 90;
  const child = Bun.spawn(
    [
      tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
      "-ss", start.toFixed(3), "-t", String(WINDOW), "-i", source,
      "-filter_complex", `[0:v]fps=${RATE},split[a][b];[b]scale=${W}:${H},format=gray[g]`,
      "-map", "[a]", "-q:v", "2", `${stem}-%02d.jpg`,
      "-map", "[g]", "-f", "rawvideo", "pipe:1",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const stop = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", stop, { once: true });
  const timeout = setTimeout(stop, 90_000);
  try {
    const [grey, err] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text()]);
    await child.exited;
    const made = fs.readdirSync(dir).filter((name) => name.startsWith(`frame-${Math.round(asked * 10)}-`) && name.endsWith(".jpg")).sort();
    if (made.length === 0) throw new Error(`no frame at ${clock(asked)}${child.exitCode !== 0 ? ` (${err.trim().split("\n").at(-1)?.slice(0, 160) ?? "FFmpeg failed"})` : ""}`);
    const pixels = new Uint8Array(grey);
    const scores = made.map((_, n) => sharpness(pixels.subarray(n * W * H, (n + 1) * W * H), W, H));
    const best = scores.indexOf(Math.max(...scores));
    const path = `${stem}.jpg`;
    fs.renameSync(join(dir, made[best]!), path);
    for (const [n, name] of made.entries()) if (n !== best) fs.rmSync(join(dir, name), { force: true });
    return { asked, at: start + best / RATE, path };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", stop);
  }
}

/** How sharp a grey picture is: the variance of its Laplacian (a blur has little edge left). */
export function sharpness(pixels: Uint8Array, width: number, height: number): number {
  if (pixels.length < width * height) return 0;
  let sum = 0;
  let squares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = y * width + x;
      const value = 4 * pixels[at]! - pixels[at - 1]! - pixels[at + 1]! - pixels[at - width]! - pixels[at + width]!;
      sum += value;
      squares += value * value;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return squares / count - mean * mean;
}
