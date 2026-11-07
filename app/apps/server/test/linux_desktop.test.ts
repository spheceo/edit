// Edit on a Linux desktop (linux_desktop.ts): its launcher entry and Chrome's app window.
import { expect, test } from "bun:test";

import { chrome } from "../src/broll.ts";
import { entryText, WINDOW_APP_ID, windowCommand } from "../src/linux_desktop.ts";

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
