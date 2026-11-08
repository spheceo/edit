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

import { chrome } from "./broll.ts";
import * as diag from "./diag.ts";
import { join, parent } from "./paths.ts";
import { RELEASE } from "./version.ts";

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
    "--window-size=1600,1000",
  ];
}

/**
 * Lets Edit's page in the window show the desktop's notifications without
 * asking (notices.ts: a draft is ready while Edit is behind other windows):
 * the window's own Chrome profile allows them for its origin. Written before
 * Chrome starts; a Chrome already running on the profile keeps its own copy
 * (and writes it back on quit), so it's left alone then.
 */
export function allowNotifications(home: string, port: number): void {
  const profile = join(home, "window");
  try {
    fs.lstatSync(join(profile, "SingletonLock"));
    return;
  } catch {
    // Chrome isn't running on it.
  }
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
  if ((allowed[origin] as { setting?: unknown } | undefined)?.setting === 1) return;
  allowed[origin] = { setting: 1 };
  try {
    keep(path, JSON.stringify(prefs));
  } catch (error) {
    diag.warn("app", `letting Edit's window show notifications: ${diag.messageOf(error)}`);
  }
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
