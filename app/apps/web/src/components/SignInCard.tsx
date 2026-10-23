// "Sign in to Edit": shown on the home screen until this Mac is signed in (accounts.spheceo.com).

import { LogIn } from "lucide-react";
import { useEffect, useState } from "react";

import { LATER, loadAccount, signIn, useAccount } from "../lib/account";
import { readSetting, writeSetting } from "../lib/storage";
import { Button } from "./ui";

export function SignInCard() {
  const account = useAccount((state) => state.account);
  const waiting = useAccount((state) => state.waiting);
  const [later, setLater] = useState(() => readSetting(LATER) === "1");

  useEffect(() => {
    void loadAccount();
  }, []);

  if (account === null || account.signed_in || later) return null;
  return (
    <div className="mt-8 rounded-xl border border-sky-400/25 bg-sky-400/[0.06] p-4">
      <div className="flex items-center gap-3">
        <LogIn size={15} className="text-sky-300" />
        <div className="min-w-0 flex-1 text-[13px]">
          <span className="font-medium text-fg">Sign in to Edit</span>{" "}
          <span className="text-muted">with your Google account, so Edit's cloud, transcription and voices know it's you.</span>
          {account.problem !== null && <div className="mt-1 text-amber-300">{account.problem}</div>}
          {waiting && <div className="mt-1 text-muted">Finish signing in in your browser…</div>}
        </div>
        <button
          className="text-[12px] text-muted hover:text-fg"
          onClick={() => {
            writeSetting(LATER, "1");
            setLater(true);
          }}
        >
          Not now
        </button>
        <Button variant="primary" disabled={waiting} onClick={() => void signIn()}>
          {waiting ? "Waiting…" : "Sign in"}
        </Button>
      </div>
    </div>
  );
}
