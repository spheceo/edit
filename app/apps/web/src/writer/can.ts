import { useAccount } from "../lib/account";
import type { Kind, Script, Summary } from "./types";

/**
 * What the signed-in person may do in Script mode, from their grants at
 * accounts.spheceo.com (the same rules as the server's writer/can.ts, which
 * enforces them; this only decides what's shown).
 */
export const CAN = {
  interrogation: "scripts.interrogation",
  interrogationCompilation: "scripts.interrogation-compilation",
  foia: "scripts.foia",
  foiaCompilation: "scripts.foia-compilation",
  courtroom: "scripts.courtroom",
  courtroomCompilation: "scripts.courtroom-compilation",
  commentary: "scripts.commentary",
  share: "review.share",
  lessons: "review.lessons",
} as const;

export type Grants = { has: (id: string) => boolean; singleKinds: Kind[]; compilationKinds: Kind[] };

export function grantsOf(perms: string[], admin: boolean): Grants {
  const has = (id: string) => admin || perms.includes(id);
  return {
    has,
    singleKinds: (
      [
        ["interrogation", CAN.interrogation],
        ["foia", CAN.foia],
        ["courtroom", CAN.courtroom],
      ] as const
    )
      .filter(([, id]) => has(id))
      .map(([kind]) => kind),
    compilationKinds: (
      [
        ["interrogation", CAN.interrogationCompilation],
        ["foia", CAN.foiaCompilation],
        ["courtroom", CAN.courtroomCompilation],
      ] as const
    )
      .filter(([, id]) => has(id))
      .map(([kind]) => kind),
  };
}

/**
 * The signed-in person's grants (none until the account is known). As the
 * server's kinds.ts reads them: an admin, or a token from before the kinds
 * (no dotted id), may do everything.
 */
export function useGrants(): Grants {
  const account = useAccount((state) => state.account);
  if (account === null || account.person === null) return grantsOf([], false);
  return grantsOf(account.perms, account.admin || !account.perms.some((perm) => perm.includes(".")));
}

/** The kind of work a script is, as can.rs names it. */
export function workOf(script: Pick<Summary | Script, "sourceKind" | "compilation" | "kind">): string {
  if (script.sourceKind === "commentary") return CAN.commentary;
  const kind = script.kind ?? "interrogation";
  if (script.compilation) return kind === "courtroom" ? CAN.courtroomCompilation : kind === "foia" ? CAN.foiaCompilation : CAN.interrogationCompilation;
  return kind === "foia" ? CAN.foia : kind === "courtroom" ? CAN.courtroom : CAN.interrogation;
}
