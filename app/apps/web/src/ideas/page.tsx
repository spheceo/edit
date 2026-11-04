// The idea page (/ideas/<id>, Oct 31 2026). The user: "on this side of the
// screen, please try to copy as much of the sphe research ui. it was nice.
// and then here copy the video editor's chat that we have." So the left is
// Sphe Research's case (its header and its Titles / Thumbnail guide / Case
// form, Edit and Done per section, the main title in amber; not its list of
// threads: "No need for the threads view on the side here"), and the right is
// the editor's own chat (AgentPanel's turns and composer, the same components). One main action: send the idea to the
// board, or update its card once the reviewers' changes are made.

import { ArrowDown, ArrowLeft, ArrowUp, Check, Copy, ExternalLink, FileText, FolderOpen, Image as ImageIcon, MoreHorizontal, Plus, RotateCw, Send, Trash2, SquarePlay, TriangleAlert, X } from "lucide-react";
import { type DragEvent, type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChatShell, ChatTurns, Empty, useChatTurns, useSentNow } from "../components/AgentPanel";
import { ChatComposer } from "../components/ChatComposer";
import { ChatDock } from "../components/ChatDock";
import { picturesOnly, postFile } from "../lib/chatFiles";
import { AppMenu } from "../components/AppMenu";
import { StartedBy } from "../components/StartedBy";
import { toggleMenu } from "../components/ContextMenu";
import { Button, ConfirmDialog, cx, DialogActions, DialogTitle, IconButton, Modal, Pulse } from "../components/ui";
import { conversationEntries } from "../lib/agentTurns";
import { footageIn, footageLine, WORKSPACE_NAMES, type IdeaFootage, type IdeaImage } from "@edit/types/ideas";
import { chatImageUrl, ideasApi, imageUrl, NICHE, viewsLabel, working, type Idea, type IdeaChange, type IdeaPage as Page } from "../lib/ideas";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { Loader as EditLoader } from "../components/Logo";

/** Home, on its Ideas section. */
export function backToIdeas(): void {
  localStorage.setItem("edit.home.view", "ideas");
  navigate("/ideas");
}

// Sphe Research's own classes (thread-form.tsx), so the page reads as it did.
const FIELD_SHAPE = "w-full rounded-lg border bg-white/[0.02] px-3 py-2 text-[14.5px] leading-relaxed text-white outline-none placeholder:text-white/20";
const FIELD = `${FIELD_SHAPE} border-white/[0.06] focus:border-white/18`;
const LABEL = "text-[13px] font-medium tracking-[-0.01em] text-white/45";
const QUIET_BUTTON = "rounded-lg px-2 py-1 text-[12px] text-white/35 transition-colors hover:bg-white/[0.05] hover:text-white/80 disabled:opacity-40";
const WHITE_BUTTON = "inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-[12px] font-medium text-black transition-colors hover:bg-white/85 disabled:opacity-40";

function saveOnEnter(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, save: () => void) {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
  event.preventDefault();
  save();
}

/** The idea's card as Markdown, as the board writes one (the server's cardText). */
function cardMarkdown(idea: Idea): string {
  const main = idea.main ?? idea.titles[0]?.text;
  const titles = main === undefined ? [] : [main, ...idea.titles.map((one) => one.text).filter((one) => one !== main)];
  return [
    idea.summary ? `Summary: ${idea.summary}\n` : "",
    "Titles:",
    ...titles.map((one) => `- ${one}`),
    "",
    "Thumbnail Guide:",
    idea.thumbnailGuide,
    "",
    "Case:",
    ...idea.sources.map((one) => one.url),
    ...(idea.footage.length > 0 ? ["", "Footage:", ...idea.footage.map(footageLine)] : []),
  ]
    .filter((line, index) => line !== "" || index > 0)
    .join("\n")
    .trim();
}

export function IdeaScreen({ id }: { id: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [saving, setSaving] = useState<"saving" | "saved" | "error" | null>(null);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const toastError = useEditor((state) => state.toastError);
  const toast = useEditor((state) => state.toast);
  const load = useCallback(
    () =>
      ideasApi
        .get(id)
        .then((answer) => {
          setPage(answer);
          setMissing(null);
        })
        .catch((error: unknown) => setMissing((error as Error).message)),
    [id],
  );
  const active = page !== null && working(page.idea);
  // Footage the server is still naming: looked at again soon.
  const checking = page !== null && page.idea.footage.some((one) => one.title === undefined && one.problem === undefined);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, active ? 1_500 : checking ? 2_000 : 15_000);
    return () => clearInterval(timer);
  }, [load, active, checking]);
  // The reviewers' comments, read fresh from the card when it's waiting on changes.
  const changesAsked = page?.place?.changes === true;
  useEffect(() => {
    if (!changesAsked) return;
    void ideasApi.comments(id).then(() => load(), () => {});
  }, [changesAsked, id, load]);

  const change = (patch: IdeaChange) => {
    setSaving("saving");
    return ideasApi
      .change(id, patch)
      .then(({ idea }) => {
        setPage((last) => (last === null ? last : { ...last, idea }));
        setSaving("saved");
        return load();
      })
      .catch((error: unknown) => {
        setSaving("error");
        toastError(error, "save that");
      });
  };
  const act = (what: string, work: () => Promise<unknown>) => {
    setBusy(what);
    return work()
      .then(() => load())
      .catch((error: unknown) => toastError(error, what))
      .finally(() => setBusy(null));
  };

  return (
    <div className="flex h-full flex-col bg-black">
      <Header page={page} saving={saving} busy={busy} onChange={change} onAct={act} onSend={() => setSending(true)} onDeleted={backToIdeas} toast={toast} />
      {/* The editor's gutters: 8 px round the chat's panel. */}
      <div className="flex min-h-0 flex-1 pb-2">
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-auto">
          {page === null ? (
            <div className="flex h-full items-center justify-center text-[13px] text-white/40">{missing ?? <EditLoader size={32} />}</div>
          ) : (
            <>
              <Notices page={page} busy={busy} onRepackage={(options) => void act("repackage it", () => ideasApi.repackage(id, options))} />
              <div className="mx-auto w-full max-w-[44rem] px-8 py-10 2xl:px-14 2xl:py-14">
                <h1 aria-label="Main title" className="text-[27px] leading-[1.18] font-semibold tracking-[-0.03em] break-words text-white">
                  {page.idea.main ?? page.idea.titles[0]?.text ?? <span className="text-white/15">{active ? "Repackaging…" : "No title yet"}</span>}
                </h1>
                <Meta idea={page.idea} />
                <Changes page={page} busy={busy} onMake={() => void act("make the changes", () => ideasApi.repackage(id, { changes: true }))} />
                <div className="mt-7">
                  <CaseForm page={page} onChange={change} busy={busy !== null || active} onRegenerate={() => void act("repackage it", () => ideasApi.repackage(id, { improve: page.idea.duplicate !== null && page.idea.card === null }))} onUploaded={(idea) => setPage((last) => (last === null ? last : { ...last, idea }))} />
                </div>
              </div>
            </>
          )}
        </main>
        <ChatDock working={active}>
          <div className="flex min-h-0 flex-1 flex-col pt-2">{page === null ? <ChatShell loading /> : <Chat id={id} idea={page.idea} onAsked={() => void load()} />}</div>
        </ChatDock>
      </div>
      {page !== null && <SendDialog open={sending} idea={page.idea} onClose={() => setSending(false)} onSent={() => void load()} />}
    </div>
  );
}

