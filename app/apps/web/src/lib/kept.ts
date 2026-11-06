import { useCallback, useState } from "react";

/** The last answer each screen had, kept for this tab (and its reloads). */
const memory = new Map<string, unknown>();

function load<T>(key: string, initial: T): T {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const saved = sessionStorage.getItem(`edit.kept.${key}`);
    if (saved !== null) {
      const value = JSON.parse(saved) as T;
      memory.set(key, value);
      return value;
    }
  } catch {
    // Nothing kept, or not readable: start from `initial`.
  }
  return initial;
}

const WHO = "edit.kept.who";

/**
 * What's kept is the signed-in account's alone: when someone else signs in on
 * this Mac (or their kinds change), it all goes, so nothing of the last
 * account's shows. True when it went because the account changed.
 */
export function keepFor(who: string): boolean {
  let was: string | null = null;
  try {
    was = sessionStorage.getItem(WHO);
  } catch {
    // No session storage: memory only.
  }
  if (was === who) return false;
  memory.clear();
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith("edit.kept.")) sessionStorage.removeItem(key);
    sessionStorage.setItem(WHO, who);
  } catch {
    // As above.
  }
  return was !== null;
}

/**
 * State that outlives the screen: coming back shows what was there at once
 * (state A), and the fresh answer replaces it when it comes (state B), never a
 * blank screen between (the user, Oct 30: "keep state A and then just append
 * state B to state A").
 */
export function useKept<T>(key: string, initial: T): [T, (next: T | ((previous: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => load(key, initial));
  const set = useCallback(
    (next: T | ((previous: T) => T)) => {
      setValue((previous) => {
        const value = typeof next === "function" ? (next as (previous: T) => T)(previous) : next;
        memory.set(key, value);
        try {
          sessionStorage.setItem(`edit.kept.${key}`, JSON.stringify(value));
        } catch {
          // Too big for the session: kept in memory only.
        }
        return value;
      });
    },
    [key],
  );
  return [value, set];
}
