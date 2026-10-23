// "Finish setting up Edit": what this machine is missing, with the fix for each.

import { Check, Copy, RotateCw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { copyText } from "../lib/diagnostics";
import { cx } from "./ui";

interface SetupCheck {
  id: string;
  ok: boolean;
  title: string;
  why: string;
  fix: string;
}

export function SetupCard() {
  const [checks, setChecks] = useState<SetupCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    try {
      const response = await fetch("/api/setup");
      if (response.ok) setChecks(((await response.json()) as { checks: SetupCheck[] }).checks);
    } catch {
      // The project list already reports an unreachable server.
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void check();
  }, []);

  const missing = checks?.filter((item) => !item.ok) ?? [];
  if (missing.length === 0) return null;
  return (
    <div className="mt-8 rounded-xl border border-warning/25 bg-warning-soft p-4">
      <div className="flex items-center gap-2">
        <TriangleAlert size={15} className="text-warning" />
        <span className="text-[13px] font-medium">Finish setting up Edit</span>
        <button
          title="Check again"
          onClick={() => void check()}
          className="ml-auto flex size-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
        >
          <RotateCw size={13} className={cx(checking && "animate-spin")} />
        </button>
      </div>
      <div className="mt-2 flex flex-col gap-2">
        {missing.map((item) => (
          <div key={item.id} className="flex items-center gap-3 text-[13px]">
            <div className="min-w-0 flex-1">
              <span className="text-fg">{item.title}</span> <span className="text-muted">is missing. {item.why}</span>
            </div>
            <button
              title="Copy"
              onClick={() => void copyText(item.fix).then((done) => done && setCopied(item.id))}
              className="flex max-w-[440px] items-center gap-2 rounded-md border border-line bg-black/40 px-2 py-1 font-mono text-[11px] text-muted hover:text-fg"
            >
              <span className="truncate">{item.fix}</span>
              {copied === item.id ? <Check size={12} className="shrink-0 text-success" /> : <Copy size={12} className="shrink-0" />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
