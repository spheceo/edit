import { getScript } from "./api";
import type { Script } from "./types";

/** Scripts opened (or about to be) this session, shown at once when opened (memory only: they're big). */
export const lastOpened = new Map<string, Script>();

/** Fetched while the pointer rests on its row, so opening it is instant. */
export function prefetchScript(id: string): void {
  if (lastOpened.has(id)) return;
  void getScript(id).then((script) => lastOpened.set(id, script), () => {});
}
