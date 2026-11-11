// The frames the progress bar shows as the pointer moves over it (Sphe, Nov
// 11: "when you're hovering over the playback thing, we should be able to
// instantly get the frames of where you are"): as a video site does, small
// frames spread over the whole edit, fetched in the background the first
// time the bar is hovered for this version of the edit, so the nearest one
// is up at once; the exact frame under the pointer follows a moment later.
// The server draws each (the frame route, the engine's own render).

/** How wide each frame is fetched (px). */
const WIDTH = 240;
/** At most this many spread over the edit (one a second for a short one). */
const MOST = 100;
/** Fetched this many at a time, so the bar never crowds the player out. */
const AT_ONCE = 3;
/** Exact frames kept, newest last. */
const EXACT_KEPT = 40;

interface Board {
  key: string;
  /** Frame → its picture (an object URL). */
  spread: Map<number, string>;
  exact: Map<number, string>;
  started: boolean;
}

let board: Board | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function address(project: string, frame: number): string {
  return `/api/projects/${project}/frame/${frame}.png?max=${WIDTH}`;
}

async function picture(project: string, frame: number): Promise<string | null> {
  try {
    const response = await fetch(address(project, frame));
    if (!response.ok) return null;
    return URL.createObjectURL(await response.blob());
  } catch {
    return null;
  }
}

function forget(old: Board): void {
  for (const url of [...old.spread.values(), ...old.exact.values()]) URL.revokeObjectURL(url);
}

/** The board for this version of the edit, its spread fetched in the background (once). */
function ensure(project: string, rev: number, duration: number): Board {
  const key = `${project}:${rev}`;
  if (board?.key !== key) {
    if (board !== null) forget(board);
    board = { key, spread: new Map(), exact: new Map(), started: false };
  }
  const mine = board;
  if (!mine.started && duration > 0) {
    mine.started = true;
    const count = Math.min(MOST, Math.max(2, Math.round(duration / 30)));
    const frames = Array.from({ length: count }, (_, index) => Math.min(duration - 1, Math.round((index * (duration - 1)) / (count - 1))));
    let next = 0;
    const lane = async () => {
      while (board === mine && next < frames.length) {
        const frame = frames[next++]!;
        const url = await picture(project, frame);
        if (url === null) continue;
        if (board !== mine) {
          URL.revokeObjectURL(url);
          return;
        }
        mine.spread.set(frame, url);
        changed();
      }
    };
    for (let lanes = 0; lanes < AT_ONCE; lanes++) void lane();
  }
  return mine;
}

/** The best picture there is for `frame` now (the board started if it wasn't): its exact one, else the nearest of the spread. */
export function pictureAt(project: string, rev: number, duration: number, frame: number): string | null {
  const mine = ensure(project, rev, duration);
  const exact = mine.exact.get(frame);
  if (exact !== undefined) return exact;
  let best: string | null = null;
  let distance = Infinity;
  for (const [at, url] of mine.spread) {
    const gap = Math.abs(at - frame);
    if (gap < distance) {
      distance = gap;
      best = url;
    }
  }
  return best;
}

/** The exact frame under the pointer, fetched (the pointer rested on it). */
export async function fetchExact(project: string, rev: number, duration: number, frame: number): Promise<void> {
  const mine = ensure(project, rev, duration);
  if (mine.exact.has(frame)) return;
  const url = await picture(project, frame);
  if (url === null) return;
  if (board !== mine) {
    URL.revokeObjectURL(url);
    return;
  }
  mine.exact.set(frame, url);
  while (mine.exact.size > EXACT_KEPT) {
    const [oldest, gone] = mine.exact.entries().next().value as [number, string];
    mine.exact.delete(oldest);
    URL.revokeObjectURL(gone);
  }
  changed();
}
