import { explain } from "@edit/types/problems";
import { Download, FileText, Film, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { api, type ExportActivity as Activity } from "../lib/api";
import { cancelScriptShare } from "../writer/api";
import { useAccount } from "../lib/account";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { ProblemView } from "./ProblemView";
import { Button, cx, IconButton, Modal } from "./ui";

export const exportActive = (job: Activity) => job.state === "queued" || job.state === "running";

function stageLine(stage: string | undefined): string {
  const text = stage?.trim() || "sharing";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}…`;
}

export function exportLabel(job: Activity): string {
  if (job.kind === "script") return stageLine(job.stage);
  if (job.state === "queued") return `Queued · ${job.waiting ?? "waiting for the renderer"}`;
  if (job.state === "running") return `Exporting · ${Math.round(job.progress * 100)}%`;
  if (job.state === "done") return "Export ready";
  if (job.state === "cancelled") return "Cancelled";
  return job.error ? explain(job.error, "export it").title : "Export failed";
}

const jobKey = (job: Activity) => `${job.kind ?? "edit"}:${job.id}`;

/** The card's one number: the average of what's still going (a queued edit counts as 0). Done fills the card; a failure doesn't. */
function overallOf(jobs: Activity[]): { percent: number | null; subtitle: string; attention: boolean } {
  const active = jobs.filter(exportActive);
  if (active.length > 0) {
    const ratio = active.reduce((sum, job) => sum + (job.state === "queued" ? 0 : job.progress), 0) / active.length;
    const rendering = active.filter((job) => job.state === "running").length;
    const queued = active.filter((job) => job.state === "queued").length;
    const subtitle =
      active.length === 1
        ? active[0].name
        : [rendering ? `${rendering} exporting` : "", queued ? `${queued} queued` : ""].filter(Boolean).join(" · ");
    return { percent: Math.round(ratio * 100), subtitle, attention: false };
  }
  if (jobs.some((job) => job.state === "failed")) return { percent: null, subtitle: "Needs attention", attention: true };
  if (jobs.some((job) => job.state === "done")) return { percent: 100, subtitle: "Exports ready", attention: false };
  if (jobs.some((job) => job.state === "cancelled")) return { percent: null, subtitle: "Cancelled", attention: false };
  return { percent: null, subtitle: "Exports", attention: false };
}

/** One face. The red sits behind it, so a word is never half one colour and half another. */
function QueueFace({ subtitle, percent, attention }: { subtitle: string; percent: number | null; attention: boolean }) {
  return (
    <span className="relative z-10 flex w-full min-w-0 flex-col px-3 py-[7px]">
      <span className={cx("flex w-full items-center gap-2 text-[13px] font-medium", attention ? "text-secondary" : "text-white")}>
        <span className="min-w-0 flex-1 truncate">Exports</span>
        {percent !== null && <span className="tabular">{percent}%</span>}
      </span>
      <span className={cx("mt-0.5 block truncate text-[11.5px]", attention ? "text-danger" : "text-white/75")}>{subtitle}</span>
    </span>
  );
}

/**
 * The shared queue on Home's sidebar, above Later and Done. Edits and script
 * shares are one list. The card uses that card's border and background, and
 * the share button's red fills it left to right with the overall progress.
 * Clicking opens the queue. Hidden while nothing is running or left undismissed.
 */
export function ExportActivity() {
  const [jobs, setJobs] = useState<Activity[]>([]);
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState<Record<string, number>>({});
  const [stopping, setStopping] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const allowed = useAccount((state) => state.account === null || state.account.signed_in || !state.account.required);
  useEffect(() => {
    if (!allowed) {
      setJobs([]);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const look = async () => {
      try {
        const rows = await api.exportActivity();
        if (live) setJobs(rows);
      } catch {
        /* Keep known jobs while reconnecting. */
      }
      if (live) timer = setTimeout(() => void look(), 2000);
    };
    void look();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [allowed]);
  const visible = jobs.filter((job) => exportActive(job) || hidden[jobKey(job)] !== job.updated_ms);
  const stop = async (job: Activity) => {
    const key = jobKey(job);
    setStopping(key);
    try {
      if (job.kind === "script") await cancelScriptShare(job.id);
      else await api.cancelExport(job.id);
      setJobs(await api.exportActivity());
    } catch (error) {
      useEditor.getState().toastError(error, "stop the export");
    } finally {
      setStopping(null);
    }
  };
  const again = async (job: Activity) => {
    const key = jobKey(job);
    setRetrying(key);
    try {
      await api.retryExport(job.id);
      setJobs(await api.exportActivity());
    } catch (error) {
      useEditor.getState().toastError(error, "retry the export");
    } finally {
      setRetrying(null);
    }
  };
  if (!visible.length) return null;
  const face = overallOf(visible);
  const dismiss = (job: Activity) => setHidden((previous) => ({ ...previous, [jobKey(job)]: job.updated_ms }));
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={face.percent === null ? `Exports, ${face.subtitle}` : `Exports, ${face.subtitle}, ${face.percent}%`}
        title={face.subtitle}
        className="relative mb-1 w-full min-w-0 overflow-hidden rounded-xl border border-line bg-panel text-left transition-colors hover:bg-hover"
      >
        {face.percent !== null && face.percent > 0 && (
          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 bg-primary transition-[width] duration-300 ease-out" style={{ width: `${face.percent}%` }} />
        )}
        <QueueFace subtitle={face.subtitle} percent={face.percent} attention={face.attention} />
      </button>
      {createPortal(
        <Modal open={open} onClose={() => setOpen(false)} width={500}>
          <div className="px-6 pt-6">
            <h2 className="text-[16px] font-semibold tracking-[-0.01em]">Exports</h2>
            <p className="mt-1 text-[13px] leading-normal text-muted">Edits and scripts share this queue. They keep going if you close this or leave the project.</p>
          </div>
          <div className="mt-3 max-h-[55vh] overflow-y-auto border-t border-line">
            {visible.map((job) => {
              const script = job.kind === "script";
              return (
                <div key={jobKey(job)} className="border-b border-line px-6 py-3 last:border-b-0">
                  <div className="flex items-center gap-2">
                    {script ? <FileText size={14} className="shrink-0 text-muted" /> : <Film size={14} className="shrink-0 text-muted" />}
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left text-[13px] font-medium hover:underline"
                      title={`Open ${job.name}`}
                      onClick={() => {
                        setOpen(false);
                        navigate(script ? `/scripts/${job.id}` : `/p/${job.id}`);
                      }}
                    >
                      {job.name}
                    </button>
                    {exportActive(job) ? (
                      <Button size="sm" variant="ghost" disabled={stopping === jobKey(job) || job.stage === "cancelling"} onClick={() => void stop(job)}>
                        {stopping === jobKey(job) || job.stage === "cancelling" ? "Stopping…" : "Cancel"}
                      </Button>
                    ) : (
                      <>
                        {!script && (job.state === "failed" || job.state === "cancelled") && (
                          <Button size="sm" variant="ghost" disabled={retrying === jobKey(job)} onClick={() => void again(job)}>
                            {retrying === jobKey(job) ? "Retrying…" : "Retry"}
                          </Button>
                        )}
                        <IconButton label={`Dismiss ${job.name}'s export`} onClick={() => dismiss(job)}>
                          <X size={12} />
                        </IconButton>
                      </>
                    )}
                  </div>
                  {job.note && <div className="mt-1 pl-[22px] text-[12px] text-muted">{job.note}</div>}
                  {job.state === "failed" && job.error ? (
                    <ProblemView error={job.error} doing="export it" className="mt-1.5" />
                  ) : (
                    <div className="mt-1 pl-[22px] text-[12px] text-muted">{script ? `Script · ${exportLabel(job)}` : exportLabel(job)}</div>
                  )}
                  {exportActive(job) && (
                    <div className="mt-2 ml-[22px] h-1 overflow-hidden rounded-full bg-active" aria-hidden>
                      <div className="h-full bg-primary transition-[width] duration-300 ease-out" style={{ width: `${Math.round(job.progress * 100)}%` }} />
                    </div>
                  )}
                  {!script && job.state === "done" && job.path !== "" && (
                    <a className="mt-2 ml-[22px] inline-flex items-center gap-1.5 text-[12px] text-fg hover:underline" href={`/api/exports/file?path=${encodeURIComponent(job.path)}`} download>
                      <Download size={12} /> Download export
                    </a>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-end px-6 py-4">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </Modal>,
        document.body,
      )}
    </>
  );
}
