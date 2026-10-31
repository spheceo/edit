// Home's Later (Oct 31 2026): what someone set aside, the team's (the server's
// later.ts, mamagi's editLater). Set aside until tomorrow, Monday, a week or
// until someone brings it back; it leaves its list and comes back by itself
// on its day. The user, Oct 31: "we also need to be able to have ways to put
// projects aside, say we want to come back to a project later".

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

/** The times something can be set aside until, from `now`: tomorrow, Monday (when that isn't tomorrow), a week, and until someone brings it back. */
export function asideChoices(now = new Date()): { label: string; hint: string; until: number | null }[] {
  const tomorrow = dayStart(now, 1);
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  const monday = dayStart(now, toMonday);
  const week = dayStart(now, 7);
  const short = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return [
    { label: "Tomorrow", hint: new Date(tomorrow).toLocaleDateString(undefined, { weekday: "short" }), until: tomorrow },
    ...(toMonday > 1 ? [{ label: "Monday", hint: short(monday), until: monday }] : []),
    { label: "In a week", hint: short(week), until: week },
    { label: "Until I bring it back", hint: "", until: null },
  ];
}

/** When something comes back, in a word or two: "Tomorrow", "Mon 2 Nov", "No date". */
export function backLabel(until: number | null, now = new Date()): string {
  if (until === null) return "No date";
  if (until <= dayStart(now, 1)) return "Tomorrow";
  return new Date(until).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export interface Later {
  /** What's set aside now, by key. */
  entries: Map<string, LaterEntry>;
  /** Later can be used (signed in: it's the team's, in the cloud). */
  on: boolean;
  /** Sets `key` aside (`title` names it in the toast), with Undo. */
  set: (key: LaterKey, until: number | null, title: string) => void;
  /** Brings `key` back, with Undo. */
  back: (key: LaterKey, title: string) => void;
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
  // Something whose day came while Home was open goes back to its list.
  const now = Date.now();
  const live = entries.filter((entry) => entry.until === null || entry.until > now);
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
    const before = live.find((one) => one.key === key) ?? null;
    const entry: LaterEntry = { key, until, at: Date.now(), by: mine() };
    save(key, entry, before, `set “${title}” aside`);
    useEditor.getState().toast(until === null ? `“${title}” is set aside until you bring it back` : `“${title}” is set aside until ${backLabel(until)}`, "info", {
      label: "Undo",
      run: () => save(key, before, entry, before === null ? `bring “${title}” back` : `set “${title}” aside`),
    });
  };
  const back = (key: LaterKey, title: string) => {
    const before = live.find((one) => one.key === key) ?? null;
    if (before === null) return;
    save(key, null, before, `bring “${title}” back`);
    useEditor.getState().toast(`“${title}” is back`, "info", { label: "Undo", run: () => save(key, before, null, `set “${title}” aside`) });
  };
  return { entries: new Map(live.map((entry) => [entry.key, entry])), on, set, back };
}
