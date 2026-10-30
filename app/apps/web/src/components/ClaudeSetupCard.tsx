import { ExternalLink } from "lucide-react";
import { useEffect } from "react";
import { setupClaude, useAgent, useClaudeSupport, watchClaudeSupport } from "../lib/agent";
import { Spinner } from "./ui";

/**
 * Claude Code, when someone has to do something about it: one line saying
 * what and the button that does it. Never shown once Claude is ready, nor
 * while Edit updates or checks it by itself (the user, Oct 30: people kept
 * sending screenshots of a "Claude is ready" card that came back after being
 * closed). The CLI opens Claude's website; the account stays with Claude.
 */
export function ClaudeSetupCard() {
  const { status, error } = useClaudeSupport();
  const notInstalled = useAgent((state) => state.status?.state === "missing");
  useEffect(watchClaudeSupport, []);
  const signingIn = status?.phase === "signing_in";
  const needs = notInstalled || status?.phase === "needs_login" || status?.phase === "error" || signingIn;
  if (!needs) return null;
  const said = notInstalled
    ? "Claude Code isn't set up on this Mac."
    : signingIn
      ? "Finish signing in to Claude on its website."
      : status?.phase === "needs_login"
        ? "Claude needs you to sign in."
        : (error || status?.error || "Claude Code isn't answering.");
  return (
    <SetupLine text={said}>
      {signingIn ? (
        <>
          <Spinner size={13} />
          {status?.url && (
            <a href={status.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-fg hover:underline">
              Open sign-in page <ExternalLink size={11} />
            </a>
          )}
          <button type="button" onClick={() => void setupClaude("cancel")} className="text-muted hover:text-fg">
            Cancel
          </button>
        </>
      ) : (
        <button type="button" onClick={() => void setupClaude(notInstalled ? "repair" : status?.phase === "needs_login" ? "login" : "repair")} className="font-medium text-fg hover:underline">
          {notInstalled ? "Set up Claude" : status?.phase === "needs_login" ? "Sign in" : "Repair"}
        </button>
      )}
    </SetupLine>
  );
}

/** One thing to set up: what's wrong, then what to do. */
export function SetupLine({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-3 px-3 text-[13px]">
      <span className="size-1.5 shrink-0 rounded-full bg-warning" />
      <span className="min-w-0 flex-1 truncate text-secondary" title={text}>
        {text}
      </span>
      <span className="flex shrink-0 items-center gap-3">{children}</span>
    </div>
  );
}
