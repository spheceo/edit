// Signing in to Edit (accounts.spheceo.com): needed before anything else, since the relay
// answers signed-in people only. On the Mac running Edit, the browser's sign-in; from another
// device (Edit over Tailscale), or when asked, a code typed at the accounts site.

import { ExternalLink, LogIn, RotateCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { loadAccount, onThisMac, signIn, signInWithCode, useAccount } from "../lib/account";
import { Button } from "./ui";

/** The app once someone's signed in; this screen until then. */
export function SignInGate({ children }: { children: ReactNode }) {
  const account = useAccount((state) => state.account);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void loadAccount().finally(() => setLoaded(true));
  }, []);
  if (!loaded && account === null) return null;
  // The server didn't answer: let the app show its own "can't reach Edit".
  if (account === null || account.signed_in || !account.required) return <>{children}</>;
  return <SignInScreen />;
}

function SignInScreen() {
  const account = useAccount((state) => state.account)!;
  const waiting = useAccount((state) => state.waiting);
  const local = onThisMac();
  const device = account.device;
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-[420px] rounded-2xl border border-line bg-panel p-7">
        <div className="flex items-center gap-2.5">
          <LogIn size={17} className="text-sky-300" />
          <h1 className="text-[17px] font-semibold">Sign in to Edit</h1>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          With your Google account, through the team's accounts. An admin gives you access at accounts.spheceo.com.
        </p>

        {!account.available && (
          <div className="mt-5 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-3 text-[13px] text-amber-200">
            Can't reach {account.accounts.replace(/^https?:\/\//u, "")} right now.
            <button className="ml-2 inline-flex items-center gap-1 text-fg underline-offset-2 hover:underline" onClick={() => void loadAccount()}>
              <RotateCw size={12} /> Try again
            </button>
          </div>
        )}

        {device !== null ? (
          <div className="mt-6">
            <div className="text-[13px] text-muted">On any device, open</div>
            <a
              className="mt-1 inline-flex items-center gap-1.5 text-[14px] text-sky-300 hover:underline"
              href={device.verification_uri_complete ?? device.verification_uri}
              target="_blank"
              rel="noopener noreferrer"
            >
              {device.verification_uri.replace(/^https?:\/\//u, "")} <ExternalLink size={13} />
            </a>
            <div className="mt-4 text-[13px] text-muted">and enter</div>
            <div className="mt-1 font-mono text-[30px] font-semibold tracking-[0.12em]">{device.user_code}</div>
            <div className="mt-3 text-[12px] text-muted">Waiting for you to approve it… The code lasts {Math.max(1, Math.round(device.expires_in / 60))} minutes.</div>
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-2">
            {local ? (
              <>
                <Button variant="primary" disabled={waiting || !account.available} onClick={() => void signIn()}>
                  {waiting ? "Finish signing in in your browser…" : "Sign in with Google"}
                </Button>
                <button className="text-[12px] text-muted hover:text-fg" disabled={waiting || !account.available} onClick={() => void signInWithCode()}>
                  Use a code instead
                </button>
              </>
            ) : (
              <Button variant="primary" disabled={waiting || !account.available} onClick={() => void signInWithCode()}>
                {waiting ? "Starting…" : "Sign in with a code"}
              </Button>
            )}
          </div>
        )}

        {account.problem !== null && <div className="mt-4 text-[13px] text-amber-300">{account.problem}</div>}
      </div>
    </div>
  );
}
