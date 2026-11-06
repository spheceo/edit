// Footage heard in one ear only (JJ, Nov 6, on Cops Realize: "we only have
// audio in the left ear… for this entire case, we need to do so we can hear
// the audio in both ears"): the side of a source that carries its sound,
// measured here, so an audio clip's `channel` plays that side in both ears
// (the export's mix and the preview alike).

import * as tools from "./tools.ts";

export type Side = "left" | "right";

/** A side this much quieter than the other (dB RMS) isn't heard: the louder one is the sound. */
const QUIETER_DB = 12;
/** Seconds of a source measured at most (from each clip's own stretch). */
const MOST_SECONDS = 600;

/** What a source's sides measured: its live side, or null when both are heard (or it's mono). */
const known = new Map<string, Side | null>();

/** The RMS level (dB) of each channel FFmpeg's astats reported, in order; -inf as -Infinity. */
export function channelLevels(stderr: string): number[] {
  const levels: number[] = [];
  let channel = false;
  for (const line of stderr.split("\n")) {
    if (/\] Channel: \d+/u.test(line)) channel = true;
    else if (/\] Overall/u.test(line)) channel = false;
    const level = /\] RMS level dB: (-?inf|-?[\d.]+)/u.exec(line);
    if (channel && level) {
      levels.push(level[1]!.endsWith("inf") ? -Infinity : Number(level[1]));
      channel = false;
    }
  }
  return levels;
}

/** The side that's heard, from the two sides' levels: null when both are (or neither). */
export function liveSideOf(levels: number[]): Side | null {
  if (levels.length < 2) return null;
  const [left, right] = [levels[0]!, levels[1]!];
  if (left === -Infinity && right === -Infinity) return null;
  if (left - right >= QUIETER_DB) return "left";
  if (right - left >= QUIETER_DB) return "right";
  return null;
}

/**
 * The side of `path` that carries its sound over `spans` (source seconds,
 * [from, seconds]; the whole file when empty), or null when both sides are
 * heard. Measured once a source and stretch.
 */
export async function liveSide(path: string, spans: [number, number][] = []): Promise<Side | null> {
  const key = `${path}|${JSON.stringify(spans)}`;
  if (known.has(key)) return known.get(key)!;
  const remote = tools.isUrl(path) ? ["-protocol_whitelist", tools.protocols(path), ...tools.urlArgs(path)] : [];
  // The stretches the clips play, one after another, up to MOST_SECONDS.
  const parts: string[] = [];
  let total = 0;
  for (const [from, seconds] of spans) {
    if (total >= MOST_SECONDS) break;
    const take = Math.min(seconds, MOST_SECONDS - total);
    parts.push(`between(t,${from.toFixed(3)},${(from + take).toFixed(3)})`);
    total += take;
  }
  const keep = parts.length > 0 ? `aselect='${parts.join("+")}',` : "";
  // Read no further than the last stretch it hears: the whole file was decoded, and a long one streamed from the cloud
  // ran past the five minutes allowed (Nov 6, Cops Realize: five both_ears plans killed, "received signal 15").
  const until = spans.length > 0 ? Math.max(...spans.map(([from, seconds]) => from + seconds)) + 1 : null;
  const child = Bun.spawn(
    [tools.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "info", ...remote, ...(until === null ? [] : ["-t", until.toFixed(3)]), "-i", path, "-map", "0:a:0", "-vn", "-af", `${keep}astats`, "-f", "null", "-"],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill(), 5 * 60_000);
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]).finally(() => clearTimeout(timer));
  if (code !== 0) throw new Error(`couldn't measure the sound's sides: ${stderr.trim().split("\n").at(-1) ?? `ffmpeg exited ${code}`}`);
  const side = liveSideOf(channelLevels(stderr));
  known.set(key, side);
  return side;
}