// ---------------------------------------------------------------- the header (Sphe Research's case header)

function Header({
  page,
  saving,
  busy,
  onChange,
  onAct,
  onSend,
  onDeleted,
  toast,
}: {
  page: Page | null;
  saving: "saving" | "saved" | "error" | null;
  busy: string | null;
  onChange: (patch: IdeaChange) => Promise<unknown>;
  onAct: (what: string, work: () => Promise<unknown>) => Promise<unknown>;
  onSend: () => void;
  onDeleted: () => void;
  toast: (text: string, tone?: "agent" | "error" | "info") => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const idea = page?.idea ?? null;
  const place = page?.place ?? null;
  const sent = idea !== null && idea.status === "sent" && idea.card !== null;
  const active = idea !== null && working(idea);
  const missing = idea === null ? [] : [idea.titles.length === 0 ? "a title" : "", idea.thumbnailGuide.trim() === "" ? "a thumbnail guide" : "", idea.sources.length === 0 ? "the case link" : ""].filter(Boolean);
  const asked = place?.changes === true || (idea?.changes?.comments.length ?? 0) > 0;
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 md:px-5">
      <button type="button" onClick={backToIdeas} className="-ml-1 flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] text-white/40 transition-colors hover:bg-white/[0.05] hover:text-white/85">
        <ArrowLeft size={15} strokeWidth={1.9} />
        Ideas
      </button>
      <span className="ml-auto flex min-w-0 items-center gap-1.5 text-[11.5px] text-white/25">
        {saving === "saving" ? (
          <>
            <Pulse size={12} /> Saving
          </>
        ) : saving === "error" ? (
          <span className="text-red-300/70">Not saved</span>
        ) : saving === "saved" ? (
          <>
            <Check size={12} strokeWidth={2} /> Saved
          </>
        ) : null}
      </span>
      {idea !== null && <StartedBy by={{ sub: idea.createdBy, name: idea.createdBy }} size={24} title={`Started by ${idea.createdBy}`} className="hidden sm:inline-grid" />}
      {idea?.card != null && (
        <a href={idea.card.url} target="_blank" rel="noreferrer" title={place?.list ?? idea.card.list} className={cx("inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] transition-colors hover:bg-white/[0.05] hover:text-white/80", place?.approved ? "text-emerald-200/80" : asked ? "text-amber-200/80" : "text-white/40")}>
          <ExternalLink size={12} strokeWidth={1.9} />
          {place?.missing ? "Card gone" : place?.approved ? place.list : asked ? "Changes requested" : "On Trello"}
        </a>
      )}
      {idea !== null && !sent && (
        <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-white/[0.04] p-0.5">
          {(["draft", "ready"] as const).map((status) => (
            <button
              key={status}
              type="button"
              disabled={busy !== null || (status === "ready" && idea.status !== "ready" && missing.length > 0)}
              aria-pressed={idea.status === status}
              title={status === "ready" ? (missing.length > 0 ? `Still needs ${missing.join(", ")}` : "Checked, and ready for the board") : "Still being written"}
              onClick={() => idea.status !== status && void onChange({ status })}
              className={cx(
                "rounded-[0.4rem] px-2.5 py-1 text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-30",
                idea.status === status ? (status === "draft" ? "bg-amber-300/15 text-amber-100" : "bg-emerald-300/15 text-emerald-100") : "text-white/35 hover:text-white/70",
              )}
            >
              {status === "draft" ? "Draft" : "Ready"}
            </button>
          ))}
        </div>
      )}
      {/* In the top bar beside the board's button, not under the footage where it was too easily clicked (Sphe, Nov 2). */}
      {idea !== null && canStartScript(idea) && (
        <Button size="sm" variant="subtle" disabled={active} onClick={() => startScript(idea)} title="New project, with this idea's title and footage">
          Start the script
        </Button>
      )}
      {idea !== null &&
        (sent ? (
          <Button size="sm" variant={asked ? "primary" : "subtle"} busy={busy === "update the card"} disabled={busy !== null || active || missing.length > 0} onClick={() => void onAct("update the card", () => ideasApi.updateCard(idea.id).then(({ labelled }) => toast(labelled ? "The card is updated and labelled Changes Made." : "The card is updated.", "info")))}>
            <RotateCw size={13} /> Update the card
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={busy !== null || active || missing.length > 0} title={missing.length > 0 ? `Still needs ${missing.join(", ")}` : undefined} onClick={onSend}>
            <Send size={13} /> Send to Trello
          </Button>
        ))}
      {idea !== null && (
        <IconButton
          label="Idea options"
          onClick={(event) =>
            toggleMenu(
              event.currentTarget,
              [
                { label: "Copy as markdown", icon: <Copy size={14} />, onSelect: () => void navigator.clipboard?.writeText(cardMarkdown(idea)).then(() => toast("Copied as Markdown.", "info")) },
                ...(idea.summary === ""
                  ? [{ label: "Ask Claude for a summary", icon: <Plus size={14} />, disabled: active, onSelect: () => void onAct("ask for a summary", () => onChange({ wantsSummary: true }).then(() => ideasApi.chat(idea.id, "Write the summary: one factual sentence, 30 words at most."))) }]
                  : []),
                { label: "Delete idea", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(true) },
              ],
              { width: 210 },
            )
          }
        >
          <MoreHorizontal size={15} />
        </IconButton>
      )}
      <AppMenu />
      {idea !== null && (
        <ConfirmDialog
          open={deleting}
          onClose={() => setDeleting(false)}
          title="Delete this idea?"
          detail={`${idea.main ?? idea.sources[0]?.title ?? "This idea"}. ${idea.card !== null ? "Its card stays on the board." : "It goes for the whole team."}`}
          confirm="Delete"
          busy={busy === "delete the idea"}
          onConfirm={() => void onAct("delete the idea", () => ideasApi.remove(idea.id).then(onDeleted))}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- above the form

/** The case under the title: its kind (and a niche an older run gave), and the video or article it's from. */
function Meta({ idea }: { idea: Idea }) {
  const niche = idea.niche ? NICHE[idea.niche] : null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      <span className="flex flex-wrap gap-1.5">
        <span className="inline-flex w-fit items-center rounded-lg bg-white/[0.04] px-2 py-1 text-[12px] text-white/55">{WORKSPACE_NAMES[idea.workspace]}</span>
        {niche !== null && (
          <span className="inline-flex w-fit items-center gap-1.5 rounded-lg bg-white/[0.04] px-2 py-1 text-[12px] text-white/55">
            <span className={cx("size-1.5 rounded-full", niche.dot)} />
            {niche.label}
          </span>
        )}
      </span>
      {idea.sources.map((source) => (
        <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="group flex items-center gap-3 rounded-xl px-1 py-1 transition-colors hover:bg-white/[0.03]">
          {source.kind === "youtube" && source.thumbnail !== null && <img src={source.thumbnail} alt="" className="h-9 w-16 shrink-0 rounded-md object-cover" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-white/70 group-hover:text-white/90">{source.title || source.url}</span>
            <span className="block truncate text-[11.5px] text-white/30">
              {source.kind === "youtube"
                ? [source.channel, viewsLabel(source.views), source.outlier !== "unknown" ? `${source.outlier} outlier` : "", source.durationSeconds !== null ? `${Math.round(source.durationSeconds / 60)} min` : ""].filter(Boolean).join(" · ")
                : source.outlet}
            </span>
          </span>
          <ExternalLink size={13} strokeWidth={1.9} className="shrink-0 text-white/20 group-hover:text-white/50" />
        </a>
      ))}
    </div>
  );
}

/** Bands under the header, as Sphe Research's duplicate notice: the case already on the board, a skipped case, a run that stopped. */
function Notices({ page, busy, onRepackage }: { page: Page; busy: string | null; onRepackage: (options: { improve?: boolean; changes?: boolean }) => void }) {
  const { idea } = page;
  const off = busy !== null || working(idea);
  const run = idea.run;
  const band = "shrink-0 border-b border-amber-400/20 bg-amber-400/[0.05] px-5 py-2.5";
  const link = "underline decoration-amber-100/20 underline-offset-2 transition-colors hover:text-amber-100/90 disabled:opacity-40";
  return (
    <>
      {idea.duplicate !== null && idea.card === null && (
        <div className={band}>
          <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-amber-100/90">
            <TriangleAlert size={13} strokeWidth={1.9} /> This video is already on the board.
          </p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-amber-100/55">
            As “{idea.duplicate.name}” ({idea.duplicate.list || "archived"}).{" "}
            <a href={idea.duplicate.url} target="_blank" rel="noreferrer" className={link}>
              Open
            </a>{" "}
            ·{" "}
            <button type="button" disabled={off} onClick={() => onRepackage({ improve: true })} className={link}>
              Improve it
            </button>
            : Claude treats that title as the version to beat.
          </p>
        </div>
      )}
      {idea.skipped !== null && idea.titles.length === 0 && (
        <div className={band}>
          <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-amber-100/90">
            <TriangleAlert size={13} strokeWidth={1.9} /> Skipped
          </p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-amber-100/55">
            {idea.skipped}{" "}
            <button type="button" disabled={off} onClick={() => onRepackage({})} className={link}>
              Try again
            </button>
          </p>
        </div>
      )}
      {run !== null && (run.state === "failed" || run.state === "stopped") && (
        <p className="shrink-0 border-b border-red-500/15 bg-red-500/[0.04] px-5 py-2 text-[12.5px] leading-relaxed text-red-200/75">
          {run.state === "stopped" ? "Stopped" : "Claude stopped short"}: {run.error}{" "}
          <button type="button" disabled={off} onClick={() => onRepackage({ changes: run.what === "repackage" && idea.changes !== null && idea.card !== null })} className="underline underline-offset-2 disabled:opacity-40">
            Repackage again
          </button>
        </p>
      )}
    </>
  );
}

/** The reviewers' comments on the card, while it waits on changes (Sphe Research's review box). */
function Changes({ page, busy, onMake }: { page: Page; busy: string | null; onMake: () => void }) {
  const { idea, place } = page;
  if (idea.card === null || !(place?.changes || (idea.changes?.comments.length ?? 0) > 0)) return null;
  const comments = idea.changes?.comments ?? [];
  return (
    <div className="mt-6 rounded-xl border border-amber-300/15 bg-amber-300/[0.03] p-4" aria-label="Changes requested">
      <p className="text-[12.5px] font-medium text-amber-100/85">Changes requested on the card</p>
      <ul className="mt-2.5 space-y-2">
        {comments.map((comment) => (
          <li key={comment.id} className="text-[13px] leading-relaxed text-white/75">
            <span className="text-white/35">{comment.author}:</span> <span className="whitespace-pre-wrap">{comment.text}</span>
          </li>
        ))}
        {comments.length === 0 && <li className="shimmer text-[12.5px]">Reading the comments…</li>}
      </ul>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-[12px] text-white/35">Check what Claude changes, then Update the card: it gets Changes Made.</span>
        <button type="button" disabled={busy !== null || working(idea) || comments.length === 0} onClick={onMake} className={WHITE_BUTTON}>
          Make these changes
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the form (Sphe Research's thread form)

type Section = "summary" | "titles" | "guide" | "case" | "notes";

function SectionHeader({ label, section, editing, onToggle, action, hint }: { label: string; section: Section; editing: Section | null; onToggle: (section: Section | null) => void; action?: ReactNode; hint?: string }) {
  const active = editing === section;
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className={LABEL}>
        {label}
        {hint !== undefined && <span className="ml-2 text-[12px] font-normal text-white/25">{hint}</span>}
      </h3>
      <div className="flex items-center gap-1">
        {action}
        <button type="button" onClick={() => onToggle(active ? null : section)} className={QUIET_BUTTON}>
          {active ? "Done" : "Edit"}
        </button>
      </div>
    </div>
  );
}

function CaseForm({ page, onChange, busy, onRegenerate, onUploaded }: { page: Page; onChange: (patch: IdeaChange) => Promise<unknown>; busy: boolean; onRegenerate: () => void; onUploaded: (idea: Idea) => void }) {
  const { idea } = page;
  const [editing, setEditing] = useState<Section | null>(null);
  // What's being written in the section open for editing; saved on Done (or Enter).
  const [titles, setTitles] = useState<{ id?: string; text: string }[]>([]);
  const [text, setText] = useState("");
  const focus = useRef<number | null>(null);
  useEffect(() => {
    if (focus.current === null) return;
    document.querySelector<HTMLTextAreaElement>(`[data-idea-title="${focus.current}"]`)?.focus();
    focus.current = null;
  }, [titles.length, editing]);

  const value = (section: Section) => (section === "summary" ? idea.summary : section === "guide" ? idea.thumbnailGuide : section === "notes" ? idea.notes : "");
  /** Opens a section (saving the one open before), or closes it saving what was written. */
  const toggle = (next: Section | null) => {
    if (editing !== null) save(editing);
    if (next === "titles") setTitles(idea.titles.map((one) => ({ id: one.id, text: one.text })));
    else if (next !== null) setText(value(next));
    setEditing(next);
  };
  const save = (section: Section) => {
    if (section === "titles") {
      const next = titles.filter((one) => one.text.trim() !== "");
      const same = next.length === idea.titles.length && next.every((one, index) => one.text.trim() === idea.titles[index]?.text && one.id === idea.titles[index]?.id);
      if (!same) void onChange({ titles: next.map((one) => (one.id !== undefined ? { id: one.id, text: one.text.trim() } : { text: one.text.trim() })) });
      return;
    }
    if (section === "case") return;
    if (text.trim() === value(section).trim()) return;
    const patch: IdeaChange = section === "summary" ? { summary: text } : section === "guide" ? { thumbnailGuide: text } : { notes: text };
    void onChange(patch);
  };
  const done = () => toggle(null);
  const main = idea.main ?? idea.titles[0]?.text ?? null;
  const titleRows = editing === "titles" ? titles : idea.titles.map((one) => ({ id: one.id, text: one.text }));
  const byOf = new Map(idea.titles.map((one) => [one.id, one.by]));

  return (
    <div className="flex flex-col gap-8">
      {(idea.summary !== "" || editing === "summary") && (
        <section>
          <SectionHeader label="Summary" section="summary" editing={editing} onToggle={toggle} />
          {editing === "summary" ? (
            <textarea autoFocus value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => saveOnEnter(event, done)} rows={2} placeholder="One short factual sentence" aria-label="Summary" className={cx(FIELD, "mt-2 min-h-[3.25rem] resize-y")} />
          ) : (
            <p className="mt-2 text-[14.5px] leading-relaxed text-white/80">{idea.summary}</p>
          )}
        </section>
      )}

      <section>
        <SectionHeader
          label="Titles"
          section="titles"
          editing={editing}
          onToggle={toggle}
          action={
            <button type="button" onClick={onRegenerate} disabled={busy} className="rounded-lg px-2 py-1 text-[12px] text-white/55 transition-colors hover:bg-white/[0.05] hover:text-white disabled:opacity-40">
              Regenerate titles
            </button>
          }
        />
        <ul className={cx("mt-2 flex flex-col", editing === "titles" ? "gap-2" : "gap-1")}>
          {titleRows.length > 0 ? (
            titleRows.map((title, index) => {
              const isMain = main !== null && title.text.trim() === main;
              const key = title.id ?? `new-${index}`;
              const by = title.id === undefined ? undefined : byOf.get(title.id);
              return (
                <li key={key} aria-label={`Title ${index + 1}`} className="flex items-start gap-2">
                  <span className={cx("w-4 shrink-0 text-center text-[13px] leading-relaxed text-white/25", editing === "titles" && "mt-2.5")}>{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    {editing === "titles" ? (
                      <textarea
                        data-idea-title={index}
                        value={title.text}
                        onChange={(event) => {
                          const next = event.target.value.replace(/\r?\n/g, " ");
                          setTitles((last) => last.map((one, at) => (at === index ? { ...one, text: next } : one)));
                        }}
                        onKeyDown={(event) => saveOnEnter(event, done)}
                        placeholder="Title option"
                        rows={1}
                        className={cx(isMain ? `${FIELD_SHAPE} border-amber-300/55` : FIELD, "resize-none overflow-hidden break-words whitespace-pre-wrap [field-sizing:content]")}
                      />
                    ) : (
                      <p className={cx("text-[14.5px] leading-relaxed break-words", isMain ? "font-medium text-amber-200/90" : "text-white/85")}>{title.text}</p>
                    )}
                    {by !== undefined && by !== "claude" && <p className="mt-0.5 text-[11.5px] text-white/30">Written by {by}</p>}
                  </div>
                  {editing === "titles" && (
                    <IconButton
                      label={`Title ${index + 1} options`}
                      className="mt-1 size-8 shrink-0"
                      onClick={(event) =>
                        toggleMenu(
                          event.currentTarget,
                          [
                            {
                              label: isMain ? "Main title" : "Use as main title",
                              icon: <Check size={14} />,
                              disabled: isMain || title.text.trim() === "",
                              onSelect: () => {
                                // The titles as written and the main one, in one change.
                                const chosen = title.text.trim();
                                const next = titles.filter((one) => one.text.trim() !== "").map((one) => (one.id !== undefined ? { id: one.id, text: one.text.trim() } : { text: one.text.trim() }));
                                setEditing(null);
                                void onChange({ titles: next, main: chosen });
                              },
                            },
                            { label: "Delete", icon: <Trash2 size={14} />, danger: true, onSelect: () => setTitles((last) => last.filter((_, at) => at !== index)) },
                          ],
                          { width: 190 },
                        )
                      }
                    >
                      <MoreHorizontal size={15} />
                    </IconButton>
                  )}
                </li>
              );
            })
          ) : (
            <li className="text-[14.5px] text-white/25">{busy ? <span className="shimmer">Claude is writing the titles…</span> : "No titles yet"}</li>
          )}
        </ul>
        <button
          type="button"
          onClick={() => {
            if (editing !== "titles") {
              setTitles([...idea.titles.map((one) => ({ id: one.id, text: one.text })), { text: "" }]);
              if (editing !== null) save(editing);
              setEditing("titles");
              focus.current = idea.titles.length;
            } else {
              focus.current = titles.length;
              setTitles((last) => [...last, { text: "" }]);
            }
          }}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[12.5px] text-white/40 transition-colors hover:bg-white/[0.04] hover:text-white/80"
        >
          Add title
        </button>
      </section>

      <Guide idea={idea} editing={editing} text={text} setText={setText} onToggle={toggle} done={done} onChange={onChange} onUploaded={onUploaded} />

      <section>
        <SectionHeader label="Case" section="case" editing={editing} onToggle={toggle} />
        <div className="mt-2 flex flex-col gap-1">
          {idea.sources.map((source) => (
            <a key={source.url} href={source.url} target="_blank" rel="noreferrer" aria-label="Case link" className="block break-all text-[14.5px] text-amber-200/85 underline decoration-amber-300/30 underline-offset-2 transition-colors hover:decoration-amber-300/70">
              {source.url}
            </a>
          ))}
          {idea.sources.length === 0 && <p className="text-[14.5px] text-white/25">No case link</p>}
          {editing === "case" && <p className="text-[12px] text-white/30">The case is the video or article the idea was made from: start a new idea for another.</p>}
        </div>
      </section>

      <Footage idea={idea} onChange={onChange} />

      {/* Notes (idea.notes, the team's, never on the card) are hidden for now: Sphe, Nov 2, "remove this for now". */}
    </div>
  );
}

// ---------------------------------------------------------------- the footage

/** Whether a script can start from the idea: its footage, or the case's own video. */
const canStartScript = (idea: Idea) => idea.footage.length > 0 || idea.sources.some((one) => one.kind === "youtube");

/** New project on Home, opened with the idea's main title, its kind and its footage (the case's own video when none of it is listed). */
function startScript(idea: Idea): void {
  // A bodycam repost is its own footage: the case's video goes in when no footage of the case is listed.
  const own = idea.footage.some((one) => !one.reuse) ? [] : idea.sources.flatMap((one) => (one.kind === "youtube" ? [one.url] : []));
  const text = [...own, ...idea.footage.map(footageLine)].join("\n");
  sessionStorage.setItem("edit.newProject", JSON.stringify({ title: idea.main ?? idea.titles[0]?.text ?? "", text, style: idea.workspace === "bodycam" ? "bodycam" : "interrogation" }));
  navigate("/");
}

const FOOTAGE_ICON = { youtube: SquarePlay, drive: FolderOpen, doc: FileText } as const;
const FOOTAGE_KIND = { youtube: "YouTube", drive: "Google Drive", doc: "Script Doc" } as const;

/**
 * What the script is written from, as New project takes it (Sphe, Nov 2: "we
 * can allow for many options added each item a footage link and we detect
 * youtube and drive. so we are able to mark a case as reuse etc. basically how
 * things we would expect for us to start a script"): links added one or many
 * at a time, each a YouTube or Drive video (or a script's Doc, a reuse), named
 * as Script mode reads it, ticked Reuse for a case the channel already
 * covered. Start the script opens New project with them and the main title.
 */
function Footage({ idea, onChange }: { idea: Idea; onChange: (patch: IdeaChange) => Promise<unknown> }) {
  const [adding, setAdding] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // The server names each link as Script mode reads it once it's saved (YouTube's details take ~20 s); the page shows it on its next look.
  const save = (footage: IdeaFootage[]) => onChange({ footage: footage.map(({ id, url, reuse, title }) => ({ id, url, reuse, ...(title !== undefined ? { title } : {}) })) });
  const add = async (text: string) => {
    const { footage, refused } = footageIn(text, () => Math.random().toString(36).slice(2, 10));
    setProblem(refused.length > 0 ? `${refused[0]} isn't a YouTube or Google Drive link.` : null);
    const fresh = footage.filter((one) => !idea.footage.some((had) => had.url === one.url));
    if (fresh.length === 0) return;
    setAdding("");
    await save([...idea.footage, ...fresh]);
  };
  return (
    <section>
      <h3 className={LABEL}>Footage</h3>
      {idea.footage.length > 0 && (
        <ul className="mt-2 flex flex-col overflow-hidden rounded-xl border border-white/[0.06]">
          {idea.footage.map((one) => {
            const Icon = FOOTAGE_ICON[one.kind];
            const checking = one.title === undefined && one.problem === undefined;
            const broken = one.problem !== undefined && !one.reuse;
            return (
              <li key={one.id} className="group/footage flex items-center gap-3 border-t border-white/[0.05] px-3 py-2.5 transition-colors first:border-t-0 hover:bg-white/[0.02]">
                <span className={cx("grid size-8 shrink-0 place-items-center rounded-lg", one.kind === "youtube" ? "bg-red-400/10 text-red-300/80" : "bg-white/[0.05] text-white/50")}>
                  <Icon size={15} strokeWidth={1.8} aria-label={FOOTAGE_KIND[one.kind]} />
                </span>
                <span className="min-w-0 flex-1">
                  <a href={one.url} target="_blank" rel="noreferrer" title={one.url} className="block truncate text-[14px] leading-snug text-white/85 transition-colors hover:text-white">
                    {one.title ?? one.url}
                  </a>
                  <span className={cx("block truncate text-[11.5px] leading-snug", broken ? "text-red-200/70" : checking ? "shimmer text-white/30" : "text-white/30")}>
                    {broken ? one.problem : checking ? "Checking…" : FOOTAGE_KIND[one.kind]}
                  </span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={one.reuse}
                  disabled={one.kind === "doc"}
                  title={one.kind === "doc" ? "A script's Doc is always reused as it was written" : one.reuse ? "Reused as it was: not written again" : "A case the channel already covered? Reuse it as it was"}
                  onClick={() => void save(idea.footage.map((other) => (other.id === one.id ? { ...other, reuse: !other.reuse } : other)))}
                  className={cx(
                    "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-[background,border-color,color] duration-150 disabled:cursor-default",
                    one.reuse ? "border-sky-300/25 bg-sky-300/[0.12] text-sky-100" : "border-white/[0.08] text-white/40 hover:border-white/[0.16] hover:bg-white/[0.04] hover:text-white/75",
                  )}
                >
                  {one.reuse ? <Check size={12} strokeWidth={2.4} /> : <RotateCw size={11} strokeWidth={2.1} />}
                  Reuse
                </button>
                <button type="button" aria-label="Remove this footage" title="Remove" onClick={() => void save(idea.footage.filter((other) => other.id !== one.id))} className="-mr-1 grid size-7 shrink-0 place-items-center rounded-md text-white/25 opacity-0 transition-opacity group-hover/footage:opacity-100 hover:bg-white/[0.06] hover:text-white/70 focus-visible:opacity-100">
                  <X size={13} strokeWidth={2} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <input
        value={adding}
        onChange={(event) => setAdding(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void add(adding);
        }}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text/plain");
          if (!/https?:\/\//.test(pasted)) return;
          event.preventDefault();
          void add(pasted);
        }}
        placeholder={idea.footage.length === 0 ? "Paste the footage: YouTube or Drive links, one or many" : "Add footage"}
        aria-label="Add footage"
        className={cx(FIELD, "mt-2 text-[13.5px]")}
      />
      {problem !== null && <p className="mt-1.5 text-[12px] text-red-200/70">{problem}</p>}
    </section>
  );
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function imageFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const files = [...data.files].filter((file) => IMAGE_TYPES.includes(file.type));
  if (files.length > 0) return files;
  return [...data.items].flatMap((item) => (item.kind === "file" && IMAGE_TYPES.includes(item.type) ? [item.getAsFile()].filter((one): one is File => one !== null) : []));
}

const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

function Guide({
  idea,
  editing,
  text,
  setText,
  onToggle,
  done,
  onChange,
  onUploaded,
}: {
  idea: Idea;
  editing: Section | null;
  text: string;
  setText: (value: string) => void;
  onToggle: (section: Section | null) => void;
  done: () => void;
  onChange: (patch: IdeaChange) => Promise<unknown>;
  onUploaded: (idea: Idea) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [over, setOver] = useState(false);
  const toastError = useEditor((state) => state.toastError);
  const order = useMemo(() => idea.images.map((one) => one.id), [idea.images]);
  const upload = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      setUploading(true);
      void (async () => {
        try {
          for (const one of files) onUploaded(await ideasApi.upload(idea.id, one));
        } catch (error) {
          toastError(error, "add the picture");
        } finally {
          setUploading(false);
          if (file.current) file.current.value = "";
        }
      })();
    },
    [idea.id, onUploaded, toastError],
  );
  // A picture pasted anywhere on the page (not into a field) is added, as Sphe Research's form does.
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (typing(event.target)) return;
      const files = imageFiles(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      upload(files);
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [upload]);
  const move = (id: string, by: number) => {
    const at = order.indexOf(id);
    const next = [...order];
    next.splice(at, 1);
    next.splice(at + by, 0, id);
    void onChange({ images: next });
  };
  const drop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setOver(false);
    upload(imageFiles(event.dataTransfer));
  };
  // One short label, as the guide names the picture (Sphe, Nov 2: "just have a label like "Base" on the bottom left corner and thats about it"):
  // "First frame", "Base", "Reference", "Original thumbnail"; the person's own pictures and the card's have none.
  const caption = (image: IdeaImage): string | null => {
    if (image.from === "frame") {
      const place = image.name.split(" · ")[0] ?? "frame";
      return place.charAt(0).toUpperCase() + place.slice(1);
    }
    if (image.from === "base") return image.name === "reference" ? "Reference" : "Base";
    if (image.from === "video") return "Original thumbnail";
    return null;
  };
  // Where a picture comes from, to open: a frame at its second of the video, the approved card, the case's video.
  const video = idea.sources.find((one) => one.kind === "youtube");
  const linkOf = (image: IdeaImage): string | null => {
    if (image.from === "frame" && video !== undefined) return `${video.url}${video.url.includes("?") ? "&" : "?"}t=${Math.floor(image.frame?.at ?? 0)}s`;
    if (image.from === "base") return idea.base?.cardUrl ?? null;
    if (image.from === "video") return video?.url ?? null;
    return null;
  };
  return (
    <section>
      <SectionHeader label="Thumbnail guide" section="guide" editing={editing} onToggle={onToggle} />
      {editing === "guide" ? (
        <textarea autoFocus value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => saveOnEnter(event, done)} rows={1} placeholder="What the thumbnail should show" aria-label="Thumbnail guide" className={cx(FIELD, "mt-2 resize-none overflow-hidden [field-sizing:content]")} />
      ) : (
        <p aria-label="Thumbnail guide" className="mt-2 text-[14.5px] leading-relaxed whitespace-pre-wrap text-white/80">
          {idea.thumbnailGuide.trim() || <span className="text-white/25">No thumbnail guide</span>}
        </p>
      )}
      {idea.guideBy !== "claude" && idea.thumbnailGuide !== "" && <p className="mt-1 text-[11.5px] text-white/30">Written by {idea.guideBy}: a fresh run keeps it.</p>}

      <div className="mt-3 flex flex-col gap-3">
        {idea.images.map((image, index) => {
          const label = caption(image);
          const link = linkOf(image);
          return (
            <div key={image.id} className="group/image relative">
              <img src={imageUrl(idea.id, image.id)} alt={image.name} loading="lazy" className="max-h-[70vh] w-full rounded-xl border border-white/[0.06] object-contain" />
              {label !== null && <span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] text-white/75 backdrop-blur">{label}</span>}
              <button
                type="button"
                aria-label="Picture options"
                title="Picture options"
                onClick={(event) =>
                  toggleMenu(
                    event.currentTarget,
                    [
                      ...(link !== null ? [{ label: "Open link", icon: <ExternalLink size={14} />, onSelect: () => window.open(link, "_blank", "noopener,noreferrer") }] : []),
                      ...(index > 0 ? [{ label: "Move up", icon: <ArrowUp size={14} />, onSelect: () => move(image.id, -1) }] : []),
                      ...(index < idea.images.length - 1 ? [{ label: "Move down", icon: <ArrowDown size={14} />, onSelect: () => move(image.id, 1) }] : []),
                      { label: "Delete", icon: <Trash2 size={14} />, danger: true, onSelect: () => void onChange({ images: order.filter((one) => one !== image.id) }) },
                    ],
                    { width: 180 },
                  )
                }
                className="absolute top-2 right-2 grid size-8 place-items-center rounded-lg bg-black/60 text-white/70 opacity-0 backdrop-blur transition-[opacity,color] group-hover/image:opacity-100 hover:text-white focus-visible:opacity-100"
              >
                <MoreHorizontal size={15} />
              </button>
            </div>
          );
        })}
      </div>

      {idea.images.length < 8 && (
        <div className="mt-3">
          <p className={LABEL}>Add reference image</p>
          <input ref={file} type="file" accept={IMAGE_TYPES.join(",")} multiple hidden onChange={(event) => upload([...(event.target.files ?? [])])} />
          <button
            type="button"
            aria-label="Reference image dropzone"
            disabled={uploading}
            onClick={() => file.current?.click()}
            onDragEnter={(event) => {
              if (![...event.dataTransfer.types].includes("Files")) return;
              event.preventDefault();
              setOver(true);
            }}
            onDragOver={(event) => {
              if (![...event.dataTransfer.types].includes("Files")) return;
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={drop}
            className={cx(
              "mt-2 flex min-h-[4.75rem] w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-4 py-3 text-center transition-colors disabled:opacity-50",
              over ? "border-white/35 bg-white/[0.05] text-white/70" : "border-white/[0.12] bg-white/[0.02] text-white/35 hover:border-white/22 hover:text-white/55",
            )}
          >
            <ImageIcon size={16} strokeWidth={1.8} />
            <span className="text-[12.5px] leading-relaxed">{uploading ? "Uploading…" : "Click to browse, drop an image, or paste"}</span>
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- the chat (the editor's own)

function Chat({ id, idea, onAsked }: { id: string; idea: Idea; onAsked: () => void }) {
  const toastError = useEditor((state) => state.toastError);
  const running = working(idea);
  const entries = conversationEntries(idea.chat, idea.createdAt, running ? idea.run : null, (turn) => (turn.images ?? []).map((image) => ({ name: image.name, kind: "image" as const, url: chatImageUrl(idea.id, image.id) })));
  // A message shows the moment it's sent; what was there when the page opened doesn't animate in.
  const sent = useSentNow(entries);
  const { turns, known } = useChatTurns(id, sent.entries, running || sent.sending);
  // Its own steps say what it's at ("Reading the captions"); a plain "Claude is working" is left to the chat's thinking words.
  const step = idea.run?.step !== undefined && !/^(Claude is working|Waiting for a turn)$/.test(idea.run.step) ? idea.run.step : undefined;
  const other = running && idea.run !== null && idea.run.tools === undefined && idea.run.said === undefined ? `On ${idea.run.holder}` : undefined;
  // Pictures attached to a message are kept beside the idea's own, not among its eight.
  const files = useMemo(
    () => ({
      accept: picturesOnly,
      upload: async (file: File, progress: (loaded: number) => void, signal: AbortSignal) =>
        ((await postFile(`/api/ideas/${encodeURIComponent(id)}/chat-images?name=${encodeURIComponent(file.name)}`, file, progress, signal, { "content-type": file.type })) as { image: IdeaImage }).image,
    }),
    [id],
  );
  return (
    <ChatShell
      resetKey={id}
      footer={
        <ChatComposer
          running={running}
          disabled={false}
          modelName="Opus 5.5"
          placeholder="Ask for another angle, or a change…"
          draft={`ideas.chat-draft.${id}`}
          chat={`idea:${id}`}
          files={files}
          onSend={(message, attached) => {
            sent.hold(message, attached.map((one) => ({ name: one.name, kind: one.kind, url: one.preview })));
            void ideasApi.chat(id, message, attached.map((one) => one.landed as IdeaImage)).then(onAsked, (error: unknown) => {
              sent.drop();
              toastError(error, "ask Claude");
            });
          }}
          onStop={() => void ideasApi.stop(id).then(onAsked, (error: unknown) => toastError(error, "stop it"))}
        />
      }
    >
      {sent.entries.length === 0 ? (
        <Empty title="Ask for a change" detail="Another angle, punchier titles, one more title, a different place in the thumbnail. Claude changes the idea as you watch." />
      ) : (
        <ChatTurns turns={turns} known={known} thinking={running ? (step ?? other) : undefined} />
      )}
    </ChatShell>
  );
}

// ---------------------------------------------------------------- sending

/** Which lane the idea goes to (remembered on this Mac), checked on the board as it's sent. */
function SendDialog({ open, idea, onClose, onSent }: { open: boolean; idea: Idea; onClose: () => void; onSent: () => void }) {
  const [lanes, setLanes] = useState<{ key: string; name: string }[]>([]);
  const [lane, setLane] = useState(() => localStorage.getItem("ideas.lane") ?? "sphe");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [anyway, setAnyway] = useState(false);
  const toast = useEditor((state) => state.toast);
  useEffect(() => {
    if (!open) return;
    setProblem(null);
    setAnyway(false);
    void ideasApi.home().then((home) => {
      // This idea's board's lanes; a lane remembered from the other board falls back to this one's first.
      const own = home.lanes.filter((one) => one.workspace === idea.workspace);
      setLanes(own);
      setLane((now) => (own.length === 0 || own.some((one) => one.key === now) ? now : own[0]!.key));
    }, () => {});
  }, [open, idea.workspace]);
  const send = () => {
    setBusy(true);
    setProblem(null);
    localStorage.setItem("ideas.lane", lane);
    ideasApi
      .send(idea.id, lane, anyway)
      .then(({ idea: sent }) => {
        toast(`Sent to ${sent.card?.list ?? "the board"}.`, "info");
        onSent();
        onClose();
      })
      .catch((error: unknown) => setProblem((error as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <Modal open={open} onClose={() => !busy && onClose()} width={460}>
      <div className="p-6">
        <DialogTitle
          title="Send to Trello"
          detail={`A card at the top of the lane on the ${idea.workspace === "bodycam" ? "Raw Channels" : "Interrogation"} board, named “${idea.main ?? idea.titles[0]?.text ?? ""}”: its titles, the thumbnail guide and ${idea.images.length === 1 ? "its picture" : `its ${idea.images.length} pictures`} (the first is the cover), and the case.`}
        />
        <div className="mt-4 space-y-1.5">
          {(lanes.length > 0 ? lanes : [{ key: lane, name: "…" }]).map((one) => (
            <label key={one.key} className={cx("flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-[13px]", lane === one.key ? "border-muted bg-raised" : "border-line hover:bg-hover")}>
              <input type="radio" name="lane" checked={lane === one.key} onChange={() => setLane(one.key)} className="accent-[var(--color-primary)]" />
              {one.name}
            </label>
          ))}
        </div>
        {idea.duplicate !== null && (
          <label className="mt-3 flex items-start gap-2 rounded-lg border border-[#ffb02e40] bg-warning-soft px-3 py-2 text-[12px]">
            <input type="checkbox" checked={anyway} onChange={(event) => setAnyway(event.target.checked)} className="mt-0.5" />
            <span>
              It's already on the board as “{idea.duplicate.name}” ({idea.duplicate.list || "archived"}). Send a second card for it anyway.
            </span>
          </label>
        )}
        {problem !== null && <p className="mt-3 text-[12px] text-danger">{problem}</p>}
        <DialogActions>
          <Button variant="subtle" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={send} busy={busy} disabled={lanes.length === 0 || (idea.duplicate !== null && !anyway)}>
            <Send size={14} /> Send
          </Button>
        </DialogActions>
      </div>
    </Modal>
  );
}
