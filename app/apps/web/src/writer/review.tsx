import { useCallback, useEffect, useRef, useState } from "react";
import { askConfirm } from "./confirm";
import { CommentsPanel, hoverNote } from "./comments";
import { approveReview, cancelScriptShare, compressReview, deleteReviewLink, fixNotes, getScript, restoreScript, message, onReviews, reviewCounts, reviewNotes, scriptAudit, shareScript } from "./api";
import { makeDoc } from "./docs-dialog";
import type { BuildStatus, Cite, DocFile, Paragraph, ReviewApproval, ReviewBlock, ReviewCounts, ReviewNote, Script } from "./types";
import { CAN, useGrants } from "./can";
import { Dialog, Icon } from "./ui";
import { formatBytes } from "../lib/time";

/**
 * Review on a Repack link (reviews.rs): Share, the notes reviewers leave,
 * and what Claude changed for each, drawn as bands on the script. Hovering
 * a band says whose note it was, what they asked, and what Claude did.
 */

/** A note for the video editor: Edit's agent follows it in that section (a line starting "edit:"). */
export const isEditNote = (text: string | undefined) => !!text && text.split("\n").some((line) => /^\s*edit:/i.test(line));

/** Open notes per script, for the list's badges. */
export function useReviewCounts() {
  const [counts, setCounts] = useState<ReviewCounts | null>(null);
  useEffect(() => {
    let live = true;
    const ask = () => void reviewCounts().then((next) => live && setCounts(next), () => {});
    ask();
    const stop = onReviews(ask);
    const timer = window.setInterval(ask, 20_000);
    return () => {
      live = false;
      stop();
      window.clearInterval(timer);
    };
  }, []);
  return counts;
}

/** A script's notes and its blocks as they now read; asked again when notes change or the script does. */
export function useReview(id: string, revision: number) {
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [blocks, setBlocks] = useState<ReviewBlock[]>([]);
  const [approved, setApproved] = useState<ReviewApproval | null>(null);
  const refresh = useCallback(
    () =>
      void reviewNotes(id).then(
        (found) => {
          setNotes(found.notes);
          setBlocks(found.blocks);
          setApproved(found.approved ?? null);
        },
        () => {},
      ),
    [id],
  );
  useEffect(() => {
    refresh();
    return onReviews(refresh);
  }, [refresh, revision]);
  return { notes, blocks, approved, refresh };
}

/** Part of a block's text a band covers: a fix's change, or an open note's words. */
export type Band = { start: number; end: number; notes: string[]; kind: "fix" | "open" | "note" };

/** Bands by block: each done note's changed ranges, and each open note's anchor. */
export function bandsOf(notes: ReviewNote[]): Map<string, Band[]> {
  const out = new Map<string, Band[]>();
  const add = (blockId: string, band: Band) => out.set(blockId, [...(out.get(blockId) ?? []), band]);
  for (const note of notes) {
    if (note.parentId) continue;
    if (note.status === "done") {
      for (const range of note.changedRanges) add(range.blockId, { start: range.start, end: range.end, notes: [note.id], kind: "fix" });
    } else if (note.anchor?.blockId) {
      add(note.anchor.blockId, { start: note.anchor.start ?? 0, end: note.anchor.end ?? 0, notes: [note.id], kind: "open" });
    }
  }
  return out;
}

/** A moment as blocks.rs prints a clip: whole seconds, rounded down. */
function stamp(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(seconds / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}` : `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
}

const citeLine = (cite: Cite) => `[${cite.video} ${stamp(cite.startMs)}–${stamp(cite.endMs)}]${cite.quote.trim() ? ` "${cite.quote.trim()}"` : ""}`;

/**
 * A paragraph's bands, piece by piece: its text is each piece on its own
 * line (blocks.rs paragraph_text), so a band on narration lands in that
 * piece's own offsets, and one touching a clip marks the clip.
 */
