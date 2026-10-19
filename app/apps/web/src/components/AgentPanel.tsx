import {
  ArrowUp,
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Eye,
  FileInput,
  FileText,
  FolderOpen,
  LayoutGrid,
  ListChecks,
  Music,
  RotateCw,
  ScrollText,
  Share,
  SlidersHorizontal,
  Spline,
  Square,
  SquarePen,
  SquareTerminal,
  SquarePlus,
  Trash2,
  Type,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  chooseEffort,
  chooseModel,
  currentEffort,
  currentModel,
  EFFORT_LABELS,
  newChat,
  openAgent,
  providerName,
  sendToAgent,
  stopAgent,
  useAgent,
  type AgentEntry,
} from "../lib/agent";
import { buildTurns, callTitle, formatWorked, groupSummary, type Turn } from "../lib/agentTurns";
import { useMachine } from "../lib/api";
import { useEditor } from "../lib/store";
import { toggleMenu, type MenuItem } from "./ContextMenu";
import { cx, IconButton } from "./ui";

/** OpenAI's mark (same path phi uses). */
/** The agent on Claude Code: a plain terminal glyph (Anthropic's marks aren't ours to use). */
export function ClaudeMark({ size = 16 }: { size?: number }) {
  return <SquareTerminal size={size} aria-hidden />;
}

/** The mark of the provider the agent runs on. */
export function AgentMark({ size = 16 }: { size?: number }) {
  const codex = useAgent((state) => state.status?.provider === "codex");
  return codex ? <OpenAIMark size={size} /> : <ClaudeMark size={size} />;
}

export function OpenAIMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-label="OpenAI">
      <path d="M22.28 9.82a6 6 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.98 5.98 0 0 0-4 2.9 6.05 6.05 0 0 0 .75 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.51 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07Zm-9.02 12.61a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.79.79 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.59a4.5 4.5 0 0 1-4.49 4.49ZM3.6 18.3a4.47 4.47 0 0 1-.54-3.01l.15.09 4.78 2.75a.77.77 0 0 0 .78 0l5.84-3.37v2.34a.08.08 0 0 1-.03.06L9.74 19.95a4.5 4.5 0 0 1-6.14-1.65ZM2.34 7.9a4.49 4.49 0 0 1 2.37-1.98v5.68a.77.77 0 0 0 .39.68l5.81 3.35-2.02 1.17a.08.08 0 0 1-.07 0l-4.83-2.79A4.5 4.5 0 0 1 2.34 7.87Zm16.6 3.86-5.84-3.4L15.12 7.2a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.11v-5.68a.79.79 0 0 0-.4-.67Zm2.01-3.02-.14-.09-4.78-2.78a.78.78 0 0 0-.78 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.07l4.83-2.78a4.5 4.5 0 0 1 6.68 4.66ZM8.31 12.86l-2.02-1.16a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14.08-4.78 2.76a.79.79 0 0 0-.4.68Zm1.1-2.36 2.6-1.5 2.6 1.5v3l-2.6 1.5-2.6-1.5Z" />
    </svg>
  );
}

