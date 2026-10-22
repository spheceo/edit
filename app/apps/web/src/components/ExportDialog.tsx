import { Check, CircleAlert, Cloud, CloudUpload, Copy, Download, ExternalLink, FolderOpen, RotateCw, Share2, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api, type Review, useMachine, type ExportRecord } from "../lib/api";
import { copyDriveLink, driveFolder, openDrive, uploadsToDrive, useDriveLink } from "../lib/drive";
import { projectDuration } from "../lib/edit";
import { chaptersInSpan, DEFAULTS, estimateBytes, extensionOf, formatBytes, outputSize, scriptChapters, type ExportOptions } from "../lib/exporting";
import { inOutSpan, useInOut } from "../lib/inOut";
import { preview } from "../lib/playback";
import { flushSave, useEditor, type DriveState } from "../lib/store";
import { shortDuration, timecode } from "../lib/time";
import type { DriveFile } from "../lib/types";
import { Button, Modal, Switch, Tabs } from "./ui";
import { rate } from "../lib/types";

/**
 * Every export is the house one: the project's own size and frame rate, MP4
 * (H.264, high quality, the Mac's hardware encoder), the mix at −14 LUFS and
 * the script's chapters. No choices to get wrong: a 30 fps edit exported at
 * 60 only repeated its frames, twice the time for the same picture, and any
 * size or rate but the project's misses the chunked export that reuses the
 * last one (decided Oct 19).
 */
const HOUSE: Omit<ExportOptions, "range" | "chapters"> = { ...DEFAULTS, size: null, fps: null };