export function pieceBands(paragraph: Paragraph, bands: Band[] | undefined): Map<number, Band[]> {
  const out = new Map<number, Band[]>();
  if (!bands?.length) return out;
  let at = 0;
  paragraph.pieces.forEach((piece, index) => {
    const text = piece.kind === "say" ? piece.text : citeLine(piece);
    const [from, to] = [at, at + text.length];
    for (const band of bands) {
      // An empty band at a piece's start belongs to it; elsewhere a band must overlap.
      const touches = band.start === band.end ? band.start >= from && band.start <= to : band.start < to && band.end > from;
      if (!touches) continue;
      const local = { ...band, start: Math.max(0, band.start - from), end: Math.min(text.length, band.end - from) };
      out.set(index, [...(out.get(index) ?? []), local]);
    }
    at = to + 1;
  });
  return out;
}

/** Where a piece's text starts in its paragraph's block text (each piece on its own line, blocks.rs paragraph_text): a comment's words are named there. */
export function pieceOffset(paragraph: Paragraph, index: number) {
  let at = 0;
  paragraph.pieces.slice(0, index).forEach((piece) => (at += (piece.kind === "say" ? piece.text : citeLine(piece)).length + 1));
  return at;
}

/** What an element-wide band carries for the tooltip (a timestamp, a clip, a heading). */
export function bandProps(bands: Band[] | undefined) {
  if (!bands?.length) return {};
  return { "data-band": bands.flatMap((band) => band.notes).join(" "), "data-band-kind": bands.some((band) => band.kind === "fix") ? "fix" : "open" };
}

// ---- The tooltip --------------------------------------------------------------

type Tip = { ids: string[]; x: number; y: number } | null;
let tipListener: ((tip: Tip) => void) | null = null;

/** Shows the notes behind a band at the pointer; null hides it. */
export function showTip(tip: Tip) {
  tipListener?.(tip);
}

/**
 * The card a band shows on hover: the reviewer's words and name, Claude's
 * summary of what it changed, and the version. Elements marked with
 * `data-band` (bandProps) show it by themselves; text bands call showTip.
 */
