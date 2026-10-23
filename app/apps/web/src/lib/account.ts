// Who's signed in to Edit (accounts.spheceo.com; the server keeps the sign-in): the menu's
// "Signed in as …" and Sign out, and the sign-in card on the home screen.

import { create } from "zustand";

export interface Account {
  signed_in: boolean;
  person: { email: string; name: string; image: string | null } | null;
  perms: string[];
  admin: boolean;
  signing_in: boolean;
  problem: string | null;
  accounts: string;
}

export const useAccount = create<{ account: Account | null; waiting: boolean }>(() => ({ account: null, waiting: false }));

export async function loadAccount(): Promise<Account | null> {
  try {
    const response = await fetch("/api/account");
    if (!response.ok) return null;
    const account = (await response.json()) as Account;
    useAccount.setState({ account });
    return account;
  } catch {
    return null;
  }
}

/** Opens the sign-in in the Mac's browser, then waits (up to ten minutes) for it to come back. */
export async function signIn(): Promise<void> {
  useAccount.setState({ waiting: true });
  try {
    const response = await fetch("/api/account/sign-in", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!response.ok) return;
    const started = Date.now();
    while (Date.now() - started < 10 * 60_000) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const account = await loadAccount();
      if (account === null) continue;
      if (account.signed_in || (!account.signing_in && account.problem !== null)) return;
    }
  } finally {
    useAccount.setState({ waiting: false });
  }
}

export async function signOut(): Promise<void> {
  const response = await fetch("/api/account/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (response.ok) useAccount.setState({ account: (await response.json()) as Account });
}

/** "Not now" on the home screen's card (Edit still works on the team's shared sign-in for now). */
export const LATER = "edit.signIn.later";
