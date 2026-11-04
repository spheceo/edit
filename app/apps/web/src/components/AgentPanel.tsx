import { explain } from "@edit/types/problems";
import {
  ArrowLeft,
  AudioLines,
  Check,
  ChevronRight,
  CircleSlash,
  Eye,
  FileInput,
  Image,
  FileText,
  FolderOpen,
  LayoutGrid,
  ListChecks,
  MousePointerClick,
  Music,
  RotateCcw,
  ScrollText,
  Scissors,
  Share,
  SlidersHorizontal,
  Spline,
  Square,
  SquarePlus,
  Star,
  Trash2,
  Type,
  Wrench,
  ScanEye,
  Pencil,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  closeSub,
  openAgent,
  openSub,
  sendToAgent,
  stopSub,
  useClaudeSupport,
  stopAgent,
  useAgent,
  watchClaudeSupport,
  type AgentEntry,
} from "../lib/agent";
import { buildTurns, callTitle, formatWorked, groupSummary, isWorking, shortSpan, thinkingWord, type Turn } from "../lib/agentTurns";
import { useNow } from "../lib/now";
import { api, mediaUrl } from "../lib/api";
import { queued, useNotes } from "../lib/notes";
import { playhead } from "../lib/playback";
import { projectUploader } from "../lib/upload";
import { useEditor } from "../lib/store";
import { ChatComposer, SentFiles } from "./ChatComposer";
import { UserWords } from "./Quotes";
import { NoteQueue } from "./NoteQueue";
import { ProblemView } from "./ProblemView";
import { Button, cx, Modal } from "./ui";
import { ClaudeSetupCard } from "./ClaudeSetupCard";
import { ClaudeMark } from "./ClaudeMark";

export { ClaudeMark };

export function AgentPanel() {
  const sub = useAgent((state) => state.sub);
  return sub !== null ? <SubAgentPanel /> : <MainAgentPanel />;
}

/**
 * The right-hand chat, one shell for every surface (the editor, a script, an
 * idea, a thumbnail): the panel's card, a scroll that keeps to the newest
 * entry unless you've scrolled up, and the composer or whatever sits under
 * it — so what a chat gains lands in all of them at once. `bare` drops the
 * card for a chat inside another panel (a script's grid draws its own).
 */
