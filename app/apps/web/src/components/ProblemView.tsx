// How Edit shows something that went wrong: a short title, what to do, the
// one button that helps, and the original words only behind Details (with
// Report, which sends them to us). One look for every panel (problems.ts).

import { explain, type Problem } from "@edit/types/problems";
import { CircleAlert } from "lucide-react";
import { useState } from "react";

import { setupClaude } from "../lib/agent";
import { signIn } from "../lib/account";
import { openReport } from "../lib/diagnostics";
import { cx } from "./ui";

/** The button for a problem's action; `onRetry` only where trying again is something this place can do. */
function ActionButton({ problem, onRetry }: { problem: Problem; onRetry?: () => void }) {
  const button = "rounded-md border border-line-strong px-2 py-0.5 text-[12px] text-fg hover:bg-hover";
  if (problem.action === "sign-in") return <button className={button} onClick={() => void signIn()}>Sign in</button>;
  if (problem.action === "claude-sign-in") return <button className={button} onClick={() => void setupClaude("login")}>Sign in to Claude</button>;
  if (problem.action === "retry" && onRetry) return <button className={button} onClick={onRetry}>Try again</button>;
  return null;
}

export function ProblemView({
  error,
  doing,
  onRetry,
  compact,
  className,
}: {
  /** The error (or its words) as it came. */
  error: unknown;
  /** What was being done, as "Couldn't …" finishes it ("download this file"). */
  doing?: string;
  onRetry?: () => void;
  /** One line for a row in a list (the fix shows on hover). */
  compact?: boolean;
  className?: string;
}) {
  const problem = explain(error, doing);
  const [open, setOpen] = useState(false);
  if (compact) {
    return (
      <span className={cx("text-[11px] text-danger", className)} title={[problem.fix, problem.details].filter(Boolean).join("\n\n")}>
        {problem.title}
      </span>
    );
  }
  return (
    <div className={cx("flex items-start gap-2 text-[12px]", className)}>
      <CircleAlert size={14} className="mt-px shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-fg">{problem.title}</div>
        {problem.fix && <p className="mt-0.5 leading-relaxed text-muted">{problem.fix}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <ActionButton problem={problem} onRetry={onRetry} />
          {problem.details !== "" && problem.details !== problem.title && (
            <button className="px-1 text-[11px] text-faint hover:text-fg" onClick={() => setOpen(!open)}>
              {open ? "Hide details" : "Details"}
            </button>
          )}
          <button className="px-1 text-[11px] text-faint hover:text-fg" onClick={() => openReport(problem.details || problem.title)}>
            Report
          </button>
        </div>
        {open && (
          <pre className="mt-1.5 max-h-32 overflow-auto rounded-md bg-black/30 p-2 text-[11px] whitespace-pre-wrap break-words text-faint select-text">
            {problem.details}
          </pre>
        )}
      </div>
    </div>
  );
}

/** A toast's problem: the same, sized for a toast. */
export function ToastProblem({ problem, onDismiss }: { problem: Problem; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0 flex-1 text-left">
      <div className="font-medium">{problem.title}</div>
      {problem.fix && <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{problem.fix}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
        <ActionButton problem={problem} />
        {problem.details !== "" && problem.details !== problem.title && (
          <button className="px-1 text-[11px] text-faint hover:text-fg" onClick={() => setOpen(!open)}>
            {open ? "Hide details" : "Details"}
          </button>
        )}
        <button
          className="px-1 text-[11px] text-faint hover:text-fg"
          onClick={() => {
            onDismiss();
            openReport(problem.details || problem.title);
          }}
        >
          Report
        </button>
      </div>
      {open && (
        <pre className="mt-1.5 max-h-32 overflow-auto rounded-md bg-black/30 p-2 text-[11px] whitespace-pre-wrap break-words text-faint select-text">
          {problem.details}
        </pre>
      )}
    </div>
  );
}
