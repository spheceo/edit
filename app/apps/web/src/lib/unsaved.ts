// Edits the server never got (offline, the server down, another Mac holding
// the lock), kept on this browser so leaving or reloading never drops them:
// the patch from the server's last version (patch.ts) and that version's
// revision, one per project. The next open puts them back (store.ts).
//
// IndexedDB, not localStorage: a patch of a long edit can run to megabytes.
// Storage that's blocked or full answers false or null, never throws.

import type { Patch } from "./patch";

export interface Unsaved {
  id: string;
  base_rev: number;
  patch: Patch;
  /** When it was kept (ms). */
  at: number;
  /**
   * Kept because it met a change from elsewhere to the same things (an agent's,
   * another client's): the other change won, and this one is put back only when
   * asked (store.ts `rebase`), never by itself on the next open.
   */
  collided?: boolean;
}

const DB = "edit.unsaved";
const STORE = "projects";

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("unsaved edits storage blocked"));
  }).catch((error: unknown) => {
    opening = null;
    throw error;
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest | null): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve((request?.result ?? null) as T);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("aborted"));
      }),
  );
}

/** One at a time, in order: a keep can't land after the forget that followed it. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>, fallback: T): Promise<T> {
  const next = queue.then(task).catch(() => fallback);
  queue = next;
  return next;
}

/** Keeps `entry` (replacing the project's last); false when storage failed. */
export function keepUnsaved(entry: Unsaved): Promise<boolean> {
  return serial(() => run<unknown>("readwrite", (store) => store.put(entry)).then(() => true), false);
}

/** The project's kept edits, if any. */
export function readUnsaved(id: string): Promise<Unsaved | null> {
  return serial(() => run<Unsaved | undefined>("readonly", (store) => store.get(id)).then((entry) => entry ?? null), null);
}

export function forgetUnsaved(id: string): Promise<void> {
  return serial(() => run<unknown>("readwrite", (store) => store.delete(id)).then(() => undefined), undefined);
}
