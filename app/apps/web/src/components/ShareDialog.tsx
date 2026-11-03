import { Check, Copy, ExternalLink, Link2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api, type Review } from "../lib/api";
import { projectDuration } from "../lib/edit";
import { chaptersInSpan, DEFAULTS, scriptChapters, type ExportOptions } from "../lib/exporting";
import { preview } from "../lib/playback";
import { flushSave, useEditor } from "../lib/store";
import { rate } from "../lib/types";
import { CAN, useGrants } from "../writer/can";
import { ProblemView } from "./ProblemView";
import { Button, cx, Modal, Select } from "./ui";

/**
 * Share replaces Export (Oct 24): one button exports the whole edit the
 * house way (the project's size and rate, H.264, −14 LUFS, the script's
 * chapters) and puts it on the project's review link, where anyone with it
 * watches and leaves notes at a moment, and the notes come back to the agent.
 * The first share makes the link; every share after is a new version on it.
 */
const HOUSE: Omit<ExportOptions, "range" | "chapters"> = { ...DEFAULTS, size: null, fps: null };

export function ShareDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useEditor((state) => state.project);
  const exportState = useEditor((state) => state.exportState);
  const toast = useEditor((state) => state.toast);
  const [review, setReview] = useState<Review | null>(null);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  // Put this revision over the latest version (same number, same link) instead of adding one.
  const [replace, setReplace] = useState(false);
  // Deleting the link is asked first (it can't be undone), and needs “Share for review”.
  const [deleting, setDeleting] = useState<"ask" | "running" | null>(null);
  const mayDelete = useGrants().has(CAN.share);
  // A channel's watermark on the export (Sphe, Nov 2: "a checkbox to include the watermark and we pick the channel"):
  // the channels are the Watermarks folder's pictures; the project's last choice is the server's (review.watermark).
  const [channels, setChannels] = useState<{ id: string; code: string; name: string }[] | null>(null);
  const [channelsFailed, setChannelsFailed] = useState<string | null>(null);
  const [marked, setMarked] = useState(false);
  const [channel, setChannel] = useState<string | null>(null);
  const [markTouched, setMarkTouched] = useState(false);
  // YouTube's upload settings (Sphe, Nov 2): a keyframe every half second, 320 kbps sound, −14 LUFS; else the house export.
  const [youtube, setYoutube] = useState(false);
  useEffect(() => {
    if (!open) return;
    setMarkTouched(false);
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

  // The review as it stands, and while a share runs, how it's going.
  const sharing = review?.sharing ?? null;
  useEffect(() => {
    if (!open || !id) return;
    let live = true;
    const look = () =>
      void api
        .review(id)
        .then((given) => live && setReview(given))
        .catch(() => {});
    look();
    const timer = setInterval(look, sharing !== null || starting ? 1500 : 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [open, id, sharing, starting]);

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
      void navigator.clipboard?.writeText(review.review.url).catch(() => {});
      toast(`Shared v${latest}: link copied`, "info");
    }
  }, [review, sharing, latest, said, toast]);

  if (!project) return null;
  const busy = starting || sharing !== null;
  const link = review?.review ?? null;

  const share = async () => {
    if (busy) return;
    setStarting(true);
    setProblem(null);
    try {
      useEditor.getState().endGesture();
      await flushSave();
      if (useEditor.getState().dirty) throw new Error("The latest changes couldn’t be saved. Try again once the connection returns.");
      const duration = projectDuration(project);
      const span: [number, number] = [0, duration];
      const embedded = chaptersInSpan(chapters, span, rate(project.settings));
      const options: ExportOptions = { ...HOUSE, range: span, chapters: embedded.length >= 2 ? embedded : [], ...(youtube ? { preset: "youtube" as const, quality: "high" as const, loudness: -14 } : {}) };
      await api.shareProject(project.id, options, replace && latest !== null, false, marked && channel !== null ? channel : null);
      setReview(await api.review(project.id));
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setStarting(false);
    }
  };

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
      setReplace(false);
      setReview(await api.review(project.id));
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setDeleting(null);
    }
  };

  const progress = exportState?.state === "queued" ? "Export queued · you can keep editing" : exportState?.state === "running" ? `Exporting… ${Math.round(exportState.progress * 100)}%` : sharing ? `${sharing[0]!.toUpperCase()}${sharing.slice(1)}…` : null;

  return (
    <Modal open={open} onClose={onClose} width={500}>
      <div className="p-6">
        <h2 className="text-[18px] font-semibold tracking-[-0.3px]">Share</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">
          {link
            ? "Each share exports the edit as it is now and adds it to this link as a new version. Only people signed in can open the link, watch it and leave notes at a moment; the notes come back to the agent."
            : "Exports the whole edit and makes a review link. Only people signed in can open it, watch and leave notes at a moment; the notes come back to the agent. Later shares go on the same link as new versions."}
        </p>

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

        <div className="mt-2 flex items-center gap-3 rounded-[10px] border border-line bg-panel px-3 py-2.5">
          <label className="flex min-w-0 flex-1 items-center gap-2.5 text-[13px]" title="H.264 High, a keyframe every half second, AAC at 320 kbps, −14 LUFS with peaks under −1 dBTP">
            <input type="checkbox" checked={youtube} disabled={busy} onChange={(event) => setYoutube(event.target.checked)} />
            <span className="min-w-0">
              <span className="block text-fg">For YouTube</span>
              <span className="block text-[12px] leading-snug text-muted">A keyframe every half second, 320 kbps sound, −14 LUFS</span>
            </span>
          </label>
        </div>

        <div className="mt-5 flex min-h-[34px] items-center gap-3">
          <div className="min-w-0 flex-1 text-[12px]">
            {progress && <span className="text-muted tabular">{progress}</span>}
            {!progress && problem && (
              <ProblemView error={problem} doing="share it" />
            )}
            {!progress && !problem && exportState?.state === "done" && link && (
              <span className="flex items-center gap-1.5 text-success">
                <Check size={13} /> Up on the link
              </span>
            )}
          </div>
          {link && latest !== null && (
            <label className="flex items-center gap-1.5 text-[12px] text-muted" title={`Puts this export over v${latest}: same number, same link, instead of a new version`}>
              <input type="checkbox" checked={replace} disabled={busy} onChange={(event) => setReplace(event.target.checked)} />
              Replace v{latest}
            </label>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" disabled={busy || projectDuration(project) <= 0} onClick={() => void share()}>
            {busy ? "Sharing…" : link && latest !== null ? (replace ? `Replace v${latest}` : `Share v${latest + 1}`) : "Share"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
