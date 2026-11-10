import { Check, Copy, Download, ExternalLink, FolderSearch, HardDriveDownload, Link2, MessageSquareText, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api, type Review } from "../lib/api";
import { projectDuration } from "../lib/edit";
import { shareStatus, shownPath } from "../lib/export-face";
import { chaptersInSpan, DEFAULTS, scriptChapters, type ExportOptions } from "../lib/exporting";
import { onThisMac, showInFinder } from "../lib/files";
import { FILE_MANAGER, THIS_MACHINE } from "../lib/platform";
import { preview } from "../lib/playback";
import { flushSave, useEditor } from "../lib/store";
import { rate } from "../lib/types";
import { useGrants } from "../writer/can";
import { askExportFolder } from "./ExportFolder";
import { ProblemView } from "./ProblemView";
import { Button, cx, Modal, Select } from "./ui";

/**
 * Share replaces Export (Oct 24): one button exports the whole edit for
 * YouTube (the project's size and rate, H.264, a keyframe every half second,
 * 320 kbps sound, −14 LUFS, the script's chapters) and puts it on the
 * project's review link, where anyone with it watches and leaves notes at a
 * moment, and the notes come back to the agent. The first share makes the
 * link. A later share replaces the latest version when it has no comments,
 * and adds the next version when it has any.
 *
 * Export is back beside it (JJ, Nov 10: "an export option that is only to
 * export on your pc … not to the feedback link where it takes a year"): the
 * same file, in the exports folder of the computer running Edit and nowhere
 * else. No review copy, no upload, no link, so it's there when the encode
 * ends (his Mac, Nov 9: an export of 24 s, and a link 19 min 35 s later).
 * The dialog is Export, and its two ways are side by side, each saying where
 * the video goes (Sphe, Nov 10: "the distinction between share and export
 * needs to be made more clear"): saved on this Mac, or sent for feedback.
 */
const HOUSE: Omit<ExportOptions, "range" | "chapters"> = { ...DEFAULTS, size: null, fps: null, preset: "youtube" };

