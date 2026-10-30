// The idea page (/ideas/<id>, Oct 31 2026): the case, its titles (the
// starred one names the card), the thumbnail guide and its pictures, the
// summary and the footage folder, beside the conversation with Claude; one
// main action: send it to the board, or update its card once the reviewers'
// changes are made. Sphe Research's case (Titles, Thumbnail Guide, Case) and
// Repack's thread (a main title, a base thumbnail), on Edit's page.

import { ArrowLeft, ArrowUp, Check, CircleAlert, ExternalLink, FileText, ImagePlus, MessageSquare, RotateCw, Send, Square, Star, Trash2, TriangleAlert, X } from "lucide-react";
import { type ClipboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { AppMenu } from "../components/AppMenu";
import { Button, cx, IconButton, Modal, Spinner } from "../components/ui";
import { ideasApi, imageUrl, viewsLabel, working, type Idea, type IdeaChange, type IdeaPage as Page, type IdeaTurn } from "../lib/ideas";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { ago } from "../lib/time";

const FIELD = "w-full rounded-lg border border-line-strong bg-bg px-3 text-[13px] text-fg outline-none placeholder:text-faint focus:border-muted";
const SECTION = "mt-8";
const HEADING = "flex items-baseline gap-2 text-[13px] font-semibold";
const HINT = "text-[12px] font-normal text-faint";

/** Home, on its Ideas tab. */
export function backToIdeas(): void {
  localStorage.setItem("edit.home.view", "ideas");
  navigate("/ideas");
}

export function IdeaScreen({ id }: { id: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
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
  const run = page?.idea.run ?? null;
  const active = page !== null && working(page.idea);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, active ? 1_500 : 15_000);
    return () => clearInterval(timer);
  }, [load, active]);
  // The reviewers' comments, read fresh from the card when it's waiting on changes.
  const changesAsked = page?.place?.changes === true;
  useEffect(() => {
    if (!changesAsked) return;
    void ideasApi.comments(id).then(() => load(), () => {});
  }, [changesAsked, id, load]);

  const change = (patch: IdeaChange) =>
    ideasApi
      .change(id, patch)
      .then(({ idea }) => setPage((last) => (last === null ? last : { ...last, idea })))
      .then(() => load())
      .catch((error: unknown) => toastError(error, "save that"));
  const act = (what: string, work: () => Promise<unknown>) => {
    setBusy(what);
    return work()
      .then(() => load())
      .catch((error: unknown) => toastError(error, what))
      .finally(() => setBusy(null));
  };

  if (page === null)
    return (
      <div className="flex h-full flex-col">
        <TopBar title={missing ?? ""} />
        <div className="flex flex-1 items-center justify-center text-muted">{missing ?? <Spinner size={20} />}</div>
      </div>
    );
  const { idea, place } = page;
  const sent = idea.status === "sent" && idea.card !== null;
  const asked = changesAsked || (idea.changes !== null && idea.changes.comments.length > 0);
  const missingParts = [idea.titles.length === 0 ? "a title" : "", idea.thumbnailGuide.trim() === "" ? "a thumbnail guide" : "", idea.sources.length === 0 ? "the case link" : ""].filter(Boolean);
  const main = sent ? (
    <Button variant={asked ? "primary" : "subtle"} disabled={busy !== null || active || missingParts.length > 0} onClick={() => void act("update the card", () => ideasApi.updateCard(id).then(({ labelled }) => toast(labelled ? "The card is updated and labelled Changes Made." : "The card is updated.", "info")))}>
      {busy === "update the card" ? <Spinner size={13} /> : <RotateCw size={14} />} Update the card
    </Button>
  ) : (
    <Button variant="primary" disabled={busy !== null || active || missingParts.length > 0} title={missingParts.length > 0 ? `Still needs ${missingParts.join(", ")}` : undefined} onClick={() => setSending(true)}>
      <Send size={14} /> Send to Trello
    </Button>
  );
  return (
    <div className="flex h-full flex-col">
      <TopBar title={idea.main ?? idea.titles[0]?.text ?? idea.sources[0]?.title ?? "New idea"}>
        <StatusChip page={page} />
        <div className="ml-auto flex items-center gap-1.5">
          {idea.card !== null && (
            <a href={idea.card.url} target="_blank" rel="noreferrer" className="flex h-[34px] items-center gap-1.5 rounded-lg px-3 text-[13px] text-secondary hover:bg-hover hover:text-fg">
              <ExternalLink size={14} /> {place?.list || idea.card.list}
            </a>
          )}
          {!sent && (
            <Button variant="ghost" disabled={busy !== null || (idea.status === "draft" && missingParts.length > 0)} onClick={() => void change({ status: idea.status === "ready" ? "draft" : "ready" })} title={idea.status === "draft" ? "Checked and ready to go to the board" : undefined}>
              {idea.status === "ready" ? "Back to draft" : (
                <>
                  <Check size={14} /> Mark ready
                </>
              )}
            </Button>
          )}
          {place?.approved && idea.sources.some((one) => one.kind === "youtube") && (
            <Button variant="subtle" onClick={() => startScript(idea)} title="New project: Write a script, from this idea's case">
              <FileText size={14} /> Write the script
            </Button>
          )}
          {main}
          <AppMenu />
        </div>
      </TopBar>
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[760px] px-8 pt-6 pb-24">
            <Banners page={page} busy={busy} onRepackage={(options) => void act("repackage it", () => ideasApi.repackage(id, options))} />
            <Sources idea={idea} />
            <Titles page={page} onChange={change} />
            <Guide page={page} onChange={change} onUploaded={(next) => setPage((last) => (last === null ? last : { ...last, idea: next }))} />
            {(idea.wantsSummary || idea.summary !== "") && (
              <section className={SECTION}>
                <div className={HEADING}>
                  Summary <span className={HINT}>one sentence, 30 words at most</span>
                </div>
                <Saved value={idea.summary} rows={2} placeholder="What happened, in one sentence" onSave={(summary) => change({ summary })} />
              </section>
            )}
            <section className={SECTION}>
              <div className={HEADING}>
                Footage <span className={HINT}>the case's Google Drive folder, when someone has it</span>
              </div>
              <Saved value={idea.footage} placeholder="https://drive.google.com/drive/folders/…" onSave={(footage) => change({ footage })} line />
            </section>
            <section className={SECTION}>
              <div className={HEADING}>
                Notes <span className={HINT}>for the team here; never on the card</span>
              </div>
              <Saved value={idea.notes} rows={3} placeholder="Anything worth remembering about this case" onSave={(notes) => change({ notes })} />
            </section>
            <Again idea={idea} busy={busy !== null || active} onRepackage={(steer) => void act("repackage it", () => ideasApi.repackage(id, { steer, improve: idea.duplicate !== null && !sent }))} onSummary={() => void change({ wantsSummary: !idea.wantsSummary })} />
            <section className="mt-12 border-t border-line pt-6">
              <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => void act("delete the idea", () => ideasApi.remove(id).then(backToIdeas))}>
                <Trash2 size={13} /> Delete this idea
              </Button>
              <span className="ml-3 text-[12px] text-faint">{idea.card !== null ? "Its card stays on the board." : "It goes for everyone."}</span>
            </section>
          </div>
        </main>
        <Chat id={id} idea={idea} run={run} onAsked={() => void load()} />
      </div>
      <SendDialog open={sending} idea={idea} onClose={() => setSending(false)} onSent={() => void load()} />
    </div>
  );
}

