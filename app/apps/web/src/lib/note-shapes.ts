// The pure parts of the notes on the player (lib/notes.ts): which notes are
// in the queue, where the picture sits in the viewer, a drag as a box.

import type { AppNote, NoteBox } from "./api";

/** The notes in the row above the composer: queued ones, and the ones with the agent, in timeline order. */
export function queued(notes: AppNote[]): AppNote[] {
  return notes.filter((note) => note.status === "queued" || note.status === "sent").sort((a, b) => a.now - b.now || a.at - b.at);
}

/** The picture's rectangle inside a box `width`×`height` showing a `frameWidth`×`frameHeight` frame (letterboxed, centred). */
export function pictureRect(width: number, height: number, frameWidth: number, frameHeight: number): { left: number; top: number; width: number; height: number } {
  const fit = Math.min(width / frameWidth, height / frameHeight);
  const shown = { width: frameWidth * fit, height: frameHeight * fit };
  return { left: (width - shown.width) / 2, top: (height - shown.height) / 2, ...shown };
}

/** A box dragged from `a` to `b` (px inside the picture's rectangle), as fractions of the frame, kept inside it. */
export function boxFrom(a: { x: number; y: number }, b: { x: number; y: number }, rect: { width: number; height: number }): NoteBox | null {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const x0 = clamp(Math.min(a.x, b.x) / rect.width);
  const y0 = clamp(Math.min(a.y, b.y) / rect.height);
  const x1 = clamp(Math.max(a.x, b.x) / rect.width);
  const y1 = clamp(Math.max(a.y, b.y) / rect.height);
  // A click, not a drag: no box.
  if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
