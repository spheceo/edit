// Ideas on Home (Oct 31 2026): the team's ideas as rows of Home's table, in
// its Ideas section (Drafts, On the board); the idea page a click away (the
// user: "one tab, one mode, one page … i think thats better").

import { ArrowUpRight, CircleAlert, ExternalLink, Eye, Lightbulb, MessageSquare, Send, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button, cx, DialogActions, DialogTitle, Field, Modal, Pulse, Switch, Tabs, TextArea, TextField } from "../components/ui";
import { AsideStatus, BackMark, Category, CHIP, COLUMNS, contextMenu, CreatorCell, KindMark, LengthCell, NAME, ROW, RowButtons, StatusCell, Updated, useAside, withAside } from "../components/HomeTable";
import { WORKSPACE_NAMES, type Workspace } from "@edit/types/ideas";
import { ideasApi, NICHE, viewsLabel, type ChangeCard, type IdeaRow, type IdeasHome } from "../lib/ideas";
import { useKept } from "../lib/kept";
import { laterKey } from "../lib/later";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";

/** Where an idea is on Home: a draft (repackaging, ready, stopped), its card on the board, or done once the card is approved. */
export function ideaStage(row: IdeaRow): "drafts" | "board" | "done" {
  if (row.summary.status === "sent" && row.place?.approved === true) return "done";
  return row.summary.status === "sent" ? "board" : "drafts";
}

/** Home's ideas, polled while Claude works (every few seconds) and otherwise now and then. */
export function useIdeasHome(enabled: boolean): [IdeasHome | null, () => void, string | null] {
  const [home, setHome] = useKept<IdeasHome | null>("home.ideas", null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    ideasApi
      .home()
      .then((answer) => {
        setHome(answer);
        setError(null);
      })
      .catch((failure: unknown) => setError((failure as Error).message));
  }, [setHome]);
  const busy = home?.ideas.some((row) => row.summary.run === "running" || row.summary.run === "queued") ?? false;
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, busy ? 3_000 : 20_000);
    return () => clearInterval(timer);
  }, [busy, refresh, enabled]);
  return [home, refresh, error];
}

/** What an idea's row says of where it stands. */
function Status({ row }: { row: IdeaRow }) {
  const { summary, place } = row;
  if (place?.changes)
    return (
      <span className={cx(CHIP, "text-warning")} title={`Changes requested on its card (${place.list})`}>
        <MessageSquare size={12} /> Changes requested
      </span>
    );
  if (summary.run === "running" || summary.run === "queued")
    return (
      <span className={cx(CHIP, "max-w-full text-info")} title={summary.step ?? undefined}>
        <Pulse size={12} /> <span className="truncate">{summary.run === "queued" ? "Waiting" : (summary.step ?? "Repackaging")}</span>
      </span>
    );
  if (summary.status === "sent")
    return place?.missing ? (
      <span className={cx(CHIP, "text-warning")}>Card gone</span>
    ) : (
      <span className={cx(CHIP, "max-w-full", place?.approved ? "text-success" : "text-secondary")} title={place?.list ?? summary.card?.list}>
        <Send size={12} /> <span className="truncate">{place?.approved ? place.list : (place?.list ?? summary.card?.list ?? "On the board")}</span>
      </span>
    );
  if (summary.duplicate !== null)
    return (
      <span className={cx(CHIP, "text-warning")} title={`Already on the board as “${summary.duplicate}”`}>
        <CircleAlert size={12} /> On the board already
      </span>
    );
  if (summary.skipped !== null)
    return (
      <span className={cx(CHIP, "text-warning")} title={summary.skipped}>
        <TriangleAlert size={12} /> Skipped
      </span>
    );
  if (summary.run === "failed" || summary.run === "stopped")
    return (
      <span className={cx(CHIP, "text-danger")} title={summary.step ?? undefined}>
        <TriangleAlert size={12} /> {summary.run === "failed" ? "Stopped short" : "Stopped"}
      </span>
    );
  return <span className={cx(CHIP, summary.status === "ready" ? "text-success" : "text-muted")}>{summary.status === "ready" ? "Ready" : "Draft"}</span>;
}

