// Signing in to Edit (accounts.spheceo.com): needed before anything else, since the relay
// answers signed-in people only. On the Mac running Edit, the browser’s sign-in; from another
// device (Edit over Tailscale), or when asked, a code typed at the accounts site.

import { ExternalLink, RotateCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { loadAccount, onThisMac, signIn, signInWithCode, useAccount } from "../lib/account";
import { Tile } from "./Logo";
import { Button } from "./ui";

/** The app once someone’s signed in; this screen until then. */
export function SignInGate({ children }: { children: ReactNode }) {
  const account = useAccount((state) => state.account);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void loadAccount().finally(() => setLoaded(true));
  }, []);
  if (!loaded && account === null) return null;
  // The server didn’t answer: let the app show its own "can’t reach Edit".
  if (account === null || account.signed_in || !account.required) return <>{children}</>;
  return <SignInScreen />;
}

/** Google’s "G", as the kit’s sign-in shows it. */
function GoogleG() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

// The kit’s full-window sign-in (design/kit/templates/sign-in-edit.html): left-aligned, Edit’s tile, one outlined Google button.
function SignInScreen() {
  const account = useAccount((state) => state.account)!;
  const waiting = useAccount((state) => state.waiting);
  const local = onThisMac();
  const device = account.device;
  return (
    <div className="grid h-full place-items-center overflow-y-auto px-6 py-12 text-[14px] leading-normal">
      <div className="w-[330px]">
        <Tile size={56} />
        <h1 className="mt-[18px] text-[24px] leading-[1.2] font-semibold tracking-[-0.03em]">Sign in to Edit</h1>

        {device !== null ? (
          <>
            <p className="mt-2 text-muted">On any device, open the link and enter the code. It lasts {Math.max(1, Math.round(device.expires_in / 60))} minutes.</p>
            <a
              className="mt-5 inline-flex items-center gap-1.5 text-[14px] text-fg underline decoration-line-strong underline-offset-[3px] hover:decoration-muted"
              href={device.verification_uri_complete ?? device.verification_uri}
              target="_blank"
              rel="noopener noreferrer"
            >
              {device.verification_uri.replace(/^https?:\/\//u, "")} <ExternalLink size={13} />
            </a>
            <div className="mt-3 font-mono text-[30px] font-semibold tracking-[0.12em]">{device.user_code}</div>
            <div className="shimmer mt-3 text-[13px]">Waiting for you to approve it…</div>
          </>
        ) : (
          <>
            <p className="mt-2 mb-[22px] text-muted">
              {local
                ? "Use the Google account an admin added. Your browser opens to finish, then brings you back to Edit."
                : "Use the Google account an admin added. You’ll get a code to enter on any device."}
            </p>
            {local ? (
              <>
                <Button size="lg" className="w-full border-line-strong bg-panel hover:bg-raised" disabled={waiting || !account.available} onClick={() => void signIn()}>
                  <GoogleG />
                  {waiting ? "Finish signing in in your browser…" : "Continue with Google"}
                </Button>
                <p className="mt-3.5 text-[13px] text-muted">
                  On another device?{" "}
                  <button
                    className="text-secondary underline decoration-line-strong underline-offset-[3px] hover:text-fg disabled:opacity-45"
                    disabled={waiting || !account.available}
                    onClick={() => void signInWithCode()}
                  >
                    Sign in with a code
                  </button>
                </p>
              </>
            ) : (
              <Button size="lg" className="w-full border-line-strong bg-panel hover:bg-raised" disabled={waiting || !account.available} onClick={() => void signInWithCode()}>
                {waiting ? "Starting…" : "Sign in with a code"}
              </Button>
            )}
          </>
        )}

        {!account.available && (
          <div className="mt-5 flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2.5 text-[13px] text-warning">
            Can’t reach {account.accounts.replace(/^https?:\/\//u, "")} right now.
            <button className="ml-auto inline-flex items-center gap-1 text-fg underline-offset-2 hover:underline" onClick={() => void loadAccount()}>
              <RotateCw size={12} /> Try again
            </button>
          </div>
        )}
        {account.problem !== null && <div className="mt-4 text-[13px] text-danger">{account.problem}</div>}
        <p className="mt-6 text-[12px] text-faint">Only people an admin has added can sign in.</p>
      </div>
    </div>
  );
}
