// A "(conflicted copy)" on Home: kept by a Mac when two changed one script or
// edit at once. That Mac pushed it as new, so the cloud names that Mac's person
// as who started it, and it stood in their Mine (Nov 8, JJ: "Why do these stand
// like they are my scripts? They are not"). It's whose its original is.

/** "Name (conflicted copy)", once or more. */
export const COPY = /(\s*\(conflicted copy\))+$/u;

/** Each conflicted copy made as its original's (by name, a script or the edit made from it): yours only if that is. */
export function creditCopies<T extends { title: string; mine: boolean; fresh?: boolean; section: string }>(items: T[]): void {
  const originals = new Map(items.filter((item) => item.section !== "ideas" && !COPY.test(item.title)).map((item) => [item.title, item]));
  for (const item of items) {
    const original = COPY.test(item.title) ? originals.get(item.title.replace(COPY, "")) : undefined;
    if (original === undefined) continue;
    item.mine = original.mine;
    // Not yours: not under your New either.
    if (!original.mine) item.fresh = false;
  }
}
