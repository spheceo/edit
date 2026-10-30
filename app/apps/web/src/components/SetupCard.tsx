// What this machine still needs set up, one line each with its fix; nothing
// once it's all there (the user, Oct 30: "make this a lot cleaner and a lot
// shorter").

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { copyText } from "../lib/diagnostics";
import { useClaudeSupport, useAgent } from "../lib/agent";
import { ClaudeSetupCard, SetupLine } from "./ClaudeSetupCard";

interface SetupCheck {
  id: string;
  ok: boolean;
  title: string;
  why: string;
  fix: string;
}

export function SetupCard() {
  const [checks, setChecks] = useState<SetupCheck[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const claude = useClaudeSupport((state) => state.status?.phase);
  const claudeMissing = useAgent((state) => state.status?.state === "missing");

  const check = async () => {
    try {
      const response = await fetch("/api/setup");
      if (response.ok) setChecks(((await response.json()) as { checks: SetupCheck[] }).checks);
    } catch {
      // The project list already reports an unreachable server.
    }
  };

  useEffect(() => {
    void check();
    // Fixed in a terminal meanwhile: looked at again when Edit comes back to the front.
    const again = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, []);

  // Claude has its own line (ClaudeSetupCard), shown only when there's something to do.
  const missing = checks?.filter((item) => !item.ok && item.id !== "claude") ?? [];
  const claudeLine = claudeMissing || claude === "needs_login" || claude === "error" || claude === "signing_in";
  if (missing.length === 0 && !claudeLine) return null;
  return (
    <div className="mt-6 divide-y divide-line overflow-hidden rounded-lg border border-line">
      <ClaudeSetupCard />
      {missing.map((item) => (
        <SetupLine key={item.id} text={`${item.title} is missing. ${item.why}`}>
          <button
            title="Copy the command that installs it"
            onClick={() => void copyText(item.fix).then((done) => done && setCopied(item.id))}
            className="flex max-w-[320px] items-center gap-2 rounded-md bg-raised px-2 py-1 font-mono text-[11px] text-muted hover:text-fg"
          >
            <span className="truncate">{item.fix}</span>
            {copied === item.id ? <Check size={12} className="shrink-0 text-success" /> : <Copy size={12} className="shrink-0" />}
          </button>
        </SetupLine>
      ))}
    </div>
  );
}
