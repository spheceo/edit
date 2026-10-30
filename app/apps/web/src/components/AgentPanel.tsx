import { explain } from "@edit/types/problems";
import {
  ArrowUp,
  AudioLines,
  Check,
  ChevronRight,
  Copy,
  Eye,
  FileInput,
  FileText,
  FolderOpen,
  LayoutGrid,
  ListChecks,
  Music,
  RotateCcw,
  RotateCw,
  ScrollText,
  Share,
  SlidersHorizontal,
  Spline,
  Square,
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
  openAgent,
  sendToAgent,
  useClaudeSupport,
  stopAgent,
  useAgent,
  type AgentEntry,
} from "../lib/agent";
import { buildTurns, callTitle, formatWorked, groupSummary, type Turn } from "../lib/agentTurns";
import { api, useMachine } from "../lib/api";
import { playhead } from "../lib/playback";
import { useSettled } from "../lib/settled";
import { useEditor } from "../lib/store";
import { ProblemView } from "./ProblemView";
import { Button, cx } from "./ui";
import { ClaudeSetupCard } from "./ClaudeSetupCard";

/** Claude’s mark (Simple Icons’ path), in Claude’s orange: the agent runs on the user’s Claude Code. */
export function ClaudeMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#d97757" aria-label="Claude" className="shrink-0">
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

/** OpenAI’s mark (same path phi uses). */

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
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const turns = buildTurns(entries, running);

  // Entries already there when the chat loaded don’t animate in.
  const known = useRef<{ project?: string; ids: Set<string> }>({ ids: new Set() });
  if (loaded && known.current.project !== projectId) known.current = { project: projectId, ids: new Set(entries.map((entry) => entry.id)) };

  useEffect(() => {
    if (projectId) void openAgent(projectId);
  }, [projectId]);

  // Stay pinned to the newest message unless you’ve scrolled up; jump before
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
      <div
        ref={list}
        onScroll={(event) => {
          const node = event.currentTarget;
          stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {!loaded ? (
          <ChatLoading />
        ) : !entries.length && status && !status.ready ? (
          status.provider === "codex" ? <SetupCodex /> : <SetupClaude />
        ) : !entries.length ? (
          <Empty title="Ask for an edit" detail="Ask for captions, cuts, B-roll, grades. Changes land on your timeline live and undo with ⌘Z." />
        ) : (
          <div className="flex flex-col gap-4">
            {turns.map((turn, index) => (
              <TurnView key={index} turn={turn} known={known.current.ids} />
            ))}
          </div>
        )}
      </div>

      {projectId && <ResetCard projectId={projectId} />}
      {!(status && !status.ready) && <Composer disabled={!status?.ready} />}
    </section>
  );
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
          className="mb-1 ml-8 max-w-[calc(100%-2rem)] self-end rounded-2xl bg-raised px-3 py-2 text-[13px] whitespace-pre-wrap text-fg ring-1 ring-line [overflow-wrap:anywhere]"
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
      <div className="font-medium">{title}</div>
      <p className="mx-auto mt-1 max-w-[270px] text-[12px] leading-relaxed text-muted">{detail}</p>
      {children}
    </div>
  );
}

function EntryView({ entry, muted, fresh }: { entry: AgentEntry; muted?: boolean; fresh?: boolean }) {
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

/**
 * The agent asked to reset the edit (`reset_edit`, "reset the video"): the
 * user accepts or rejects here, and the agent, waiting on the answer, carries on.
 */
function ResetCard({ projectId }: { projectId: string }) {
  const asked = useEditor((state) => state.resetAsked);
  const [answering, setAnswering] = useState(false);
  if (!asked) return null;
  const answer = (accept: boolean) => {
    setAnswering(true);
    void api
      .answerReset(projectId, accept)
      .then(() => useEditor.setState({ resetAsked: false }))
      .catch((error) => useEditor.getState().toastError(error, "answer the agent"))
      .finally(() => setAnswering(false));
  };
  return (
    <div className="mx-2.5 mb-1 shrink-0 rounded-xl border border-line-strong bg-raised p-3">
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <RotateCcw size={14} className="shrink-0 text-warning" />
        Reset the edit?
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-muted">
        Every clip goes and the script is laid out again as the import left it: the footage ranges, cut-in cards and voice-overs. Media, transcripts and research stay. The edit before is kept in the project’s history.
      </p>
      <div className="mt-2.5 flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={answering} onClick={() => answer(false)}>
          Reject
        </Button>
        <Button size="sm" variant="primary" disabled={answering} onClick={() => answer(true)}>
          Accept and reset
        </Button>
      </div>
    </div>
  );
}

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
  // Stop takes a click only once the turn has run a moment: never the send's own second click.
  const stoppable = useSettled(running);
  const modelName = useAgent((state) => state.modelName);
  const input = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const message = text.trim();
    if (!message || running || disabled) return;
    setText("");
    // Where the playhead is goes with it: the agent starts there (the server reads it what's under it).
    void sendToAgent(message, playhead.frame);
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
      <div className={cx("rounded-xl border border-line bg-black p-2 transition-colors focus-within:border-muted", disabled && "opacity-50")}>
        <textarea
          ref={input}
          name="message"
          aria-label="Message the agent"
          autoComplete="off"
          value={text}
          disabled={disabled}
          rows={2}
          placeholder={running ? "Working…" : "Start the editing workflow, or ask for a change…"}
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
          <span className="flex h-6 items-center gap-1.5 px-1 text-[11px] font-medium text-muted" title="Edit picks the model and how hard it thinks">
            {modelName ?? ""}
          </span>
          {running ? (
            <button
              type="button"
              aria-label="Stop"
              title="Stop"
              disabled={!stoppable}
              onClick={stopAgent}
              className="ml-auto flex size-7 items-center justify-center rounded-lg bg-white text-black transition-transform active:scale-90 disabled:opacity-60"
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

/** The chat while it loads: the shape of a conversation, pulsing, rather than an empty panel (the user, Oct 30: "we need a better loading view"). */
function ChatLoading() {
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
