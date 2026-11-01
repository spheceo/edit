// The lessons inbox (Nov 1 2026): lasting feedback the team gave an agent,
// noted so it reaches the next teaching round; kept in mamagi
// (`edit:listLessons`) through the relay; apps/server/src/lesson_inbox.ts.

/** How far a lesson reaches: every video, its kind of video, or one person's or channel's taste. */
export type LessonScope = "house" | "style" | "person";

/** Open: waiting for a teaching round. Taught: in a skill, code or an audit (`outcome` says where). Dropped: a one-off (`outcome` says why). */
export type LessonStatus = "open" | "taught" | "dropped";

export interface LessonPerson {
  sub: string;
  name: string;
  picture: string | null;
}

export interface InboxLesson {
  id: string;
  /** The lesson in general terms. */
  lesson: string;
  /** The team's own words. */
  quote: string;
  /** Who said it, when not whose session noted it (a reviewer on a comment). */
  from: string | null;
  /** The part of the work: a skill's name, "script", "ideas" or "other". */
  part: string;
  style: string | null;
  scope: LessonScope;
  source: { kind: "edit" | "script" | "idea"; id: string; name: string } | null;
  status: LessonStatus;
  outcome: string | null;
  at: number;
  by: LessonPerson | null;
  closedAt: number | null;
  closedBy: LessonPerson | null;
}