/** An idea in Home's table: its main title, niche, where it stands, who started it, the video's views. */
export function IdeaTableRow({ row }: { row: IdeaRow }) {
  const { summary } = row;
  const aside = useAside(laterKey("idea", row.id), summary.title);
  const open = () => {
    aside.seen();
    navigate(`/ideas/${row.id}`);
  };
  const items = withAside([{ label: "Open", icon: <ArrowUpRight size={14} />, onSelect: open }], aside.items);
  const details = [summary.source, summary.outlier && summary.outlier !== "unknown" ? `${summary.outlier} outlier` : "", summary.sources > 1 ? `${summary.sources} sources` : ""].filter(Boolean).join(" · ");
  return (
    <div role="row" onClick={open} onContextMenu={contextMenu(items)} className={cx(COLUMNS, ROW)}>
      <div role="cell" className="flex min-w-0 items-center gap-2.5" title={details || undefined}>
        <KindMark kind="idea" />
        {aside.woke && <BackMark entry={aside.woke} />}
        <span className={NAME}>{summary.title}</span>
      </div>
      {/* Its kind (Interrogation or Bodycam); a niche an older run gave beside it. */}
      <Category text={[WORKSPACE_NAMES[row.workspace ?? "interrogation"], summary.niche ? NICHE[summary.niche].label : ""].filter(Boolean).join(" · ")} />
      <StatusCell>{aside.entry ? <AsideStatus entry={aside.entry} /> : <Status row={row} />}</StatusCell>
      <CreatorCell by={row.createdBy === null ? null : { sub: row.createdBy.sub, name: row.createdBy.name, ...(row.createdBy.picture !== null ? { picture: row.createdBy.picture } : {}) }} />
      <LengthCell title={summary.views !== null ? `${summary.views.toLocaleString()} views` : undefined}>
        {summary.views !== null && (
          <>
            <Eye size={13} className="shrink-0 text-faint" />
            {viewsLabel(summary.views).replace(/ views?$/u, "")}
          </>
        )}
      </LengthCell>
      <Updated at={row.updatedAt} title={row.updatedBy ? `by ${row.updatedBy}` : undefined} />
      <RowButtons aside={aside.button} items={items} />
    </div>
  );
}

/** A card on a lane waiting on changes that no idea has yet: opening it makes one. */
export function CardTableRow({ card, onOpened }: { card: ChangeCard; onOpened?: () => void }) {
  const [opening, setOpening] = useState(false);
  const last = card.comments.at(-1);
  const aside = useAside(laterKey("card", card.id), card.name);
  const open = () => {
    aside.seen();
    setOpening(true);
    ideasApi
      .fromCard(card.id, card.workspace)
      .then(({ id }) => {
        onOpened?.();
        navigate(`/ideas/${id}`);
      })
      .catch((failure: unknown) => useEditor.getState().toastError(failure, "open that card"))
      .finally(() => setOpening(false));
  };
  const items = withAside(
    [
      { label: "Open as an idea", icon: <ArrowUpRight size={14} />, onSelect: open },
      { label: "Open on Trello", icon: <ExternalLink size={14} />, onSelect: () => window.open(card.url, "_blank", "noopener") },
    ],
    aside.items,
  );
  return (
    <div role="row" onClick={open} onContextMenu={contextMenu(items)} className={cx(COLUMNS, ROW)}>
      <div role="cell" className="flex min-w-0 items-center gap-2.5" title={last ? `${last.author}: ${last.text}` : card.list}>
        <KindMark kind="idea" />
        {aside.woke && <BackMark entry={aside.woke} />}
        <span className={NAME}>{card.name}</span>
      </div>
      <Category text={card.list} />
      <StatusCell>
        {aside.entry ? (
          <AsideStatus entry={aside.entry} />
        ) : (
          <span className={cx(CHIP, "text-warning")} title={last ? `${last.author}: ${last.text}` : card.list}>
            {opening ? <Pulse size={12} /> : <MessageSquare size={12} />} Changes requested
          </span>
        )}
      </StatusCell>
      <CreatorCell by={null} />
      <LengthCell />
      <span role="cell" />
      <RowButtons aside={aside.button} items={items} />
    </div>
  );
}

/** No ideas yet: what an idea is, and the way to make one. */
export function NoIdeas({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-col items-center px-4 py-16 text-center">
      <Lightbulb size={22} className="text-muted" />
      <div className="mt-3 text-[14px] font-medium">No ideas yet</div>
      <p className="mt-1 max-w-[380px] text-[12.5px] text-muted">Paste a YouTube interrogation or bodycam video, or an article: Claude writes the titles and the thumbnail guide, and you send it to the board.</p>
      <Button className="mt-4" variant="light" onClick={onNew}>
        New idea
      </Button>
    </div>
  );
}

/** What a kind of idea is made from and an angle for it, as the dialog asks. */
const KIND: Record<Workspace, { what: string; angle: string }> = {
  interrogation: { what: "YouTube interrogations or articles", angle: "e.g. the GPS data, the moment her story collapses" },
  bodycam: { what: "YouTube bodycam videos or articles", angle: "e.g. what officers find inside, the moment she plays the victim" },
};

