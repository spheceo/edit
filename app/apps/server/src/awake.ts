// Keeps the Mac awake while Edit works: an import, an export, an upload or an
// agent's turn left running while the editor walks away used to stop when the
// Mac went to sleep, and looked stuck when they came back. macOS's own
// `caffeinate -i -s -w <this pid>` holds off idle sleep (and sleep on power)
// for as long as it runs; it's stopped once nothing's running, and it ends by
// itself if Edit does. A closed lid on battery still sleeps: that's the user's.

import * as diag from "./diag.ts";

/** How often what's running is looked at. */
const EVERY_MS = 15_000;

let held: Bun.Subprocess | null = null;

function hold(why: string): void {
  if (held !== null || process.platform !== "darwin") return;
  try {
    held = Bun.spawn(["/usr/bin/caffeinate", "-i", "-s", "-w", String(process.pid)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    diag.info("awake", `keeping the Mac awake: ${why}`);
  } catch (error) {
    diag.warn("awake", `couldn't keep the Mac awake: ${diag.messageOf(error)}`);
  }
}

function release(): void {
  if (held === null) return;
  held.kill();
  held = null;
  diag.info("awake", "nothing running: the Mac may sleep again");
}

/** Looks every few seconds at `working` (what's running, or null) and holds the Mac awake while it says something. */
export function keepAwakeWhile(working: () => string | null): void {
  const look = () => {
    let why: string | null = null;
    try {
      why = working();
    } catch (error) {
      diag.warn("awake", diag.messageOf(error));
    }
    if (why === null) release();
    else hold(why);
  };
  setInterval(look, EVERY_MS).unref();
  look();
}
