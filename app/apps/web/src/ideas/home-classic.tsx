// Home's Ideas tab, on the Home everyone has (HomeClassic.tsx; the sidebar
// Home's Ideas section is ideas/home.tsx, a beta): the team's ideas, by what
// they need — the changes reviewers asked for on the board, a run that
// stopped, a case already on the board — then those Claude is repackaging, the
// drafts, the ones ready to send and those on the board (with where their card
// is now). One tab, the idea page a click away (the user: "one tab, one mode,
// one page … i think thats better").

import { CircleAlert, ExternalLink, Lightbulb, MessageSquare, Plus, Send, TriangleAlert } from "lucide-react";
import { Fragment, useState } from "react";

import { Button, cx, Spinner } from "../components/ui";
import { StartedBy } from "../components/StartedBy";
import { ideasApi, viewsLabel, type ChangeCard, type IdeaRow, type IdeasHome } from "../lib/ideas";
import {  } from "../lib/kept";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { ago } from "../lib/time";

const PILL = "inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full bg-raised px-2.5 text-[12px] leading-none font-medium whitespace-nowrap";

type Group = { key: string; label: string; rows: (IdeaRow | ChangeCard)[] };

const isCard = (row: IdeaRow | ChangeCard): row is ChangeCard => !("summary" in row);

/** Which of Home's groups an idea is in. */
function groupOf(row: IdeaRow): string {
  const { summary, place } = row;
  if (place?.changes) return "needs";
  if (summary.run === "running" || summary.run === "queued") return "working";
  if (summary.status !== "sent" && (summary.run === "failed" || summary.run === "stopped" || summary.duplicate !== null || summary.skipped !== null)) return "needs";
  if (summary.status === "ready") return "ready";
  if (summary.status === "sent") return "sent";
  return "drafts";
}

const LABELS: [string, string][] = [
  ["needs", "Needs you"],
  ["working", "Repackaging"],
  ["drafts", "Drafts"],
  ["ready", "Ready to send"],
  ["sent", "On the board"],
];

export function IdeasTab({ home, error, query, onNew }: { home: IdeasHome | null; error: string | null; query: string; onNew: () => void }) {
  const [opening, setOpening] = useState<string | null>(null);
  const words = query.trim().toLowerCase();
  const kept = (title: string) => words === "" || title.toLowerCase().includes(words);
  if (home === null) {
    return error === null ? (
      <div className="mt-16 flex justify-center">
        <Spinner size={20} />
      </div>
    ) : (
      <p className="mt-16 text-center text-muted">The ideas didn’t load: {error}</p>
    );
  }
  const groups: Group[] = LABELS.map(([key, label]) => ({
    key,
    label,
    rows: [...(key === "needs" ? home.changes.filter((card) => kept(card.name)) : []), ...home.ideas.filter((row) => groupOf(row) === key && kept(row.summary.title))],
  })).filter((group) => group.rows.length > 0);
  const open = (card: ChangeCard) => {
    setOpening(card.id);
    ideasApi
      .fromCard(card.id, card.workspace)
      .then(({ id }) => navigate(`/ideas/${id}`))
      .catch((failure: unknown) => useEditor.getState().toastError(failure, "open that card"))
      .finally(() => setOpening(null));
  };
  return (
    <>
      {(home.boardError ?? error) && (
        <p className="mt-4 text-[12px] text-warning/80" title={home.boardError ?? error ?? ""}>
          The board couldn’t be read just now: where cards are may be out of date.
        </p>
      )}
      {groups.length === 0 ? (
        words !== "" ? (
          <p className="mt-16 text-center text-muted">Nothing matches “{query.trim()}”.</p>
        ) : (
          <div className="mt-6 flex flex-col items-center rounded-xl border border-line px-4 py-12 text-center">
            <Lightbulb size={22} className="text-muted" />
            <div className="mt-3 text-[14px] font-medium">No ideas yet</div>
            <p className="mt-1 max-w-[380px] text-[12px] text-muted">Paste a YouTube interrogation or an article: Claude writes the titles and the thumbnail guide, and you send it to the board.</p>
            <Button className="mt-4" variant="light" onClick={onNew}>
              <Plus size={15} strokeWidth={2.2} /> New idea
            </Button>
          </div>
        )
      ) : (
        <div role="table" aria-label="Ideas" className="mt-6 overflow-hidden rounded-xl border border-line">
          {groups.map((group, index) => (
            <Fragment key={group.key}>
              <div className={cx("flex items-center gap-2 px-4 pt-3.5 pb-1.5 text-[11.5px] font-medium text-faint", index > 0 && "border-t border-line")}>
                {group.label} <span className="tabular">{group.rows.length}</span>
              </div>
              {group.rows.map((row) => (isCard(row) ? <CardRow key={row.id} card={row} opening={opening === row.id} onOpen={() => open(row)} /> : <Row key={row.id} row={row} />))}
            </Fragment>
          ))}
        </div>
      )}
    </>
  );
}