const safeName = (name: string) => name.replace(/[^\w\- ]+/g, "_").trim() || "Edit";

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useEditor((state) => state.project);
  const exportState = useEditor((state) => state.exportState);
  const driveState = useEditor((state) => state.driveState);
  const drive = useDriveLink(project?.id ?? "", project?.drive);
  const toast = useEditor((state) => state.toast);
  const points = useInOut();
  const machine = useMachine();
  const [spanChoice, setSpanChoice] = useState<"inout" | "whole">("whole");
  // Upload to Drive: asked for this time, else a whole subtitled video does.
  const [driveChoice, setDriveChoice] = useState<boolean | null>(null);
  // The media drive's Exports folder when one is set (when a media drive is set).
  const [exportsDir, setExportsDir] = useState("~/Movies/Edit");
  const [preparing, setPreparing] = useState(false);
  const starting = useRef(false);
  const renderStarted = useRef(0);
  const [, setTick] = useState(0);

  // Timeline frames are at the project's real rate (23.976 for an NTSC 24).
  const frameRate = project ? rate(project.settings) : 30;
  const duration = project ? projectDuration(project) : 0;
  const inOut = inOutSpan(duration, points);

  // On opening: the in/out span when there is one, else the whole edit.
  useEffect(() => {
    if (!open) return;
    setSpanChoice(inOut ? "inout" : "whole");
    setDriveChoice(null);
    void api
      .mediaDrive()
      .then((drive) => setExportsDir(drive.exports))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // While rendering: time the run for an estimate of what's left, and say when it's done.
  useEffect(() => {
    if (exportState?.state === "running") {
      if (!renderStarted.current) renderStarted.current = performance.now();
      const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
      return () => clearInterval(timer);
    }
    if (exportState?.state === "done" && renderStarted.current && document.hidden && "Notification" in window && Notification.permission === "granted") {
      new Notification("Export finished", { body: exportState.path.split("/").pop() });
    }
    renderStarted.current = 0;
  }, [exportState?.state, exportState?.path]);

  // Sections come from the preview engine, which may finish starting after this mounts.
  const sections = preview.sections;
  const chapters = useMemo(() => (project ? scriptChapters(project, sections) : []), [project, sections]);

  if (!project) return null;

  const range: [number, number] = spanChoice === "inout" && inOut ? inOut : [0, duration];
  const seconds = (range[1] - range[0]) / frameRate;
  const spanChapters = chaptersInSpan(chapters, range, frameRate);
  const embedding = spanChapters.length >= 2;
  const [width, height] = outputSize(HOUSE, project.settings.width, project.settings.height);
  const bytes = estimateBytes(HOUSE, width, height, seconds, project.settings.fps);
  const path = `${exportsDir}/${safeName(project.name)}.${extensionOf(HOUSE.format)}`;
  const whole = range[0] === 0 && range[1] >= duration && duration > 0;
  const subtitled = uploadsToDrive(project, HOUSE.format, range, duration);
  const toDrive = whole && (driveChoice ?? subtitled);
  const running = exportState?.state === "running";

  const start = async () => {
    if (starting.current || useEditor.getState().exportState?.state === "running") return;
    starting.current = true;
    setPreparing(true);
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => {});
    let requested = false;
    try {
      useEditor.getState().endGesture();
      const intended = useEditor.getState().project;
      await flushSave();
      const saved = useEditor.getState();
      if (saved.project?.id !== project.id) return;
      if (saved.dirty) throw new Error("The latest changes couldn't be saved. Try exporting again once the connection returns.");
      if (saved.project !== intended) throw new Error("The project changed while preparing the export. Review the latest version and try again.");
      useEditor.setState({ exportState: { state: "running", progress: 0, path }, driveState: null });
      requested = true;
      renderStarted.current = performance.now();
      const options: ExportOptions = { ...HOUSE, range, chapters: embedding ? spanChapters : [] };
      const { path: output } = await api.exportProject(project.id, path, options, whole ? toDrive : undefined);
      const current = useEditor.getState();
      if (current.project?.id === project.id && current.exportState?.state === "running") useEditor.setState({ exportState: { ...current.exportState, path: output } });
    } catch (error) {
      const current = useEditor.getState();
      if (requested && current.project?.id === project.id && current.exportState?.state === "running") useEditor.setState({ exportState: null });
      toast((error as Error).message, "error");
    } finally {
      starting.current = false;
      setPreparing(false);
    }
  };

  const elapsed = renderStarted.current ? (performance.now() - renderStarted.current) / 1000 : 0;
  const left = running && exportState.progress > 0.03 ? (elapsed * (1 - exportState.progress)) / exportState.progress : null;

  return (
    <Modal open={open} onClose={onClose} width={560}>
      <div className="flex max-h-[88vh] flex-col">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
          <h2 className="text-[16px] font-semibold tracking-[-0.01em]">Export</h2>
          <p className="mt-1 text-[12px] text-muted">
            {range[0] === 0 && range[1] === duration ? "The whole edit" : "In to out"}, rendered exactly as the preview shows it.
          </p>
          <RenderPreview projectId={project.id} range={range} size={[width, height]} progress={running ? exportState.progress : null} />
          <div className="mt-2 flex items-center justify-between font-mono text-[11px] text-faint tabular">
            <span>{timecode(range[0], frameRate)}</span>
            <span>{timecode(range[1], frameRate)}</span>
          </div>
          <p className="mt-3 text-[12px] text-muted tabular">
            {[`${width}×${height}`, `${project.settings.fps} fps`, shortDuration(seconds), bytes !== null && `≈ ${formatBytes(bytes)}`, embedding && `${spanChapters.length} chapters`]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {inOut && (
            <div className="mt-4">
              <Tabs<"inout" | "whole">
                id="export-span"
                value={spanChoice}
                tabs={[
                  { value: "inout", label: `In–Out · ${shortDuration((inOut[1] - inOut[0]) / frameRate)}` },
                  { value: "whole", label: `Whole · ${shortDuration(duration / frameRate)}` },
                ]}
                onChange={setSpanChoice}
              />
            </div>
          )}
          <p className="mt-4 truncate font-mono text-[11px] text-faint" title={path}>
            Saves to {path} on {machine}
          </p>
          {whole && (
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px] text-muted">
              <Switch checked={toDrive} onChange={setDriveChoice} />
              <Cloud size={12} className="shrink-0" />
              <span>
                Then upload it to the team's {subtitled ? driveFolder(project) : "Render"} folder on Drive{toDrive ? ", viewable by anyone with the link" : ""}
              </span>
            </label>
          )}
        </div>

        <ExportsList projectId={project.id} machine={machine} finished={exportState?.state === "done" ? exportState.path : null} />
        <DriveRow
          state={driveState}
          drive={drive}
          onRetry={exportState?.state === "done" ? () => void api.driveUpload(project.id, exportState.path).catch((error) => toast((error as Error).message, "error")) : null}
          onCopy={(url) => void copyDriveLink(url, toast)}
        />
        <div className="flex min-h-16 items-center gap-3 border-t border-line px-6 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-x-3 text-[12px]">
            {exportState?.state === "running" && (
              <span className="text-muted tabular">
                Rendering… {Math.round(exportState.progress * 100)}%{left !== null && ` · about ${shortDuration(Math.max(1, left))} left`}
              </span>
            )}
            {exportState?.state === "done" && (
              <>
                <span className="flex min-w-0 items-center gap-1.5 text-green-300">
                  <Check size={13} className="shrink-0" />
                  <span className="truncate">
                    Exported in {exportState.seconds?.toFixed(1)}s{exportState.bytes ? ` · ${formatBytes(exportState.bytes)}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <a href={`/api/exports/file?path=${encodeURIComponent(exportState.path)}`} download>
                    <Button size="sm" variant="subtle">
                      <Download size={13} /> Download
                    </Button>
                  </a>
                  <Button size="sm" variant="ghost" onClick={() => void api.revealExport(exportState.path).catch((error) => toast((error as Error).message, "error"))}>
                    <FolderOpen size={13} /> Show on {machine}
                  </Button>
                  <Button size="sm" variant="ghost" title="Copy the file's path" onClick={() => void navigator.clipboard.writeText(exportState.path).then(() => toast("Copied the path"))}>
                    <Copy size={13} />
                  </Button>
                </span>
              </>
            )}
            {exportState?.state === "failed" && (
              <span className="flex min-w-0 items-center gap-1.5 text-red-300">
                <CircleAlert size={13} className="shrink-0" /> <span className="truncate">{exportState.error}</span>
              </span>
            )}
            {exportState?.state === "cancelled" && <span className="text-muted">Cancelled</span>}
          </div>
          {running ? (
            <Button variant="danger" onClick={() => void api.cancelExport(project.id)}>
              Cancel export
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" disabled={seconds <= 0 || preparing} onClick={() => void start()}>
                {preparing ? "Preparing…" : exportState?.state === "done" ? "Export again" : "Export"}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * The project's exports on the machine running Edit, newest first (they
 * survive a restart): each downloads to this device (the Mac, or another
 * over Tailscale), shows in Finder there, or is deleted, after a second click.
 */
function ExportsList({ projectId, machine, finished }: { projectId: string; machine: string; finished: string | null }) {
  const [list, setList] = useState<ExportRecord[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const toast = useEditor((state) => state.toast);
  useEffect(() => {
    let live = true;
    void api
      .exports(projectId)
      .then((given) => live && setList(given))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [projectId, finished]);
  const [sharing, setSharing] = useState<string | null>(null);
  const [review, setReview] = useState<Review["review"]>(null);
  const [approving, setApproving] = useState(false);
  useEffect(() => {
    void api
      .review(projectId)
      .then((given) => setReview(given.review))
      .catch(() => setReview(null));
  }, [projectId, finished, sharing]);
  const shown = (list ?? []).filter((one) => !one.missing);
  const latest = review === null || review.versions.length === 0 ? null : Math.max(...review.versions.map((one) => one.n));
  // Approves the latest version: two clicks, as it deletes the others' files for good.
  const approve = async () => {
    if (!approving) {
      setApproving(true);
      return;
    }
    try {
      const done = await api.approveReview(projectId);
      toast(`Approved v${done.version}${done.deleted.length > 0 ? `; deleted ${done.deleted.length} older export${done.deleted.length === 1 ? "" : "s"}` : ""}`, "info");
      setReview((await api.review(projectId)).review);
      setList(await api.exports(projectId));
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setApproving(false);
    }
  };
  // Shares an export to a Repack link (a review copy, uploaded); the link is copied once it's up.
  const share = async (path: string) => {
    setSharing("Starting");
    try {
      const answer = await api.shareReview(projectId, path);
      let url = answer.url ?? null;
      while (url === null) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const review = await api.review(projectId);
        if (review.sharing !== null) {
          setSharing(review.sharing);
          continue;
        }
        url = review.review?.url ?? null;
        if (url === null) throw new Error("the share didn't finish (see the log)");
      }
      await navigator.clipboard?.writeText(url).catch(() => {});
      toast(`Shared for review: ${url} (link copied)`, "info");
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setSharing(null);
    }
  };
  if (shown.length === 0) return null;
  return (
    <div className="border-t border-line px-6 py-3">
      {review !== null && latest !== null && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[12px]">
          <span className="min-w-0 flex-1 truncate">
            Review v{latest}
            {review.approved !== null ? <span className="text-green-300"> · approved v{review.approved.version} by {review.approved.by}</span> : null}
          </span>
          <Button size="sm" variant="ghost" title="Copy the review's link" onClick={() => void navigator.clipboard?.writeText(review.url).then(() => toast("Review link copied", "info"))}>
            <Copy size={13} />
          </Button>
          {review.approved === null && (
            <Button size="sm" variant={approving ? "danger" : "ghost"} onClick={() => void approve()} title="The team signed it off: the review closes, and the other versions' files and their exports here are deleted (their notes stay)">
              {approving ? `Approve v${latest} and delete the others` : `Approve v${latest}`}
            </Button>
          )}
        </div>
      )}
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">Exports on {machine}</div>
      <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
        {shown.map((one) => (
          <li key={one.path} className="flex items-center gap-2 text-[12px]">
            <span className="min-w-0 flex-1 truncate text-fg" title={one.path}>
              {one.name}
            </span>
            <span className="shrink-0 tabular text-faint">
              {new Date(one.finished_ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              {one.bytes ? ` · ${formatBytes(one.bytes)}` : ""}
            </span>
            <a href={`/api/exports/file?path=${encodeURIComponent(one.path)}`} download title="Download to this device">
              <Button size="sm" variant="ghost">
                <Download size={13} />
              </Button>
            </a>
            <Button size="sm" variant="ghost" title={`Show on ${machine}`} onClick={() => void api.revealExport(one.path).catch((error) => toast((error as Error).message, "error"))}>
              <FolderOpen size={13} />
            </Button>
            {one.whole && (
              <Button
                size="sm"
                variant="ghost"
                disabled={sharing !== null}
                title={sharing ?? "Share for review: a Repack link anyone can comment on; the notes come back to the agent"}
                onClick={() => void share(one.path)}
              >
                <Share2 size={13} />
              </Button>
            )}
            {confirming === one.path ? (
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  void api
                    .deleteExport(projectId, one.path)
                    .then((after) => {
                      setList(after);
                      setConfirming(null);
                    })
                    .catch((error) => toast((error as Error).message, "error"))
                }
              >
                Delete file
              </Button>
            ) : (
              <Button size="sm" variant="ghost" title="Delete this export" onClick={() => setConfirming(one.path)}>
                <Trash2 size={13} />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The export's upload to Drive, then its link. */
function DriveRow({
  state,
  drive,
  onRetry,
  onCopy,
}: {
  state: DriveState | null;
  drive: DriveFile | null;
  onRetry: (() => void) | null;
  onCopy: (url: string) => void;
}) {
  const url = state?.state === "done" ? state.url : state ? null : drive?.url;
  if (!state && !drive) return null;
  return (
    <div className="flex min-h-11 items-center gap-3 border-t border-line px-6 py-2 text-[12px]">
      {state?.state === "uploading" && (
        <span className="flex items-center gap-1.5 text-muted tabular">
          <CloudUpload size={13} /> Uploading to Drive… {Math.round((state.progress ?? 0) * 100)}%
        </span>
      )}
      {state?.state === "failed" && (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-red-300">
          <CircleAlert size={13} className="shrink-0" /> <span className="truncate">Drive upload failed: {state.error}</span>
        </span>
      )}
      {state?.state === "failed" && onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          <RotateCw size={13} /> Upload again
        </Button>
      )}
      {url && (
        <>
          <span className="flex min-w-0 items-center gap-1.5 text-muted">
            <Cloud size={13} className="shrink-0" />
            <span className="truncate">{state ? "Uploaded to Drive" : `On Drive: ${drive?.name}`}</span>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <Button size="sm" variant="subtle" onClick={() => onCopy(url)}>
              <Copy size={13} /> Copy link
            </Button>
            <Button size="sm" variant="ghost" onClick={() => openDrive(url)}>
              <ExternalLink size={13} /> Open on Drive
            </Button>
          </span>
        </>
      )}
    </div>
  );
}

/**
 * A frame of the span as the export will render it, from the server's
 * renderer. Hover to look through the span; while exporting it follows the
 * render.
 */
function RenderPreview({ projectId, range, size, progress }: { projectId: string; range: [number, number]; size: [number, number]; progress: number | null }) {
  const [start, end] = range;
  const [hover, setHover] = useState<number | null>(null);
  // The middle of the span shows what it is better than its first frame (often a fade from black).
  const resting = start + Math.floor((end - start) / 2);
  const [frame, setFrame] = useState(resting);
  // Ask for a new picture at most every so often: each is a server render.
  useEffect(() => {
    const at = progress !== null ? start + Math.floor(progress * (end - start - 1)) : hover !== null ? start + Math.floor(hover * (end - start - 1)) : resting;
    const timer = setTimeout(() => setFrame(Math.max(start, Math.min(end - 1, at))), progress !== null ? 1500 : 120);
    return () => clearTimeout(timer);
  }, [start, end, hover, progress, resting]);
  const src = `/api/projects/${projectId}/frame/${frame}.png?max=640`;
  const [w, h] = size;
  return (
    <div className="mt-4 flex h-[280px] items-center justify-center rounded-xl bg-black ring-1 ring-line">
      <div
        className="relative h-full max-h-[260px] max-w-[500px] overflow-hidden rounded-md bg-black"
        style={{ aspectRatio: `${w} / ${h}` }}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <img src={src} alt="Export preview" className="absolute inset-0 size-full object-contain" />
        {hover !== null && progress === null && <div className="absolute inset-y-0 w-px bg-playhead" style={{ left: `${hover * 100}%` }} />}
        {progress !== null && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
            <motion.div className="h-full bg-white" animate={{ width: `${progress * 100}%` }} transition={{ ease: "easeOut", duration: 0.25 }} />
          </div>
        )}
      </div>
    </div>
  );
}
