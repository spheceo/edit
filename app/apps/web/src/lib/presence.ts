// Tells Edit's server someone is using the window (apps/server/src/presence.ts),
// so diagnostics can say how long the app has been idle before an admin acts
// from afar. A key, a click or a scroll, at most every 30 s; nothing else.

const EVERY_MS = 30_000;

/** Calls `send` on the first use and then at most once every `every` ms; returns the listener to attach. */
export function throttled(send: () => void, every = EVERY_MS, now: () => number = Date.now): () => void {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const at = now();
    if (at - last < every) return;
    last = at;
    send();
  };
}

/** Starts reporting use of this window; returns how to stop. */
export function watchPresence(target: Window = window): () => void {
  const used = throttled(() => void fetch("/api/presence", { method: "POST" }).catch(() => {}));
  const events = ["keydown", "pointerdown", "wheel"] as const;
  for (const event of events) target.addEventListener(event, used, { passive: true, capture: true });
  return () => {
    for (const event of events) target.removeEventListener(event, used, { capture: true });
  };
}