function Thumb({ src }: { src: string | null }) {
  return src === null ? (
    <span className="grid h-9 w-16 shrink-0 place-items-center rounded-md border border-line bg-panel text-faint">
      <Lightbulb size={14} />
    </span>
  ) : (
    <img src={src} alt="" loading="lazy" className="h-9 w-16 shrink-0 rounded-md border border-line object-cover" />
  );
}

/** What an idea's row says of where it stands. */
function Status({ row }: { row: IdeaRow }) {
  const { summary, place } = row;
  if (place?.changes)
    return (
      <span className={cx(PILL, "text-warning")} title={`Changes requested on its card (${place.list})`}>
        <MessageSquare size={12} /> Changes requested
      </span>
    );
  if (summary.run === "running" || summary.run === "queued")
    return (
      <span className={cx(PILL, "text-info")} title={summary.step ?? undefined}>
        <Spinner size={12} /> {summary.run === "queued" ? "Waiting" : (summary.step ?? "Repackaging")}
      </span>
    );
  if (summary.status === "sent")
    return place?.missing ? (
      <span className={cx(PILL, "text-warning")}>Card gone</span>
    ) : (
      <span className={cx(PILL, place?.approved ? "text-success" : "text-fg")} title={place?.list ?? summary.card?.list}>
        <Send size={12} /> {place?.approved ? place.list : (place?.list ?? summary.card?.list ?? "On the board")}
      </span>
    );
  if (summary.duplicate !== null)
    return (
      <span className={cx(PILL, "text-warning")} title={`Already on the board as “${summary.duplicate}”`}>
        <CircleAlert size={12} /> On the board already
      </span>
    );
  if (summary.skipped !== null)
    return (
      <span className={cx(PILL, "text-warning")} title={summary.skipped}>
        <TriangleAlert size={12} /> Skipped
      </span>
    );
  if (summary.run === "failed" || summary.run === "stopped")
    return (
      <span className={cx(PILL, "text-danger")} title={summary.step ?? undefined}>
        <TriangleAlert size={12} /> {summary.run === "failed" ? "Stopped short" : "Stopped"}
      </span>
    );
  return <span className={cx(PILL, summary.status === "ready" ? "text-success" : "text-secondary")}>{summary.status === "ready" ? "Ready" : "Draft"}</span>;
}

function Row({ row }: { row: IdeaRow }) {
  const { summary } = row;
  const details = [viewsLabel(summary.views), summary.outlier && summary.outlier !== "unknown" ? `${summary.outlier} outlier` : "", summary.sources > 1 ? `${summary.sources} sources` : ""].filter(Boolean).join(" · ");
  return (
    <div role="row" onClick={() => navigate(`/ideas/${row.id}`)} className="group flex min-h-14 cursor-pointer items-center gap-3 border-t border-line px-4 py-2.5 transition-colors hover:bg-panel">
      <Thumb src={summary.thumbnail} />
      <div role="cell" className="min-w-0 flex-1">
        <div className="truncate text-[14px] text-fg group-hover:underline group-hover:underline-offset-[3px]">{summary.title}</div>
        {details !== "" && <div className="truncate text-[12px] text-faint">{details}</div>}
      </div>
      <Status row={row} />
      <StartedBy by={row.createdBy === null ? null : { sub: row.createdBy.sub, name: row.createdBy.name, ...(row.createdBy.picture !== null ? { picture: row.createdBy.picture } : {}) }} size={20} placeholder />
      <span role="cell" className="w-[88px] shrink-0 text-right text-[13px] text-secondary">
        {ago(row.updatedAt)}
      </span>
    </div>
  );
}

/** A card on a lane waiting on changes that no idea has yet: opening it makes one. */
function CardRow({ card, opening, onOpen }: { card: ChangeCard; opening: boolean; onOpen: () => void }) {
  const last = card.comments.at(-1);
  return (
    <div role="row" onClick={onOpen} className="group flex min-h-14 cursor-pointer items-center gap-3 border-t border-line px-4 py-2.5 transition-colors hover:bg-panel">
      <Thumb src={null} />
      <div role="cell" className="min-w-0 flex-1">
        <div className="truncate text-[14px] text-fg group-hover:underline group-hover:underline-offset-[3px]">{card.name}</div>
        <div className="truncate text-[12px] text-faint">{last ? `${last.author}: ${last.text}` : card.list}</div>
      </div>
      <span className={cx(PILL, "text-warning")} title={card.list}>
        {opening ? <Spinner size={12} /> : <MessageSquare size={12} />} Changes requested
      </span>
      <a href={card.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg" title="Open the card on Trello">
        <ExternalLink size={14} />
      </a>
      <span className="w-[88px] shrink-0" />
    </div>
  );
}
