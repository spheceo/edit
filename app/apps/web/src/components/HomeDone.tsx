// Marked done on the classic Home (Sphe, Oct 31: "have the ability to set
// projects as done, so we dont have to see them"): the new Home's Mark as done,
// kept in the team's Later (the server's later.ts), so a project marked done
// here is done on every Mac and in the new Home's Done too. It leaves Needs you
// and All projects for the Done tab, where Move back brings it back.

import { CircleCheck, Undo2 } from "lucide-react";
import { createContext, useContext } from "react";

import { laterKey, type Later, type LaterKey } from "../lib/later";
import type { Listed } from "./Home";
import type { MenuItem } from "./ContextMenu";

export const DoneContext = createContext<Later | null>(null);

/** A row's key in Later: an edit by its project, a script by its id (as the new Home keys them). */
export function rowKey(row: Listed): LaterKey | null {
  if (row.local !== null) return laterKey("edit", row.local.id);
  if (row.cloud !== null) return laterKey("edit", row.cloud.id);
  return row.script ? laterKey("script", row.script.id) : null;
}

/** Whether `key` is marked done, and when. */
export function doneAt(later: Later, key: LaterKey | null): number | null {
  const entry = key === null ? undefined : later.entries.get(key);
  return entry?.done === true ? entry.at : null;
}

/** A row's ⋯ item: Mark as done, or Move back once it's done. */
export function useDoneItems(key: LaterKey | null, title: string): MenuItem[] {
  const later = useContext(DoneContext);
  if (later === null || key === null || !later.on) return [];
  return doneAt(later, key) !== null
    ? [{ label: "Move back", icon: <Undo2 size={14} />, onSelect: () => later.moveBack(key, title) }]
    : [{ label: "Mark as done", icon: <CircleCheck size={14} />, onSelect: () => later.done(key, title) }];
}
