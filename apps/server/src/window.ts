// The desktop app's side here (app.rs): the window is its own small program
// now (crates/edit-window, a Tauri helper), extracted from the binary to
// `<home>/bin/Edit` (that file name is what the Dock shows) and started onto
// the server's URL. It quits when its stdin closes, so a server that dies
// leaves no window behind; when the window closes, Edit lets go of its cloud
// projects and exits.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { embedded } from "./embedded.ts";
import { isFile, join, parent } from "./paths.ts";
import * as seams from "./seams.ts";
import { onRestart } from "./update.ts";

/** The keys a Finder launch lacks that Edit needs: Homebrew's PATH (FFmpeg, Codex) and the library's sign-in. */
const KEYS = ["PATH", "GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET", "GOOGLE_DOCS_REFRESH_TOKEN"];

/**
 * Opened from Finder, the app gets launchd's bare environment: no Homebrew on
 * PATH (FFmpeg, Codex) and none of the shell's keys. Borrow them from the
 * user's login shell, as a terminal would have them.
 */
export function adoptShellEnv(): void {
  if (process.stdin.isTTY === true) return;
  const shell = process.env.SHELL ?? "/bin/zsh";
  let output: Bun.SyncSubprocess<"pipe", "ignore">;
  try {
    // A shell profile that waits on something mustn't keep the app from opening.
    output = Bun.spawnSync([shell, "-ilc", "env -0"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 3000,
    });
  } catch {
    return;
  }
  if (output.signalCode !== null && output.signalCode !== undefined) return;
  for (const entry of output.stdout.toString().split("\0")) {
    const at = entry.indexOf("=");
    if (at < 0) continue;
    const key = entry.slice(0, at);
    const value = entry.slice(at + 1);
    const current = process.env[key];
    const missing = current === undefined || current === "";
    if (KEYS.includes(key) && (key === "PATH" || missing) && value !== "") process.env[key] = value;
  }
}

/** Whether something already listens on 127.0.0.1:`port` (another Edit, most likely). */
export function portTaken(port: number): boolean {
  try {
    const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    probe.stop(true);
    return false;
  } catch {
    return true;
  }
}

/**
 * The window helper to run: the binary's own, written to `<home>/bin/Edit`
 * when it differs from what's there; else `EDIT_WINDOW`, one beside this
 * binary, or the dev build's. Null when this build has none.
 */
export function windowHelper(home: string): string | null {
  const inside = embedded()?.window ?? null;
  if (inside !== null) {
    // Its own folder: "Edit" and "edit" are one name on a case-insensitive disk.
    const target = join(home, "bin", "Edit");
    const bytes = new Uint8Array(fs.readFileSync(inside));
    const want = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    let have: string | null = null;
    try {
      have = new Bun.CryptoHasher("sha256").update(fs.readFileSync(target)).digest("hex");
    } catch {
      have = null;
    }
    if (have !== want) {
      const temp = `${target}.${process.pid}.tmp`;
      fs.mkdirSync(join(home, "bin"), { recursive: true });
      fs.writeFileSync(temp, bytes, { mode: 0o755 });
      fs.chmodSync(temp, 0o755);
      fs.renameSync(temp, target);
    }
    return target;
  }
  const given = process.env.EDIT_WINDOW;
  if (given !== undefined && given !== "") return isFile(given) ? given : null;
  const candidates: string[] = [];
  const beside = parent(fs.realpathSync(process.execPath));
  if (beside !== null) candidates.push(join(beside, "edit-window"));
  // A dev run: the cargo build of crates/edit-window.
  const repo = join(import.meta.dir, "../../..");
  for (const dir of [process.env.CARGO_TARGET_DIR, join(repo, "target")]) {
    if (dir === undefined || dir === "") continue;
    candidates.push(join(dir, "debug", "edit-window"), join(dir, "release", "edit-window"));
  }
  return candidates.find((candidate) => isFile(candidate)) ?? null;
}

/**
 * Opens the editor at `url` in the window helper and runs until it closes:
 * then cloud projects open here are pushed and their locks let go, and Edit
 * exits (with the helper's code when it couldn't open).
 */
export function runWindow(helper: string, url: string): void {
  let restarting = false;
  const child = Bun.spawn([helper, "--url", url], { stdin: "pipe", stdout: "inherit", stderr: "inherit" });
  // An update execs a new `edit app`, which opens a fresh window: this one goes first.
  onRestart(() => {
    restarting = true;
    child.kill();
  });
  void child.exited.then(async (code) => {
    if (restarting) return;
    try {
      await seams.cloudProjects.shutdown();
    } catch (error) {
      if (!seams.isNotPorted(error)) diag.warn("cloud", `on the way out: ${diag.messageOf(error)}`);
    }
    process.exit(code === 0 ? 0 : code);
  });
}
