// Telling the person when work they left running is done (Sphe, Nov 8:
// "notifications when things are done, first drafts, revisions etc. if you're
// not on that page or not on the app"): an edit the agent built or revised, a
// script's first draft or revision, an idea's titles, a thumbnail, a share.
//
// Each page says where it is and whether its window has focus
// (`{type: "attention"}` on the events socket, apps/web/src/lib/notices.ts).
// When something finishes:
//   - someone is on its page in a focused window: nothing, they saw it;
//   - Edit is focused on another page: a toast there, with Open;
//   - nobody has Edit in front: the system's notification. A Mac's from Edit's
//     own window, in Notification Center (window_focus.ts carries it,
//     crates/edit-window/src/notices.rs); else from the page that was in front
//     last and may show them (Linux's Chrome window, a browser).
// A click on either opens the page.

import * as diag from "./diag.ts";
import * as windowFocus from "./window_focus.ts";

export interface Notice {
  /** The same key twice within a few seconds is one notice. */
  key: string;
  /** What happened, short: "First draft is ready". */
  title: string;
  /** What it's about: the script's or project's name, maybe a line more. */
  body: string;
  /** The page it's on, opened by a click: `/p/<id>`, `/scripts/<id>`, `/ideas/<id>`, `/thumbnails/<id>`. */
  path: string;
}

/** How a notice reached the person. */
export type Reach = "seen" | "toast" | "window" | "page" | "nobody" | "repeat";

/** A page open on Edit's events socket. */
export interface Viewer {
  send: (text: string) => void;
  /** Its window has focus and the page shows. */
  focused: boolean;
  path: string;
  /** It may show the system's notifications itself (the browser's permission is granted). */
  system: boolean;
  /** When it last had focus (ms), to pick the page that was in front last. */
  lastFocused: number;
}

const viewers = new Set<Viewer>();
/** Keys notified lately, with when. */
const recent = new Map<string, number>();
const REPEAT_MS = 10_000;

/** A page connected: told notices through `send`. */
export function connect(send: (text: string) => void): Viewer {
  const viewer: Viewer = { send, focused: false, path: "/", system: false, lastFocused: 0 };
  viewers.add(viewer);
  return viewer;
}

export function disconnect(viewer: Viewer): void {
  viewers.delete(viewer);
}

/** A message from a page: where it is and whether it has focus. Anything else is ignored. */
export function heard(viewer: Viewer, text: string): void {
  let message: { type?: unknown; focused?: unknown; path?: unknown; system?: unknown };
  try {
    message = JSON.parse(text) as typeof message;
  } catch {
    return;
  }
  if (message === null || typeof message !== "object" || message.type !== "attention") return;
  viewer.focused = message.focused === true;
  if (typeof message.path === "string") viewer.path = message.path;
  viewer.system = message.system === true;
  if (viewer.focused) viewer.lastFocused = Date.now();
}

/** Whether a page at `at` shows what's on `path` (the page itself, or a part of it). */
const shows = (at: string, path: string): boolean => at === path || at.startsWith(`${path}/`) || at.startsWith(`${path}?`);

/** Tells the person `notice`, the way that fits where they are (see the top); how it went. */
export function notify(notice: Notice): Reach {
  const now = Date.now();
  for (const [key, at] of recent) if (now - at > REPEAT_MS) recent.delete(key);
  if (recent.has(notice.key)) return "repeat";
  recent.set(notice.key, now);
  const text = (how: "toast" | "system") => JSON.stringify({ type: "notice", how, notice });
  const focused = [...viewers].filter((one) => one.focused);
  let reach: Reach;
  if (focused.some((one) => shows(one.path, notice.path))) {
    reach = "seen";
  } else if (focused.length > 0) {
    for (const one of focused) one.send(text("toast"));
    reach = "toast";
  } else if (windowFocus.notify(notice)) {
    reach = "window";
  } else {
    const last = [...viewers].filter((one) => one.system).sort((a, b) => b.lastFocused - a.lastFocused)[0];
    if (last === undefined) {
      reach = "nobody";
    } else {
      last.send(text("system"));
      reach = "page";
    }
  }
  diag.info("notices", `${notice.title} (${notice.path}): ${reach}`);
  return reach;
}

/** A line of `text` fit for a notification: its first line, plain, at most `max` characters. */
export function line(text: string, max = 140): string {
  const first =
    text
      .split("\n")
      .map((one) => one.replace(/[*_`#>]+/gu, "").replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1").trim())
      .find((one) => one !== "") ?? "";
  const chars = [...first];
  return chars.length <= max ? first : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** Tests: no pages, nothing sent. */
export function resetForTests(): void {
  viewers.clear();
  recent.clear();
}
