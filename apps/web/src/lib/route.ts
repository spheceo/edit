import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
window.addEventListener("popstate", () => listeners.forEach((listener) => listener()));

export function navigate(path: string) {
  if (path === location.pathname) return;
  history.pushState(null, "", path);
  listeners.forEach((listener) => listener());
}

export function usePath() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => location.pathname,
  );
}