/** New project, Write a script, with the idea's main title and its case's links (Interrogation). */
function startScript(idea: Idea): void {
  const links = idea.sources.map((one) => one.url);
  if (idea.footage !== "") links.push(idea.footage);
  sessionStorage.setItem("edit.newProject", JSON.stringify({ title: idea.main ?? idea.titles[0]?.text ?? "", text: links.join("\n"), style: "interrogation" }));
  navigate("/");
}

function TopBar({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-4">
      <button onClick={backToIdeas} className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-muted hover:bg-hover hover:text-fg">
        <ArrowLeft size={15} /> Ideas
      </button>
      <span className="min-w-0 truncate text-[14px] font-medium" title={title}>
        {title}
      </span>
      {children}
    </header>
  );
}

const CHIP = "inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full bg-raised px-2.5 text-[12px] leading-none font-medium whitespace-nowrap";

function StatusChip({ page }: { page: Page }) {
  const { idea, place } = page;
  if (working(idea))
    return (
      <span className={cx(CHIP, "text-info")}>
        <Spinner size={12} /> {idea.run?.step ?? "Working"}
      </span>
    );
  if (place?.changes)
    return (
      <span className={cx(CHIP, "text-warning")}>
        <MessageSquare size={12} /> Changes requested
      </span>
    );
  if (idea.status === "sent") return <span className={cx(CHIP, place?.approved ? "text-success" : "text-fg")}>{place?.approved ? "Approved" : "On the board"}</span>;
  return <span className={cx(CHIP, idea.status === "ready" ? "text-success" : "text-secondary")}>{idea.status === "ready" ? "Ready" : "Draft"}</span>;
}

