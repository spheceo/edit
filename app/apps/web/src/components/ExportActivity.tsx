import { Copy, Download, FileText, Film, FolderSearch, X } from "lucide-react";
import { useEffect, useState } from "react";

import { api, type ExportActivity as Activity } from "../lib/api";
import { cardFace, exportLabel } from "../lib/export-face";
import { onThisMac, showInFinder } from "../lib/files";
import { cancelScriptShare } from "../writer/api";
import { useAccount } from "../lib/account";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { FolderPicker } from "./FolderBrowser";
import { ProblemView } from "./ProblemView";
import { Button, cx, DialogTitle, IconButton, Modal } from "./ui";

export const exportActive = (job: Activity) => job.state === "queued" || job.state === "running";

const jobKey = (job: Activity) => `${job.kind ?? "edit"}:${job.id}`;

/**
 * A finished edit, and where it is. On the Mac running Edit (its window, or a
 * browser there) the file is already here: shown in Finder, or copied to a
 * folder picked; a "download" there was a second copy dropped out of sight
 * (Sphe, Nov 4). From another device, it's that device's download.
 */
function Finished({ job }: { job: Activity }) {
  const [copying, setCopying] = useState(false);
  const here = job.onDisk === true && job.saved !== undefined;
  const link = `/api/exports/file?path=${encodeURIComponent(job.path)}`;
  if (!onThisMac()) {
    return (
      <div className="mt-2 ml-[22px] flex items-center gap-2">
        <a className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-[12px] font-medium text-fg transition-colors hover:bg-hover" href={link} download>
          <Download size={13} /> Download
        </a>
        <span className="text-[12px] text-muted">to this device's Downloads folder</span>
      </div>
    );
  }
  return (
    <div className="mt-1 ml-[22px]">
      <div className="text-[12px] leading-snug break-all text-muted" title={job.path}>
        {here ? `Saved to ${job.saved}` : "Kept in the cloud, not on this Mac: a copy comes back down when you save one."}
      </div>
      <div className="mt-2 flex items-center gap-2">
        {here && (
          <Button size="sm" variant="subtle" onClick={() => showInFinder(job.path)}>
            <FolderSearch size={13} /> Show in Finder
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setCopying(true)}>
          <Copy size={13} /> Save a copy to…
        </Button>
      </div>
      <FolderPicker
        open={copying}
        onClose={() => setCopying(false)}
        title="Save a copy"
        detail={`A copy of ${job.name}'s export goes in the folder you pick. The one Edit keeps stays where it is.`}
        start={job.path.slice(0, job.path.lastIndexOf("/"))}
        confirm="Save here"
        onPick={async (folder) => {
          const { path } = await api.copyExport(job.path, folder);
          setCopying(false);
          useEditor.getState().toast(`Saved a copy to ${path.split("/").slice(-2).join("/")}`, "info", { label: "Show in Finder", run: () => showInFinder(path) });
        }}
      />
    </div>
  );
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
      // A hidden window looks again once it's shown.
      if (!document.hidden) {
        try {
          const rows = await api.exportActivity();
          if (live) setJobs(rows);
        } catch {
          /* Keep known jobs while reconnecting. */
        }
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
  const face = cardFace(visible);
  const dismiss = (job: Activity) => setHidden((previous) => ({ ...previous, [jobKey(job)]: job.updated_ms }));
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={face.percent === null ? `Exports, ${face.title}` : `Exports, ${face.title}, ${face.percent}%`}
        title={face.title}
        className="relative mb-1 w-full min-w-0 overflow-hidden rounded-xl border border-line bg-panel text-left transition-colors hover:bg-hover"
      >
        {face.percent !== null && face.percent > 0 && (
          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 bg-primary transition-[width] duration-300 ease-out" style={{ width: `${face.percent}%` }} />
        )}
        <QueueFace subtitle={face.subtitle} percent={face.percent} attention={face.attention} />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} width={500}>
        <div className="px-6 pt-6">
          <DialogTitle title="Exports" detail="Edits and scripts share this queue. They keep going if you close this or leave the project." />
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
                {!script && job.state === "done" && job.path !== "" && <Finished job={job} />}
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-end px-6 py-4">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </Modal>
    </>
  );
}
