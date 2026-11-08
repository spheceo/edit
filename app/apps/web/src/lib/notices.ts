// Telling the person when work they left running is done (the server's
// notices.ts decides how). This page says where it is and whether its window
// has focus, on the events socket, each time either changes; the server
// answers with a toast here (Edit in front, another page) or, when nothing of
// Edit is in front, a system notification this page shows itself: Linux's
// Chrome window (its profile allows them, linux_desktop.ts) or a browser that
// was allowed. Edit.app's window posts its own (crates/edit-window), and a
// click there opens the page through `edit:open`. Settings → Notifications
// turns them back on after a "Don't Allow" (`permission`, `turnOn`, `sendTest`).

import { navigate, onPath } from "./route";
import { sendEvent, useEditor } from "./store";

export interface Notice {
  key: string;
  title: string;
  body: string;
  path: string;
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Edit.app's window's calls (crates/edit-window/src/notices.rs), or null in a browser. */
const windowCalls = (): Invoke | null => {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function" ? internals.invoke : null;
};

/** Edit.app's window: it posts notifications itself, in Notification Center. */
const inEditApp = (): boolean => (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;

/** Linux's window: Chrome's app window onto edit.localhost (linux_desktop.ts). */
const inLinuxWindow = (): boolean => location.hostname === "edit.localhost";

/** Whether this page may show the system's notifications itself. */
const mayShow = (): boolean => !inEditApp() && typeof Notification !== "undefined" && Notification.permission === "granted";

/** Where this page is and whether it's in front, as the server takes it. */
export function attention(): { type: "attention"; focused: boolean; path: string; system: boolean } {
  return { type: "attention", focused: document.visibilityState === "visible" && document.hasFocus(), path: location.pathname, system: mayShow() };
}

/**
 * How notifications stand here: "on", "off" (turned off for Edit), "ask"
 * (never answered), or "none" (this window can't have them).
 */
export type Permission = "on" | "off" | "ask" | "none";

export async function permission(): Promise<Permission> {
  const calls = windowCalls();
  if (calls !== null) {
    try {
      const said = await calls("notices_status");
      return said === "on" || said === "off" || said === "ask" ? said : "none";
    } catch {
      // A window from before Settings could ask.
      return "none";
    }
  }
  if (typeof Notification === "undefined") return "none";
  return Notification.permission === "granted" ? "on" : Notification.permission === "denied" ? "off" : "ask";
}

/** Where turning them on was left: done here, or for the person to finish in System Settings, the reopening window, or the browser's own settings. */
export type TurnedOn = { now: Permission; then: "done" | "system" | "reopening" | "browser" };

/**
 * Turns notifications on as far as this window can (Settings → Notifications):
 * the question again while it may still be asked; once answered no, Edit.app
 * opens macOS's Notifications settings on Edit, and Linux's window reopens
 * with them allowed (Chrome asks only once, and opens no settings from outside).
 */
export async function turnOn(): Promise<TurnedOn> {
  const calls = windowCalls();
  if (calls !== null) {
    const now = (await calls("notices_allow")) as Permission;
    return { now, then: now === "off" ? "system" : "done" };
  }
  if (typeof Notification === "undefined") return { now: "none", then: "done" };
  if (Notification.permission === "default") {
    await Notification.requestPermission();
    window.dispatchEvent(new Event("edit:attention"));
    return { now: await permission(), then: "done" };
  }
  if (Notification.permission === "denied" && inLinuxWindow()) {
    const answer = (await fetch("/api/notifications/reopen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: location.pathname }) })
      .then((response) => response.json())
      .catch(() => ({}))) as { reopening?: unknown };
    if (answer.reopening === true) return { now: "off", then: "reopening" };
  }
  return { now: await permission(), then: Notification.permission === "granted" ? "done" : "browser" };
}

/** A notification now, as one about finished work comes, so the person sees they arrive. */
export async function sendTest(): Promise<void> {
  const calls = windowCalls();
  if (calls !== null) {
    await calls("notices_test", { path: location.pathname });
    return;
  }
  show("system", { key: "test", title: "Notifications are on", body: "This is how Edit tells you a draft, a revision or a share is done.", path: location.pathname });
}

/** Opens the notice's page and brings this window forward. */
function open(path: string): void {
  window.focus();
  navigate(path);
}

function show(how: unknown, notice: Notice): void {
  if (how === "toast") {
    useEditor.getState().toast(`${notice.title} · ${notice.body}`, "agent", { label: "Open", run: () => navigate(notice.path) });
    return;
  }
  if (how !== "system" || !mayShow()) return;
  try {
    const shown = new Notification(notice.title, { body: notice.body, tag: notice.key, icon: "/apple-touch-icon.png" });
    shown.onclick = () => {
      open(notice.path);
      shown.close();
    };
  } catch {
    // A browser that won't show one from a page: the work is still there to see.
  }
}

/** Starts reporting this page's attention and showing notices; returns how to stop. */
export function watchNotices(): () => void {
  let said = "";
  const report = (again = false) => {
    const now = JSON.stringify(attention());
    if (now === said && !again) return;
    said = now;
    sendEvent(now);
  };
  const changed = () => report();
  const connected = () => report(true);
  const heard = (event: Event) => {
    const detail = (event as CustomEvent<{ how?: unknown; notice?: Notice }>).detail;
    if (detail?.notice !== undefined) show(detail.how, detail.notice);
  };
  // Edit.app's window: its notification was clicked.
  const opened = (event: Event) => {
    const path = (event as CustomEvent<unknown>).detail;
    if (typeof path === "string" && path.startsWith("/")) open(path);
  };
  // A browser asks once whether Edit may notify, on a click (it won't ask otherwise).
  const ask = () => {
    if (inEditApp() || typeof Notification === "undefined" || Notification.permission !== "default") return;
    void Notification.requestPermission()
      .then(() => report())
      .catch(() => {});
  };
  window.addEventListener("focus", changed);
  window.addEventListener("blur", changed);
  document.addEventListener("visibilitychange", changed);
  window.addEventListener("edit:connected", connected);
  // The permission changed here (Settings → Notifications): the server hears this page may show them now.
  window.addEventListener("edit:attention", changed);
  window.addEventListener("edit:notice", heard);
  window.addEventListener("edit:open", opened);
  window.addEventListener("pointerdown", ask, { once: true, capture: true });
  const stopPath = onPath(changed);
  report(true);
  return () => {
    window.removeEventListener("focus", changed);
    window.removeEventListener("blur", changed);
    document.removeEventListener("visibilitychange", changed);
    window.removeEventListener("edit:connected", connected);
    window.removeEventListener("edit:attention", changed);
    window.removeEventListener("edit:notice", heard);
    window.removeEventListener("edit:open", opened);
    window.removeEventListener("pointerdown", ask, { capture: true });
    stopPath();
  };
}