/** What needs a decision: the case already on the board, a run that stopped, the reviewers' changes. */
function Banners({ page, busy, onRepackage }: { page: Page; busy: string | null; onRepackage: (options: { improve?: boolean; changes?: boolean }) => void }) {
  const { idea, place } = page;
  const run = idea.run;
  const off = busy !== null || working(idea);
  const banners: ReactNode[] = [];
  if (idea.duplicate !== null && idea.card === null)
    banners.push(
      <Banner key="dup" tone="warning" icon={<CircleAlert size={15} />} title={`Already on the board as “${idea.duplicate.name}”`} body={`${idea.duplicate.list || "Archived"}. Improve it, and Claude treats that title as the version to beat.`}>
        <a href={idea.duplicate.url} target="_blank" rel="noreferrer">
          <Button size="sm" variant="ghost">
            Open card <ExternalLink size={12} />
          </Button>
        </a>
        <Button size="sm" variant="subtle" disabled={off} onClick={() => onRepackage({ improve: true })}>
          Improve it
        </Button>
      </Banner>,
    );
  if (idea.skipped !== null && idea.titles.length === 0)
    banners.push(
      <Banner key="skip" tone="warning" icon={<TriangleAlert size={15} />} title="Skipped" body={idea.skipped}>
        <Button size="sm" variant="subtle" disabled={off} onClick={() => onRepackage({})}>
          Try again
        </Button>
      </Banner>,
    );
  if (run !== null && (run.state === "failed" || run.state === "stopped"))
    banners.push(
      <Banner key="run" tone="danger" icon={<TriangleAlert size={15} />} title={run.state === "stopped" ? "Stopped" : "Claude stopped short"} body={run.error ?? ""}>
        <Button size="sm" variant="subtle" disabled={off} onClick={() => onRepackage({ changes: run.what === "repackage" && idea.changes !== null && idea.card !== null })}>
          Repackage again
        </Button>
      </Banner>,
    );
  if ((place?.changes || (idea.changes?.comments.length ?? 0) > 0) && idea.card !== null)
    banners.push(
      <div key="changes" className="mt-4 rounded-xl border border-[#ffb02e40] bg-warning-soft px-4 py-3">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-warning">
          <MessageSquare size={15} /> Changes requested on the card
        </div>
        <ul className="mt-2 space-y-1.5">
          {(idea.changes?.comments ?? []).map((comment) => (
            <li key={comment.id} className="text-[13px]">
              <span className="text-muted">{comment.author}:</span> <span className="whitespace-pre-wrap">{comment.text}</span>
            </li>
          ))}
          {(idea.changes?.comments.length ?? 0) === 0 && <li className="text-[12px] text-muted">Reading the comments…</li>}
        </ul>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="subtle" disabled={off || (idea.changes?.comments.length ?? 0) === 0} onClick={() => onRepackage({ changes: true })}>
            Make these changes
          </Button>
          <span className="text-[12px] text-muted">Then check them, and Update the card: it gets Changes Made.</span>
        </div>
      </div>,
    );
  return <>{banners}</>;
}

