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
