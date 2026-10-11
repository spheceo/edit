/** Preferences are optional: blocked or full browser storage must never break editing. */
export function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private browsing, a full quota, or storage disabled by the browser.
  }
}

export function savedFrame(project: string): number {
  const value = Number(readSetting(`edit.playhead.${project}`));
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function saveFrame(project: string, frame: number) {
  if (Number.isFinite(frame) && frame >= 0 && frame <= Number.MAX_SAFE_INTEGER) {
    writeSetting(`edit.playhead.${project}`, String(Math.round(frame)));
  }
}
