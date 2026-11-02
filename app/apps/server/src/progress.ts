// How long the background work an agent waits on has left: a clip's
// smoothing, a moving map shot, the watcher's windows, an export. Each says so
// in its tool's reply and in get_edit_context, from its measured progress
// where it has one (a map's frames, the watcher's windows, an export's share
// done), else from how long that work takes here. The agent then waits once
// for that long (the wait tool) instead of reading the project again and
// again to see (Diffusion Studio's jobs say when to look again; Sphe's Nov 2
// list, item 4).

/** The clock (tests move it). */
export const timing = {
  now: () => performance.now(),
  sleep: (ms: number) => Bun.sleep(ms),
};

export type Work = "smooth" | "map" | "watch" | "export";

/**
 * How long each takes here before it has measured progress of its own, from
 * Edit's logs (Nov 2): a clip's smoothing 2 min 53 s to 3 min 14 s, one at a
 * time across the Mac; a moving map shot 2 to 10 min; a watch window 1 min
 * 50 s to 2 min 21 s, a few at once. Each finished job moves its kind's
 * figure toward what it took.
 */
const typical: Record<Work, number> = { smooth: 190_000, map: 300_000, watch: 130_000, export: 600_000 };

interface Entry {
  kind: Work;
  project: string;
  started: number;
  /** Measured progress: parts done of total (frames, windows), or a share (total 1). */
  done: number;
  total: number;
  /** When `done` was first above zero, and what it was then (an export joined part-way). */
  first: [number, number] | null;
}

const running = new Map<string, Entry>();

function keyOf(kind: Work, project: string, part: string): string {
  return `${kind}:${project}:${part}`;
}

/** Notes work as started (again: a restart of the same part keeps its first start). */
export function begin(kind: Work, project: string, part: string, total = 0): void {
  const key = keyOf(kind, project, part);
  if (running.has(key)) return;
  running.set(key, { kind, project, started: timing.now(), done: 0, total, first: null });
}

/** Its measured progress: `done` of `total` (a share: total 1). */
export function step(kind: Work, project: string, part: string, done: number, total?: number): void {
  const entry = running.get(keyOf(kind, project, part));
  if (entry === undefined) return;
  if (total !== undefined) entry.total = total;
  if (done > 0 && entry.first === null) entry.first = [timing.now(), done];
  entry.done = Math.max(entry.done, done);
}

/** Crosses it off; a whole run (from 0) teaches its kind how long it takes. */
export function end(kind: Work, project: string, part: string, ok = true): void {
  const key = keyOf(kind, project, part);
  const entry = running.get(key);
  running.delete(key);
  if (entry === undefined || !ok) return;
  const took = timing.now() - entry.started;
  // Per window for the watcher; per job for the rest.
  const each = kind === "watch" && entry.total > 0 ? took / Math.max(1, Math.ceil(entry.total / WATCH_AT_ONCE)) : took;
  if (each > 1000) typical[kind] = Math.round(typical[kind] * 0.6 + each * 0.4);
}

/** The watcher's windows at once (watch.ts AT_ONCE). */
export const WATCH_AT_ONCE = 12;

/** Milliseconds one entry has left. */
function left(entry: Entry, now: number): number {
  const elapsed = now - entry.started;
  if (entry.first !== null && entry.total > 0 && entry.done > entry.first[1]) {
    // Its own rate since progress first showed.
    const [at, from] = entry.first;
    const rate = (entry.done - from) / Math.max(now - at, 1);
    return Math.max((entry.total - entry.done) / rate, 1000);
  }
  if (entry.kind === "watch" && entry.total > 0) {
    const rounds = Math.ceil((entry.total - entry.done) / WATCH_AT_ONCE);
    return Math.max(rounds * typical.watch - (entry.done === 0 ? elapsed : 0), 15_000);
  }
  return Math.max(typical[entry.kind] - elapsed, 15_000);
}

/** What's still running for a project, of these kinds (all by default). */
export function pending(project: string, kinds: readonly Work[] = ["smooth", "map", "watch", "export"]): Entry[] {
  return [...running.values()].filter((entry) => entry.project === project && kinds.includes(entry.kind));
}