function Banner({ tone, icon, title, body, children }: { tone: "warning" | "danger"; icon: ReactNode; title: string; body: string; children?: ReactNode }) {
  return (
    <div className={cx("mt-4 flex items-start gap-3 rounded-xl border px-4 py-3", tone === "warning" ? "border-[#ffb02e40] bg-warning-soft" : "border-[#ff003340] bg-danger-soft")}>
      <span className={cx("mt-0.5", tone === "warning" ? "text-warning" : "text-danger")}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold">{title}</div>
        {body !== "" && <div className="mt-0.5 text-[12px] text-secondary">{body}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

function Sources({ idea }: { idea: Idea }) {
  return (
    <section className="mt-6">
      <div className={HEADING}>Case</div>
      <div className="mt-2 space-y-2">
        {idea.sources.map((source) => (
          <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="group flex items-center gap-3 rounded-xl border border-line p-2.5 hover:bg-panel">
            {source.kind === "youtube" && source.thumbnail !== null ? <img src={source.thumbnail} alt="" className="h-14 w-24 shrink-0 rounded-md object-cover" /> : <span className="grid h-14 w-24 shrink-0 place-items-center rounded-md bg-panel text-faint"><FileText size={16} /></span>}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium group-hover:underline group-hover:underline-offset-[3px]">{source.title || source.url}</div>
              <div className="truncate text-[12px] text-muted">
                {source.kind === "youtube"
                  ? [source.channel, viewsLabel(source.views), source.outlier !== "unknown" ? `${source.outlier} outlier` : "", source.durationSeconds !== null ? `${Math.round(source.durationSeconds / 60)} min` : ""].filter(Boolean).join(" · ")
                  : source.outlet}
              </div>
            </div>
            <ExternalLink size={14} className="mr-1 shrink-0 text-faint" />
          </a>
        ))}
      </div>
    </section>
  );
}

/** A field saved when it's left (or Enter, on a line). */
function Saved({ value, onSave, placeholder, rows = 3, line = false, className }: { value: string; onSave: (value: string) => unknown; placeholder?: string; rows?: number; line?: boolean; className?: string }) {
  const [text, setText] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(value);
  }, [value]);
  const save = () => {
    editing.current = false;
    if (text.trim() !== value.trim()) void onSave(text);
  };
  return line ? (
    <input
      value={text}
      placeholder={placeholder}
      onFocus={() => (editing.current = true)}
      onChange={(event) => setText(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
      className={cx(FIELD, "mt-2 h-[34px]", className)}
    />
  ) : (
    <textarea
      value={text}
      rows={rows}
      placeholder={placeholder}
      onFocus={() => (editing.current = true)}
      onChange={(event) => setText(event.target.value)}
      onBlur={save}
      className={cx(FIELD, "mt-2 resize-y py-2 leading-[1.5]", className)}
    />
  );
}

function Titles({ page, onChange }: { page: Page; onChange: (patch: IdeaChange) => unknown }) {
  const { idea, problems, style } = page;
  const [adding, setAdding] = useState("");
  const list = idea.titles.map((one) => ({ id: one.id, text: one.text }));
  const save = (next: { id?: string; text: string }[]) => onChange({ titles: next });
  return (
    <section className={SECTION}>
      <div className={HEADING}>
        Titles <span className={HINT}>the starred one names the card{style !== null ? ` · the team's run ${style.typicalWords[0]}–${style.typicalWords[1]} words` : ""}</span>
      </div>
      <div className="mt-2 space-y-1.5">
        {idea.titles.map((title, index) => (
          <div key={title.id}>
            <div className="group flex items-center gap-1.5">
              <IconButton label={title.text === idea.main ? "The main title: it names the card" : "Make this the main title"} active={title.text === idea.main} onClick={() => onChange({ main: title.text })}>
                <Star size={14} className={title.text === idea.main ? "fill-current text-warning" : ""} />
              </IconButton>
              <Saved line value={title.text} onSave={(text) => save(list.map((one, at) => (at === index ? { id: one.id, text } : one)))} className="mt-0 flex-1" />
              <IconButton label="Remove this title" onClick={() => save(list.filter((_, at) => at !== index))} className="opacity-0 group-hover:opacity-100">
                <X size={14} />
              </IconButton>
            </div>
            <div className="ml-9 flex gap-2 text-[11.5px]">
              {problems[title.id] !== undefined && <span className="text-warning">This title {problems[title.id]}.</span>}
              {title.by !== "claude" && <span className="text-faint">Written by {title.by}</span>}
            </div>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <span className="size-7 shrink-0" />
          <input
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || adding.trim() === "") return;
              void save([...list, { text: adding.trim() }]);
              setAdding("");
            }}
            placeholder={idea.titles.length === 0 ? "Write a title, or let Claude" : "Add a title"}
            className={cx(FIELD, "h-[34px] flex-1 border-dashed")}
          />
        </div>
      </div>
    </section>
  );
}

function Guide({ page, onChange, onUploaded }: { page: Page; onChange: (patch: IdeaChange) => unknown; onUploaded: (idea: Idea) => void }) {
  const { idea } = page;
  const file = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const toastError = useEditor((state) => state.toastError);
  const add = (files: FileList | File[]) => {
    const picked = [...files].filter((one) => one.type.startsWith("image/"));
    if (picked.length === 0) return;
    setUploading(true);
    void (async () => {
      try {
        for (const one of picked) onUploaded(await ideasApi.upload(idea.id, one));
      } catch (error) {
        toastError(error, "add the picture");
      } finally {
        setUploading(false);
      }
    })();
  };
  const order = idea.images.map((one) => one.id);
  return (
    <section className={SECTION} onPaste={(event: ClipboardEvent) => event.clipboardData.files.length > 0 && add(event.clipboardData.files)}>
      <div className={HEADING}>
        Thumbnail guide <span className={HINT}>one lowercase note: the place, who's in the middle, at most one action</span>
      </div>
      <Saved value={idea.thumbnailGuide} rows={2} placeholder="we use the interrogation room and have the suspect in the middle" onSave={(thumbnailGuide) => onChange({ thumbnailGuide })} />
      {page.guideProblem !== null && <div className="mt-1 text-[11.5px] text-warning">The guide {page.guideProblem}.</div>}
      {idea.guideBy !== "claude" && idea.thumbnailGuide !== "" && <div className="mt-1 text-[11.5px] text-faint">Written by {idea.guideBy}: Claude keeps it on a fresh run.</div>}
      {idea.base !== null && (
        <div className="mt-2 text-[12px] text-muted">
          Base:{" "}
          <a href={idea.base.cardUrl} target="_blank" rel="noreferrer" className="text-fg underline-offset-[3px] hover:underline">
            {idea.base.title}
          </a>
          <button onClick={() => void onChange({ base: null })} className="ml-2 text-faint hover:text-fg">
            Remove
          </button>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {idea.images.map((image, index) => (
          <figure key={image.id} className="group relative w-[168px] overflow-hidden rounded-lg border border-line bg-panel">
            <img src={imageUrl(idea.id, image.id)} alt={image.name} loading="lazy" className="aspect-video w-full object-cover" />
            <figcaption className="flex items-center justify-between px-2 py-1 text-[11px] text-muted">
              <span className="truncate">{index === 0 ? "Cover" : image.from === "base" ? "Base" : image.from === "video" ? "Its thumbnail" : image.name}</span>
              <span className="flex opacity-0 group-hover:opacity-100">
                {index > 0 && (
                  <button title="Make this the cover" onClick={() => void onChange({ images: [image.id, ...order.filter((one) => one !== image.id)] })} className="px-1 hover:text-fg">
                    Cover
                  </button>
                )}
                <button title="Remove this picture" onClick={() => void onChange({ images: order.filter((one) => one !== image.id) })} className="px-1 hover:text-fg">
                  <X size={12} />
                </button>
              </span>
            </figcaption>
          </figure>
        ))}
        {idea.images.length < 8 && (
          <button onClick={() => file.current?.click()} className="flex aspect-video w-[168px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line-strong text-[12px] text-muted hover:bg-hover hover:text-fg">
            {uploading ? <Spinner size={16} /> : <ImagePlus size={16} />}
            Add a picture
            <span className="text-[11px] text-faint">or paste one here</span>
          </button>
        )}
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(event) => event.target.files && add(event.target.files)} />
      </div>
    </section>
  );
}

function Again({ idea, busy, onRepackage, onSummary }: { idea: Idea; busy: boolean; onRepackage: (steer: string) => void; onSummary: () => void }) {
  const [steer, setSteer] = useState(idea.steer);
  useEffect(() => setSteer(idea.steer), [idea.steer]);
  return (
    <section className={SECTION}>
      <div className={HEADING}>
        Repackage <span className={HINT}>fresh titles and guide; what you wrote stays</span>
      </div>
      <div className="mt-2 flex gap-2">
        <input value={steer} onChange={(event) => setSteer(event.target.value)} placeholder="An angle to pursue (optional)" className={cx(FIELD, "h-[34px] flex-1")} onKeyDown={(event) => event.key === "Enter" && !busy && onRepackage(steer)} />
        <Button variant="subtle" disabled={busy} onClick={() => onRepackage(steer)}>
          <RotateCw size={14} /> Repackage
        </Button>
      </div>
      <button onClick={onSummary} className="mt-2 text-[12px] text-muted hover:text-fg">
        {idea.wantsSummary ? "Don't write a summary" : "Write a summary too"}
      </button>
    </section>
  );
}

function Tools({ tools }: { tools: NonNullable<IdeaTurn["tools"]> }) {
  const named: Record<string, string> = { save_titles: "Titles", remove_titles: "Removed titles", set_main_title: "Main title", save_thumbnail_guide: "Thumbnail guide", save_summary: "Summary", skip_case: "Skipped", Read: "Looked at a picture" };
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {tools.map((tool, index) => (
        <span key={index} title={tool.detail} className={cx("inline-flex h-5 items-center gap-1 rounded-full bg-raised px-2 text-[11px]", tool.state === "error" ? "text-warning" : "text-muted")}>
          {tool.state === "running" ? <Spinner size={10} /> : tool.state === "error" ? <TriangleAlert size={10} /> : <Check size={10} />}
          {named[tool.name] ?? tool.name}
        </span>
      ))}
    </div>
  );
}

/** The conversation with Claude about the idea, and what it's doing now. */
function Chat({ id, idea, run, onAsked }: { id: string; idea: Idea; run: Idea["run"]; onAsked: () => void }) {
  const key = `ideas.chat-draft.${id}`;
  const [text, setText] = useState(() => localStorage.getItem(key) ?? "");
  const [sending, setSending] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const toastError = useEditor((state) => state.toastError);
  const busy = working(idea);
  useEffect(() => {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  }, [key, text]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [idea.chat.length, run?.said, run?.tools?.length]);
  const send = () => {
    const asked = text.trim();
    if (asked === "" || busy || sending) return;
    setSending(true);
    ideasApi
      .chat(id, asked)
      .then(() => {
        setText("");
        onAsked();
      })
      .catch((error: unknown) => toastError(error, "ask Claude"))
      .finally(() => setSending(false));
  };
  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-line">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-line px-4">
        <span className="text-[13px] font-semibold">Claude</span>
        {busy && (
          <Button size="sm" variant="ghost" onClick={() => void ideasApi.stop(id).then(onAsked, (error: unknown) => toastError(error, "stop it"))}>
            <Square size={11} className="fill-current" /> Stop
          </Button>
        )}
      </div>
      <div ref={log} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {idea.chat.length === 0 && !busy && <p className="text-[12px] text-muted">Ask for another angle, punchier titles, one more title, a different place in the thumbnail.</p>}
        {idea.chat.map((turn, index) => (
          <div key={index} className={turn.role === "you" ? "flex justify-end" : ""}>
            {turn.role === "you" ? (
              <div className="max-w-[85%] rounded-[12px] bg-raised px-3 py-2 text-[13px] whitespace-pre-wrap">{turn.text}</div>
            ) : (
              <div>
                <div className={cx("text-[13px] leading-[1.55] whitespace-pre-wrap", turn.failed ? "text-warning" : "text-fg")}>{turn.text}</div>
                {turn.tools !== undefined && turn.tools.length > 0 && <Tools tools={turn.tools} />}
                <div className="mt-1 text-[11px] text-faint">
                  {ago(turn.at)}
                  {turn.workedMs !== undefined ? ` · worked ${Math.max(1, Math.round(turn.workedMs / 1000))} s` : ""}
                </div>
              </div>
            )}
          </div>
        ))}
        {busy && run !== null && (
          <div>
            <div className="flex items-center gap-2 text-[12px] text-info">
              <Spinner size={12} /> {run.step ?? "Working"}
              {run.holder !== "" && <span className="text-faint">· {run.by} on {run.holder}</span>}
            </div>
            {run.said !== undefined && run.said !== "" && <div className="mt-1.5 text-[13px] leading-[1.55] whitespace-pre-wrap text-secondary">{run.said}</div>}
            {run.tools !== undefined && run.tools.length > 0 && <Tools tools={run.tools} />}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-line p-3">
        <div className="flex items-end gap-2 rounded-xl border border-line-strong bg-bg p-2 focus-within:border-muted">
          <textarea
            value={text}
            rows={2}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            placeholder={busy ? "Claude is working…" : "Ask Claude to change something"}
            className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-1 text-[13px] text-fg outline-none placeholder:text-faint"
          />
          <IconButton label="Send" disabled={busy || sending || text.trim() === ""} onClick={send} className="bg-fg text-bg hover:bg-white hover:text-bg">
            {sending ? <Spinner size={12} /> : <ArrowUp size={14} />}
          </IconButton>
        </div>
      </div>
    </aside>
  );
}

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
    void ideasApi.home().then((home) => setLanes(home.lanes), () => {});
  }, [open]);
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
      <div className="p-5">
        <h2 className="text-[15px] font-semibold">Send to Trello</h2>
        <p className="mt-1 text-[12px] text-muted">
          A card at the top of the lane on the Interrogation board, named “{idea.main ?? idea.titles[0]?.text}”: its titles, the thumbnail guide and {idea.images.length === 1 ? "its picture" : `its ${idea.images.length} pictures`} (the first is the cover), and the case.
        </p>
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
      </div>
      <div className="flex justify-end gap-2 border-t border-line bg-bg/40 px-5 py-3">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={send} disabled={busy || lanes.length === 0 || (idea.duplicate !== null && !anyway)}>
          {busy ? <Spinner size={13} /> : <Send size={14} />} Send
        </Button>
      </div>
    </Modal>
  );
}
