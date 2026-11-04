// The composer every chat on the right shares: the editor's, an idea's and a
// thumbnail's (Sphe, Nov 3: "the changes we've made to ui and files
// functionality on the composer must apply to ALL chat's"). One card, its
// corners always round, a shade darker at the edge; files attached sit inside
// it above the words (+ opens Finder, a drop or a paste attaches); what's
// attached to the chat rather than the message (queued messages, the team's
// notes, the agent asking to reset) sits in an island on its top edge, inset
// from its sides and the same black (after Phi's composer and queue).
// A message sent while Claude works waits in the queue and goes when it's done.
// Words quoted into the chat (chatQuotes.ts) sit in the island until sent.

import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, ArrowUp, FileText, Film, Image as ImageIcon, Music, Plus, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { create } from "zustand";

import { parseQuoted, quotedMessage, removeQuote, takeQuotes, useQuotesOf, type ChatQuote } from "../lib/chatQuotes";
import { QuoteView } from "./Quotes";
import { attachFiles, detachFile, takeFiles, uploading, useFilesOf, type Accept, type ChatFile, type FileKind, type Uploader } from "../lib/chatFiles";
import { useSettled } from "../lib/settled";
import { formatBytes } from "../lib/time";
import { useEditor } from "../lib/store";
import { ClaudeMark } from "./ClaudeMark";
import { cx, ProgressRing } from "./ui";

/** The card's edge, and the island's: a shade under the app's line (Sphe, Nov 3: "a slightly darker border"). */
const EDGE = "border-[#1c1c1c]";

interface Queued {
  id: number;
  text: string;
  files: ChatFile[];
  quotes: ChatQuote[];
}

/** Messages waiting for the turn to end, per chat. */
const useQueue = create<{ chats: Record<string, Queued[]> }>(() => ({ chats: {} }));
let queuedId = 0;
const NO_QUEUE: Queued[] = [];

