import { MUTE_FADE_SECONDS, type Mute } from "./types";

/** The gain an audio clip's mutes leave at `time` (seconds of the source), as edit-core's `mute_gain`. */
export function muteGain(mutes: Mute[], time: number) {
  let gain = 1;
  for (const mute of mutes) {
    const distance = Math.max(mute.from - time, time - mute.to, 0);
    gain = Math.min(gain, (1 - Math.cos(Math.PI * Math.min(distance / MUTE_FADE_SECONDS, 1))) / 2);
  }
  return gain;
}

/**
 * Points (source seconds, gain) between `from` and `to` that, joined by
 * straight ramps, follow the mutes' cosine fades: the first is at `from`.
 */
export function mutePoints(mutes: Mute[], from: number, to: number, steps = 8): [number, number][] {
  const times = new Set<number>([from]);
  for (const mute of mutes) {
    if (mute.to + MUTE_FADE_SECONDS < from || mute.from - MUTE_FADE_SECONDS > to) continue;
    for (let i = 0; i <= steps; i++) {
      times.add(mute.from - MUTE_FADE_SECONDS + (MUTE_FADE_SECONDS * i) / steps);
      times.add(mute.to + (MUTE_FADE_SECONDS * i) / steps);
    }
  }
  return [...times]
    .filter((time) => time >= from && time <= to)
    .sort((a, b) => a - b)
    .map((time) => [time, muteGain(mutes, time)]);
}