export function ChatShell({
  children,
  footer,
  header,
  loading,
  resetKey,
  bare,
  className,
  label,
}: {
  children?: ReactNode;
  /** Under the scroll: the composer and what goes with it. */
  footer?: ReactNode;
  /** A bar above the scroll (the sub-agent's back row). */
  header?: ReactNode;
  loading?: boolean;
  /** When this changes the scroll snaps back to the tail (a new chat opened). */
  resetKey?: unknown;
  /** No card chrome: the chat lives inside a panel that draws its own. */
  bare?: boolean;
  className?: string;
  label?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Stay pinned to the newest message unless you've scrolled up; jump before
  // paint so streaming text never lurches.
  useLayoutEffect(() => {
    const node = list.current;
    if (node && stick.current) node.scrollTop = node.scrollHeight;
  });
  useLayoutEffect(() => {
    stick.current = true;
  }, [resetKey]);
  return (
    <section
      aria-label={label}
      // repack-chat: the script pages' base styles leave the chat's own alone (writer.css).
      className={cx("repack-chat flex h-full min-h-0 flex-1 flex-col overflow-hidden", !bare && "rounded-xl border border-line bg-panel", className)}
    >
      {header}
      <div
        ref={list}
        onScroll={(event) => {
          const node = event.currentTarget;
          stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {/* The scroller stays a plain block. A flex item that is also a flex column can refuse to shrink and clip the composer. This inner column is at least as tall as the scroller, so an empty chat centers, and a long transcript still grows and scrolls. */}
        <div className="flex min-h-full flex-col gap-4">{loading ? <ChatLoading /> : children}</div>
      </div>
      {footer ? <div className="shrink-0">{footer}</div> : null}
    </section>
  );
}

/** A chat's entries as turns, plus the ids already there (they don't animate in). */
/**
 * A message shown the moment it's sent, before the server's chat has it (Sphe,
 * Nov 4: "when you send a prompt it should show up instantly"): `hold` it as
 * it's sent, `drop` it if the send was refused. It goes once the chat has one
 * more message of the person's than when it was sent.
 */
export function useSentNow(entries: AgentEntry[]): { entries: AgentEntry[]; sending: boolean; hold: (text: string, attachments?: AgentEntry["attachments"]) => void; drop: () => void } {
  const asked = entries.filter((entry) => entry.kind === "user").length;
  const [pending, setPending] = useState<{ text: string; at: number; asked: number; attachments?: AgentEntry["attachments"] } | null>(null);
  const landed = pending !== null && asked > pending.asked;
  useEffect(() => {
    if (landed) setPending(null);
  }, [landed]);
  const shown = pending !== null && !landed;
  return {
    entries: shown ? [...entries, { id: `pending-${pending.at}`, kind: "user", text: pending.text, at: pending.at, updated: pending.at, ...(pending.attachments !== undefined && pending.attachments.length > 0 ? { attachments: pending.attachments } : {}) }] : entries,
    sending: shown,
    hold: (text, attachments) => setPending({ text, at: Date.now(), asked, ...(attachments !== undefined ? { attachments } : {}) }),
    drop: () => setPending(null),
  };
}

export function useChatTurns(key: unknown, entries: AgentEntry[], running: boolean): { turns: Turn[]; known: Set<string> } {
  const turns = buildTurns(entries, running);
  const known = useRef<{ key: unknown; ids: Set<string> } | null>(null);
  if (known.current?.key !== key) known.current = { key, ids: new Set(entries.map((entry) => entry.id)) };
  return { turns, known: known.current!.ids };
}

/**
 * A sub-agent's own chat (the fresh-eyes final pass), opened from its card:
 * read as the main chat reads, Back to the main thread, Stop while it works.
 */
function SubAgentPanel() {
  const sub = useAgent((state) => state.sub)!;
  const { turns, known } = useChatTurns(sub.title, sub.entries, sub.running);
  return (
    <ChatShell
      loading={!sub.loaded}
      header={
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-2">
          <Button variant="ghost" onClick={closeSub} aria-label="Back to the main thread" className="h-7 gap-1 px-2 text-[12px]">
            <ArrowLeft size={14} strokeWidth={2} /> Main thread
          </Button>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{sub.title}</span>
          {sub.running && (
            <Button variant="ghost" onClick={stopSub} className="h-7 gap-1 px-2 text-[12px]">
              <Square size={11} strokeWidth={2.4} /> Stop
            </Button>
          )}
        </div>
      }
    >
      {sub.entries.length === 0 ? <Empty title="Starting" detail="A new agent is opening the edit to watch it through." /> : <ChatTurns turns={turns} known={known} />}
    </ChatShell>
  );
}

/** A sub-agent's card in the main chat: what it is, how it's going, and the way into its own chat. */
function SubAgentCard({ entry }: { entry: AgentEntry }) {
  const state = entry.status === "running" ? "Watching the edit through…" : entry.status === "done" ? "Done" : entry.status === "stopped" ? "Stopped" : "Didn't finish";
  return (
    <button
      onClick={() => void openSub(entry)}
      className="group flex w-full items-center gap-2.5 rounded-lg border border-line bg-raised px-3 py-2 text-left transition-colors hover:bg-active"
    >
      <ScanEye size={15} strokeWidth={2} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-fg">{entry.text.split(":")[0]}</span>
        <span className={cx("block truncate text-[11.5px]", entry.status === "failed" ? "text-danger" : "text-muted")}>
          {entry.status === "failed" ? entry.text.slice(entry.text.indexOf(":") + 1).trim() : state}
        </span>
      </span>
      <ChevronRight size={14} className="shrink-0 text-faint group-hover:text-muted" />
    </button>
  );
}

function MainAgentPanel() {
  const projectId = useEditor((state) => state.project?.id);
  const { status, entries, running, loaded } = useAgent();
  // Entries already there when the chat loaded don’t animate in.
  const { turns, known } = useChatTurns(loaded ? projectId : "loading", entries, running);
  // Not ready, with the conversation already on screen: the setup card used
  // to stand in for an empty chat only, so this hid the composer and never
  // asked again (a project opened while Claude was still being checked).
  const blocked = Boolean(status && !status.ready);

  useEffect(() => {
    if (projectId) void openAgent(projectId);
  }, [projectId]);

  useEffect(() => {
    if (!blocked) return;
    return watchClaudeSupport();
  }, [blocked]);

  return (
    <ChatShell
      loading={!loaded}
      resetKey={loaded ? projectId : "loading"}
      footer={
        entries.length > 0 || !blocked ? (
          <>
            {blocked && <NotReadyNote />}
            <Composer disabled={!status?.ready} projectId={projectId} />
          </>
        ) : undefined
      }
    >
      {!entries.length && status && !status.ready ? (
        <SetupClaude />
      ) : !entries.length ? (
        <Empty title="Ask for an edit" detail="Ask for captions, cuts, B-roll, grades. Changes land on your timeline live and undo with ⌘Z." />
      ) : (
        <ChatTurns turns={turns} known={known} />
      )}
    </ChatShell>
  );
}

/** Why the composer is waiting, above it: the sign-in card when someone has to act, otherwise one line while Edit finishes checking. */
function NotReadyNote() {
  const status = useAgent((state) => state.status);
  const phase = useClaudeSupport((state) => state.status?.phase);
  if (status?.state === "missing" || phase === "needs_login" || phase === "error" || phase === "signing_in") return <ClaudeSetupCard />;
  return <p className="px-3 pt-2 text-[12px] leading-relaxed text-muted">Getting Claude ready. You can type again in a moment.</p>;
}

/** True once nothing has streamed or changed for `quiet` ms (so "Thinking" doesn’t blink between steps). */
function useQuiet(activityAt: number, quiet: number) {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), Math.max(0, quiet - (Date.now() - activityAt)));
    return () => clearTimeout(timer);
  }, [activityAt, quiet]);
  return settled;
}

