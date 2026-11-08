// Catches the page freezing (a render loop, a runaway effect): a heartbeat
// that comes late says the main thread was stuck, and each store's changes are
// counted, so the log names what was churning ("useEditor.media 4,812 times in
// 2 s") instead of just "Loading frame…" and a window that won't click. A
// stall also says what ran meanwhile: the browser's long frames with the
// scripts in them (where it tells), and the components React drew last
// (reactCommits.ts). Nov 8: 730 of Sphe's 732 stalls said only "no store
// changing", which left nothing to fix.

import { useAgent } from "./agent";
import { note } from "./diagnostics";
import { lastCommits, type Commit } from "./reactCommits";
import { useEditor } from "./store";
import { useView } from "./timelineView";

/** A heartbeat this late means the page was stuck. */
const LATE_MS = 1500;
/** This many store changes in a quarter of a second is a loop, not work. */
const STORM = 300;

/** Changes in the current quarter second, by "store.key". */
let counts = new Map<string, number>();
let last = new Map<string, number>();

function count(store: string, next: object, prev: object) {
  for (const key of Object.keys(next)) {
    if ((next as Record<string, unknown>)[key] === (prev as Record<string, unknown>)[key]) continue;
    const name = `${store}.${key}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
}

const busiest = (map: Map<string, number>) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, times]) => `${name} ${times}×`)
    .join(", ");

/** A long stretch of the main thread the browser noted (a long animation frame, or a long task where that's all it tells). */
export interface LongFrame {
  start: number;
  duration: number;
  /** Time in script, and in style and layout, where the browser says. */
  script?: number;
  layout?: number;
  /** The scripts that took longest: "WebSocket.onmessage → applyAgentEvent (index-….js@123456) 820 ms". */
  scripts: string[];
}

const ms = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`);

interface ScriptTiming {
  duration: number;
  invoker?: string;
  invokerType?: string;
  sourceFunctionName?: string;
  sourceURL?: string;
  sourceCharPosition?: number;
}

/** A long-animation-frame (or longtask) entry as the stall line tells it. */
export function frameOf(entry: PerformanceEntry): LongFrame {
  const loaf = entry as PerformanceEntry & { scripts?: ScriptTiming[]; styleAndLayoutStart?: number };
  const scripts = [...(loaf.scripts ?? [])].sort((a, b) => b.duration - a.duration);
  const end = entry.startTime + entry.duration;
  return {
    start: entry.startTime,
    duration: entry.duration,
    ...(loaf.scripts !== undefined ? { script: scripts.reduce((sum, one) => sum + one.duration, 0) } : {}),
    ...(loaf.styleAndLayoutStart ? { layout: Math.max(0, end - loaf.styleAndLayoutStart) } : {}),
    scripts: scripts.slice(0, 3).map((one) => {
      const file = one.sourceURL ? `${one.sourceURL.split("/").pop()}@${one.sourceCharPosition ?? "?"}` : "?";
      return `${one.invoker ?? one.invokerType ?? "?"} → ${one.sourceFunctionName || "(anonymous)"} (${file}) ${ms(one.duration)}`;
    }),
  };
}

/**
 * The stall line: how long, what changed, what ran. `frames` null: this
 * browser doesn't say (Safari, Edit.app's window); an empty list where it
 * does means nothing on the page ran that long, so the page was held up from
 * outside (timers held back while out of view, the computer busy or asleep).
 */
export function describeStall(late: number, changing: string, frames: LongFrame[] | null, commits: readonly Commit[]): string {
  const parts = [`The page was stuck for ${(late / 1000).toFixed(1)} s`, `changing most: ${changing}`];
  if (frames === null) parts.push("long frames: this browser doesn't say");
  else if (frames.length === 0) parts.push("no long frame on the page meanwhile: held up from outside it (timers held back, the computer busy or asleep)");
  else {
    const total = frames.reduce((sum, one) => sum + one.duration, 0);
    const script = frames.reduce((sum, one) => sum + (one.script ?? 0), 0);
    const layout = frames.reduce((sum, one) => sum + (one.layout ?? 0), 0);
    const worst = [...frames].sort((a, b) => b.duration - a.duration)[0]!;
    const split = [script > 0 && `${ms(script)} in script`, layout > 0 && `${ms(layout)} in style and layout`].filter(Boolean).join(", ");
    parts.push(`${frames.length} long frame${frames.length === 1 ? "" : "s"} (${ms(total)}${split ? `: ${split}` : ""}); the longest ${ms(worst.duration)}${worst.scripts.length > 0 ? `: ${worst.scripts.join("; ")}` : ""}`);
  }
  if (commits.length > 0) parts.push(`React drew last: ${commits.slice(-3).map((commit) => `[${commit.names.join(", ")}${commit.count > 1 ? `; ${commit.count} in all` : ""}]`).join(" ")}`);
  return parts.join("; ");
}

let reported = 0;
/** Long frames of the last two minutes. */
let frames: LongFrame[] = [];

/** Watches for long frames where the browser tells, giving back how to take the ones not yet heard; null where it doesn't. */
function watchLongFrames(): (() => void) | null {
  const types = typeof PerformanceObserver === "undefined" ? [] : (PerformanceObserver.supportedEntryTypes ?? []);
  const type = types.includes("long-animation-frame") ? "long-animation-frame" : types.includes("longtask") ? "longtask" : null;
  if (type === null) return null;
  const take = (entries: PerformanceEntry[]) => {
    const since = performance.now() - 120_000;
    frames = [...frames.filter((one) => one.start > since), ...entries.map(frameOf)].slice(-100);
  };
  const observer = new PerformanceObserver((list) => take(list.getEntries()));
  observer.observe({ type, buffered: true });
  // The frame a stall happened in is reported after it ends: what's waiting is taken before reading.
  return () => take(observer.takeRecords());
}

export function watchForFreezes() {
  useEditor.subscribe((next, prev) => count("useEditor", next, prev));
  useAgent.subscribe((next, prev) => count("useAgent", next, prev));
  useView.subscribe((next, prev) => count("useView", next, prev));
  const takeFrames = watchLongFrames();
  let beat = performance.now();
  // A hidden tab's timers run about once a minute (Chrome's throttling), so a
  // beat that late is the tab out of sight, not the page stuck: Oct 30, a
  // background tab said "stuck for 59.8 s" 300 times in four hours.
  let hiddenMeanwhile = document.hidden;
  document.addEventListener("visibilitychange", () => (hiddenMeanwhile = true));
  setInterval(() => {
    const now = performance.now();
    const late = hiddenMeanwhile || document.hidden ? 0 : now - beat - 250;
    const from = beat;
    hiddenMeanwhile = document.hidden;
    beat = now;
    const total = [...counts.values()].reduce((sum, times) => sum + times, 0);
    // At most one report every 10 s, so a long freeze doesn't flood the log.
    if ((late > LATE_MS || total > STORM) && Date.now() - reported > 10_000) {
      reported = Date.now();
      const what = busiest(counts) || busiest(last) || "no store changing (a component's own state, or work outside React)";
      if (late > LATE_MS) {
        const commits = lastCommits().slice(-3);
        // A moment on, so the browser has reported the long frame the stall was in.
        setTimeout(() => {
          takeFrames?.();
          const during = takeFrames === null ? null : frames.filter((one) => one.start + one.duration > from && one.start < now);
          note("warn", "ui", describeStall(late, what, during, commits));
        }, 300);
      } else {
        note("warn", "ui", `${total} store changes in a quarter of a second; changing most: ${what}`);
      }
    }
    // A late beat covers the stuck stretch: keep last second's counts for the report.
    if (late <= LATE_MS) last = counts;
    counts = new Map();
  }, 250);
}
