// Ported as it is from Repack's script chat (apps/web/src/components/script-chat-log.tsx), the user, Oct 30:
// "have the EXACT chat viewer that repack has". Keep it in step with Repack's.
import {
  ArrowUpDown,
  AudioLines,
  BookOpen,
  Check,
  ChevronRight,
  Clapperboard,
  Copy,
  Crop,
  Ear,
  FileText,
  FoldHorizontal,
  Images,
  LayoutList,
  ListVideo,
  type LucideIcon,
  MessageSquareText,
  MousePointerClick,
  Move,
  MoveHorizontal,
  Newspaper,
  NotebookPen,
  Palette,
  PenLine,
  Repeat2,
  RotateCcw,
  ScanEye,
  ScanSearch,
  Scissors,
  ScrollText,
  Search,
  Sparkles,
  SpellCheck,
  SquareSplitHorizontal,
  TextCursorInput,
  Trash2,
  Undo2,
  Upload,
  VolumeX,
  Wrench,
  X,
} from "lucide-react";
import { useState } from "react";
import { parseScriptQuotedMessage } from "./quote";
import {
  type ScriptToolCall,
  type ScriptToolGroup,
  toolLabel,
  toolRows,
  turnParts,
  workedLabel,
} from "./turn";
import { copyText } from "./copy-text";
import { Markdown } from "./markdown";
import styles from "./chat-log.module.css";

type Jump = (seconds: number, end?: number, timeline?: boolean) => void;

