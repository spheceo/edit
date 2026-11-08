// Telling the person when work they left running is done (the server's
// notices.ts decides how). This page says where it is and whether its window
// has focus, on the events socket, each time either changes; the server
// answers with a toast here (Edit in front, another page) or, when nothing of
// Edit is in front, a system notification this page shows itself: Linux's
// Chrome window (its profile allows them, linux_desktop.ts) or a browser that
// was allowed. Edit.app's window posts its own (crates/edit-window), and a
// click there opens the page through `edit:open`.

import { navigate, onPath } from "./route";
import { sendEvent, useEditor } from "./store";

export interface Notice {
  key: string;
  title: string;
  body: string;
  path: string;
}

/** Edit.app's window: it posts notifications itself, in Notification Center. */
const inEditApp = (): boolean => (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;

/** Whether this page may show the system's notifications itself. */
const mayShow = (): boolean => !inEditApp() && typeof Notification !== "undefined" && Notification.permission === "granted";

/** Where this page is and whether it's in front, as the server takes it. */
export function attention(): { type: "attention"; focused: boolean; path: string; system: boolean } {
  return { type: "attention", focused: document.visibilityState === "visible" && document.hasFocus(), path: location.pathname, system: mayShow() };
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
    window.removeEventListener("edit:notice", heard);
    window.removeEventListener("edit:open", opened);
    window.removeEventListener("pointerdown", ask, { capture: true });
    stopPath();
  };
}
