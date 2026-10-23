// Bringing Edit's window to the front from the server: after the browser's
// sign-in comes back (the team: Edit "should come to the front by itself").
// The window (crates/edit-window) asks `GET /api/window/next`, a long poll
// answered `{focus: true}` the moment something here wants the window in
// front, or `{focus: false}` after a while to ask again. Both ways Edit runs
// work alike (Edit.app starts the server; `edit app` starts the window), no
// macOS permission is needed, and a headless `edit serve` has no window
// asking, so `attached()` says to offer an "Open Edit" button instead.

import type { App } from "./app.ts";
import type { Router } from "./http/router.ts";

/** How long one poll is held before it's answered "nothing yet". */
const HOLD_MS = 25_000;
/** A window that asked within this long is there. */
const FRESH_MS = HOLD_MS + 10_000;

let waiting: ((focus: boolean) => void)[] = [];
let lastAsked = 0;
/** A focus asked while no window was waiting: given to the next poll that comes soon. */
let owed = 0;

/** Whether Edit's own window is open and listening (Edit.app, `edit app`); false when headless. */
export function attached(): boolean {
  return waiting.length > 0 || Date.now() - lastAsked < FRESH_MS;
}

/** Brings Edit's window to the front, if there is one. */
export function focus(): void {
  const now = waiting;
  waiting = [];
  if (now.length === 0) owed = Date.now();
  for (const answer of now) answer(true);
}

/** One poll: answered true when `focus()` is called, false after HOLD_MS (`holdMs` for tests). */
export function next(holdMs = HOLD_MS): Promise<boolean> {
  lastAsked = Date.now();
  if (owed > 0 && Date.now() - owed < 10_000) {
    owed = 0;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const answer = (focus: boolean) => {
      clearTimeout(timer);
      lastAsked = Date.now();
      resolve(focus);
    };
    const timer = setTimeout(() => {
      waiting = waiting.filter((one) => one !== answer);
      answer(false);
    }, holdMs);
    waiting.push(answer);
  });
}

export function routes(router: Router<App>): void {
  router.get("/api/window/next", async () => Response.json({ focus: await next() }));
}

/** Tests: nothing waiting, nothing owed. */
export function resetForTests(): void {
  for (const answer of waiting) answer(false);
  waiting = [];
  lastAsked = 0;
  owed = 0;
}
