// Keeps the Mac awake while Edit works: an import, an export, an upload or an
// agent's turn left running while the editor walks away used to stop when the
// Mac went to sleep, and looked stuck when they came back. macOS's own
// `caffeinate -i -s -w <this pid>` holds off idle sleep (and sleep on power)
// for as long as it runs; it's stopped once nothing's running, and it ends by
// itself if Edit does. A closed lid on battery still sleeps: that's the user's.
// On Linux, systemd's inhibitor lock does the same (idle and sleep), held by a
// `tail --pid` that ends with Edit.

import * as diag from "./diag.ts";

/** How often what's running is looked at. */
const EVERY_MS = 15_000;

let held: Bun.Subprocess | null = null;
const MACHINE = process.platform === "darwin" ? "the Mac" : "this computer";

/** What holds the machine awake until it's killed or Edit ends, or null where there's nothing to. */
function holder(why: string): string[] | null {
  if (process.platform === "darwin") return ["/usr/bin/caffeinate", "-i", "-s", "-w", String(process.pid)];
  if (process.platform === "linux" && Bun.which("systemd-inhibit") !== null) {
    return ["systemd-inhibit", "--what=idle:sleep", "--who=Edit", `--why=${why}`, "--mode=block", "tail", `--pid=${process.pid}`, "-f", "/dev/null"];
  }
  return null;
}

function hold(why: string): void {
  if (held !== null) return;
  const command = holder(why);
  if (command === null) return;
  try {
    held = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    diag.info("awake", `keeping ${MACHINE} awake: ${why}`);
  } catch (error) {
    diag.warn("awake", `couldn't keep ${MACHINE} awake: ${diag.messageOf(error)}`);
  }
}

function release(): void {
  if (held === null) return;
  held.kill();
  held = null;
  diag.info("awake", `nothing running: ${MACHINE} may sleep again`);
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
