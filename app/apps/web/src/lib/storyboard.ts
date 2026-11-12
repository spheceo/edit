// The frames the progress bar shows as the pointer moves over it (Sphe, Nov
// 11: "when you're hovering over the playback thing, we should be able to
// instantly get the frames of where you are"): as a video site does, small
// frames spread over the whole edit, fetched in the background the first
// time the bar is hovered for this version of the edit, so the nearest one
// is up at once; the exact frame under the pointer follows a moment later.
// The server draws each (the frame route, the engine's own render).
//
// With the smooth render made (Sphe, Nov 12: "try to really work on the
// precision of the images that show up when we hover"), the bar reads the
// sheets the server cuts from it instead (storyboard.ts there): a frame every
// 2 s, the nearest to the pointer drawn from one sheet of 100 at once, where
// the spread above has one every 30 s (one 15 s away from the pointer).

/** How wide each frame is fetched (px). */
const WIDTH = 240;
/** At most this many spread over the edit (one a second for a short one). */
const MOST = 100;
/** Fetched this many at a time, so the bar never crowds the player out. */
const AT_ONCE = 3;
/** Exact frames kept, newest last. */
const EXACT_KEPT = 40;
/** The sheets asked for again this many times when there's no answer (4 s, 8 s, 16 s, 32 s apart). */
const FAILED_TRIES = 4;

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

/** The board for this version without its spread (the sheets stand in for it): only exact frames kept. */
function exactBoard(project: string, rev: number): Board {
  const key = `${project}:${rev}`;
  if (board?.key !== key) {
    if (board !== null) forget(board);
    // Not started: if the sheets stop standing in (an unsaved change), pictureAt fetches the spread for it.
    board = { key, spread: new Map(), exact: new Map(), started: false };
  }
  return board;
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

/** The exact frame's picture, when it's been fetched (no spread started). */
export function exactAt(project: string, rev: number, frame: number): string | null {
  return board?.key === `${project}:${rev}` ? board.exact.get(frame) ?? null : null;
}

/** The exact frame under the pointer, fetched (the pointer rested on it). */
export async function fetchExact(project: string, rev: number, duration: number, frame: number, spread = true): Promise<void> {
  const mine = spread ? ensure(project, rev, duration) : exactBoard(project, rev);
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

/** The server's sheets cut from the smooth render (apps/server storyboard.ts). */
interface Sprites {
  key: string;
  board: { columns: number; rows: number; width: number; height: number; times: number[] } | null;
  /** Sheet → its picture once loaded (the browser keeps it). */
  sheets: Map<number, string>;
  asked: boolean;
}

let sprites: Sprites | null = null;

/** One frame of a sheet: the sheet's address, and where the frame sits on it (px). */
export interface Cell {
  sheet: string;
  x: number;
  y: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
}

/** The sheets for render `stamp` of `project`, asked for (again every 2 s while they're cut) and loaded, two at a time. */
function ensureSprites(project: string, stamp: string): Sprites {
  const key = `${project}:${stamp}`;
  if (sprites?.key !== key) sprites = { key, board: null, sheets: new Map(), asked: false };
  const mine = sprites;
  if (!mine.asked) {
    mine.asked = true;
    const base = `/api/projects/${project}/storyboard`;
    const ask = async (): Promise<void> => {
      let failed = 0;
      for (let tries = 0; tries < 300 && sprites === mine; tries++) {
        const answer = await fetch(`${base}?v=${encodeURIComponent(stamp)}`).then((response) => (response.ok ? response.json() : null), () => null) as (Sprites["board"] & { state: string }) | null;
        // No answer (the render not here yet, the server restarting, the network): asked again a few times, further apart each.
        if (answer === null) {
          if (++failed > FAILED_TRIES) return;
          await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** failed));
          continue;
        }
        if (answer.state === "ready") {
          mine.board = answer;
          changed();
          const count = Math.ceil(answer.times.length / (answer.columns * answer.rows));
          let next = 0;
          const lane = async () => {
            while (sprites === mine && next < count) {
              const n = next++;
              const url = `${base}/${n}.jpg?v=${encodeURIComponent(stamp)}`;
              const loaded = await new Promise<boolean>((resolve) => {
                const image = new Image();
                image.onload = () => resolve(true);
                image.onerror = () => resolve(false);
                image.src = url;
              });
              if (loaded) {
                mine.sheets.set(n, url);
                changed();
              }
            }
          };
          void lane();
          void lane();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    };
    void ask();
  }
  return mine;
}

/** The sheet frame nearest `seconds` of render `stamp` (null until its sheet is in). */
export function cellAt(project: string, stamp: string, seconds: number): Cell | null {
  const mine = ensureSprites(project, stamp);
  const board = mine.board;
  if (board === null || board.times.length === 0) return null;
  // The keyframe nearest the pointer (times are sorted).
  let low = 0;
  let high = board.times.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (board.times[middle]! < seconds) low = middle + 1;
    else high = middle;
  }
  const index = low > 0 && Math.abs(board.times[low - 1]! - seconds) <= Math.abs(board.times[low]! - seconds) ? low - 1 : low;
  const per = board.columns * board.rows;
  const sheet = mine.sheets.get(Math.floor(index / per));
  if (sheet === undefined) return null;
  const at = index % per;
  return { sheet, x: (at % board.columns) * board.width, y: Math.floor(at / board.columns) * board.height, width: board.width, height: board.height, columns: board.columns, rows: board.rows };
}
