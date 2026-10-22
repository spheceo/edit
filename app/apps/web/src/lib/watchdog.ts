// Catches the page freezing (a render loop, a runaway effect): a heartbeat
// that comes late says the main thread was stuck, and each store's changes are
// counted, so the log names what was churning ("useEditor.media 4,812 times in
// 2 s") instead of just "Loading frame…" and a window that won't click.

import { useAgent } from "./agent";
import { note } from "./diagnostics";
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

let reported = 0;

export function watchForFreezes() {
  useEditor.subscribe((next, prev) => count("useEditor", next, prev));
  useAgent.subscribe((next, prev) => count("useAgent", next, prev));
  useView.subscribe((next, prev) => count("useView", next, prev));
  let beat = performance.now();
  setInterval(() => {
    const now = performance.now();
    const late = now - beat - 250;
    beat = now;
    const total = [...counts.values()].reduce((sum, times) => sum + times, 0);
    // At most one report every 10 s, so a long freeze doesn't flood the log.
    if ((late > LATE_MS || total > STORM) && Date.now() - reported > 10_000) {
      reported = Date.now();
      const what = busiest(counts) || busiest(last) || "no store changing (a component's own state, or work outside React)";
      note("warn", "ui", `${late > LATE_MS ? `The page was stuck for ${(late / 1000).toFixed(1)} s` : `${total} store changes in a quarter of a second`}; changing most: ${what}`);
    }
    // A late beat covers the stuck stretch: keep last second's counts for the report.
    if (late <= LATE_MS) last = counts;
    counts = new Map();
  }, 250);
}
