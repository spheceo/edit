import { Check, ExternalLink, LoaderCircle, Wrench, X } from "lucide-react";
import { useEffect, useState } from "react";
import { claudeBusy, setupClaude, useAgent, useClaudeSupport, watchClaudeSupport } from "../lib/agent";
import { useMachine } from "../lib/api";

/** The CLI opens Claude's website; the account and password stay with Claude. */
export function ClaudeSetupCard({ initial = false }: { initial?: boolean }) {
  const { status, error } = useClaudeSupport();
  const notInstalled = useAgent((state) => state.status?.state === "missing");
  const missing = notInstalled || (initial && !status?.path);
  const machine = useMachine();
  const [dismissed, setDismissed] = useState<number | null>(null);
  useEffect(watchClaudeSupport, []);
  const busy = claudeBusy(status);
  if (!initial && (!status || status.phase === "idle" || (status.phase === "ready" && dismissed === status.checkedAt)) && !error) return null;
  return (
    <div className="m-3 shrink-0 rounded-xl border border-line bg-raised p-3 text-[12px]">
      <div className="flex items-center gap-2 font-medium">
        {busy ? <LoaderCircle size={14} className="animate-spin" /> : status?.phase === "ready" ? <Check size={14} /> : <Wrench size={14} />}
        <span>Claude Code on {machine}</span>
        {status?.phase === "ready" && <button type="button" aria-label="Dismiss Claude diagnosis" onClick={() => setDismissed(status.checkedAt)} className="ml-auto rounded p-1 text-muted hover:bg-hover"><X size={14} /></button>}
      </div>
      <p role="status" aria-live="polite" className="mt-2 leading-relaxed text-muted">
        {status?.message || "Edit can set up Claude Code and check that it can send a request. Sign in on Claude's website when it opens."}
      </p>
      {(error || status?.error) && <p role="alert" className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words text-danger">{error || status?.error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {busy ? (
          <>
            {status?.url && <a href={status.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-lg bg-hover px-3 py-2 font-medium">Open sign-in page <ExternalLink size={12} /></a>}
            <button type="button" onClick={() => void setupClaude("cancel")} className="rounded-lg px-3 py-2 text-muted hover:bg-hover hover:text-fg">Cancel</button>
          </>
        ) : status?.phase === "ready" ? null : (
          <>
            <button type="button" onClick={() => void setupClaude(missing ? "repair" : "login")} className="rounded-lg bg-hover px-3 py-2 font-medium">{missing ? "Set up Claude" : status?.phase === "needs_login" ? "Sign in to Claude" : "Reconnect Claude"}</button>
            <button type="button" onClick={() => void setupClaude("diagnose")} className="rounded-lg px-3 py-2 text-muted hover:bg-hover hover:text-fg">Check Claude</button>
            {status?.phase === "error" && <button type="button" onClick={() => void setupClaude("repair")} className="rounded-lg px-3 py-2 text-muted hover:bg-hover hover:text-fg">Update and repair</button>}
          </>
        )}
      </div>
      {Boolean(status?.checks.length) && (
        <details className="mt-3 text-muted">
          <summary className="cursor-pointer hover:text-fg">Diagnosis</summary>
          <div className="mt-2 max-h-40 space-y-3 overflow-auto">
            {status?.checks.map((check, index) => (
              <div key={`${check.name}-${index}`}>
                <div className={check.ok ? "text-success" : "text-warning"}>{check.name}: {check.ok ? "passed" : "needs attention"}</div>
                <pre className="mt-1 font-sans whitespace-pre-wrap break-words">{check.detail}</pre>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