export function AgentPanel() {
  const projectId = useEditor((state) => state.project?.id);
  const { status, entries, running, loaded } = useAgent();
  const busy = running;
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const turns = buildTurns(entries, running);

  // Entries already there when the chat loaded don't animate in.
  const known = useRef<{ project?: string; ids: Set<string> }>({ ids: new Set() });
  if (loaded && known.current.project !== projectId) known.current = { project: projectId, ids: new Set(entries.map((entry) => entry.id)) };

  useEffect(() => {
    if (projectId) void openAgent(projectId);
  }, [projectId]);

  // Stay pinned to the newest message unless you've scrolled up; jump before
  // paint so streaming text never lurches.
  useLayoutEffect(() => {
    const node = list.current;
    if (node && stick.current) node.scrollTop = node.scrollHeight;
  });
  useLayoutEffect(() => {
    stick.current = true;
  }, [projectId, loaded]);

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line pr-1.5 pl-3.5">
        <AgentMark size={15} />
        <span className="font-medium">{providerName(status)}</span>
        {status?.ready !== false && (
          <IconButton label="New chat" className="ml-auto" disabled={busy || !entries.length} onClick={newChat}>
            <SquarePen size={14} />
          </IconButton>
        )}
      </div>

      <div
        ref={list}
        onScroll={(event) => {
          const node = event.currentTarget;
          stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {!loaded ? null : status && !status.ready ? (
          status.provider === "codex" ? <SetupCodex /> : <SetupClaude />
        ) : !entries.length ? (
          <Empty title={`Edit with ${providerName(status)}`} detail="Ask for captions, cuts, B-roll, grades. Changes land on your timeline live and undo with ⌘Z." />
        ) : (
          <div className="flex flex-col gap-4">
            {turns.map((turn, index) => (
              <TurnView key={index} turn={turn} known={known.current.ids} />
            ))}
          </div>
        )}
      </div>

      {!(status && !status.ready) && <Composer disabled={!status?.ready} />}
    </section>
  );
}

/** True once nothing has streamed or changed for `quiet` ms (so "Thinking" doesn't blink between steps). */
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
 * (e.g. the server's copy replacing an optimistic message) can't freeze it mid-fade.
 */
const appear = (fresh: boolean) =>
  ({
    initial: fresh ? { opacity: 0, y: 4 } : false,
    animate: { opacity: 1, y: 0 },
    transition: { type: "spring", stiffness: 520, damping: 42 },
  }) as const;

/** One exchange: your message, the work (folds away when done), the answer. */
function TurnView({ turn, known }: { turn: Turn; known: Set<string> }) {
  const [open, setOpen] = useState(false);
  const activityAt = useAgent((state) => state.activityAt);
  const quiet = useQuiet(activityAt, 450);
  const lastGroup = [...turn.parts].reverse().find((part) => part.kind === "group");
  const toolRunning = lastGroup?.kind === "group" && lastGroup.calls.some((call) => call.status === "running");
  const thinking = turn.live && quiet && !toolRunning;
  const fresh = (id: string) => !known.has(id);
  return (
    <div className="flex flex-col gap-1.5">
      {turn.user && (
        <motion.div
          {...appear(fresh(turn.user.id) && !turn.user.id.startsWith("user-"))}
          className="mb-1 ml-8 self-end rounded-2xl bg-raised px-3 py-2 text-[13px] whitespace-pre-wrap text-fg ring-1 ring-line"
        >
          {turn.user.text}
        </motion.div>
      )}
      {turn.live ? (
        // Live: everything in the order it happens.
        turn.parts.map((part, index) =>
          part.kind === "group" ? (
            <ToolGroup key={part.id} calls={part.calls} live={index === turn.parts.length - 1} />
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
                  part.kind === "group" ? <ToolGroup key={part.id} calls={part.calls} live={false} /> : <EntryView key={part.entry.id} entry={part.entry} muted />,
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
            className="shimmer h-7 px-1.5 text-[12px] leading-7"
          >
            Thinking
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const TOOL_ICONS: Record<string, LucideIcon> = {
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

/** Consecutive tool calls: one row that shows the live step, then a summary (as in phi). */
function ToolGroup({ calls, live }: { calls: AgentEntry[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const current = live ? ([...calls].reverse().find((call) => call.status === "running") ?? calls.at(-1)) : undefined;
  const failed = calls.some((call) => call.status === "failed");
  const Icon = current ? toolIcon(current.tool) : failed ? CircleAlert : calls.length === 1 ? toolIcon(calls[0].tool) : ListChecks;
  const title = current ? callTitle(current) : calls.length === 1 ? callTitle(calls[0]) : groupSummary(calls);
  return (
    <div>
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg/85"
      >
        <Icon size={13} className={cx("shrink-0", failed ? "text-red-400" : "text-faint")} />
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
        {failed && <span className="text-[11px] text-red-400">failed</span>}
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

/** Claude Code missing or signed out: the steps to fix it on the machine running Edit, and a re-check. */
function SetupClaude() {
  const status = useAgent((state) => state.status);
  const project = useAgent((state) => state.project);
  const machine = useMachine();
  const [checking, setChecking] = useState(false);
  const missing = status?.state !== "logged_out";
  const steps = missing ? ["curl -fsSL https://claude.ai/install.sh | bash", "claude auth login"] : ["claude auth login"];
  return (
    <div className="flex min-h-full flex-col justify-center px-1">
      <span className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-raised text-fg ring-1 ring-line">
        <ClaudeMark size={20} />
      </span>
      <div className="mt-3 text-center font-medium">{missing ? "Install Claude Code to use the agent" : "Sign in to Claude Code"}</div>
      <p className="mx-auto mt-1 max-w-[260px] text-center text-[12px] leading-relaxed text-muted">
        Edit runs Claude Code on your own Claude plan or API key, on <span className="text-fg">{machine}</span>. Run this there:
      </p>
      <div className="mt-4 flex flex-col gap-1.5">
        {steps.map((step, index) => (
          <CopyLine key={step} index={steps.length > 1 ? index + 1 : undefined} text={step} />
        ))}
      </div>
      <button
        type="button"
        disabled={checking || !project}
        onClick={() => {
          if (!project) return;
          setChecking(true);
          void openAgent(project).finally(() => setChecking(false));
        }}
        className="mx-auto mt-4 flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium text-muted ring-1 ring-line transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
      >
        <RotateCw size={12} className={checking ? "animate-spin" : undefined} />
        {checking ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}

/** Codex missing or signed out: the steps to fix it on the machine running Edit, and a re-check. */
function SetupCodex() {
  const status = useAgent((state) => state.status);
  const project = useAgent((state) => state.project);
  const machine = useMachine();
  const [checking, setChecking] = useState(false);
  const missing = status?.state !== "logged_out";
  const steps = missing ? ["npm install -g @openai/codex", "codex login"] : ["codex login"];
  return (
    <div className="flex min-h-full flex-col justify-center px-1">
      <span className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-raised text-fg ring-1 ring-line">
        <OpenAIMark size={20} />
      </span>
      <div className="mt-3 text-center font-medium">{missing ? "Install Codex to use the agent" : "Sign in to Codex"}</div>
      <p className="mx-auto mt-1 max-w-[260px] text-center text-[12px] leading-relaxed text-muted">
        {missing ? "Edit drives the Codex CLI" : "Codex is installed but signed out"} on <span className="text-fg">{machine}</span>. Run this there:
      </p>
      <div className="mt-4 flex flex-col gap-1.5">
        {steps.map((step, index) => (
          <CopyLine key={step} index={steps.length > 1 ? index + 1 : undefined} text={step} />
        ))}
      </div>
      <button
        type="button"
        disabled={checking || !project}
        onClick={() => {
          if (!project) return;
          setChecking(true);
          void openAgent(project).finally(() => setChecking(false));
        }}
        className="mx-auto mt-4 flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium text-muted ring-1 ring-line transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
      >
        <RotateCw size={12} className={checking ? "animate-spin" : undefined} />
        {checking ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}

function CopyLine({ text, index }: { text: string; index?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex h-9 items-center gap-2 rounded-lg bg-black pr-1 pl-3 ring-1 ring-line">
      {index !== undefined && <span className="text-[11px] text-faint tabular">{index}</span>}
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">{text}</code>
      <button
        type="button"
        title="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        className="flex size-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-fg"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}

function Empty({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col justify-center px-2 text-center">
      <span className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-raised text-fg ring-1 ring-line">
        <OpenAIMark size={20} />
      </span>
      <div className="mt-3 font-medium">{title}</div>
      <p className="mx-auto mt-1 max-w-[270px] text-[12px] leading-relaxed text-muted">{detail}</p>
      {children}
    </div>
  );
}

function EntryView({ entry, muted, fresh }: { entry: AgentEntry; muted?: boolean; fresh?: boolean }) {
  if (entry.kind === "error") {
    return (
      <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-2.5 py-2 text-[12px] text-red-200">
        <CircleAlert size={13} className="mt-px shrink-0" />
        <span>{entry.text}</span>
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
 * The agent's replies as Markdown (tables, lists, headings, code), styled for
 * the panel. Raw HTML in a reply is shown as text, never run.
 */
const MARKDOWN: Components = {
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
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

function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN} skipHtml>
      {text}
    </ReactMarkdown>
  );
}

function Composer({ disabled }: { disabled: boolean }) {
  const [text, setText] = useState("");
  const running = useAgent((state) => state.running);
  const models = useAgent((state) => state.models);
  const model = useAgent((state) => currentModel(state));
  const effort = useAgent((state) => currentEffort(state));
  const name = useAgent((state) => providerName(state.status));
  const input = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const message = text.trim();
    if (!message || running || disabled) return;
    setText("");
    void sendToAgent(message);
  };

  const pick = (event: React.MouseEvent<HTMLButtonElement>, items: MenuItem[], width: number) => {
    const box = event.currentTarget.getBoundingClientRect();
    // Clicking the picker again closes its menu.
    toggleMenu(event.currentTarget, items, { width, at: { x: box.left, y: box.top - 4 } });
  };

  return (
    // A plain form + labelled textarea: what dictation tools (Wispr Flow) look for to paste into.
    <form
      className="shrink-0 p-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className={cx("rounded-xl border border-line bg-black p-2 transition-colors focus-within:border-line-strong", disabled && "opacity-50")}>
        <textarea
          ref={input}
          name="message"
          aria-label={`Message ${name}`}
          autoComplete="off"
          value={text}
          disabled={disabled}
          rows={2}
          placeholder={running ? `${name} is working…` : "Start the editing workflow, or ask for a change…"}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          className="max-h-40 min-h-[40px] w-full resize-none bg-transparent px-1 text-[13px] text-fg outline-none placeholder:text-faint"
          style={{ height: Math.min(160, 40 + Math.max(0, text.split("\n").length - 2) * 18) }}
        />
        <div className="mt-1 flex items-center gap-1">
          <Pill
            disabled={disabled || !models.length}
            onClick={(event) =>
              pick(
                event,
                [
                  { heading: "Model" },
                  ...models.map((option) => ({
                    label: option.name,
                    icon: <OpenAIMark size={13} />,
                    hint: option.is_default ? "Default" : undefined,
                    checked: option.id === model?.id,
                    onSelect: () => chooseModel(option.id),
                  })),
                ],
                220,
              )
            }
          >
            <OpenAIMark size={11} />
            {model?.name ?? "Model"}
          </Pill>
          <Pill
            disabled={disabled || !model}
            title="Thinking"
            onClick={(event) =>
              pick(
                event,
                [
                  { heading: "Thinking" },
                  ...(model?.efforts ?? []).map((option) => ({
                    label: EFFORT_LABELS[option] ?? option,
                    hint: option === model?.default_effort ? "Default" : undefined,
                    checked: option === effort,
                    onSelect: () => chooseEffort(option),
                  })),
                ],
                168,
              )
            }
          >
            <EffortMeter level={(model?.efforts ?? []).indexOf(effort)} of={(model?.efforts ?? []).length} />
            {EFFORT_LABELS[effort] ?? effort}
          </Pill>
          {running ? (
            <button
              type="button"
              aria-label="Stop"
              title="Stop"
              onClick={stopAgent}
              className="ml-auto flex size-7 items-center justify-center rounded-lg bg-white text-black transition-transform active:scale-90"
            >
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              title="Send (Enter)"
              disabled={!text.trim() || disabled}
              className="ml-auto flex size-7 items-center justify-center rounded-lg bg-white text-black transition-[transform,opacity] active:scale-90 disabled:opacity-25"
            >
              <ArrowUp size={14} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

/** Four tiny bars: how hard the model thinks, at a glance. */
function EffortMeter({ level, of }: { level: number; of: number }) {
  const filled = of > 1 ? Math.round(((Math.max(0, level) + 1) / of) * 4) : 2;
  return (
    <span className="flex h-2.5 items-end gap-[1.5px]" aria-hidden>
      {[0, 1, 2, 3].map((bar) => (
        <span key={bar} className={cx("w-[2px] rounded-full", bar < filled ? "bg-current" : "bg-current opacity-25")} style={{ height: 4 + bar * 2 }} />
      ))}
    </span>
  );
}

function Pill({ children, onClick, disabled, title }: { children: ReactNode; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none"
    >
      {children}
      <ChevronDown size={11} className="opacity-60" />
    </button>
  );
}
