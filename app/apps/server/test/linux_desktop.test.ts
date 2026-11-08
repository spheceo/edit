// Edit on a Linux desktop (linux_desktop.ts): its launcher entry and Chrome's app window.
import { expect, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { chrome } from "../src/broll.ts";
import { allowNotifications, entryText, WINDOW_APP_ID, windowCommand } from "../src/linux_desktop.ts";

test("the launcher entry opens `edit app` and claims the window by Chrome's app ID for edit.localhost", () => {
  const entry = entryText("/home/sphe/.local/bin/edit", "/home/sphe/.local/share/icons/edit.png");
  expect(entry).toContain("Exec=/home/sphe/.local/bin/edit app\n");
  expect(entry).toContain("Icon=/home/sphe/.local/share/icons/edit.png\n");
  // What Chrome 157 sets for --app=http://edit.localhost:<any port>/ on Wayland (WAYLAND_DEBUG, Nov 7).
  expect(entry).toContain("StartupWMClass=chrome-edit.localhost__-Default\n");
  expect(WINDOW_APP_ID).toBe("chrome-edit.localhost__-Default");
  // A path with a space is quoted, as the spec asks.
  expect(entryText("/opt/my apps/edit", "/i.png")).toContain('Exec="/opt/my apps/edit" app\n');
});

test.skipIf(chrome() === null)("the window is Chrome's app window onto edit.localhost, its profile in the Edit home", () => {
  const command = windowCommand("/home/sphe/.edit", 7700)!;
  expect(command[0]).toBe(chrome()!);
  expect(command).toContain("--app=http://edit.localhost:7700/");
  expect(command).toContain("--user-data-dir=/home/sphe/.edit/window");
});

test("the window's Chrome profile lets Edit's page notify without asking, keeping what else it has; a block stays until Turn on; never under a running Chrome", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "edit-window-prefs-"));
  const allowed = (port: number, setting: number) => ({ content_settings: { exceptions: { notifications: { [`http://edit.localhost:${port},*`]: { setting } } } } });
  try {
    const prefs = path.join(home, "window", "Default", "Preferences");
    allowNotifications(home, 7700);
    expect(JSON.parse(fs.readFileSync(prefs, "utf8"))).toEqual({ profile: allowed(7700, 1) });
    fs.writeFileSync(prefs, JSON.stringify({ browser: { kept: true }, profile: { name: "Edit" } }));
    allowNotifications(home, 7701);
    expect(JSON.parse(fs.readFileSync(prefs, "utf8"))).toEqual({ browser: { kept: true }, profile: { name: "Edit", ...allowed(7701, 1) } });
    // Blocked in the window (Chrome writes 2): kept at the next start, allowed again by Turn on.
    fs.writeFileSync(prefs, JSON.stringify({ profile: allowed(7700, 2) }));
    allowNotifications(home, 7700);
    expect(JSON.parse(fs.readFileSync(prefs, "utf8"))).toEqual({ profile: allowed(7700, 2) });
    allowNotifications(home, 7700, true);
    expect(JSON.parse(fs.readFileSync(prefs, "utf8"))).toEqual({ profile: allowed(7700, 1) });
    // A lock a killed Chrome left (its process gone) doesn't stop it.
    fs.writeFileSync(prefs, "{}");
    const lock = path.join(home, "window", "SingletonLock");
    fs.symlinkSync(`${os.hostname()}-999999999`, lock);
    allowNotifications(home, 7700);
    expect(JSON.parse(fs.readFileSync(prefs, "utf8"))).toEqual({ profile: allowed(7700, 1) });
    // Chrome running on the profile (a live process's lock) keeps its own copy.
    fs.rmSync(lock);
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, lock);
    fs.writeFileSync(prefs, "{}");
    allowNotifications(home, 7700);
    expect(fs.readFileSync(prefs, "utf8")).toBe("{}");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
