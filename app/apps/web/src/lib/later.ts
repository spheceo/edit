// Home's Later (Oct 31 2026): what someone set aside, the team's (the server's
// later.ts, mamagi's editLater). Set aside until tomorrow, Monday, a week or
// until someone brings it back, it leaves its list for Later. On its day it's
// back: in its list and at the top of Needs you, marked Back, until someone
// opens it. The user, Oct 31: "we also need to be able to have ways to put
// projects aside, say we want to come back to a project later"; then "does it
// sort of get snoozed and comes back clearly formatted showing like this was
// awoken".

import type { LaterEntry, LaterKey } from "@edit/types/later";
import { useCallback, useEffect } from "react";

import { useAccount } from "./account";
import { useKept } from "./kept";
import { useEditor } from "./store";

export type { LaterEntry, LaterKey };

const KEY = /^(edit|script|idea|card):[A-Za-z0-9_-]{1,120}$/;

/** `kind:id` as Later names it, or null for an id it can't take. */
export function laterKey(kind: "edit" | "script" | "idea" | "card", id: string): LaterKey | null {
  const key = `${kind}:${id}`;
  return KEY.test(key) ? (key as LaterKey) : null;
}

async function call(body?: unknown): Promise<unknown> {
  const response = await fetch("/api/later", body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const answer = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(answer.error ?? `HTTP ${response.status}`);
  return answer;
}

/** Midnight at the start of the day `days` after `from`'s, here. */
function dayStart(from: Date, days: number): number {
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + days);
  return day.getTime();
}

/** The times something can be set aside until, from `now`, each with its day: tomorrow, Monday (when that isn't tomorrow), a week, and until someone brings it back. */
export function asideChoices(now = new Date()): { label: string; day: string; until: number | null }[] {
  const tomorrow = dayStart(now, 1);
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  const monday = dayStart(now, toMonday);
  const week = dayStart(now, 7);
  const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return [
    { label: "Tomorrow", day: day(tomorrow), until: tomorrow },
    ...(toMonday > 1 ? [{ label: "Monday", day: day(monday), until: monday }] : []),
    { label: "In a week", day: day(week), until: week },
    { label: "Until I bring it back", day: "", until: null },
  ];
}

/** When something comes back, in a word or two: "Tomorrow", "Mon 2 Nov", "No date". */
export function backLabel(until: number | null, now = new Date()): string {
  if (until === null) return "No date";
  if (until <= dayStart(now, 1)) return "Tomorrow";
  return new Date(until).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** Set aside still (not back yet). */
export const asleep = (entry: LaterEntry, now = Date.now()) => entry.until === null || entry.until > now;

export interface Later {
  /** What's set aside, and what's back and not opened yet (`asleep` tells them apart), by key. */
  entries: Map<string, LaterEntry>;
  /** Later can be used (signed in: it's the team's, in the cloud). */
  on: boolean;
  /** Sets `key` aside (`title` names it in the toast), with Undo. */
  set: (key: LaterKey, until: number | null, title: string) => void;
  /** Brings `key` back, with Undo. */
  back: (key: LaterKey, title: string) => void;
  /** `key` was opened once back: its Back mark goes, for everyone. */
  seen: (key: LaterKey) => void;
}

/** Later, polled now and then (another Mac sets something aside), changed here at once. */
export function useLater(): Later {
  const [entries, setEntries] = useKept<LaterEntry[]>("home.later", []);
  const account = useAccount((state) => state.account);
  const on = account?.signed_in === true || account?.required === false;
  const refresh = useCallback(() => {
    void call()
      .then((answer) => setEntries((answer as { entries: LaterEntry[] }).entries))
      .catch(() => {});
  }, [setEntries]);
  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const change = (key: LaterKey, entry: LaterEntry | null) => setEntries((all) => [...all.filter((one) => one.key !== key), ...(entry ? [entry] : [])]);
  const save = (key: LaterKey, entry: LaterEntry | null, before: LaterEntry | null, doing: string) => {
    change(key, entry);
    void call(entry === null ? { key, back: true } : { key, until: entry.until })
      .then(refresh)
      .catch((error: unknown) => {
        change(key, before);
        useEditor.getState().toastError(error, doing);
      });
  };
  const mine = (): LaterEntry["by"] => {
    const person = useAccount.getState().account?.person ?? null;
    return person === null ? null : { sub: person.sub ?? "", name: person.name || person.email, picture: person.image };
  };
  const set = (key: LaterKey, until: number | null, title: string) => {
    // Set aside again once back: Undo takes the Back mark away too (a time gone can't be set again).
    const had = entries.find((one) => one.key === key) ?? null;
    const before = had !== null && asleep(had) ? had : null;
    const entry: LaterEntry = { key, until, at: Date.now(), by: mine() };
    save(key, entry, before, `set “${title}” aside`);
    useEditor.getState().toast(until === null ? `“${title}” is set aside until you bring it back` : `“${title}” is set aside until ${backLabel(until)}`, "info", {
      label: "Undo",
      run: () => save(key, before, entry, before === null ? `bring “${title}” back` : `set “${title}” aside`),
    });
  };
  const back = (key: LaterKey, title: string) => {
    const before = entries.find((one) => one.key === key) ?? null;
    if (before === null || !asleep(before)) return;
    save(key, null, before, `bring “${title}” back`);
    useEditor.getState().toast(`“${title}” is back`, "info", { label: "Undo", run: () => save(key, before, null, `set “${title}” aside`) });
  };
  const seen = (key: LaterKey) => {
    const before = entries.find((one) => one.key === key) ?? null;
    if (before === null || asleep(before)) return;
    change(key, null);
    void call({ key, back: true }).catch(() => change(key, before));
  };
  return { entries: new Map(entries.map((entry) => [entry.key, entry])), on, set, back, seen };
}
