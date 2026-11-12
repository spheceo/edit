// The little push the picture shows when the keys jump it (Sphe, Nov 12: "a
// tiny little Easter egg"): a single angled stroke that pushes the way the
// jump went and fades, with how far. Presses close together add up, as a
// video site's do (+5, +10, +15).

import { create } from "zustand";

/** Presses this close together (ms) are one jump, added up. */
const TOGETHER_MS = 700;

export const useSeekFlash = create<{ flash: { id: number; seconds: number } | null }>(() => ({ flash: null }));

let lastAt = 0;

export function flashSeek(seconds: number): void {
  const now = performance.now();
  const before = useSeekFlash.getState().flash;
  const adds = before !== null && now - lastAt < TOGETHER_MS && Math.sign(before.seconds) === Math.sign(seconds);
  lastAt = now;
  useSeekFlash.setState({ flash: { id: (before?.id ?? 0) + 1, seconds: adds ? before.seconds + seconds : seconds } });
}
