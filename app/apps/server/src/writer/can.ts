// What the signed-in person may do in Script mode: the kinds of script an
// admin granted them at accounts.spheceo.com (Edit's relay manifest lists
// them, with the ids Writer gave them), read from the token's `perms` as
// kinds.ts reads Edit's. A script of a kind someone can't write is hidden from
// them: not listed, not opened, not used as a source, no agent work on it.
// Review links, approving, fixing notes and Doc exports need `review.share`;
// teaching from feedback needs `review.lessons`.

import type { Kind, Script, Summary } from "@edit/types/writer";

import { granted } from "../kinds.ts";

export const INTERROGATION = "scripts.interrogation";
export const INTERROGATION_COMPILATION = "scripts.interrogation-compilation";
export const FOIA = "scripts.foia";
/** Bodycam (FOIA) compilations: Repack's compilation guide with its FOIA guide. */
export const FOIA_COMPILATION = "scripts.foia-compilation";
export const COURTROOM = "scripts.courtroom";
export const COURTROOM_COMPILATION = "scripts.courtroom-compilation";
export const COMMENTARY = "scripts.commentary";
export const SHARE = "review.share";
export const LESSONS = "review.lessons";

/** Whether the signed-in person has `id` (everything for an admin, or no one signed in, as kinds.ts says). */
export function has(id: string, given: Set<string> | null = granted()): boolean {
  return given === null || given.has(id);
}

/** The kind of work a script is. */
export function workOf(script: Pick<Script | Summary, "sourceKind" | "compilation" | "kind">): string {
  if (script.sourceKind === "commentary") return COMMENTARY;
  const kind = script.kind ?? "interrogation";
  if (script.compilation) return kind === "courtroom" ? COURTROOM_COMPILATION : kind === "foia" ? FOIA_COMPILATION : INTERROGATION_COMPILATION;
  return kind === "foia" ? FOIA : kind === "courtroom" ? COURTROOM : INTERROGATION;
}

/** May see and write this script. */
export const sees = (script: Pick<Script | Summary, "sourceKind" | "compilation" | "kind">, given: Set<string> | null = granted()): boolean => has(workOf(script), given);

/** The one-case formats this person may write, in the editor's order. */
export function singleKinds(given: Set<string> | null = granted()): Kind[] {
  return ([["interrogation", INTERROGATION], ["foia", FOIA], ["courtroom", COURTROOM]] as const).filter(([, id]) => has(id, given)).map(([kind]) => kind);
}

/** The compilation formats this person may write. */
export function compilationKinds(given: Set<string> | null = granted()): Kind[] {
  return ([["interrogation", INTERROGATION_COMPILATION], ["foia", FOIA_COMPILATION], ["courtroom", COURTROOM_COMPILATION]] as const).filter(([, id]) => has(id, given)).map(([kind]) => kind);
}

/** Whether this person writes scripts at all (Script mode shows only then). */
export const writesAny = (given: Set<string> | null = granted()): boolean => [INTERROGATION, INTERROGATION_COMPILATION, FOIA, FOIA_COMPILATION, COURTROOM, COURTROOM_COMPILATION, COMMENTARY].some((id) => has(id, given));

const DOING: Record<string, string> = {
  [INTERROGATION]: "write interrogation scripts",
  [INTERROGATION_COMPILATION]: "write interrogation compilations",
  [FOIA]: "write bodycam (FOIA) scripts",
  [FOIA_COMPILATION]: "write bodycam compilations",
  [COURTROOM]: "write courtroom scripts",
  [COURTROOM_COMPILATION]: "write courtroom compilations",
  [COMMENTARY]: "write commentary scripts",
  [SHARE]: "share scripts for review",
  [LESSONS]: "teach Script mode from feedback",
};

export function refusal(id: string): string {
  return `Your account can't ${DOING[id] ?? "do that"} yet. Ask an admin at accounts.spheceo.com.`;
}

export const NOT_AVAILABLE = "This script isn't available to your account.";

export function require(id: string): void {
  if (!has(id)) throw new Error(refusal(id));
}

export function requireScript(script: Pick<Script, "sourceKind" | "compilation" | "kind">): void {
  if (!sees(script)) throw new Error(NOT_AVAILABLE);
}

/** Building as `kind`: refused when the person can't write that kind. */
export function requireKind(script: Pick<Script, "sourceKind" | "compilation">, kind: Kind): void {
  require(workOf({ ...script, kind }));
}

/** The format a new one-case import starts as: the first this person may write. */
export function firstSingleKind(): Kind {
  const kind = singleKinds()[0];
  if (kind === undefined) throw new Error(refusal(INTERROGATION));
  return kind;
}

export function firstCompilationKind(): Kind {
  const kind = compilationKinds()[0];
  if (kind === undefined) throw new Error(refusal(INTERROGATION_COMPILATION));
  return kind;
}