/** New idea: links (one idea each), interrogation or bodycam, the angle, a summary or not, the footage. */
export function NewIdea({ open, onClose, onMade }: { open: boolean; onClose: () => void; onMade: () => void }) {
  const [links, setLinks] = useState("");
  // The kinds this person works on (both: they choose; the last choice is remembered on this Mac).
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace>(() => (localStorage.getItem("ideas.workspace") === "bodycam" ? "bodycam" : "interrogation"));
  useEffect(() => {
    if (!open) return;
    void ideasApi.workspaces().then(({ workspaces: mine }) => {
      setWorkspaces(mine);
      setWorkspace((now) => (mine.length === 0 || mine.includes(now) ? now : mine[0]!));
    }, () => {});
  }, [open]);
  const choose = (value: Workspace) => {
    setWorkspace(value);
    localStorage.setItem("ideas.workspace", value);
  };
  const [steer, setSteer] = useState("");
  const [summary, setSummary] = useState(false);
  const [footage, setFootage] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Links already an idea: theirs to open.
  const [known, setKnown] = useState<{ id: string; why: string }[]>([]);
  const count = (links.match(/https?:\/\/\S+/g) ?? []).length;
  const close = () => {
    if (busy) return;
    setProblem(null);
    onClose();
  };
  const make = () => {
    setBusy(true);
    setProblem(null);
    setKnown([]);
    ideasApi
      .create(links, steer, summary, count === 1 ? footage : "", workspace)
      .then(({ ideas, refused }) => {
        onMade();
        const others = refused.filter((one) => one.id === undefined);
        setKnown(refused.flatMap((one) => (one.id !== undefined ? [{ id: one.id, why: one.why }] : [])));
        if (refused.length > 0) {
          setProblem(others.length > 0 ? others.map((one) => `${one.link}: ${one.why}`).join("\n") : null);
          setLinks(others.map((one) => one.link).join("\n"));
          return;
        }
        setLinks("");
        setSteer("");
        setFootage("");
        setSummary(false);
        onClose();
        if (ideas.length === 1) navigate(`/ideas/${ideas[0]!.id}`);
      })
      .catch((failure: unknown) => setProblem((failure as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <Modal open={open} onClose={close} width={520}>
      <div className="p-6">
        <DialogTitle title="New idea" detail={`${KIND[workspace].what}, one a line. Each becomes an idea Claude repackages: 3–5 titles and a thumbnail guide.`} />
        <div className="mt-4 flex flex-col gap-3">
          <TextArea autoFocus value={links} onChange={(event) => setLinks(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" rows={4} aria-label="Links" />
          {workspaces.length > 1 && (
            <div className="flex items-center justify-between text-[13px]">
              <span>Kind</span>
              <Tabs framed id="new-idea-kind" label="Kind of idea" value={workspace} onChange={choose} tabs={workspaces.map((value) => ({ value, label: WORKSPACE_NAMES[value] }))} />
            </div>
          )}
          <Field
            stacked
            label={
              <span>
                Angle <span className="text-faint">(optional)</span>
              </span>
            }
          >
            <TextField value={steer} onChange={(event) => setSteer(event.target.value)} placeholder={KIND[workspace].angle} />
          </Field>
          {count <= 1 && (
            <Field
              stacked
              label={
                <span>
                  Footage <span className="text-faint">(optional: YouTube or Drive links; the idea's page adds more and marks reuses)</span>
                </span>
              }
            >
              <TextField value={footage} onChange={(event) => setFootage(event.target.value)} placeholder="https://drive.google.com/drive/folders/…  https://youtu.be/…" />
            </Field>
          )}
          <label className="flex items-center justify-between text-[13px]">
            <span>
              Write a summary <span className="text-[12px] text-faint">one paragraph, 35–55 words</span>
            </span>
            <Switch checked={summary} onChange={setSummary} />
          </label>
        </div>
        {problem !== null && <p className="mt-3 text-[12px] whitespace-pre-line text-danger">{problem}</p>}
        {known.map((one) => (
          <button key={one.id} type="button" onClick={() => navigate(`/ideas/${one.id}`)} className="mt-2 block text-left text-[12px] text-warning hover:underline hover:underline-offset-[3px]">
            {one.why} Open it ›
          </button>
        ))}
        <DialogActions>
          <Button variant="subtle" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={make} busy={busy} disabled={count === 0}>
            {count > 1 ? `Repackage ${count}` : "Repackage"}
          </Button>
        </DialogActions>
      </div>
    </Modal>
  );
}