/** The chat's composer: a message and its files, the model it runs on, Send, Queue or Stop. */
export function ChatComposer({
  running,
  disabled,
  modelName,
  placeholder,
  onSend,
  onStop,
  draft,
  chat,
  files,
  tray,
  value,
  onValueChange,
  allowEmpty = false,
  hint,
}: {
  running: boolean;
  disabled: boolean;
  modelName: string;
  placeholder: string;
  /** The words (the quotes in front of them), the files that made it in, and the quotes. */
  onSend: (message: string, files: ChatFile[], quotes: ChatQuote[]) => void;
  onStop: () => void;
  /** Where an unsent message is kept (localStorage), if anywhere. */
  draft?: string;
  /** Which chat this is: its files and queue are its own. */
  chat: string;
  /** How this chat uploads what's attached; without it, no +. */
  files?: { upload: Uploader; accept?: Accept };
  /** On the composer's top edge with the queue: the team's notes, the agent asking to reset. */
  tray?: ReactNode;
  /** Controlled words (a chat that sets the draft from elsewhere); without it the composer keeps its own. */
  value?: string;
  onValueChange?: (value: string) => void;
  /** This chat can send with no words (a script's first build takes notes or none). */
  allowEmpty?: boolean;
  /** A quiet word at the footer's right, before Send. */
  hint?: string;
}) {
  const [own, setOwn] = useState(() => (draft === undefined ? "" : (localStorage.getItem(draft) ?? "")));
  const text = value ?? own;
  const setText = (next: string) => {
    if (onValueChange) onValueChange(next);
    if (value === undefined) setOwn(next);
  };
  const attached = useFilesOf(chat);
  const quotes = useQuotesOf(chat);
  const queue = useQueue((state) => state.chats[chat] ?? NO_QUEUE);
  // Stop takes a click only once the turn has run a moment: never the send's own second click.
  const stoppable = useSettled(running);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const armed = useFileDrag(files !== undefined);
  const [over, setOver] = useState(false);
  const toast = useEditor((state) => state.toast);
  useEffect(() => {
    if (draft === undefined) return;
    if (text) localStorage.setItem(draft, text);
    else localStorage.removeItem(draft);
  }, [draft, text]);
  // Something quoted in: the words about it go here next.
  const quoted = useRef(quotes.length);
  useEffect(() => {
    if (quotes.length > quoted.current) input.current?.focus();
    quoted.current = quotes.length;
  }, [quotes.length]);

  // The queue goes one message at a time, each once the turn before it has
  // ended. A chat that says it's running only once it's asked again (an idea,
  // a thumbnail) gets five seconds to say so before the next goes.
  const sendNow = useRef(onSend);
  sendNow.current = onSend;
  const sentAt = useRef<number | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (running) {
      sentAt.current = null;
      return;
    }
    const first = queue[0];
    if (first === undefined || disabled) return;
    const since = sentAt.current === null ? Infinity : Date.now() - sentAt.current;
    if (since < 5000) {
      const timer = setTimeout(() => setTick((n) => n + 1), 5000 - since);
      return () => clearTimeout(timer);
    }
    sentAt.current = Date.now();
    useQueue.setState(({ chats }) => ({ chats: { ...chats, [chat]: (chats[chat] ?? []).filter((one) => one.id !== first.id) } }));
    sendNow.current(first.text, first.files, first.quotes);
  }, [running, queue, disabled, chat, tick]);

  const attach = (list: File[]) => {
    if (files === undefined || list.length === 0) return;
    const refused = attachFiles(chat, list, files.upload, files.accept);
    if (refused.length > 0) toast(refused.join(" · "), "error");
  };
  const waiting = uploading(attached);
  const ready = attached.some((one) => one.state === "done");
  const canSend = (allowEmpty || text.trim() !== "" || ready) && !waiting && !disabled;
  const send = () => {
    if (!canSend) return;
    const message = text.trim() || (ready ? "Here are the files I've attached." : "");
    const given = takeFiles(chat);
    const said = takeQuotes(chat);
    const sent = quotedMessage(said, message);
    setText("");
    if (running || queue.length > 0) {
      useQueue.setState(({ chats }) => ({ chats: { ...chats, [chat]: [...(chats[chat] ?? []), { id: ++queuedId, text: sent, files: given, quotes: said }] } }));
      return;
    }
    onSend(sent, given, said);
  };
  const hasFiles = (event: DragEvent) => files !== undefined && event.dataTransfer.types.includes("Files");
  const showStop = running && !canSend;
  const islands = [
    queue.length > 0 && <QueueIsland key="queue" chat={chat} queue={queue} />,
    ...quotes.map((one) => (
      <div key={`quote-${one.id}`} className="flex items-start gap-2 px-3 pt-2 pb-1.5">
        <QuoteView from={one.from} text={one.text} className="max-h-24 overflow-y-auto" />
        <button type="button" aria-label="Remove quoted text" title="Remove quoted text" onClick={() => removeQuote(chat, one.id)} className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-fg">
          <X size={12} />
        </button>
      </div>
    )),
    tray,
  ].filter((one) => one !== false && one !== null && one !== undefined);

  return (
    // A plain form + labelled textarea: what dictation tools (Wispr Flow) look for to paste into.
    <form
      className="shrink-0 p-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      {islands.length > 0 && <div className={cx("mx-3 divide-y divide-[#1c1c1c] overflow-hidden rounded-t-xl border border-b-0 bg-black", EDGE)}>{islands}</div>}
      {/* In focus its edge goes a light grey, not white (Sphe, Nov 2: "remove the white on click like the outline make it a light gray"). */}
      <div
        className={cx(
          "relative rounded-xl border bg-black p-2.5 transition-colors",
          over ? "border-dashed border-white/50" : armed ? "border-dashed border-white/25" : cx(EDGE, "focus-within:border-line-strong"),
          disabled && "opacity-50",
        )}
        // A file dropped here is attached (and stops here, so the page's own drop doesn't take it too).
        onDragOver={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={(event) => {
          setOver(false);
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          attach([...event.dataTransfer.files]);
        }}
      >
        {attached.length > 0 && <FileRow chat={chat} files={attached} />}
        <textarea
          ref={input}
          name="message"
          aria-label="Message the agent"
          autoComplete="off"
          value={text}
          disabled={disabled}
          rows={3}
          placeholder={armed ? "Drop to attach" : placeholder}
          onChange={(event) => setText(event.target.value)}
          // A pasted screenshot is attached. Stopped here, so a page's own
          // paste listener (a thumbnail's, an idea's) doesn't attach it again.
          onPaste={(event) => {
            const pasted = [...event.clipboardData.files];
            if (files === undefined || pasted.length === 0) return;
            event.preventDefault();
            event.stopPropagation();
            attach(pasted);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
          // Dim grey, the same ink phi uses for its composer placeholder.
          className="max-h-48 min-h-[60px] w-full resize-none bg-transparent px-1 text-[13px] leading-[19px] text-fg outline-none placeholder:text-[#5b5b64]"
          style={{ height: Math.min(192, 60 + Math.max(0, text.split("\n").length - 3) * 19) }}
        />
        <div className="mt-1.5 flex items-center gap-1.5">
          {files !== undefined && (
            <>
              <button
                type="button"
                aria-label="Attach files"
                title="Attach files (or drop them here)"
                disabled={disabled}
                onClick={() => picker.current?.click()}
                className="flex size-7 items-center justify-center rounded-full bg-white/[0.08] text-secondary transition-[background,color,transform] hover:bg-white/[0.14] hover:text-fg active:scale-90 disabled:opacity-40"
              >
                <Plus size={15} strokeWidth={2.2} />
              </button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  const picked = [...(event.target.files ?? [])];
                  event.target.value = "";
                  attach(picked);
                }}
              />
            </>
          )}
          {/* A grey pill, its words light enough to read (Sphe, Nov 3). */}
          <ModelPill name={modelName} />
          {hint !== undefined && hint !== "" && <span className="ml-auto truncate text-[11.5px] text-faint">{hint}</span>}
          {showStop ? (
            <button
              type="button"
              aria-label="Stop"
              title="Stop"
              disabled={!stoppable}
              onClick={onStop}
              className="ml-auto flex size-7 items-center justify-center rounded-full bg-white text-black transition-transform active:scale-90 disabled:opacity-60"
            >
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label={running ? "Queue" : "Send"}
              title={waiting ? "Uploading the attached files…" : running ? "Queue it: sent when Claude is done" : "Send (Enter)"}
              disabled={!canSend}
              className="ml-auto flex size-7 items-center justify-center rounded-full bg-white text-black transition-[transform,opacity] active:scale-90 disabled:opacity-25"
            >
              <ArrowUp size={14} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

/** True while files from the Mac are dragged anywhere over the window (the composer shows it takes them). */
function useFileDrag(on: boolean): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!on) return;
    let depth = 0;
    const hasFiles = (event: globalThis.DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    const enter = (event: globalThis.DragEvent) => {
      if (!hasFiles(event)) return;
      depth += 1;
      setActive(true);
    };
    const leave = (event: globalThis.DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    };
    const reset = () => {
      depth = 0;
      setActive(false);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", reset, true);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", reset, true);
      window.removeEventListener("dragend", reset);
    };
  }, [on]);
  return active;
}

/** Messages waiting for the turn to end: each its words, × to take it back. */
function QueueIsland({ chat, queue }: { chat: string; queue: Queued[] }) {
  const remove = (id: number) => useQueue.setState(({ chats }) => ({ chats: { ...chats, [chat]: (chats[chat] ?? []).filter((one) => one.id !== id) } }));
  return (
    <div role="list" aria-label="Queued messages" className="px-3 pt-2 pb-1.5">
      <div className="pb-1 text-[10.5px] font-medium tracking-wide text-faint uppercase">Queued · {queue.length}</div>
      {queue.map((one) => (
        <div key={one.id} role="listitem" className="group flex min-h-7 items-center gap-2">
          <span className="line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-[18px] text-secondary" title={one.text}>
            {parseQuoted(one.text).words}
          </span>
          {one.quotes.length > 0 && <span className="shrink-0 text-[11px] text-faint">{one.quotes.length === 1 ? "1 quote" : `${one.quotes.length} quotes`}</span>}
          {one.files.length > 0 && <span className="shrink-0 text-[11px] text-faint">{one.files.length === 1 ? "1 file" : `${one.files.length} files`}</span>}
          <button
            type="button"
            aria-label="Remove the queued message"
            title="Remove"
            onClick={() => remove(one.id)}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint opacity-60 hover:bg-hover hover:text-fg group-hover:opacity-100"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

const ICONS: Record<FileKind, typeof FileText> = { video: Film, audio: Music, file: FileText, image: ImageIcon };

/** Its share sent, 0–1. */
function progress(item: ChatFile): number {
  if (item.state === "done" || item.state === "processing") return 1;
  return item.size > 0 ? Math.min(1, item.loaded / item.size) : 0;
}

function status(item: ChatFile): string {
  if (item.state === "failed") return item.error ?? "Couldn't upload";
  if (item.state === "queued") return "Waiting…";
  if (item.state === "uploading") return `${Math.round(progress(item) * 100)}%`;
  if (item.state === "processing") return "Adding…";
  return item.size > 0 ? formatBytes(item.size) : "";
}

/** The files attached to the message, inside the card above the words. */
function FileRow({ chat, files }: { chat: string; files: ChatFile[] }) {
  return (
    <div role="list" aria-label="Attached files" className="mb-2 flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
      {files.map((item) => (item.preview !== null ? <Picture key={item.id} chat={chat} item={item} /> : <FileChip key={item.id} chat={chat} item={item} />))}
    </div>
  );
}

function Remove({ chat, item, className }: { chat: string; item: ChatFile; className?: string }) {
  return (
    <button type="button" aria-label={`Remove ${item.name}`} title="Remove" onClick={() => detachFile(chat, item.id)} className={cx("flex size-5 shrink-0 items-center justify-center rounded-full", className)}>
      <X size={11} strokeWidth={2.4} />
    </button>
  );
}

function Picture({ chat, item }: { chat: string; item: ChatFile }) {
  const busy = item.state !== "done" && item.state !== "failed";
  return (
    <div role="listitem" title={`${item.name}${status(item) ? ` · ${status(item)}` : ""}`} className="group relative size-12 shrink-0 overflow-hidden rounded-lg border border-line-strong bg-raised">
      <img src={item.preview ?? undefined} alt={item.name} className={cx("size-full object-cover transition-opacity", busy && "opacity-50")} />
      {busy && (
        <span className="absolute inset-0 flex items-center justify-center">
          <ProgressRing value={progress(item)} size={20} />
        </span>
      )}
      {item.state === "failed" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-danger">
          <AlertCircle size={16} />
        </div>
      )}
      <Remove chat={chat} item={item} className="absolute top-0.5 right-0.5 bg-black/70 text-fg opacity-0 backdrop-blur group-hover:opacity-100 focus-visible:opacity-100" />
    </div>
  );
}

function FileChip({ chat, item }: { chat: string; item: ChatFile }) {
  const Icon = ICONS[item.kind];
  const failed = item.state === "failed";
  return (
    <div role="listitem" title={item.name} className={cx("relative flex h-12 w-[176px] shrink-0 items-center gap-2 overflow-hidden rounded-lg border bg-raised pr-1 pl-2", failed ? "border-danger/40" : "border-line-strong")}>
      <span className={cx("flex size-7 shrink-0 items-center justify-center rounded-md", failed ? "bg-danger-soft text-danger" : "bg-hover text-secondary")}>
        {failed ? <AlertCircle size={14} /> : <Icon size={14} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px] text-fg">{item.name}</span>
        <span className={cx("truncate text-[11px] tabular", failed ? "text-danger" : "text-faint")}>{status(item)}</span>
      </span>
      <Remove chat={chat} item={item} className="mt-1 self-start text-faint hover:bg-hover hover:text-fg" />
      {item.state === "uploading" && <span className="absolute bottom-0 left-0 h-0.5 bg-white/70 transition-[width]" style={{ width: `${progress(item) * 100}%` }} />}
    </div>
  );
}

/** The files a message carried, above the person's words in the transcript: no bubble behind them (Sphe, Nov 3). */
export function SentFiles({ files }: { files: { name: string; kind: FileKind; url: string | null }[] }) {
  return (
    <div className="mb-1 ml-8 flex max-w-[calc(100%-2rem)] flex-wrap justify-end gap-1.5 self-end">
      {files.map((one, index) => {
        if (one.url !== null) {
          return (
            <a key={index} href={one.url} target="_blank" rel="noreferrer" title={one.name} className="block overflow-hidden rounded-xl ring-1 ring-line">
              <img src={one.url} alt={one.name} className="h-24 max-w-[200px] object-cover" />
            </a>
          );
        }
        const Icon = ICONS[one.kind];
        return (
          <span key={index} title={one.name} className="flex h-9 max-w-[220px] items-center gap-2 rounded-xl border border-line px-2.5 text-[12px] text-secondary">
            <Icon size={13} className="shrink-0 text-faint" />
            <span className="truncate">{one.name}</span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * The model answering next, in a grey pill (Sphe, Nov 3), Claude's orange mark
 * before a Claude model (Nov 2). When it changes (Opus built it, Sonnet now
 * revises it: Sphe, Nov 4) the old name rolls up and out as the new one rolls
 * in, and the pill eases to the new width.
 */
function ModelPill({ name }: { name: string }) {
  const ease = [0.2, 0, 0, 1] as const;
  return (
    <motion.span
      layout
      transition={{ layout: { duration: 0.3, ease } }}
      className="flex h-7 items-center gap-1.5 overflow-hidden rounded-full bg-white/[0.08] px-2.5 text-[11.5px] font-medium text-secondary"
      title="Edit picks the model: Opus builds, Sonnet revises"
    >
      {/^(Opus|Sonnet|Haiku|Fable|Claude)\b/u.test(name) && <ClaudeMark size={12} />}
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={name}
          className="whitespace-nowrap"
          initial={{ y: 12, opacity: 0, filter: "blur(3px)" }}
          animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
          exit={{ y: -12, opacity: 0, filter: "blur(3px)" }}
          transition={{ duration: 0.3, ease }}
        >
          {name}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
}
