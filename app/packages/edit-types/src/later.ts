// Home's Later (Oct 31 2026): what someone set aside, the team's, kept in
// mamagi (`edit:listLater`) through the relay; apps/server/src/later.ts.

/** What can be set aside: an edit, a script, an idea or a board card waiting on changes, by its id ("edit:p17…", "idea:i17…"). */
export type LaterKey = `${"edit" | "script" | "idea" | "card"}:${string}`;

/** One thing set aside. */
export interface LaterEntry {
  key: LaterKey;
  /** When it comes back by itself (ms since 1970); null: when someone brings it back. */
  until: number | null;
  /** When it was set aside. */
  at: number;
  /** Who set it aside. */
  by: { sub: string; name: string; picture: string | null } | null;
}