export function BandTip({ notes }: { notes: ReviewNote[] }) {
  const [tip, setTip] = useState<Tip>(null);
  useEffect(() => {
    tipListener = setTip;
    const over = (event: PointerEvent) => {
      const target = (event.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-band]");
      if (target) {
        const ids = (target.dataset.band ?? "").split(" ").filter(Boolean);
        setTip({ ids, x: event.clientX, y: event.clientY });
        hoverNote(ids[0] ?? null);
      } else if ((event.target as HTMLElement | null)?.closest?.("[data-band-text]") == null) setTip(null);
    };
    window.addEventListener("pointermove", over);
    return () => {
      window.removeEventListener("pointermove", over);
      if (tipListener === setTip) tipListener = null;
    };
  }, []);
  const shown = tip ? notes.filter((note) => tip.ids.includes(note.id)) : [];
  if (!tip || !shown.length) return null;
  const left = Math.min(tip.x + 14, window.innerWidth - 340);
  const top = tip.y + 16 + 220 > window.innerHeight ? Math.max(8, tip.y - 230) : tip.y + 16;
  return (
    <div className="band-tip" style={{ left, top }} role="tooltip">
      {shown.map((note) => (
        <div key={note.id} className="band-tip-note">
          <span className="band-tip-head">
            <b>{note.author}</b>
            <span className="faint">{note.status === "done" ? `Fixed in v${note.doneInVersion ?? "?"}` : `Open · on v${note.version}`}</span>
          </span>
          <q>{note.text}</q>
          {note.fixSummary && (
            <span className="band-tip-fix">
              <span className="faint">Claude: </span>
              {note.fixSummary}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ---- Share and the notes -------------------------------------------------------

const when = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** A share's stage, as the edit dialog prints one: first letter up, then an ellipsis. */
const stageLine = (stage: string) => `${stage.charAt(0).toUpperCase()}${stage.slice(1)}…`;

const docWhen = (value: string | number) => new Date(value).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** The script can become a Doc: a commentary once it has a draft, a footage script once it has a cut-in. */
const docReady = (script: Script) => (script.commentary ? !!script.commentary.draft : script.clips.some((clip) => clip.kind === "cut-in"));

/**
 * Export the script as a Google Doc, the share dialog's extra row (the edit
 * dialog's option rows). The fuller Doc window stays on the More menu.
 */
function DocExportRow({ script, onChange }: { script: Script; onChange: (script: Script) => void }) {
  const mayShare = useGrants().has(CAN.share);
  const doc = script.docExport;
  const behind = !!doc && doc.revision !== script.revision;
  const ready = docReady(script);
  const [exporting, setExporting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<DocFile | null>(null);
  const latest = made?.url ?? doc?.url;

  const make = async () => {
    setExporting(true);
    setProblem(null);
    setMade(null);
    try {
      const next = await makeDoc(script, false);
      setMade(next);
      onChange(await getScript(script.id));
      window.open(next.url, "_blank", "noopener,noreferrer");
    } catch (cause) {
      setProblem(message(cause));
    } finally {
      setExporting(false);
    }
  };

  const hint = !mayShare
    ? "Exporting needs “Share for review”: ask an admin."
    : problem
      ? problem
      : !ready
        ? "Write the script first."
        : made
          ? "Exported."
          : behind
            ? "The script has changed since the last Doc."
            : doc
              ? `Up to date · ${docWhen(doc.exportedAt)}`
              : "A new Doc from the script, with a comment on each timestamp.";

  return (
    <div className="share-row">
      <div className="share-copy">
        <b>Google Doc</b>
        <span className={problem ? "bad" : undefined}>
          {hint}
          {latest && !problem && (
            <>
              {" "}
              <a href={latest} target="_blank" rel="noreferrer">
                Open ↗
              </a>
            </>
          )}
        </span>
      </div>
      {mayShare && (
        <button type="button" className="sm" disabled={!ready || exporting} onClick={() => void make()}>
          {exporting ? "Exporting…" : doc ? "Export again" : "Export"}
        </button>
      )}
    </div>
  );
}

/** The topbar's Share button, the same red Share as the edit page. Open notes still show as a count. */
export function ReviewButton({ script, open, approved, onClick }: { script: Script; open: number; approved: ReviewApproval | null; onClick: () => void }) {
  const shared = !!script.review;
  return (
    <button
      type="button"
      className="primary review-button"
      title={
        approved
          ? `Approved v${approved.version} by ${approved.by}, ${when(approved.at)}.`
          : shared
            ? `Shared for review (v${script.review?.version}). ${open ? `${open} open ${open === 1 ? "note" : "notes"}.` : "No open notes."}`
            : "Share the script on a Repack link for review"
      }
      onClick={onClick}
    >
      <Icon name="share" size={14} />
      Share
      {open > 0 && <span className="count-badge">{open}</span>}
    </button>
  );
}

/**
 * Sharing and the notes, in the same box as the edit page's Share: the link,
 * a Google Doc export, and a progress line (the stage, with a percent while
 * the footage goes up). Close leaves a share running. Notes, approve, and
 * fixing stay in the box.
 */
export function ReviewDialog({
  open,
  script,
  notes,
  approved,
  busy,
  onClose,
  onChange,
  onJob,
  onRefresh,
}: {
  open: boolean;
  script: Script;
  notes: ReviewNote[];
  /** The approved version, made here or on Repack's page. */
  approved: ReviewApproval | null;
  busy: boolean;
  onClose: () => void;
  onChange: (script: Script) => void;
  /** A fix started from here, for the editor to follow. */
  onJob: (job: BuildStatus) => void;
  onRefresh: () => void;
}) {
  const [sharing, setSharing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [fixesHere, setFixesHere] = useState<boolean | null>(null);
  // The share's stage while this dialog follows it, and whether the last one here just landed.
  const [stage, setStage] = useState<string | null>(null);
  const [landed, setLanded] = useState(false);
  const said = useRef("");
  const sawShare = useRef(false);
  const change = useRef(onChange);
  change.current = onChange;
  // Sharing, approving and fixing need review.share; reading the notes doesn't.
  const mayShare = useGrants().has(CAN.share);
  // What a reviewer would flag, checked before it's shared, as Edit's audit is before an export.
  const [flags, setFlags] = useState<string[]>([]);
  useEffect(() => {
    if (!open) return;
    setProblem(null);
    setLanded(false);
    said.current = script.review ? `${script.review.url}#${script.review.version}` : "";
    onRefresh();
    void reviewCounts().then((counts) => setFixesHere(counts.fixesHere), () => {});
  }, [open]);
  useEffect(() => {
    if (!open) return;
    void scriptAudit(script.id).then((found) => setFlags(found.flags), () => setFlags([]));
  }, [open, script.id, script.revision]);

  // A share runs on its own (JJ, Nov 1: "so we're not freezed on that screen"): this can close, and other scripts share meanwhile.
  const sharingNow = script.sharing !== undefined;
  const shareId = script.id;
  useEffect(() => {
    if (!open || !sharingNow) return;
    let live = true;
    const look = () =>
      void getScript(shareId).then((fresh) => {
        if (!live) return;
        if (fresh.sharing) {
          sawShare.current = true;
          if (fresh.sharing.stage) setStage(fresh.sharing.stage);
          return;
        }
        const saw = sawShare.current;
        sawShare.current = false;
        setStage(null);
        if (fresh.shareFailed) {
          setLanded(false);
          setStopped(false);
          setProblem(`Sharing failed: ${fresh.shareFailed.error}`);
        } else if (fresh.review) {
          const key = `${fresh.review.url}#${fresh.review.version}`;
          if (key !== said.current) {
            said.current = key;
            setLanded(true);
            setStopped(false);
            void navigator.clipboard?.writeText(fresh.review.url).catch(() => {});
          } else if (saw) setStopped(true);
        } else if (saw) setStopped(true);
        change.current(fresh);
      }, () => {});
    look();
    const timer = window.setInterval(look, 1500);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [open, sharingNow, shareId]);
  useEffect(() => {
    if (script.shareFailed) setProblem(`Sharing failed: ${script.shareFailed.error}`);
  }, [script.shareFailed?.at]);

  const link = script.review;
  const share = async () => {
    setSharing(true);
    setProblem(null);
    setLanded(false);
    setStopped(false);
    setStage("checking the preview");
    try {
      const fresh = await shareScript(script.id);
      if (fresh.sharing?.stage) setStage(fresh.sharing.stage);
      else if (fresh.review && !fresh.shareFailed) {
        const key = `${fresh.review.url}#${fresh.review.version}`;
        if (key !== said.current) {
          said.current = key;
          setLanded(true);
          void navigator.clipboard?.writeText(fresh.review.url).catch(() => {});
        }
      }
      change.current(fresh);
    } catch (cause) {
      setProblem(message(cause));
      setStage(null);
    } finally {
      setSharing(false);
    }
  };
  // The script as it is now as the link's only version, v1: the earlier versions go, their notes move onto v1.
  const makeFirst = async () => {
    if (!link) return;
    if (!(await askConfirm(`v1 to v${link.version} are removed from the link and every note is kept on v1. The script's own version history is untouched.`, { title: "Make the script as it is now v1?", ok: "Make this v1" }))) return;
    setSharing(true);
    setProblem(null);
    setLanded(false);
    setStage("making this v1");
    try {
      const fresh = await compressReview(script.id);
      if (fresh.review) {
        said.current = `${fresh.review.url}#${fresh.review.version}`;
        setLanded(true);
        void navigator.clipboard?.writeText(fresh.review.url).catch(() => {});
      }
      change.current(fresh);
    } catch (cause) {
      setProblem(message(cause));
    } finally {
      setSharing(false);
      setStage(null);
    }
  };
  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link.url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  // Deleting the link is asked first: it can't be undone (reviewers lose the page and their notes).
  const [deleting, setDeleting] = useState<"ask" | "running" | null>(null);
  useEffect(() => {
    if (!open) setDeleting(null);
  }, [open]);
  const removeLink = async () => {
    setDeleting("running");
    setProblem(null);
    try {
      onChange(await deleteReviewLink(script.id));
      onRefresh();
    } catch (cause) {
      setProblem(message(cause));
    } finally {
      setDeleting(null);
    }
  };
  const [approving, setApproving] = useState(false);
  const approve = async (yes: boolean) => {
    if (!link) return;
    const asked = yes
      ? askConfirm("The review link stops taking notes and the other versions' files are deleted. Every note from every round is kept, and the script's own version history is untouched.", { title: `Approve v${link.version}?`, ok: `Approve v${link.version}` })
      : askConfirm("The link takes notes again; files already deleted stay deleted.", { title: `Take back the approval of v${approved?.version}?`, ok: "Take back" });
    if (!(await asked)) return;
    setApproving(true);
    setProblem(null);
    try {
      await approveReview(script.id, yes);
      onRefresh();
    } catch (cause) {
      setProblem(message(cause));
    } finally {
      setApproving(false);
    }
  };
  const fix = async () => {
    setProblem(null);
    try {
      onJob(await fixNotes(script.id));
    } catch (cause) {
      setProblem(message(cause));
    }
  };

  const roots = notes.filter((note) => !note.parentId);
  const openNotes = roots.filter((note) => note.status !== "done");
  const waiting = openNotes.length;
  const behind = link && link.revision !== script.revision;
  const spinning = sharing || sharingNow;
  const shownStage = spinning ? (stage ?? script.sharing?.stage ?? "sharing") : null;
  const cancelling = stopping || shownStage === "cancelling";
  const stopShare = async () => {
    setStopping(true);
    setProblem(null);
    try {
      await cancelScriptShare(script.id);
      setLanded(false);
      setStopped(true);
    } catch (cause) {
      setProblem(message(cause));
    } finally {
      setStopping(false);
    }
  };
  const progress = shownStage ? stageLine(shownStage) : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="share-dialog"
      title="Share"
      description={
        link
          ? "Each share publishes the script as it is now and adds it to this link as a new version. Only people signed in can open the link, read the script and leave notes."
          : "Publishes the script and makes a review link. Only people signed in can open it, read the script and leave notes. Later shares go on the same link as new versions."
      }
      width={500}
      footer={
        <>
          <span className="share-progress">
            {progress && (
              <span className="faint tabular" title="It carries on if you close this, and other scripts can be shared meanwhile.">
                {progress}
              </span>
            )}
            {!progress && problem && <span className="bad">{problem}</span>}
            {!progress && !problem && stopped && <span className="faint">Cancelled</span>}
            {!progress && !problem && !stopped && landed && link && (
              <span className="up">
                <Icon name="check" size={13} /> Up on the link
              </span>
            )}
            {!progress && !problem && !stopped && !(landed && link) && !mayShare && <span className="faint">Sharing, approving and fixing need “Share for review”: ask an admin.</span>}
          </span>
          {spinning && shownStage !== "making this v1" && (
            <button type="button" className="ghost" disabled={cancelling} onClick={() => void stopShare()}>
              {cancelling ? "Stopping…" : "Cancel"}
            </button>
          )}
          {!spinning && (stopped || script.shareFailed !== undefined) && mayShare && (
            <button type="button" className="ghost" disabled={busy} onClick={() => void share()}>
              Retry
            </button>
          )}
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
          {mayShare && (
            <button type="button" className="primary share-go" disabled={spinning || busy} onClick={() => void share()}>
              {spinning ? "Sharing…" : link ? `Share v${link.version + 1}` : "Share"}
            </button>
          )}
        </>
      }
    >
      <div className="share-stack">
        {link && (
          <div className="share-card">
            <div className="share-url">
              <Icon name="link" size={14} />
              <a className="url" href={link.url} target="_blank" rel="noreferrer" title={link.url}>
                {link.url.replace(/^https?:\/\//, "")}
              </a>
              <button type="button" className="sm ghost" title="Copy the link" onClick={() => void copy()}>
                <Icon name={copied ? "check" : "copy"} size={13} />
              </button>
              <button type="button" className="sm" title="Open the link" onClick={() => window.open(link.url, "_blank", "noopener,noreferrer")}>
                <Icon name="external" size={13} /> Open
              </button>
            </div>
            <div className="share-meta">
              <span className="grow">
                {link.version} {link.version === 1 ? "version" : "versions"}, latest v{link.version}
                {behind ? " · the script has changed since" : ""}
                {approved && <span className="ok"> · v{approved.version} approved by {approved.by}</span>}
              </span>
              {mayShare && waiting > 0 && !approved && (
                <button type="button" className="sm ghost" disabled={busy} onClick={() => void fix()}>
                  Fix {waiting} {waiting === 1 ? "note" : "notes"}
                </button>
              )}
              {mayShare && link.version > 1 && !approved && (
                <button type="button" className="sm ghost" disabled={spinning || busy} title="The script as it is now becomes the link's only version, v1; every note is kept" onClick={() => void makeFirst()}>
                  Make this v1
                </button>
              )}
              {mayShare && deleting === null && (
                <button type="button" className="sm ghost" disabled={spinning || busy} title={spinning ? "It's being shared: delete the link once that's done" : busy ? "Claude is working on this script: delete the link once that's done" : "Delete this review link for good"} onClick={() => setDeleting("ask")}>
                  <Icon name="trash" size={13} /> Delete link
                </button>
              )}
              {mayShare && !approved && deleting === null && (
                <button type="button" className="sm ghost" disabled={busy || approving} title="The script is done: the link takes no more notes, and the other versions' files are deleted (their notes stay)" onClick={() => void approve(true)}>
                  {approving ? "Approving…" : `Approve v${link.version}`}
                </button>
              )}
            </div>
            {deleting !== null && (
              <div className="share-ask" role="alertdialog" aria-label="Delete the review link">
                <span>
                  <b>Delete this link?</b> It can't be undone: reviewers lose the page and every note on it{link.version > 1 ? `, v1 to v${link.version}` : ""}. The script and its own version history stay; sharing again makes a new link.
                </span>
                <button type="button" className="sm ghost" disabled={deleting === "running"} onClick={() => setDeleting(null)}>
                  Cancel
                </button>
                <button type="button" className="sm danger-fill" disabled={deleting === "running" || spinning || busy} onClick={() => void removeLink()}>
                  {deleting === "running" ? "Deleting…" : "Delete link"}
                </button>
              </div>
            )}
          </div>
        )}
        {mayShare && flags.length > 0 && !approved && (
          <div className="review-flags">
            <strong>Before sharing: {flags.length === 1 ? "one thing" : `${flags.length} things`} the team would flag</strong>
            <ul>
              {flags.map((flag, index) => (
                <li key={index}>{flag}</li>
              ))}
            </ul>
          </div>
        )}
        <DocExportRow script={script} onChange={onChange} />
        {approved && (
          <p className="review-approved">
            <Icon name="check" size={14} />
            <span>
              <b>Approved v{approved.version}</b> · by {approved.by} · {when(approved.at)}
              <span className="faint"> · The link takes no more notes, and nothing is fixed by itself. Sharing again starts v{(link?.version ?? approved.version) + 1}, unapproved.</span>
            </span>
            {mayShare && (
              <button type="button" className="link-button" disabled={approving} onClick={() => void approve(false)}>
                Take back
              </button>
            )}
          </p>
        )}
        {mayShare && link && fixesHere !== null && !approved && (
          <p className="faint review-auto">
            {fixesHere
              ? "When a reviewer clicks Ready for changes, Claude fixes the notes on this Mac and shares the next version."
              : "When a reviewer clicks Ready for changes, the fixing computer chosen on accounts.spheceo.com fixes the notes and shares the next version."}
          </p>
        )}
        {link && (
          <CommentsPanel
            scriptId={script.id}
            reviewId={link.reviewId}
            notes={notes}
            version={link.version}
            shared
            canWrite={mayShare && !approved}
            onRefresh={onRefresh}
            onError={setProblem}
          />
        )}
      </div>
    </Dialog>
  );
}

// ---- Archived ---------------------------------------------------------------------


/**
 * An archived script, read-only: its footage was deleted to free space (from
 * Repack's page), its words and everything small kept. Restore brings the
 * footage back from its links; what came from this Mac's disk can't come back.
 */
export function ArchivedBanner({ script, working, onJob, onProblem }: { script: Script; working: boolean; onJob: (job: BuildStatus) => void; onProblem: (text: string) => void }) {
  const archive = script.archive;
  if (!archive) return null;
  const restore = async () => {
    try {
      onJob(await restoreScript(script.id));
    } catch (cause) {
      onProblem(message(cause));
    }
  };
  return (
    <div className="notice archived-notice">
      <span>
        <b>Footage archived</b> by {archive.by || "Repack"}, {when(archive.at)}
        {archive.freedBytes > 0 ? `, freeing ${formatBytes(archive.freedBytes)}` : ""}. The script and its words are kept; it reads but can't be edited until the footage is back.
        {archive.missing.length > 0 && <span className="bad"> Missing after the last restore (from this Mac's disk): {archive.missing.join(", ")}.</span>}
      </span>
      <button type="button" className="primary sm" disabled={working || archive.restoring} onClick={() => void restore()}>
        {working || archive.restoring ? "Restoring…" : "Restore footage"}
      </button>
    </div>
  );
}
