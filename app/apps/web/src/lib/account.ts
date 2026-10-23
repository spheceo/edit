// Who's signed in to Edit (accounts.spheceo.com; the server keeps the sign-in): the menu's
// "Signed in as …" and Sign out, and the sign-in card on the home screen.

import { create } from "zustand";

export interface Account {
  signed_in: boolean;
  /** The accounts site answers: signing in is offered. */
  available: boolean;
  person: { email: string; name: string; image: string | null } | null;
  perms: string[];
  admin: boolean;
  signing_in: boolean;
  /** A device sign-in waiting: the code to type at the accounts site's /device page. */
  device: { user_code: string; verification_uri: string; verification_uri_complete: string | null; expires_in: number } | null;
  /** Signing in is needed to use Edit (not with EDIT_RELAY_TOKEN, for tests and local relays). */
  required: boolean;
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

/** Opens the sign-in in the Mac's browser, then waits for it to come back. */
export async function signIn(): Promise<void> {
  useAccount.setState({ waiting: true });
  try {
    const response = await fetch("/api/account/sign-in", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (response.ok) await waitForSignIn();
  } finally {
    useAccount.setState({ waiting: false });
  }
}

/** Waits (up to ten minutes) for a sign-in started elsewhere (the browser, a code) to land. */
async function waitForSignIn(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 10 * 60_000) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const account = await loadAccount();
    if (account === null) continue;
    if (account.signed_in || (!account.signing_in && account.problem !== null)) return;
  }
}

/** Signs in with a code typed at the accounts site (this Edit used over Tailscale, or no browser here). */
export async function signInWithCode(): Promise<void> {
  useAccount.setState({ waiting: true });
  try {
    const response = await fetch("/api/account/device", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const answer = (await response.json()) as Account & { error?: string };
    if (!response.ok) {
      useAccount.setState((state) => ({ account: state.account === null ? null : { ...state.account, problem: answer.error ?? "Couldn't start signing in." } }));
      return;
    }
    useAccount.setState({ account: answer });
    await waitForSignIn();
  } finally {
    useAccount.setState({ waiting: false });
  }
}

/** Whether this page is on the Mac running Edit (the browser's sign-in can come back here) or another device. */
export function onThisMac(): boolean {
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(window.location.hostname);
}

export async function signOut(): Promise<void> {
  const response = await fetch("/api/account/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (response.ok) useAccount.setState({ account: (await response.json()) as Account });
}

