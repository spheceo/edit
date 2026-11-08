// Project patches (speed-plan 5.1): every change sent the whole project (1–2
// MB, ~100 KB compressed) to every browser, and every UI save sent it back.
// A patch says only what changed: top-level fields set or removed, and for a
// list of things with ids (clips, media, tracks, people, markers…) the ones
// added or changed, the ids removed and, when it moved, the new order.
// Applying keeps everything unchanged as it was (the same objects), which the
// UI's undo history shares.
//
// The same file is apps/web/src/lib/patch.ts (a test checks they match).

export interface ListPatch {
  /** Items added or changed (whole). */
  put: unknown[];
  remove: string[];
  /** Every id in its new order, when the order changed otherwise. */
  order?: string[];
}

export interface Patch {
  set: Record<string, unknown>;
  unset: string[];
  lists: Record<string, ListPatch>;
}

type Item = { id: string } & Record<string, unknown>;

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** A list whose items all have distinct string ids. */
function keyed(value: unknown): value is Item[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null || typeof (item as { id?: unknown }).id !== "string") return false;
    const id = (item as Item).id;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

function listDiff(before: Item[], after: Item[]): ListPatch | null {
  const old = new Map(before.map((item) => [item.id, item]));
  const now = new Set(after.map((item) => item.id));
  const put = after.filter((item) => {
    const was = old.get(item.id);
    return was === undefined || !same(was, item);
  });
  const remove = before.filter((item) => !now.has(item.id)).map((item) => item.id);
  // Where applying puts and removes alone would leave each id.
  const naive = [...before.filter((item) => now.has(item.id)).map((item) => item.id), ...after.filter((item) => !old.has(item.id)).map((item) => item.id)];
  const order = after.map((item) => item.id);
  const moved = naive.length !== order.length || naive.some((id, index) => id !== order[index]);
  if (put.length === 0 && remove.length === 0 && !moved) return null;
  return moved ? { put, remove, order } : { put, remove };
}

/** What turns `before` into `after`. */
export function diff(old: object, now: object): Patch {
  const before = old as Record<string, unknown>;
  const after = now as Record<string, unknown>;
  const patch: Patch = { set: {}, unset: [], lists: {} };
  for (const [key, value] of Object.entries(after)) {
    const was = before[key];
    if (was === value) continue;
    if (keyed(was) && keyed(value)) {
      const list = listDiff(was, value);
      if (list !== null) patch.lists[key] = list;
      continue;
    }
    if (!(key in before) || !same(was, value)) patch.set[key] = value;
  }
  for (const key of Object.keys(before)) if (!(key in after)) patch.unset.push(key);
  return patch;
}

export function empty(patch: Patch): boolean {
  return Object.keys(patch.set).length === 0 && patch.unset.length === 0 && Object.keys(patch.lists).length === 0;
}

/** `base` with `patch` applied; throws when the patch doesn't fit it. */
export function apply<T extends object>(base: T, patch: Patch): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch.set)) out[key] = value;
  for (const key of patch.unset) delete out[key];
  for (const [key, change] of Object.entries(patch.lists)) {
    const list = out[key] ?? [];
    if (!keyed(list)) throw new Error(`${key} isn't a list of things with ids`);
    const gone = new Set(change.remove);
    const next = list.filter((item) => !gone.has(item.id));
    const at = new Map(next.map((item, index) => [item.id, index]));
    for (const item of change.put) {
      const id = (item as { id?: unknown } | null)?.id;
      if (typeof id !== "string") throw new Error(`a changed ${key} item has no id`);
      const index = at.get(id);
      if (index === undefined) {
        at.set(id, next.length);
        next.push(item as Item);
      } else {
        next[index] = item as Item;
      }
    }
    if (change.order !== undefined) {
      const byId = new Map(next.map((item) => [item.id, item]));
      if (change.order.length !== next.length || change.order.some((id) => !byId.has(id))) {
        throw new Error(`${key}'s new order doesn't match its items`);
      }
      out[key] = change.order.map((id) => byId.get(id)!);
    } else {
      out[key] = next;
    }
  }
  return out as T;
}

/**
 * Fields that count as no one's change when two patches meet: `next_id` only
 * hands out ids (each change made on the newer version takes a fresh one).
 */
const SHARED = new Set(["next_id"]);

/** What a patch changes, one name each: `<field>` set or removed, `<list>:<id>` put or removed, `<list>:order` reordered. */
export function touched(patch: Patch): Set<string> {
  const out = new Set<string>();
  for (const key of [...Object.keys(patch.set), ...patch.unset]) if (!SHARED.has(key)) out.add(key);
  for (const [key, list] of Object.entries(patch.lists)) {
    for (const item of list.put) out.add(`${key}:${String((item as { id?: unknown } | null)?.id)}`);
    for (const id of list.remove) out.add(`${key}:${id}`);
    if (list.order !== undefined) out.add(`${key}:order`);
  }
  return out;
}

/** What both patches change (none: one can go on top of the other without touching what the other did). */
export function overlap(a: Patch, b: Patch): string[] {
  const theirs = touched(a);
  return [...touched(b)].filter((name) => theirs.has(name));
}

/** `patch` in two: what touches none of `names`, and what does. */
export function split(patch: Patch, names: Iterable<string>): { rest: Patch; clashing: Patch } {
  const clash = new Set(names);
  const rest: Patch = { set: {}, unset: [], lists: {} };
  const clashing: Patch = { set: {}, unset: [], lists: {} };
  for (const [key, value] of Object.entries(patch.set)) (clash.has(key) ? clashing : rest).set[key] = value;
  for (const key of patch.unset) (clash.has(key) ? clashing : rest).unset.push(key);
  for (const [key, list] of Object.entries(patch.lists)) {
    const into = (side: Patch): ListPatch => (side.lists[key] ??= { put: [], remove: [] });
    for (const item of list.put) into(clash.has(`${key}:${String((item as { id?: unknown } | null)?.id)}`) ? clashing : rest).put.push(item);
    for (const id of list.remove) into(clash.has(`${key}:${id}`) ? clashing : rest).remove.push(id);
    if (list.order !== undefined) into(clash.has(`${key}:order`) ? clashing : rest).order = list.order;
  }
  for (const side of [rest, clashing]) {
    for (const [key, list] of Object.entries(side.lists)) if (list.put.length === 0 && list.remove.length === 0 && list.order === undefined) delete side.lists[key];
  }
  return { rest, clashing };
}
