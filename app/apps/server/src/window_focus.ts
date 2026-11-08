// Bringing Edit's window to the front from the server: after the browser's
// sign-in comes back (the team: Edit "should come to the front by itself").
// The window (crates/edit-window) asks `GET /api/window/next`, a long poll
// answered `{focus: true}` the moment something here wants the window in
// front, or `{focus: false}` after a while to ask again. Both ways Edit runs
// work alike (Edit.app starts the server; `edit app` starts the window), no
// macOS permission is needed, and a headless `edit serve` has no window
// asking, so `attached()` says to offer an "Open Edit" button instead.
//
// The same poll carries the notifications the window posts in the Mac's
// Notification Center (notices.ts decides when): `notices`, each with the
// page a click opens.

import type { App } from "./app.ts";
import type { Router } from "./http/router.ts";

/** How long one poll is held before it's answered "nothing yet". */
const HOLD_MS = 25_000;
/** A window that asked within this long is there. */
const FRESH_MS = HOLD_MS + 10_000;
/** A notice no poll took within this long is dropped: old news by the time a window asks. */
const NOTICE_KEPT_MS = 60_000;

/** A notification for the window to post: a click opens `path`. */
export interface WindowNotice {
  key: string;
  title: string;
  body: string;
  path: string;
}

/** One poll's answer. */
export interface Answer {
  focus: boolean;
  notices: WindowNotice[];
}

let waiting: ((answer: Answer) => void)[] = [];
let lastAsked = 0;
/** A focus asked while no window was waiting: given to the next poll that comes soon. */
let owed = 0;
/** Notices waiting for the next poll, with when they came. */
let queued: { notice: WindowNotice; at: number }[] = [];

/** Whether Edit's own window is open and listening (Edit.app, `edit app`); false when headless. */
export function attached(): boolean {
  return waiting.length > 0 || Date.now() - lastAsked < FRESH_MS;
}

/** The queued notices still fresh, taken. */
function take(): WindowNotice[] {
  const now = Date.now();
  const fresh = queued.filter((one) => now - one.at < NOTICE_KEPT_MS).map((one) => one.notice);
  queued = [];
  return fresh;
}

/** Brings Edit's window to the front, if there is one. */
export function focus(): void {
  const now = waiting;
  waiting = [];
  if (now.length === 0) owed = Date.now();
  const notices = take();
  now.forEach((answer, index) => answer({ focus: true, notices: index === 0 ? notices : [] }));
}

/** Hands the window a notification to post; false when no window is listening (headless, or Linux's Chrome window). */
export function notify(notice: WindowNotice): boolean {
  if (!attached()) return false;
  queued.push({ notice, at: Date.now() });
  const first = waiting.shift();
  first?.({ focus: false, notices: take() });
  return true;
}

/** One poll: answered when `focus()` or `notify()` is called, else "nothing" after HOLD_MS (`holdMs` for tests). */
export function next(holdMs = HOLD_MS): Promise<Answer> {
  lastAsked = Date.now();
  const focusOwed = owed > 0 && Date.now() - owed < 10_000;
  if (focusOwed || queued.length > 0) {
    owed = 0;
    return Promise.resolve({ focus: focusOwed, notices: take() });
  }
  return new Promise((resolve) => {
    const answer = (given: Answer) => {
      clearTimeout(timer);
      lastAsked = Date.now();
      resolve(given);
    };
    const timer = setTimeout(() => {
      waiting = waiting.filter((one) => one !== answer);
      answer({ focus: false, notices: [] });
    }, holdMs);
    waiting.push(answer);
  });
}

export function routes(router: Router<App>): void {
  router.get("/api/window/next", async () => Response.json(await next()));
}

/** Tests: nothing waiting, nothing owed. */
export function resetForTests(): void {
  for (const answer of waiting) answer({ focus: false, notices: [] });
  waiting = [];
  lastAsked = 0;
  owed = 0;
  queued = [];
}