/**
 * How long a project's work of these kinds has left, ms (null: none running).
 * Smoothing runs one clip at a time across the Mac, so every clip waiting
 * counts; the rest run side by side, so the longest counts.
 */
export function remainingMs(project: string, kinds?: readonly Work[]): number | null {
  const mine = pending(project, kinds);
  if (mine.length === 0) return null;
  const now = timing.now();
  let longest = 0;
  const smoothing = [...running.values()].filter((entry) => entry.kind === "smooth");
  if (mine.some((entry) => entry.kind === "smooth")) {
    const queue = smoothing.map((entry) => left(entry, now)).sort((a, b) => a - b);
    // The one rendering now, then a whole one for each behind it.
    longest = (queue[0] ?? 0) + Math.max(0, smoothing.length - 1) * typical.smooth;
  }
  for (const entry of mine) if (entry.kind !== "smooth") longest = Math.max(longest, left(entry, now));
  return longest;
}

/** "about 40 s", "about 3 min". */
export function about(ms: number): string {
  if (ms < 60_000) return `about ${Math.max(5, Math.round(ms / 5000) * 5)} s`;
  return `about ${Math.round(ms / 60_000)} min`;
}

/** What's running and how long it has left, in a line (null: nothing). */
export function summary(project: string, kinds?: readonly Work[]): string | null {
  const mine = pending(project, kinds);
  const ms = remainingMs(project, kinds);
  if (mine.length === 0 || ms === null) return null;
  const count = (kind: Work, one: string, many: string) => {
    const n = mine.filter((entry) => entry.kind === kind).length;
    return n === 0 ? [] : [n === 1 ? one : `${n} ${many}`];
  };
  const watch = mine.find((entry) => entry.kind === "watch");
  const parts = [
    ...count("smooth", "a clip smoothing", "clips smoothing"),
    ...count("map", "a map shot rendering", "map shots rendering"),
    ...(watch === undefined ? [] : [watch.total > 0 ? `the watcher (${watch.done} of ${watch.total} windows)` : "the watcher"]),
    ...count("export", "an export", "exports"),
  ];
  return `${parts.join(", ")}: done in ${about(ms)}`;
}

/** The line a reply gives for work it started: how long, and to wait once. */
export function lookAgain(project: string, kinds?: readonly Work[]): string {
  const said = summary(project, kinds);
  if (said === null) return "";
  return ` ${said}. Go on with other work; when you need it done, wait once (wait) rather than reading the project again to see.`;
}

/**
 * Waits until a project's work of these kinds is done, or `limitMs` has
 * passed. Returns whether it's all done.
 */
export async function waitFor(project: string, kinds: readonly Work[], limitMs: number, busy: () => boolean = () => false): Promise<boolean> {
  const started = timing.now();
  for (;;) {
    if (pending(project, kinds).length === 0 && !busy()) return true;
    if (timing.now() - started >= limitMs) return false;
    await timing.sleep(Math.min(1000, Math.max(limitMs - (timing.now() - started), 10)));
  }
}

/** For tests: forget everything running and the measured figures. */
export function reset(): void {
  running.clear();
  Object.assign(typical, { smooth: 190_000, map: 300_000, watch: 130_000, export: 600_000 });
}

/** Stores whose exports are followed already. */
const followed = new WeakSet<object>();

/**
 * Follows a store's exports (their "export" events: state and the share
 * done), so an export says how long it has left like the rest. Once per store.
 */
export function followExports(store: { subscribe(listener: (event: Record<string, unknown>) => void): () => void }): void {
  if (followed.has(store)) return;
  followed.add(store);
  store.subscribe((event) => {
    if (event.type !== "export" || typeof event.id !== "string") return;
    const state = event.state;
    if (state === "queued" || state === "running") {
      begin("export", event.id, "export", 1);
      if (state === "running" && typeof event.progress === "number") step("export", event.id, "export", event.progress, 1);
    } else {
      end("export", event.id, "export", state === "done");
    }
  });
}
