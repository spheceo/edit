// What the signed-in person may work on: the kinds of video an admin gave
// them at accounts.spheceo.com (Edit's manifest, apps/relay/src/manifest.ts:
// `video.subtitles`, `edit.bodycam`, `edit.interrogation`, `edit.courtroom`,
// in the token's `perms`). The user: work outside someone's kinds "is hidden,
// not read-only": it isn't listed (Home, search, the agent's tools), opening
// it says it isn't available, and the server refuses changes to it
// (`Store.update` / `Store.commit`), new projects of it and its script imports.
//
// A project's kind: a subtitled video (subtitles over footage, `isSubtitled`)
// is `video.subtitles`; anything else is `edit.<style>`. A project with only
// footage (or nothing) yet is open to subtitlers too: that's how a subtitled
// video starts.

import { status as accountStatus } from "./accounts.ts";
import type { Style } from "./model.ts";

/** What the rule needs of a project (or its summary). */
export interface Shape {
  style: Style;
  /** Subtitles over footage. */
  subtitles: boolean;
  /** Nothing but footage (or nothing at all) yet. */
  footageOnly: boolean;
}

const LABELS: Record<string, [kind: string, grant: string]> = {
  "video.subtitles": ["subtitled videos", "Subtitled videos"],
  "edit.bodycam": ["bodycam edits", "Bodycam edits"],
  "edit.interrogation": ["interrogation edits", "Interrogation edits"],
  "edit.courtroom": ["courtroom edits", "Courtroom edits"],
  "edit.commentary": ["commentary edits", "Commentary edits"],
  "edit.shorts": ["Shorts", "Shorts"],
};

/**
 * The capabilities the signed-in person has; null for everything: an admin,
 * a token from before the kinds (no dotted id in its perms), or nobody signed
 * in (tests and a local relay: the UI asks everyone to sign in first).
 */
export function granted(): Set<string> | null {
  const now = accountStatus() as { person: unknown; perms: string[]; admin: boolean };
  if (now.person === null || now.admin) return null;
  if (!now.perms.some((perm) => perm.includes("."))) return null;
  return new Set(now.perms);
}

export function kindOf(shape: Shape): string {
  return shape.subtitles ? "video.subtitles" : `edit.${shape.style}`;
}

/** Whether the signed-in person may see and change a project of this shape. */
export function mayWork(shape: Shape, given: Set<string> | null = granted()): boolean {
  if (given === null) return true;
  if (!shape.subtitles && given.has(`edit.${shape.style}`)) return true;
  return given.has("video.subtitles") && (shape.subtitles || shape.footageOnly);
}

/** Whether they may start a project of `style` (a subtitled video starts as one too). */
export function mayStart(style: Style, given: Set<string> | null = granted()): boolean {
  return given === null || given.has(`edit.${style}`) || given.has("video.subtitles");
}

/** Whether they may make a full edit of `style` (a script import, a Writer script). */
export function mayEdit(style: Style, given: Set<string> | null = granted()): boolean {
  return given === null || given.has(`edit.${style}`);
}

/** Whether they may make full edits of any style. */
export function editsAny(given: Set<string> | null = granted()): boolean {
  return given === null || [...given].some((perm) => perm.startsWith("edit."));
}

/** Why a project they can't work on isn't there for them. */
export function unavailable(shape?: Shape): string {
  const label = shape === undefined ? undefined : LABELS[kindOf(shape)];
  return label === undefined
    ? "This project isn't available to your account."
    : `This project isn't available to your account: it's one of the ${label[0]}. An admin can give you ${label[1]} at accounts.spheceo.com.`;
}

/** Why they can't make a project of this kind (a change that would turn one into it, a new one, an import). */
export function cantMake(kind: string): string {
  const label = LABELS[kind];
  return label === undefined
    ? "Your account can't make this kind of video: ask an admin at accounts.spheceo.com."
    : `Your account can't make ${label[0]}: an admin can give you ${label[1]} at accounts.spheceo.com.`;
}
