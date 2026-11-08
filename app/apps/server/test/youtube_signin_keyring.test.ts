import { expect, test } from "bun:test";

import { keyring } from "../src/youtube_signin.ts";

test("Chrome's keyring is named on Linux, whatever session the server was started in", () => {
  // A server started outside a desktop session (Nov 8: the trial server from a shell) has no desktop variables.
  expect(keyring({}, "linux")).toBe("+gnomekeyring");
  expect(keyring({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }, "linux")).toBe("+gnomekeyring");
  expect(keyring({ XDG_CURRENT_DESKTOP: "KDE", KDE_SESSION_VERSION: "6" }, "linux")).toBe("+kwallet6");
  expect(keyring({ DESKTOP_SESSION: "plasma", KDE_SESSION_VERSION: "5" }, "linux")).toBe("+kwallet5");
  // A Mac's Chrome key is the Keychain's: yt-dlp needs no name there.
  expect(keyring({}, "darwin")).toBe("");
});