/**
 * Fade/slide in only things that are new; `animate` never changes so a swap
 * (e.g. the server’s copy replacing an optimistic message) can’t freeze it mid-fade.
 */
const appear = (fresh: boolean) =>
  ({
    initial: fresh ? { opacity: 0, y: 4 } : false,
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.18, ease: [0.2, 0, 0, 1] },
  }) as const;

/**
 * The conversation's turns, as the editor's chat shows them (the idea page's
 * chat uses it too, the user, Oct 31: "copy the video editor's chat that we
 * have"). `thinking`: what to say while a live turn has no tool running, in
 * place of "Thinking" after a quiet moment (the idea page's run says its step).
 */
export function ChatTurns({ turns, known, thinking }: { turns: Turn[]; known: Set<string>; thinking?: string }) {
  return (
    <div className="flex flex-col gap-4">
      {turns.map((turn, index) => (
        <TurnView key={index} turn={turn} known={known} thinking={thinking} />
      ))}
    </div>
  );
}

/** One exchange: your message, the work (folds away when done), the answer. */
function TurnView({ turn, known, thinking: said }: { turn: Turn; known: Set<string>; thinking?: string }) {
  const [open, setOpen] = useState(false);
  const activityAt = useAgent((state) => state.activityAt);
  const quiet = useQuiet(activityAt, 450);
  const lastGroup = [...turn.parts].reverse().find((part) => part.kind === "group");
  const toolRunning = turn.parts.some((part) => part.kind === "group" && part.calls.some((call) => call.status === "running"));
  const thinkingNow = turn.parts.some((part) => part.kind === "thinking" && part.active);
  // Into real work (a tool called, or a few seconds in): "Working for 1m 12s", ticking, shown while tools run too.
  const now = useNow(turn.live);
  const elapsed = turn.live && turn.startedAt > 0 ? now - turn.startedAt : 0;
  const working = turn.live && said === undefined && isWorking(elapsed, lastGroup !== undefined);
  // A live reasoning row already says Thinking. A running tool says so on its own row.
  const thinking = turn.live && !thinkingNow && (working || ((said !== undefined || quiet) && !toolRunning));
  const fresh = (id: string) => !known.has(id);
  const project = useEditor((state) => state.project?.id);
  return (
    <div className="flex flex-col gap-1.5">
      {turn.user?.attachments !== undefined && turn.user.attachments.length > 0 && (
        <motion.div {...appear(fresh(turn.user.id) && !turn.user.id.startsWith("user-"))} className="flex flex-col">
          <SentFiles files={turn.user.attachments.map((one) => ({ name: one.name, kind: one.kind, url: one.url ?? (one.kind === "image" && one.media !== undefined && project !== undefined ? mediaUrl(project, one.media, "proxy") : null) }))} />
        </motion.div>
      )}
      {turn.user && (
        <motion.div
          {...appear(fresh(turn.user.id) && !turn.user.id.startsWith("user-"))}
          className="mb-1 ml-8 max-w-[calc(100%-2rem)] self-end rounded-2xl bg-raised px-3 py-2 text-[13px] whitespace-pre-wrap text-fg ring-1 ring-line [overflow-wrap:anywhere]"
        >
          <UserWords text={turn.user.text} />
        </motion.div>
      )}
      {turn.live ? (
        // Live: everything in the order it happens. A tool group stays live while one of its calls is still running, even after the model has said something.
        turn.parts.map((part) =>
          part.kind === "thinking" ? (
            <ThinkingTrace key={part.id} text={part.text} active={part.active} />
          ) : part.kind === "group" ? (
            <ToolGroup key={part.id} calls={part.calls} live={part.calls.some((call) => call.status === "running")} />
          ) : (
            <EntryView key={part.entry.id} entry={part.entry} fresh={fresh(part.entry.id)} />
          ),
        )
      ) : (
        <>
          {turn.work.length > 0 && (
            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              onClick={() => setOpen((value) => !value)}
              className="flex h-6 w-fit items-center gap-1 rounded-md px-1.5 text-[12px] text-faint transition-colors hover:bg-hover hover:text-muted"
            >
              {formatWorked(turn.workedMs)}
              <ChevronRight size={12} className={cx("transition-transform duration-150", open && "rotate-90")} />
            </motion.button>
          )}
          <AnimatePresence initial={false}>
            {open && (
              <motion.div
                key="work"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                className="flex flex-col gap-1.5 overflow-hidden"
              >
                {turn.work.map((part) =>
                  part.kind === "group" ? (
                    <ToolGroup key={part.id} calls={part.calls} live={false} />
                  ) : part.kind === "thinking" ? (
                    <ThinkingTrace key={part.id} text={part.text} active={false} />
                  ) : (
                    <EntryView key={part.entry.id} entry={part.entry} muted />
                  ),
                )}
              </motion.div>
            )}
          </AnimatePresence>
          {turn.answer.map((entry) => (
            <EntryView key={entry.id} entry={entry} />
          ))}
        </>
      )}
      <AnimatePresence>
        {thinking && (
          <motion.div
            key="thinking"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            className="h-7 px-1.5 text-[12px] leading-7"
          >
            {said !== undefined ? (
              <span className="shimmer">{said}</span>
            ) : (
              <>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span key={thinkingWord(turn.startedAt, elapsed)} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }} className="shimmer inline-block">
                    {thinkingWord(turn.startedAt, elapsed)}
                  </motion.span>
                </AnimatePresence>
                {working && <span className="ml-1.5 text-faint tabular">{shortSpan(elapsed)}</span>}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const TOOL_ICONS: Record<string, LucideIcon> = {
  // A script's run (writer/chat/turn.ts names them; their labels ride in the entry's text).
  build_script: ScrollText,
  plan_part: FileText,
  read_timeline: FileText,
  read_passages: ScrollText,
  find_words: ScrollText,
  remove_words: Trash2,
  insert_words: Type,
  arrange_word_clips: LayoutGrid,
  arrange_time_clips: LayoutGrid,
  insert_cut_in: Image,
  set_reuse_link: FileText,
  move_clips: LayoutGrid,
  reorder_clip: LayoutGrid,
  trim_clip: Scissors,
  split_clip: Scissors,
  delete_items: Trash2,
  close_gaps: LayoutGrid,
  set_label: Type,
  correct_word: Type,
  history: RotateCcw,
  select_clips: MousePointerClick,
  move_playhead: LayoutGrid,
  start_export: Share,
  inspect_frames: Eye,
  read_assets: FileText,
  curate_assets: Image,
  read_doc_comments: FileText,
  find_silences: AudioLines,
  read_audio: AudioLines,
  review_cuts: Eye,
  polish_clips: Star,
  remove_silences: AudioLines,
  load_writing_skill: ScrollText,
  read_script: ScrollText,
  write_cut_ins: Type,
  set_outline: ScrollText,
  set_opening: Image,
  add_section: SquarePlus,
  finish_section: Check,
  read_plan: ScrollText,
  review_plan: Eye,
  replace_items: Type,
  remove_items: Trash2,
  finish: Check,
  // The idea page's run (ideas/run.ts).
  save_titles: Type,
  remove_titles: Trash2,
  rename_title: Pencil,
  set_main_title: Star,
  save_thumbnail_guide: Image,
  save_summary: FileText,
  skip_case: CircleSlash,
  Read: Eye,
  make_picture: Image,
  picture_prompt: FileText,
  set_layers: LayoutGrid,
  change_layers: SlidersHorizontal,
  look: Eye,
  undo: RotateCcw,
  redo: RotateCcw,
  rename: Pencil,
  get_project: FileText,
  list_projects: FolderOpen,
  read_transcript: ScrollText,
  add_text: Type,
  add_clip: SquarePlus,
  update_clip: SlidersHorizontal,
  delete_clips: Trash2,
  set_keyframes: Spline,
  import_media: FileInput,
  add_sound_effect: Music,
  render_frame: Eye,
  contact_sheet: LayoutGrid,
  export: Share,
  transcribe: AudioLines,
};

const toolIcon = (tool?: string) => TOOL_ICONS[tool ?? ""] ?? Wrench;

/** A reasoning block. While it is being written the words stay open; afterwards it folds to the label (as in phi). */
/** A thinking word that moves on every few seconds from when it appeared. */
function ThinkingWord() {
  const [since] = useState(() => Date.now());
  const now = useNow(true);
  const word = thinkingWord(since, now - since);
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={word} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }} className="shimmer inline-block">
        {word}
      </motion.span>
    </AnimatePresence>
  );
}

function ThinkingTrace({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const body = text.trim();
  const ref = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    if (active && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [active, body]);
  return (
    <div>
      <button
        type="button"
        onClick={() => body !== "" && setOpen((value) => !value)}
        className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg/85"
      >
        <span className="min-w-0 flex-1 truncate">{active ? <ThinkingWord /> : "Thinking"}</span>
      </button>
      {(active || open) && body !== "" && (
        <pre ref={ref} className="mx-1.5 mt-0.5 mb-1.5 max-h-40 overflow-auto rounded-md bg-black px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted ring-1 ring-line">
          {body}
        </pre>
      )}
    </div>
  );
}

/** Consecutive tool calls: one row that shows the live step, then a summary (as in phi). Open it for each call. */
function ToolGroup({ calls, live }: { calls: AgentEntry[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const current = live ? ([...calls].reverse().find((call) => call.status === "running") ?? calls.at(-1)) : undefined;
  // A step that didn't work is the agent's to work around (a site's bot check, a plan it fixes and sends
  // again): never red here. Only what stops the turn is a problem for the person (the error entries).
  const Icon = current ? toolIcon(current.tool) : calls.length === 1 ? toolIcon(calls[0].tool) : ListChecks;
  const title = current ? callTitle(current) : calls.length === 1 ? callTitle(calls[0]) : groupSummary(calls);
  return (
    <div>
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg/85"
      >
        <Icon size={13} className="shrink-0 text-faint" />
        <span className={cx("min-w-0 flex-1 truncate", current && "shimmer")}>{title}</span>
        {calls.length > 1 && !current && <span className="text-[11px] text-faint tabular">{calls.length}</span>}
      </button>
      {open && (
        <div className="mt-0.5 ml-[13px] flex flex-col border-l border-line pl-2">
          {calls.map((call) => (
            <ToolCall key={call.id} call={call} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCall({ call }: { call: AgentEntry }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(call.tool);
  const failed = call.status === "failed";
  return (
    <div>
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex h-[26px] w-full items-center gap-2 rounded-md px-1.5 text-left text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg/85"
      >
        <Icon size={13} className="shrink-0 text-faint" />
        <span className={cx("min-w-0 flex-1 truncate", call.status === "running" && "shimmer")}>{callTitle(call)}</span>
        {failed && <span className="text-[11px] text-faint">didn’t work</span>}
        {call.status === "stopped" && <span className="text-[11px] text-faint">stopped</span>}
      </button>
      {open && (
        <pre className="mx-1.5 mt-0.5 mb-1.5 max-h-48 overflow-auto rounded-md bg-black px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted ring-1 ring-line">
          {failed ? `${call.text}\n\n` : ""}
          {call.detail ?? call.text}
        </pre>
      )}
    </div>
  );
}

/** Claude Code missing or signed out: what to do, on one line (nothing to show while Edit readies it by itself). */
function SetupClaude() {
  const phase = useClaudeSupport((state) => state.status?.phase);
  const missing = useAgent((state) => state.status?.state === "missing");
  if (missing || phase === "needs_login" || phase === "error" || phase === "signing_in") {
    return (
      <div className="overflow-hidden rounded-lg border border-line">
        <ClaudeSetupCard />
      </div>
    );
  }
  return <Empty title="Getting Claude ready" detail="Edit is checking Claude Code on this Mac. This takes a moment." />;
}

export function Empty({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col justify-center px-2 text-center">
      <div className="font-medium">{title}</div>
      <p className="mx-auto mt-1 max-w-[270px] text-[12px] leading-relaxed text-muted">{detail}</p>
      {children}
    </div>
  );
}

function EntryView({ entry, muted, fresh }: { entry: AgentEntry; muted?: boolean; fresh?: boolean }) {
  if (entry.kind === "subagent") return <SubAgentCard entry={entry} />;
  if (entry.kind === "error") {
    const resolved = entry.status === "done";
    return (
      <div className={cx("flex items-start gap-2 rounded-lg px-2.5 py-2 text-[12px]", resolved ? "bg-raised text-muted" : "bg-danger-soft text-danger")}>
        {resolved ? (
          <>
            <Check size={13} className="mt-px shrink-0" />
            <span>{explain(entry.text, "carry on").title}</span>
          </>
        ) : (
          <ProblemView error={entry.text} doing="carry on" className="min-w-0 flex-1" />
        )}
      </div>
    );
  }
  if (!entry.text) return null;
  return (
    <motion.div
      initial={fresh ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18 }}
      className={cx("px-1.5 leading-relaxed", muted ? "text-[12px] text-muted" : "text-[13px] text-fg/90")}
    >
      <Markdown text={entry.text} />
    </motion.div>
  );
}

/**
 * The agent’s replies as Markdown (tables, lists, headings, code), styled for
 * the panel. Raw HTML in a reply is shown as text, never run.
 */
/**
 * A picture an agent put in its answer (Sphe, Nov 4: "all of the agents have the
 * ability to inline images"): its chat has made it an address this page can
 * load (the server's chat_pictures.ts); shown in the answer, big on a click.
 * One it couldn't place (or one from anywhere else) is named, never fetched.
 */
function ChatPicture({ src, alt }: { src?: string; alt?: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const words = alt?.trim() || "Picture";
  if (src === undefined || !src.startsWith("/api/") || failed) {
    return (
      <span className="my-1 inline-flex h-7 items-center gap-1.5 rounded-md bg-raised px-2 text-[12px] text-muted ring-1 ring-line">
        <Image size={13} className="text-faint" /> {words}
      </span>
    );
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title={words} className="my-2 block w-full overflow-hidden rounded-lg bg-black ring-1 ring-line transition-shadow hover:ring-line-strong">
        <img src={src} alt={words} loading="lazy" onError={() => setFailed(true)} className="block max-h-72 w-full object-contain" />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} width={Math.min(1400, window.innerWidth - 64)}>
        <button type="button" onClick={() => setOpen(false)} className="block w-full bg-black" aria-label="Close">
          <img src={src} alt={words} className="block max-h-[calc(100vh-96px)] w-full object-contain" />
        </button>
      </Modal>
    </>
  );
}

const MARKDOWN: Components = {
  // A paragraph holding a picture is a block of its own (a <p> can't hold the picture's button and dialog).
  p: ({ children, node }) => (node?.children.some((child) => child.type === "element" && child.tagName === "img") ? <div className="my-1.5 first:mt-0 last:mb-0">{children}</div> : <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>),
  img: ({ src, alt }) => <ChatPicture src={typeof src === "string" ? src : undefined} alt={alt} />,
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-fg underline decoration-white/30 underline-offset-2 hover:decoration-white">
      {children}
    </a>
  ),
  h1: ({ children }) => <h3 className="mt-3 mb-1 text-[14px] font-semibold text-fg first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 mb-1 text-[13.5px] font-semibold text-fg first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-2.5 mb-1 text-[13px] font-semibold text-fg first:mt-0">{children}</h4>,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-4 marker:text-faint">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-4 marker:text-faint">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  blockquote: ({ children }) => <blockquote className="my-1.5 border-l-2 border-line-strong pl-2.5 text-muted">{children}</blockquote>,
  hr: () => <hr className="my-3 border-line" />,
  pre: ({ children }) => <pre className="my-1.5 overflow-x-auto rounded-lg bg-black p-2.5 font-mono text-[11.5px] leading-relaxed ring-1 ring-line">{children}</pre>,
  code: ({ children, className }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-raised px-1 font-mono text-[12px]">{children}</code>
    ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg ring-1 ring-line">
      <table className="w-full border-collapse text-[12px] tabular">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-raised text-muted">{children}</thead>,
  tr: ({ children }) => <tr className="border-t border-line first:border-t-0">{children}</tr>,
  th: ({ children, style }) => (
    <th className="px-2 py-1.5 text-left font-medium" style={style}>
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className="px-2 py-1.5 align-top" style={style}>
      {children}
    </td>
  ),
};

/**
 * A chat asking to start over, in the composer's island (ChatComposer's tray),
 * as the queue and the notes sit: the edit's reset card, everywhere a chat
 * asks (Sphe, Nov 3: "the shared resetting system we have on edits, across
 * all chats"). `onAnswer(false)` rejects, `onAnswer(true)` accepts.
 */
export function ResetAsk({
  title,
  detail,
  busy,
  acceptLabel = "Accept and reset",
  onAnswer,
}: {
  title: string;
  detail: string;
  busy?: boolean;
  acceptLabel?: string;
  onAnswer: (accept: boolean) => void;
}) {
  return (
    <div className="px-3 pt-2.5 pb-2">
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <RotateCcw size={14} className="shrink-0 text-warning" />
        {title}
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-muted">{detail}</p>
      <div className="mt-2.5 flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAnswer(false)}>
          Reject
        </Button>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => onAnswer(true)}>
          {acceptLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * The agent asked to reset the edit (`reset_edit`, "reset the video"): the
 * user accepts or rejects here, and the agent, waiting on the answer, carries on.
 */
function ResetCard({ projectId }: { projectId: string }) {
  const [answering, setAnswering] = useState(false);
  const answer = (accept: boolean) => {
    setAnswering(true);
    void api
      .answerReset(projectId, accept)
      .then(() => useEditor.setState({ resetAsked: false }))
      .catch((error) => useEditor.getState().toastError(error, "answer the agent"))
      .finally(() => setAnswering(false));
  };
  return (
    <ResetAsk
      title="Reset the edit?"
      detail="Every clip goes and the script is laid out again as the import left it: the footage ranges, cut-in cards and voice-overs. Media, transcripts and research stay. The edit before is kept in the project’s history."
      busy={answering}
      onAnswer={answer}
    />
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN} skipHtml>
      {text}
    </ReactMarkdown>
  );
}

function Composer({ disabled, projectId }: { disabled: boolean; projectId: string | undefined }) {
  const running = useAgent((state) => state.running);
  const modelName = useAgent((state) => state.chatModel ?? state.modelName);
  const notes = useNotes((state) => queued(state.notes).length);
  const resetAsked = useEditor((state) => state.resetAsked);
  const upload = useMemo(() => (projectId === undefined ? undefined : { upload: projectUploader(projectId) }), [projectId]);
  // On the composer's top edge: the agent asking to reset, then the team's queued notes.
  const tray = [projectId !== undefined && resetAsked && <ResetCard key="reset" projectId={projectId} />, notes > 0 && <NoteQueue key="notes" />].filter(Boolean);
  return (
    <ChatComposer
      chat={`project:${projectId ?? ""}`}
      files={upload}
      tray={tray.length > 0 ? tray : undefined}
      running={running}
      disabled={disabled}
      modelName={modelName ?? ""}
      placeholder="Start the editing workflow, or ask for a change…"
      // Where the playhead is goes with it: the agent starts there (the server reads it what's under it).
      onSend={(message, files) => void sendToAgent(message, playhead.frame, files)}
      onStop={stopAgent}
    />
  );
}

/** The chat while it loads: the shape of a conversation, pulsing, rather than an empty panel (the user, Oct 30: "we need a better loading view"). */
export function ChatLoading() {
  const line = "h-2.5 animate-pulse rounded-full bg-raised";
  return (
    <div role="status" aria-label="Loading the chat" className="flex flex-col gap-5 pt-1">
      {[0, 1].map((turn) => (
        <div key={turn} className="flex flex-col gap-3">
          <div className="ml-auto h-8 w-[55%] animate-pulse rounded-xl bg-raised" />
          <div className="flex flex-col gap-2">
            <div className={cx(line, "w-[88%]")} />
            <div className={cx(line, "w-[72%]")} />
            <div className={cx(line, turn === 0 ? "w-[80%]" : "w-[46%]")} />
          </div>
        </div>
      ))}
    </div>
  );
}
