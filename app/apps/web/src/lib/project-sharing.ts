import type { Project } from "./types";

/** Reuses unchanged JSON branches. Only the newly received JSON is modified;
 * prior snapshots (including Immer-frozen undo entries) are never mutated. */
function share(previous: unknown, incoming: unknown): unknown {
  if (Object.is(previous, incoming)) return previous;
  if (!previous || !incoming || typeof previous !== "object" || typeof incoming !== "object") return incoming;
  if (Array.isArray(previous) && Array.isArray(incoming)) {
    let same = previous.length === incoming.length;
    for (let i = 0; i < incoming.length; i++) {
      const value = share(previous[i], incoming[i]);
      if (value !== incoming[i]) incoming[i] = value;
      if (value !== previous[i]) same = false;
    }
    return same ? previous : incoming;
  }
  if (Array.isArray(previous) || Array.isArray(incoming)) return incoming;
  const before = previous as Record<string, unknown>;
  const next = incoming as Record<string, unknown>;
  const keys = Object.keys(next);
  let same = keys.length === Object.keys(before).length;
  for (const key of keys) {
    const value = share(before[key], next[key]);
    if (value !== next[key]) next[key] = value;
    if (!Object.hasOwn(before, key) || value !== before[key]) same = false;
  }
  return same ? previous : incoming;
}

function byId<T extends { id: string }>(before: T[], incoming: T[]): T[] {
  if (before === incoming) return before;
  const known = new Map(before.map((item) => [item.id, item]));
  for (let i = 0; i < incoming.length; i++) incoming[i] = share(known.get(incoming[i].id), incoming[i]) as T;
  return before.length === incoming.length && incoming.every((item, i) => item === before[i]) ? before : incoming;
}

/** Server snapshots used to retain a fresh copy of every clip at each of 200
 * undo steps. A one-clip revision now retains only that clip's changed branches,
 * even if other clips were reordered, inserted or deleted in the same update. */
export function shareProject(before: Project, incoming: Project): Project {
  if (before === incoming || before.id !== incoming.id) return incoming;
  incoming.clips = byId(before.clips, incoming.clips);
  incoming.media = byId(before.media, incoming.media);
  incoming.tracks = byId(before.tracks, incoming.tracks);
  // Collections have already been reconciled by id. Do not walk them again by
  // index: reordered entries may now be frozen nodes from another undo entry.
  const prior = before as unknown as Record<string, unknown>;
  const next = incoming as unknown as Record<string, unknown>;
  const keys = Object.keys(next);
  let same = keys.length === Object.keys(prior).length;
  for (const key of keys) {
    if (key !== "clips" && key !== "tracks" && key !== "media") next[key] = share(prior[key], next[key]);
    if (!Object.hasOwn(prior, key) || next[key] !== prior[key]) same = false;
  }
  return same ? before : incoming;
}