/** Copy, retry and time, shown when the message is pointed at or focused. */
function MessageActions({
  text,
  at,
  onRetry,
}: {
  text: string;
  at?: string;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const date = at ? new Date(at) : null;
  return (
    <div className={styles.actions}>
      {onRetry ? (
        <button
          type="button"
          aria-label="Retry message"
          title="Retry message"
          onClick={onRetry}
        >
          <RotateCcw size={13} />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy message"}
        title={copied ? "Copied" : "Copy message"}
        onClick={() =>
          void copyText(text).then((done) => {
            if (!done) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      {date ? (
        <time dateTime={date.toISOString()} title={date.toLocaleString()}>
          {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      ) : null}
    </div>
  );
}

export function UserMessage({
  text,
  at,
  onRetry,
}: {
  text: string;
  at?: string;
  /** Answers this message again, when it was left without an answer. */
  onRetry?: () => void;
}) {
  // Words quoted from the script sit apart, above what was asked about them.
  const quoted = parseScriptQuotedMessage(text);
  return (
    <div className={`${styles.user} repack-chat`}>
      <div className={styles.bubble}>
        {quoted ? (
          <>
            <span className={styles.bubbleQuote}>
              <span>{quoted.narrationNumber === null ? "Quoted from the script" : `Quoted from narration ${quoted.narrationNumber}`}</span>
              <span className={styles.bubbleQuoteText}>{quoted.quote}</span>
            </span>
            {quoted.request}
          </>
        ) : (
          text
        )}
      </div>
      <MessageActions text={text} at={at} onRetry={onRetry} />
    </div>
  );
}

/** One icon per tool, so a run of work reads at a glance. */
const TOOL_ICONS: Record<string, LucideIcon> = {
  plan_part: NotebookPen,
  read_timeline: ListVideo,
  read_transcript: FileText,
  read_passages: FileText,
  find_words: Search,
  remove_words: Scissors,
  insert_words: TextCursorInput,
  arrange_word_clips: LayoutList,
  arrange_time_clips: LayoutList,
  insert_cut_in: Clapperboard,
  set_reuse_link: Repeat2,
  move_clips: Move,
  reorder_clip: ArrowUpDown,
  trim_clip: Crop,
  split_clip: SquareSplitHorizontal,
  delete_items: Trash2,
  close_gaps: FoldHorizontal,
  set_label: Palette,
  correct_word: SpellCheck,
  history: Undo2,
  select_clips: MousePointerClick,
  move_playhead: MoveHorizontal,
  start_export: Upload,
  inspect_frames: ScanEye,
  read_assets: Newspaper,
  curate_assets: Images,
  read_doc_comments: MessageSquareText,
  find_silences: AudioLines,
  read_audio: Ear,
  review_cuts: ScanSearch,
  polish_clips: Sparkles,
  remove_silences: VolumeX,
  load_writing_skill: BookOpen,
  read_script: ScrollText,
  write_cut_ins: PenLine,
  // Edit's script build, with Repack's icons for the like of each.
  set_outline: NotebookPen,
  set_opening: Clapperboard,
  add_section: LayoutList,
  finish_section: Check,
  read_plan: ScrollText,
  review_plan: ScanSearch,
  replace_items: PenLine,
  remove_items: Trash2,
  finish: Sparkles,
};

function ToolRows({ calls, live }: { calls: ScriptToolCall[]; live: boolean }) {
  return (
    <div className={styles.tools}>
      {toolRows(calls).map((row) => {
        // A saved turn that was stopped mid-tool is no longer running anything.
        const running = live && row.state === "running";
        const Icon =
          row.state === "error" ? X : (TOOL_ICONS[row.tool ?? ""] ?? Wrench);
        // A summary that only repeats the tool’s name says nothing more.
        // Edit's server sends the tool, not its words: named here, as Repack names it.
        const label = row.label || toolLabel(row.tool ?? "", row.state !== "running");
        const detail =
          row.detail &&
          row.detail.replace(/\W/g, "").toLowerCase() !==
            label.replace(/\W/g, "").toLowerCase()
            ? row.detail
            : undefined;
        return (
          <div
            key={row.id}
            className={styles.tool}
            data-state={running ? "running" : row.state}
            title={detail}
          >
            <Icon size={12} />
            <span>
              {label}
              {row.count > 1 ? ` ×${row.count}` : ""}
            </span>
            {detail ? <small>{detail}</small> : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One agent turn, in the order it happened: words, then the tools it ran,
 * then more words. Once finished, the tools fold away behind how long the
 * turn took, leaving the answer.
 */
export function AgentTurn({
  text,
  trace,
  workedMs,
  partial = false,
  at,
  live = false,
  waitingLabel = "Thinking",
  waitingNote,
  onJump,
}: {
  text: string;
  trace?: ScriptToolGroup[];
  workedMs?: number;
  /** Saved before it finished: stopped, or cut off by a reload or the server. */
  partial?: boolean;
  at?: string;
  live?: boolean;
  waitingLabel?: string;
  waitingNote?: string;
  onJump?: Jump;
}) {
  const [open, setOpen] = useState(false);
  const parts = turnParts(text, trace);
  const traced = parts.some((part) => part.type === "tools");
  const last = parts.at(-1);
  // Nothing on screen is moving: no words arriving and no tool running.
  const waiting =
    live &&
    (!last ||
      (last.type === "tools" &&
        !last.calls.some((call) => call.state === "running")));
  return (
    <div className={`${styles.turn} repack-chat`}>
      {!live && traced ? (
        <button
          type="button"
          className={styles.worked}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {workedLabel(workedMs)}
          <ChevronRight size={12} className={styles.chevron} />
        </button>
      ) : null}
      {live || open ? (
        parts.map((part, index) =>
          part.type === "text" ? (
            <Markdown
              // biome-ignore lint/suspicious/noArrayIndexKey: parts only grow while streaming
              key={index}
              text={part.text}
              live={live && index === parts.length - 1}
              caret={false}
              onJump={onJump}
            />
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts only grow while streaming
            <ToolRows key={index} calls={part.calls} live={live} />
          ),
        )
      ) : (
        <Markdown text={text} onJump={onJump} />
      )}
      {waiting ? (
        <div className={styles.waiting} role="status">
          <span className={styles.thinking}>{waitingLabel}</span>
          {waitingNote ? (
            <span className={styles.waitingNote}>{waitingNote}</span>
          ) : null}
        </div>
      ) : null}
      {!live && partial ? (
        <span className={styles.stopped}>Stopped before finishing.</span>
      ) : null}
      {live ? null : <MessageActions text={text} at={at} />}
    </div>
  );
}

/** Why an answer failed, under its turn, as Repack's chat says it (script-editor's chatNotice). */
export function ChatNotice({ children }: { children: React.ReactNode }) {
  return (
    <p role="note" className={`${styles.notice} repack-chat`}>
      {children}
    </p>
  );
}
