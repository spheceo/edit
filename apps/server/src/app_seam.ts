// The app's one export other packages use (through `seams.app`).

/**
 * The binary that was started: the compiled `edit` (bun in a dev run). The
 * Rust app re-ran itself as an `Edit` hard link and kept the original in
 * EDIT_EXE; the window is its own helper now, so this is just the process's.
 */
export function originalExe(): string {
  return process.execPath;
}
