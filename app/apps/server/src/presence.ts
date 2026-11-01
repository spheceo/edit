// When someone last used Edit's window (Nov 1: "are you able to see when his
// app is idle?"). The window says so on a key, click or scroll, at most every
// 30 s (apps/web/src/lib/presence.ts); the requests Edit makes by itself (polls,
// the agent, syncs) don't count. Diagnostics say how long ago, so an admin can
// tell "idle for two hours" from "editing right now" before acting from afar.
//
//   POST /api/presence    the window was used just now

import type { App } from "./app.ts";
import { json } from "./http/errors.ts";
import type { Router } from "./http/router.ts";

let last: number | null = null;

/** When the window was last used (ms), or null since Edit started. */
export const lastUsedAt = (): number | null => last;

export function used(at = Date.now()): void {
  last = at;
}

export function routes(router: Router<App>): void {
  router.post("/api/presence", () => {
    used();
    return json({ ok: true });
  });
}