export function ShareDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useEditor((state) => state.project);
  const exportState = useEditor((state) => state.exportState);
  const toast = useEditor((state) => state.toast);
  const [review, setReview] = useState<Review | null>(null);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  // Deleting the link is asked first (it can't be undone).
  const [deleting, setDeleting] = useState<"ask" | "running" | null>(null);
  const mayDelete = useGrants().shares;
  // A channel's watermark on the export (Sphe, Nov 2: "a checkbox to include the watermark and we pick the channel"):
  // the channels are the Watermarks folder's pictures; the project's last choice is the server's (review.watermark).
  const [channels, setChannels] = useState<{ id: string; code: string; name: string }[] | null>(null);
  const [channelsFailed, setChannelsFailed] = useState<string | null>(null);
  const [marked, setMarked] = useState(false);
  const [channel, setChannel] = useState<string | null>(null);
  const [markTouched, setMarkTouched] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // A share or export just stopped here, so a finished export isn't announced as the new version.
  const [stopped, setStopped] = useState(false);
  // The export asked for here was an Export (this computer only), not a share's.
  const [only, setOnly] = useState(false);
  // The exports folder as shown ("~/Movies/Edit") and this computer's home, so where an Export went reads as `~/…`.
  const [folder, setFolder] = useState<{ shown: string; home: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    setMarkTouched(false);
    void api.exportFolder().then(
      (given) => setFolder({ shown: given.shown, home: given.home }),
      // Shown whole, then.
      () => {},
    );
    void api.watermarks().then(
      (given) => {
        setChannels(given.channels);
        setChannelsFailed(null);
      },
      (error: Error) => setChannelsFailed(error.message),
    );
  }, [open]);
  const sections = preview.sections;
  const chapters = useMemo(() => (project ? scriptChapters(project, sections) : []), [project, sections]);
  const id = project?.id ?? "";

  // The review as it stands, and while a share runs, how it's going (the server's share job, the one answer Home and the Exports panel read too).
  const sharing = review?.sharing ?? null;
  const lastShare = review?.share ?? null;
  useEffect(() => {
    if (!open || !id) return;
    let live = true;
    const look = () =>
      void api
        .review(id)
        .then((given) => live && setReview(given))
        // Noted by api.ts; the next look asks again.
        .catch(() => {});
    look();
    const timer = setInterval(look, sharing !== null || starting ? 1500 : 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [open, id, sharing, starting]);

  // A share under way (begun here, or by Ready for changes) is what the dialog says, not an Export before it.
  useEffect(() => {
    if (sharing !== null) setOnly(false);
  }, [sharing]);

  // The project's watermark as last shared, until it's changed here.
  const savedMark = review?.watermark ?? null;
  useEffect(() => {
    if (markTouched || review === null) return;
    setMarked(savedMark !== null);
    if (savedMark !== null) setChannel(savedMark);
  }, [review, savedMark, markTouched]);
  useEffect(() => {
    if (channel === null && channels && channels.length > 0) setChannel((channels.find((one) => one.code === "SI") ?? channels[0]!).id);
  }, [channels, channel]);

  // A share that just finished: its link copied, said once.
  const [said, setSaid] = useState<string | null>(null);
  const latest = review?.review && review.review.versions.length > 0 ? Math.max(...review.review.versions.map((one) => one.n)) : null;
  useEffect(() => {
    if (!review?.review || sharing !== null || latest === null) return;
    const key = `${review.review.url}#${latest}`;
    if (said === null) {
      setSaid(key);
      return;
    }
    if (key !== said) {
      setSaid(key);
      // Said as it is: a copy refused (the window not focused) leaves the link in the dialog to copy by hand.
      const shared = `Shared v${latest}`;
      void (navigator.clipboard?.writeText(review.review.url) ?? Promise.reject(new Error("no clipboard"))).then(
        () => toast(`${shared}: link copied`, "info"),
        () => toast(shared, "info"),
      );
    }
  }, [review, sharing, latest, said, toast]);

  if (!project) return null;
  const busy = starting || sharing !== null;
  const exporting = exportState?.state === "queued" || exportState?.state === "running";
  const link = review?.review ?? null;
  // One at a time: either way makes the same file.
  const unable = busy || exporting || retrying || projectDuration(project) <= 0;

  // Share and Export make the same file: the edit as saved, whole, the house export.
  const start = async (go: (options: ExportOptions, watermark: string | null) => Promise<void>) => {
    if (busy || exporting) return;
    setStarting(true);
    setStopped(false);
    setProblem(null);
    try {
      await askExportFolder();
      useEditor.getState().endGesture();
      await flushSave();
      if (useEditor.getState().dirty) throw new Error("The latest changes couldn’t be saved. Try again once the connection returns.");
      const duration = projectDuration(project);
      const span: [number, number] = [0, duration];
      const embedded = chaptersInSpan(chapters, span, rate(project.settings));
      await go({ ...HOUSE, range: span, chapters: embedded.length >= 2 ? embedded : [] }, marked && channel !== null ? channel : null);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setStarting(false);
    }
  };
  const share = () =>
    start(async (options, watermark) => {
      setOnly(false);
      await api.shareProject(project.id, options, false, true, watermark);
      setReview(await api.review(project.id));
    });
  const exportHere = () =>
    start(async (options, watermark) => {
      await api.exportHere(project.id, options, watermark);
      setOnly(true);
    });

  // Approving deletes the other versions' files: two clicks.
  const approve = async () => {
    if (!approving) {
      setApproving(true);
      return;
    }
    try {
      const done = await api.approveReview(project.id);
      toast(`Approved v${done.version}`, "info");
      setReview(await api.review(project.id));
    } catch (error) {
      useEditor.getState().toastError(error, "approve it");
    } finally {
      setApproving(false);
    }
  };

  const removeLink = async () => {
    setDeleting("running");
    setProblem(null);
    try {
      await api.deleteReview(project.id);
      toast("Review link deleted", "info");
      setSaid(null);
      setReview(await api.review(project.id));
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setDeleting(null);
    }
  };

  // The server's answer: a reviewer's comment on the latest version makes the next share a new version, else it replaces it.
  const next = review?.next ?? null;
  const status = shareStatus({ exportState, sharing, share: lastShare, linked: link !== null, stopped, only });
  const ended = !busy && !exporting && (status.kind === "share-failed" || status.kind === "export-failed" || status.kind === "cancelled");
  const retry = async () => {
    if (busy || retrying) return;
    setRetrying(true);
    setProblem(null);
    try {
      await api.retryExport(project.id);
      setStopped(false);
      setReview(await api.review(project.id));
    } catch (error) {
      // Cancelled before an export existed: share with the dialog's settings.
      if ((error as Error).message === "nothing to retry") {
        setRetrying(false);
        await share();
        return;
      }
      setProblem((error as Error).message);
    } finally {
      setRetrying(false);
    }
  };
  const stop = async () => {
    setStopping(true);
    setProblem(null);
    try {
      if (sharing !== null) await api.cancelShare(project.id);
      if (exporting) await api.cancelExport(project.id);
      setStopped(true);
      setReview(await api.review(project.id));
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setStopping(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={500}>
      <div className="p-6">
        <h2 className="text-[18px] font-semibold tracking-[-0.3px]">Export</h2>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <Choice
            icon={<HardDriveDownload size={16} />}
            title={`Save to ${THIS_MACHINE}`}
            detail={`The video file, in ${folder?.shown ?? "your exports folder"}. Nothing is uploaded.`}
            disabled={unable}
            onClick={() => void exportHere()}
          />
          <Choice
            icon={<MessageSquareText size={16} />}
            title="Send for feedback"
            detail="Uploads it to the review link, where the team watches it and leaves notes for the agent."
            note={link && next !== null ? (next.replace ? `Replaces v${next.version}: no one has commented on it` : `Adds v${next.version} to the link`) : link ? null : "Makes the link"}
            primary
            disabled={unable}
            onClick={() => void share()}
          />
        </div>

        {link && (
          <div className="mt-4 flex flex-col rounded-[10px] border border-line bg-panel">
            <div className="flex items-center gap-2.5 px-3 py-2.5">
              <Link2 size={14} className="shrink-0 text-muted" />
              <a href={link.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-[13px] text-fg hover:underline" title={link.url}>
                {link.url.replace(/^https?:\/\//, "")}
              </a>
              <Button size="sm" variant="ghost" title="Copy the link" onClick={() => void navigator.clipboard?.writeText(link.url).then(() => toast("Link copied", "info"))}>
                <Copy size={13} />
              </Button>
              <a href={link.url} target="_blank" rel="noreferrer">
                <Button size="sm" variant="subtle">
                  <ExternalLink size={13} /> Open
                </Button>
              </a>
            </div>
            <div className="flex items-center gap-2 border-t border-line px-3 py-2 text-[12px] text-muted">
              <span className="flex-1">
                {latest !== null ? `${link.versions.length} ${link.versions.length === 1 ? "version" : "versions"}, latest v${latest}` : "No versions yet"}
                {link.approved && <span className="text-success"> · v{link.approved.version} approved by {link.approved.by}</span>}
              </span>
              {mayDelete && deleting === null && (
                <Button size="sm" variant="ghost" disabled={busy} title={busy ? "It's being shared: delete the link once that's done" : "Delete this review link for good"} onClick={() => setDeleting("ask")}>
                  <Trash2 size={13} /> Delete link
                </Button>
              )}
              {!link.approved && latest !== null && deleting === null && (
                <Button
                  size="sm"
                  variant={approving ? "danger" : "ghost"}
                  onClick={() => void approve()}
                  title="The team signed it off: the review closes, and the other versions' files and their exports here are deleted (their notes stay)"
                >
                  {approving ? `Approve v${latest} and delete the others` : `Approve v${latest}`}
                </Button>
              )}
            </div>
            {deleting !== null && (
              <div className="flex items-center gap-2 border-t border-line px-3 py-2.5 text-[12px]">
                <span className="min-w-0 flex-1 text-fg">Delete this link? It can't be undone: reviewers lose the page and every note on it. The exports here stay.</span>
                <Button size="sm" variant="ghost" disabled={deleting === "running"} onClick={() => setDeleting(null)}>
                  Cancel
                </Button>
                <Button size="sm" variant="danger" disabled={deleting === "running" || busy} onClick={() => void removeLink()}>
                  {deleting === "running" ? "Deleting…" : "Delete link"}
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3 rounded-[10px] border border-line bg-panel px-3 py-2.5">
          <label className="flex min-w-0 flex-1 items-center gap-2.5 text-[13px]" title="The channel's logo at 10%, moving around the frame like a DVD player's, over everything">
            <input
              type="checkbox"
              checked={marked}
              disabled={busy || channels === null || channels.length === 0}
              onChange={(event) => {
                setMarkTouched(true);
                setMarked(event.target.checked);
              }}
            />
            <span className="min-w-0">
              <span className="block text-fg">Watermark</span>
              <span className="block text-[12px] leading-snug text-muted">
                {channelsFailed ? `The channels didn’t load: ${channelsFailed}` : channels === null ? "Loading the channels…" : channels.length === 0 ? "No channels in the Watermarks folder" : "The channel’s logo at 10%, moving around the frame"}
              </span>
            </span>
          </label>
          {channels && channels.length > 0 && channel !== null && (
            <Select
              value={channel}
              options={channels.map((one) => ({ value: one.id, label: one.name }))}
              onChange={(value) => {
                setMarkTouched(true);
                setChannel(value);
                setMarked(true);
              }}
              className={cx("h-[30px] min-w-[150px] shrink-0 justify-between rounded-lg border border-line-strong bg-bg pr-2.5 pl-3 text-[13px] hover:border-muted", !marked && "opacity-50")}
            />
          )}
        </div>

        {/* An Export's file, where it is (JJ, Nov 10: "save it locally and display where it is saved"). */}
        {!problem && status.kind === "saved" && (
          <div className="mt-4 flex items-center gap-2.5 rounded-[10px] border border-line bg-panel px-3 py-2.5 text-[13px]">
            <Check size={14} className="shrink-0 text-success" />
            <span className="min-w-0 flex-1 truncate text-fg" title={status.path}>
              Saved to {shownPath(status.path, folder?.home ?? null)}
            </span>
            {onThisMac() ? (
              <Button size="sm" variant="subtle" className="shrink-0" onClick={() => showInFinder(status.path)}>
                <FolderSearch size={13} /> Show in {FILE_MANAGER}
              </Button>
            ) : (
              <a className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-[12px] font-medium text-fg transition-colors hover:bg-hover" href={`/api/exports/file?path=${encodeURIComponent(status.path)}`} download>
                <Download size={13} /> Download
              </a>
            )}
          </div>
        )}

        <div className="mt-5 flex min-h-[34px] items-center gap-3">
          <div className="min-w-0 flex-1 text-[12px]">
            {status.kind === "progress" && <span className="text-muted tabular">{status.text}</span>}
            {status.kind !== "progress" && problem && <ProblemView error={problem} doing="share it" />}
            {!problem && status.kind === "share-failed" && <ProblemView error={status.error} doing="share it" />}
            {!problem && status.kind === "export-failed" && (status.error ? <ProblemView error={status.error} doing="export it" /> : <span className="text-muted">Export failed</span>)}
            {!problem && status.kind === "cancelled" && <span className="text-muted">Cancelled</span>}
            {/* Only once the server says the version is published: the export finishing is not the share. */}
            {!problem && status.kind === "up" && (
              <span className="flex items-center gap-1.5 text-success">
                <Check size={13} /> Up on the link
              </span>
            )}
          </div>
          {(exporting || sharing !== null) && (
            <Button variant="ghost" disabled={stopping || sharing === "cancelling"} onClick={() => void stop()}>
              {stopping || sharing === "cancelling" ? "Stopping…" : "Cancel"}
            </Button>
          )}
          {ended && (
            <Button variant="ghost" disabled={retrying} onClick={() => void retry()}>
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** One way out of the dialog: where the video goes, said on the button itself. */
function Choice({ icon, title, detail, note, primary = false, disabled, onClick }: { icon: React.ReactNode; title: string; detail: string; note?: string | null; primary?: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "flex min-w-0 flex-col items-start gap-1.5 rounded-[10px] border p-3.5 text-left transition-colors disabled:cursor-default disabled:opacity-50",
        primary ? "border-primary/60 bg-primary/10 enabled:hover:bg-primary/15" : "border-line bg-panel enabled:hover:bg-hover",
      )}
    >
      <span className="flex items-center gap-2 text-[14px] font-semibold text-fg">
        <span className={primary ? "text-primary" : "text-muted"}>{icon}</span>
        {title}
      </span>
      <span className="text-[12px] leading-snug text-muted">{detail}</span>
      {note && <span className="text-[12px] leading-snug text-secondary">{note}</span>}
    </button>
  );
}
