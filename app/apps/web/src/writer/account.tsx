// Who's signed in, for Script mode's screens: Edit's own sign-in (lib/account.ts)
// read in Writer's shape, so its grants (can.ts) and the starter's avatar read
// as they did. Signing in, out and the account menu are Edit's.

import { useEffect } from "react";

import { AppMenu } from "../components/AppMenu";
import { loadAccount, useAccount as useEditAccount } from "../lib/account";
import type { AccountStatus } from "./api";

/** Edit's account as Writer's `AccountStatus`: everything is allowed to an admin, or a token from before the kinds (as the server's kinds.ts reads it). */
export function useAccount(): readonly [AccountStatus | null, (next: AccountStatus) => void] {
  const account = useEditAccount((state) => state.account);
  useEffect(() => {
    if (account === null) void loadAccount();
  }, [account]);
  if (account === null) return [null, () => {}] as const;
  const legacy = !account.perms.some((perm) => perm.includes("."));
  const status: AccountStatus = {
    signedIn: account.signed_in,
    person: account.person
      ? { sub: account.person.email, email: account.person.email, name: account.person.name, image: account.person.image, perms: account.perms, admin: account.admin || legacy }
      : null,
    signingIn: account.signing_in,
    signInUrl: null,
    code: null,
    error: account.problem,
  };
  return [status, () => void loadAccount()] as const;
}

/** The avatar menu at the right of Script mode's header: Edit's. */
export function AccountMenu(_props: { onSettings?: () => void; onLogs?: () => void }) {
  return <AppMenu />;
}
