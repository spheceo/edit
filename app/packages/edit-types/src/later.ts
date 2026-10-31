// Home's Later (Oct 31 2026): what someone set aside, the team's, kept in
// mamagi (`edit:listLater`) through the relay; apps/server/src/later.ts.

/** What can be set aside: an edit, a script, an idea or a board card waiting on changes, by its id ("edit:p17…", "idea:i17…"). */
export type LaterKey = `${"edit" | "script" | "idea" | "card"}:${string}`;

/** One thing set aside, or marked done (`done`). */
export interface LaterEntry {
  key: LaterKey;
  /** When it comes back by itself (ms since 1970); null: when someone brings it back (always, done). */
  until: number | null;
  /** Marked done by hand: in Done until someone moves it back. */
  done?: boolean;
  /** When it was set aside, or marked done. */
  at: number;
  /** Who set it aside, or marked it done. */
  by: { sub: string; name: string; picture: string | null } | null;
}
