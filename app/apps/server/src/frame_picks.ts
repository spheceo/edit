// Frames that follow the footage (Sphe's Nov 2 list, item 2, from Diffusion
// Studio's `grab --auto`): rather than evenly spaced frames, which spend
// half a sheet on a hallway the camera walked down and miss the two seconds
// in the bedroom, the stretch is scanned at 2 frames a second in the same
// small grey frames the camera angles use (seats.ts: 64 × 36, brightness
// taken out), and a frame is kept each time the picture settles into a new
// state: a cut, or the camera having moved on far enough. Within each state
// the stillest frame is the one kept (so a dissolve or a whip pan is waited
// out and the pick is sharp); a state shorter than a second is a transition
// or a glimpse and is skipped; past the cap, the states least unlike the one
// before go first.

import * as diag from "./diag.ts";
import { join } from "./paths.ts";
import { fixed } from "./rust.ts";
import * as tools from "./tools.ts";
import * as fs from "node:fs";

/** Frames a second scanned, and their size (seats.ts's). */
export const FPS = 2;
const WIDE = 64;
const HIGH = 36;
const SIZE = WIDE * HIGH;
/** This unlike the state's first frame (brightness taken out, 0 alike .. ~1): a new state. seats.rs's cut is 0.16. */
export const NEW_STATE = 0.16;
/** States shorter than this (s) are a transition or a glimpse. */
const SHORTEST = 1;

/** A frame with its brightness taken out (seats.rs `levelled`). */
function levelled(frame: Uint8Array): Float32Array {
  let sum = 0;
  for (const value of frame) sum += value;
  const mean = sum / Math.max(frame.length, 1);
  const out = new Float32Array(frame.length);
  for (let index = 0; index < frame.length; index++) out[index] = frame[index]! - mean;
  return out;
}

/** How unlike two levelled frames are (seats.rs `distance`). */
function distance(a: Float32Array, b: Float32Array): number {
  let total = 0;
  for (let index = 0; index < a.length; index++) total += Math.abs(a[index]! - b[index]!);
  return total / Math.max(a.length, 1) / 128;
}

export interface Pick {
  /** Seconds of the file. */
  time: number;
  /** The state it stands for: from, to (seconds). */
  from: number;
  to: number;
}

/**
 * The picks in `gray` (WIDE × HIGH bytes a frame, FPS a second, the first at
 * `start`): one per settled state, at most `most`.
 */
export function picks(gray: Uint8Array, start: number, most: number): Pick[] {
  const count = Math.floor(gray.length / SIZE);
  if (count === 0) return [];
  const frames = Array.from({ length: count }, (_, index) => levelled(gray.subarray(index * SIZE, (index + 1) * SIZE)));
  // How much each frame moves from the one before (0 for the first).
  const motion = frames.map((frame, index) => (index === 0 ? 0 : distance(frames[index - 1]!, frame)));
  // States: a new one wherever the picture is far from where the current one began.
  const states: [number, number][] = [];
  let begin = 0;
  for (let index = 1; index < count; index++) {
    if (distance(frames[begin]!, frames[index]!) > NEW_STATE) {
      states.push([begin, index]);
      begin = index;
    }
  }
  states.push([begin, count]);
  const lasting = states.filter(([from, to]) => (to - from) / FPS >= SHORTEST);
  const chosen = (lasting.length > 0 ? lasting : states).map(([from, to]) => {
    // The stillest frame in it: the least motion into it and out of it.
    let best = from;
    let calm = Infinity;
    for (let index = from; index < to; index++) {
      const around = (index > from ? motion[index]! : 0) + (index + 1 < to ? motion[index + 1]! : 0);
      if (around < calm) {
        calm = around;
        best = index;
      }
    }
    return { index: best, from, to };
  });
  // Past the cap: drop the pick least unlike the one kept before it, one at a time.
  while (chosen.length > Math.max(1, most)) {
    let weakest = 1;
    let least = Infinity;
    for (let at = 1; at < chosen.length; at++) {
      const unlike = distance(frames[chosen[at - 1]!.index]!, frames[chosen[at]!.index]!);
      if (unlike < least) {
        least = unlike;
        weakest = at;
      }
    }
    // Its stretch goes to the one before it.
    chosen[weakest - 1]!.to = chosen[weakest]!.to;
    chosen.splice(weakest, 1);
  }
  return chosen.map(({ index, from, to }) => ({ time: start + index / FPS, from: start + from / FPS, to: start + to / FPS }));
}

/** The stretch's grey frames, FPS a second, from the light preview when there is one. */
export async function grayOf(source: string, start: number, end: number): Promise<Uint8Array> {
  const cache = tools.mediaCache(source);
  const light = cache === null ? null : join(cache, "preview-light.mp4");
  const input = light !== null && fs.existsSync(light) ? light : source;
  const remote = tools.isUrl(input) ? ["-protocol_whitelist", tools.protocols(input), ...tools.urlArgs(input)] : [];
  const command = [tools.ffmpeg(), "-hide_banner", "-loglevel", "error", ...remote, "-ss", fixed(start, 3), "-t", fixed(Math.max(end - start, 0.5), 3), "-i", input, "-map", "0:v:0", "-vf", `fps=${FPS},scale=${WIDE}:${HIGH},format=gray`, "-f", "rawvideo", "pipe:1"];
  try {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`couldn't read the footage's frames: ${err.trim()}`);
    return new Uint8Array(out);
  } catch (error) {
    throw new Error(diag.messageOf(error));
  }
}
