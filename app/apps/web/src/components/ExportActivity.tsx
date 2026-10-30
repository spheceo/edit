import { explain } from "@edit/types/problems";
import { Check, ChevronDown, CircleAlert, Download, Film, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, type ExportActivity as Activity } from "../lib/api";
import { useAccount } from "../lib/account";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { ProblemView } from "./ProblemView";
import { Button, IconButton, Spinner } from "./ui";

export const exportActive = (job: Activity) => job.state === "queued" || job.state === "running";
export function exportLabel(job: Activity): string {
  if (job.state === "queued") return "Queued · waiting for the renderer";
  if (job.state === "running") return `Exporting · ${Math.round(job.progress * 100)}%`;
  if (job.state === "done") return "Export ready";
  if (job.state === "cancelled") return "Cancelled";
  return job.error ? explain(job.error, "export it").title : "Export failed";
}

/** Lives above project routes: Close and changing projects never hide jobs.
 * Polling also restores activity after a reload/reconnection without needing
 * to have witnessed that project's websocket events. */
export function ExportActivity() {
  const [jobs, setJobs] = useState<Activity[]>([]);
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState<Record<string, number>>({});
  const [stopping, setStopping] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const allowed = useAccount(state => state.account === null || state.account.signed_in || !state.account.required);
  useEffect(() => {
    if (!allowed) { setJobs([]); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const look = async () => {
      try { const rows = await api.exportActivity(); if (live) setJobs(rows); } catch { /* Keep known jobs while reconnecting. */ }
      if (live) timer = setTimeout(() => void look(), 2000);
    };
    void look();
    return () => { live = false; clearTimeout(timer); };
  }, [allowed]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  const visible = jobs.filter(job => exportActive(job) || hidden[job.id] !== job.updated_ms);
  if (!visible.length) return null;
  const active = visible.filter(exportActive).length;
  const rendering = visible.filter(job => job.state === "running").length;
  const queued = visible.filter(job => job.state === "queued").length;
  const failed = visible.some(job => job.state === "failed");
  const completed = visible.some(job => job.state === "done");
  const stop = async (id: string) => {
    setStopping(id);
    try { await api.cancelExport(id); setJobs(await api.exportActivity()); }
    catch (error) { useEditor.getState().toastError(error, "stop the export"); }
    finally { setStopping(null); }
  };
  return (
    <div ref={root} className="fixed top-14 right-3 z-40 max-w-[calc(100vw-24px)]">
      <button type="button" aria-expanded={open} aria-controls="export-activity" onClick={() => setOpen(!open)}
        className="ml-auto flex h-9 items-center gap-2 rounded-lg border border-line bg-panel px-3 text-[12px] text-fg shadow-lg hover:bg-raised">
        {active ? <Spinner /> : failed ? <CircleAlert size={14} className="text-danger" /> : completed ? <Check size={14} className="text-success" /> : <Film size={14} />}
        {active ? [rendering ? `${rendering} exporting` : "", queued ? `${queued} queued` : ""].filter(Boolean).join(" · ") : failed ? "Export needs attention" : completed ? "Exports ready" : "Export activity"}
        <ChevronDown size={13} />
      </button>
      {open && <section id="export-activity" aria-label="Export activity" className="mt-2 w-[360px] max-w-full overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
        <div className="border-b border-line px-3 py-2.5">
          <h2 className="text-[13px] font-semibold">Exports</h2>
          <p className="mt-0.5 text-[11px] text-muted">Keep editing or open another project. Local exports render one at a time.</p>
        </div>
        <div className="max-h-[55vh] overflow-y-auto">
          {visible.map(job => <div key={job.id} className="border-b border-line px-3 py-3 last:border-b-0">
            <div className="flex items-center gap-2">
              <Film size={14} className="shrink-0 text-muted" />
              <button type="button" className="min-w-0 flex-1 truncate text-left text-[12px] font-medium hover:underline" title={`Open ${job.name}`} onClick={() => navigate(`/p/${job.id}`)}>{job.name}</button>
              {exportActive(job) ? <Button size="sm" variant="ghost" disabled={stopping === job.id} onClick={() => void stop(job.id)}>{stopping === job.id ? "Stopping…" : "Cancel"}</Button>
                : <IconButton label={`Dismiss ${job.name}'s export`} onClick={() => setHidden(previous => ({ ...previous, [job.id]: job.updated_ms }))}><X size={12} /></IconButton>}
            </div>
            {job.state === "failed" && job.error ? <ProblemView error={job.error} doing="export it" className="mt-1.5" /> : <div className="mt-1.5 text-[11px] text-muted">{exportLabel(job)}</div>}
            {job.state === "running" && <progress aria-label={`${job.name} export progress`} max={1} value={job.progress} className="mt-2 h-1 w-full accent-fg" />}
            {job.state === "done" && <a className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-fg hover:underline" href={`/api/exports/file?path=${encodeURIComponent(job.path)}`} download><Download size={12} /> Download export</a>}
          </div>)}
        </div>
      </section>}
    </div>
  );
}
