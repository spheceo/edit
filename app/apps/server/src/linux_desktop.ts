// Edit on a Linux desktop: its window is Chrome's, as an app window (no tabs,
// no address bar) with a profile of its own in the Edit home, since
// WebKitGTK (what Tauri's window is on Linux) has no WebGPU and Chrome there
// does (Nov 7, an RTX 4060, no flags). And it's in the desktop's app list with
// its icon: a release writes `edit.desktop` and the icon in the user's data
// folder whenever it starts, so the entry always opens the `edit` running now.
//
// The window is opened at edit.localhost (Chrome reaches *.localhost on this
// machine and counts it secure, so WebGPU works): Chrome names an app
// window's Wayland app ID by its host, port left out, so the entry's
// StartupWMClass claims Edit's window and not other 127.0.0.1 pages.

import * as fs from "node:fs";
import * as os from "node:os";

import icon from "../../../assets/brand/edit-icon-1024.png" with { type: "file" };

import type { App } from "./app.ts";
import { chrome } from "./broll.ts";
import * as diag from "./diag.ts";
import { json } from "./http/errors.ts";
import { readJson, type Router } from "./http/router.ts";
import { join, parent } from "./paths.ts";
import { RELEASE } from "./version.ts";
import { reopenWindow } from "./window.ts";

/** The host Edit's window opens: its own, so the window has its own app ID. */
export const WINDOW_HOST = "edit.localhost";

/** Chrome's Wayland app ID for an app window onto `WINDOW_HOST` (its Default profile). */
export const WINDOW_APP_ID = `chrome-${WINDOW_HOST}__-Default`;

/** Chrome's command for Edit's window onto the server at `port`, or null with no Chrome. */
export function windowCommand(home: string, port: number): string[] | null {
  const browser = chrome();
  if (browser === null) return null;
  return [
    browser,
    `--app=http://${WINDOW_HOST}:${port}/`,
    `--user-data-dir=${join(home, "window")}`,
    "--class=Edit",
    "--no-first-run",
    "--no-default-browser-check",
    // Nothing kept in this profile needs the desktop's keyring (Edit's sign-in is the server's): no unlock prompt.
    "--password-store=basic",
    // Reopened by Edit (Settings → Notifications), it was closed on purpose: no "restore pages?".
    "--hide-crash-restore-bubble",
    "--window-size=1600,1000",
  ];
}

/** Whether a Chrome is running on `profile` now: its lock names this machine and a live process (one killed leaves its lock). */
function chromeOn(profile: string): boolean {
  let target: string;
  try {
    target = fs.readlinkSync(join(profile, "SingletonLock"));
  } catch {
    return false;
  }
  const at = target.lastIndexOf("-");
  const pid = Number(target.slice(at + 1));
  // Another machine's lock (a shared home): not ours to judge.
  if (at < 0 || target.slice(0, at) !== os.hostname() || !Number.isInteger(pid)) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lets Edit's page in the window show the desktop's notifications without
 * asking (notices.ts: a draft is ready while Edit is behind other windows):
 * the window's own Chrome profile allows them for its origin. Written before
 * Chrome starts, since it reads its profile only then (and a Chrome running
 * on it writes its own copy back on quit). A block set in the window stays,
 * unless `again` (Settings → Notifications → Turn on).
 */
export function allowNotifications(home: string, port: number, again = false): void {
  const profile = join(home, "window");
  if (chromeOn(profile)) return;
  const path = join(profile, "Default", "Preferences");
  let prefs: Record<string, unknown> = {};
  try {
    const read = JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
    if (read !== null && typeof read === "object" && !Array.isArray(read)) prefs = read as Record<string, unknown>;
  } catch {
    // A new profile.
  }
  const within = (parent: Record<string, unknown>, key: string): Record<string, unknown> => {
    const found = parent[key];
    if (found !== null && typeof found === "object" && !Array.isArray(found)) return found as Record<string, unknown>;
    const made: Record<string, unknown> = {};
    parent[key] = made;
    return made;
  };
  const allowed = within(within(within(within(prefs, "profile"), "content_settings"), "exceptions"), "notifications");
  const origin = `http://${WINDOW_HOST}:${port},*`;
  const now = (allowed[origin] as { setting?: unknown } | undefined)?.setting;
  if (now === 1 || (now !== undefined && !again)) return;
  allowed[origin] = { setting: 1 };
  try {
    keep(path, JSON.stringify(prefs));
  } catch (error) {
    diag.warn("app", `letting Edit's window show notifications: ${diag.messageOf(error)}`);
  }
}

/**
 * Settings → Notifications → Turn on, in Linux's window after a block: Chrome
 * won't ask again and won't open its settings from outside, so the window is
 * closed, its profile allowed again, and opened back on the same page (about
 * two seconds). Answered first; false when this Edit has no window of its own.
 */
export function routes(router: Router<App>): void {
  router.post("/api/notifications/reopen", async (context) => {
    const given = (await readJson<{ path?: unknown }>(context).catch(() => ({}))) as { path?: unknown };
    const path = typeof given.path === "string" && given.path.startsWith("/") ? given.path : "/";
    if (process.platform !== "linux") return json({ reopening: false });
    const { home } = context.app.store;
    const { port } = context.app;
    const done = reopenWindow(`http://${WINDOW_HOST}:${port}${path}`, () => allowNotifications(home, port, true));
    // Its answer goes before the window does.
    const answer = await Promise.race([done.then((reopening) => ({ reopening })), Bun.sleep(300).then(() => ({ reopening: true }))]);
    void done.catch((error: unknown) => diag.warn("app", `reopening Edit's window: ${diag.messageOf(error)}`));
    return json(answer);
  });
}

/** Where the desktop looks for the user's apps and their icons. */
function dataHome(): string {
  const given = process.env.XDG_DATA_HOME;
  return given !== undefined && given !== "" ? given : join(os.homedir(), ".local", "share");
}

/** The entry for `program`, opening Edit's window. */
export function entryText(program: string, iconPath: string): string {
  const quoted = /[\s"'\\$`]/u.test(program) ? `"${program.replace(/(["\\$`])/gu, "\\$1")}"` : program;
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Edit",
    "Comment=Scripts and edits, with the agent",
    `Exec=${quoted} app`,
    `Icon=${iconPath}`,
    "Terminal=false",
    "Categories=AudioVideo;Video;AudioVideoEditing;",
    `StartupWMClass=${WINDOW_APP_ID}`,
    "StartupNotify=true",
    "",
  ].join("\n");
}

/** Writes `text` to `path` when it isn't there already (mode 644). */
function keep(path: string, bytes: Uint8Array | string): void {
  const now = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  try {
    if (fs.readFileSync(path).equals(now)) return;
  } catch {
    // Not there yet.
  }
  fs.mkdirSync(parent(path)!, { recursive: true });
  const next = `${path}.${process.pid}.next`;
  fs.writeFileSync(next, now, { mode: 0o644 });
  fs.renameSync(next, path);
}

/**
 * Puts Edit in this Linux desktop's apps, opening the `edit` running now: a
 * release only (a dev run's program is Bun), and quietly when it can't.
 */
export function keepLauncher(): void {
  if (process.platform !== "linux" || !RELEASE) return;
  try {
    const program = fs.realpathSync(process.execPath);
    const iconPath = join(dataHome(), "icons", "edit.png");
    keep(iconPath, new Uint8Array(fs.readFileSync(icon)));
    keep(join(dataHome(), "applications", "edit.desktop"), entryText(program, iconPath));
  } catch (error) {
    diag.warn("app", `adding Edit to the desktop's apps: ${diag.messageOf(error)}`);
  }
}
