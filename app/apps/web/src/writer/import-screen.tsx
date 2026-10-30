import { useEffect, useRef, useState } from "react";
import type { ImportProgress } from "./types";
import { Dialog } from "./ui";
import { elapsed, STEPS, stepOf } from "./import-steps";

/**
 * A script's import, shown over its project in the middle of the screen:
 * each step, how far it is, what it's doing now and for how long. The
 * import keeps going after the producer leaves; Home follows it.
 */
export function ImportScreen({ item, onLeave }: { item: ImportProgress | null; onLeave: () => void }) {
  const shown = useRef(item);
  if (item) shown.current = item;
  const current = shown.current;
  // When each step was first seen, for its time.
  const [began, setBegan] = useState<Record<string, number>>({});
  const timedId = useRef<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const step = current ? stepOf(current) : "download";
  useEffect(() => {
    if (!current) return;
    const changed = timedId.current !== current.id;
    timedId.current = current.id;
    setBegan((previous) => {
      const times = changed ? {} : previous;
      return times[step] ? times : { ...times, [step]: Date.now(), ...(times.start ? {} : { start: Date.now() }) };
    });
  }, [current?.id, step]);
  useEffect(() => {
    if (!item) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [!!item]);
  const at = STEPS.findIndex((candidate) => candidate.key === step);
  const percent = Math.max(0, Math.min(100, current?.percent ?? 0));
  return (
    <Dialog
      open={!!item}
      onClose={onLeave}
      title={`Importing ${current?.title ?? ""}`}
      description="The footage is getting ready. It keeps going if you leave: Home follows it, and the script opens ready here."
      width={720}
      footer={
        <>
          <span className="faint">{began.start ? `Running for ${elapsed(now - began.start)}` : ""}</span>
          <span className="spacer" />
          <button type="button" className="primary" data-autofocus onClick={onLeave}>
            Back to projects
          </button>
        </>
      }
    >
      <div className="import-screen">
        <div className="import-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="import-meter-head">
            <strong>{percent}%</strong>
            <span>{current?.detail || "Starting…"}</span>
          </div>
          <div className="import-bar">
            <i style={{ width: `${percent}%` }} />
          </div>
        </div>
        <ol className="import-steps">
          {STEPS.map((candidate, index) => {
            const state = index < at ? "done" : index === at ? "now" : "later";
            return (
              <li key={candidate.key} data-state={state}>
                <span className="import-dot" aria-hidden="true" />
                <div>
                  <strong>{candidate.label}</strong>
                  <p>{state === "now" && current?.detail ? current.detail : candidate.hint}</p>
                </div>
                <span className="faint import-time">
                  {state === "now" && began[candidate.key] ? elapsed(now - began[candidate.key]) : state === "done" ? "Done" : ""}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </Dialog>
  );
}
