// The composer every chat on the right shares: the editor's, an idea's and a
// thumbnail's (Sphe, Nov 3: "the changes we've made to ui and files
// functionality on the composer must apply to ALL chat's"). One card, its
// corners always round, a shade darker at the edge; files attached sit inside
// it above the words (+ opens Finder, a drop or a paste attaches); what's
// attached to the chat rather than the message (queued messages, the team's
// notes, the agent asking to reset) sits in an island on its top edge, inset
// from its sides and the same black (after Phi's composer and queue).
// A message sent while Claude works waits in the queue and goes when it's done
// (a Bodycam HQ chat's waits on the server, which sends it: `hq`).
// Words quoted into the chat (chatQuotes.ts) sit in the island until sent.

import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, ArrowUp, Check, FileText, Film, Image as ImageIcon, Music, Plus, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { create } from "zustand";

import { inlineQuote, parseQuoted, quoteLabel, quotedMessage, removeQuote, restoreQuote, takeQuotes, useQuotesOf, type ChatQuote } from "../lib/chatQuotes";
import { CHIP, MARK } from "./Quotes";
import { attachFiles, detachFile, takeFiles, uploading, useFilesOf, type Accept, type ChatFile, type FileKind, type Uploader } from "../lib/chatFiles";
import { useSettled } from "../lib/settled";
import { formatBytes } from "../lib/time";
import { useEditor } from "../lib/store";
import { ClaudeMark } from "./ClaudeMark";
import { DEFAULT_EFFORT, EFFORTS, effortName, HQ_EFFORT, HQ_MODELS, hqModel, modelFor, REVISION_MODELS } from "@edit/types/models";
import { loadModelChoice, pickModel, useModelChoice } from "../lib/models";
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
/**
 * A queued message waits this long after the turn ends: Edit's own next turn
 * (a follow-up, agent.ts followLater, a second on) goes first, and the queue
 * waits for it rather than racing it ("the agent is still working").
 */
const AFTER_TURN_MS = 2000;
/** And this long after it sent one: a chat that says it's running only once it's asked again (an idea, a thumbnail) has time to say so. */
const AFTER_SEND_MS = 5000;
let queuedId = 0;
const NO_QUEUE: Queued[] = [];

/**
 * A chip's mark in the words as an earlier build saved them (Nov 12's dev
 * builds): read back, it showed as a stray number.
 */
const OLD_MARK = /\u2063\d+\u2063/gu;

/**
 * The box's words as typed (`full`: each chip as its quote, as Claude reads
 * it, in place; else the words alone, as a draft keeps them): text and line
 * breaks in order, a block the browser made for a new line its break.
 */
function read(box: HTMLElement, quotes: readonly ChatQuote[], full = false): string {
  let out = "";
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child instanceof HTMLElement && child.dataset.quoteId !== undefined) {
        const quote = quotes.find((one) => one.id === Number(child.dataset.quoteId));
        if (quote !== undefined && full) out += inlineQuote(quote);
      } else if (child.nodeType === Node.TEXT_NODE) {
        out += (child.textContent ?? "").replace(/\u00a0/gu, " ");
      } else if (child.nodeName === "BR") {
        out += "\n";
      } else {
        if ((child.nodeName === "DIV" || child.nodeName === "P") && out !== "" && !out.endsWith("\n")) out += "\n";
        walk(child);
      }
    }
  };
  walk(box);
  return full || out.trim() !== "" ? out : "";
}

/** What a copy or cut of the box takes: the words, each chip its quote's words in quotation marks. */
function copied(range: Range, quotes: readonly ChatQuote[]): string {
  const part = document.createElement("div");
  part.append(range.cloneContents());
  for (const chip of part.querySelectorAll<HTMLElement>("[data-quote-id]")) {
    const quote = quotes.find((one) => one.id === Number(chip.dataset.quoteId));
    chip.replaceWith(quote === undefined ? "" : `\u201c${quote.text}\u201d`);
  }
  return read(part, []);
}

/** A quote's chip in the editable box: built as DOM (React doesn't own what's typed there), the look of QuoteChip's. */
function chipOf(quote: ChatQuote, onRemove: () => void): HTMLElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.quoteId = String(quote.id);
  chip.className = `${CHIP} group/chip`;
  chip.title = `${quoteLabel(quote.from)}: ${quote.text}`;
  const mark = document.createElement("span");
  mark.className = MARK;
  mark.textContent = "\u201c";
  const words = document.createElement("span");
  words.className = "truncate";
  words.textContent = quote.text.replace(/\s+/gu, " ");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.ariaLabel = "Remove the quote";
  remove.className = "-mr-0.5 hidden size-4 shrink-0 items-center justify-center rounded text-[#8fb0ff]/70 group-hover/chip:flex hover:text-white";
  remove.textContent = "\u00d7";
  remove.addEventListener("mousedown", (event) => event.preventDefault());
  remove.addEventListener("click", onRemove);
  chip.append(mark, words, remove);
  return chip;
}

/** The chat's composer: a message and its files, the model it runs on, Send, Queue or Stop. */
export function ChatComposer({
  running,
  disabled,
  modelName,
  revising,
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
  hq = false,
}: {
  running: boolean;
  disabled: boolean;
  /** Who answers next, where the chat knows better than the menu's rule (the editor's: the server says). */
  modelName?: string;
  /** This chat has the model menu: whether its next turn is a revision (the model's the person's pick) or a build (always Opus). Without it, `modelName` alone (thumbnails). */
  revising?: boolean;
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
  /**
   * A Bodycam HQ chat (Edit V2): its own model menu, every model at any time,
   * and a message sent while it works goes to `onSend` at once, for the server
   * to queue (shown in `tray`), rather than waiting here.
   */
  hq?: boolean;
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
  const input = useRef<HTMLDivElement>(null);
  // The box's words as last read from it, so a change from outside (`value`) is told apart from typing.
  const shown = useRef("");
  // Quotes whose chip was deleted in the box, for an undo that brings the chip back.
  const dropped = useRef(new Map<number, ChatQuote>());
  const [empty, setEmpty] = useState(text === "");
  const picker = useRef<HTMLInputElement>(null);
  const armed = useFileDrag(files !== undefined);
  const [over, setOver] = useState(false);
  const toast = useEditor((state) => state.toast);
  useEffect(() => {
    if (draft === undefined) return;
    // The words alone: a chip's quote lives in the chat's quotes, not the draft.
    const words = text.replace(OLD_MARK, "");
    if (words.trim()) localStorage.setItem(draft, words);
    else localStorage.removeItem(draft);
  }, [draft, text]);
  // The words put in from outside (a draft brought back, a chat that sets them, a send that clears them): into the box.
  useEffect(() => {
    const box = input.current;
    if (box === null || text === shown.current) return;
    for (const node of [...box.childNodes]) if (!(node instanceof HTMLElement && node.dataset.quoteId !== undefined)) node.remove();
    const words = text.replace(OLD_MARK, "");
    if (words !== "") box.append(document.createTextNode(words));
    shown.current = read(box, quotes);
    setEmpty(shown.current === "");
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  // Something quoted in: a chip where the caret is (or at the end), the words about it typed next to it; one taken out
  // of the store (sent, removed) leaves the box.
  useEffect(() => {
    const box = input.current;
    if (box === null) return;
    const inBox = new Set([...box.querySelectorAll<HTMLElement>("[data-quote-id]")].map((chip) => Number(chip.dataset.quoteId)));
    for (const chip of box.querySelectorAll<HTMLElement>("[data-quote-id]")) if (!quotes.some((one) => one.id === Number(chip.dataset.quoteId))) chip.remove();
    const fresh = quotes.filter((one) => !inBox.has(one.id));
    if (fresh.length > 0) {
      const selection = window.getSelection();
      let range = selection !== null && selection.rangeCount > 0 && box.contains(selection.getRangeAt(0).startContainer) ? selection.getRangeAt(0) : null;
      if (range === null) {
        range = document.createRange();
        range.selectNodeContents(box);
        range.collapse(false);
      }
      for (const quote of fresh) {
        // Taken out by its ×, it's gone for good: an undo doesn't bring it back.
        const chip = chipOf(quote, () => {
          dropped.current.delete(quote.id);
          removeQuote(chat, quote.id);
        });
        const space = document.createTextNode("\u00a0");
        range.insertNode(space);
        range.insertNode(chip);
        range.setStartAfter(space);
        range.collapse(true);
      }
      box.focus();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    shown.current = read(box, quotes);
    setEmpty(shown.current === "" && quotes.length === 0);
  }, [quotes, chat]);

  // The queue goes one message at a time, each once the turn before it has
  // ended and nothing of Edit's own follows it (AFTER_TURN_MS). Sent from a
  // timer, never from the effect itself: a send in the commit that saw the
  // turn end set the chat running again inside it.
  const sendNow = useRef(onSend);
  sendNow.current = onSend;
  const wasRunning = useRef(running);
  const nextAt = useRef(0);
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      return;
    }
    if (wasRunning.current) {
      wasRunning.current = false;
      nextAt.current = Math.max(nextAt.current, Date.now() + AFTER_TURN_MS);
    }
    if (queue.length === 0 || disabled) return;
    const timer = setTimeout(() => {
      const first = useQueue.getState().chats[chat]?.[0];
      if (first === undefined) return;
      nextAt.current = Date.now() + AFTER_SEND_MS;
      useQueue.setState(({ chats }) => ({ chats: { ...chats, [chat]: (chats[chat] ?? []).filter((one) => one.id !== first.id) } }));
      sendNow.current(first.text, first.files, first.quotes);
    }, Math.max(0, nextAt.current - Date.now()));
    return () => clearTimeout(timer);
  }, [running, queue, disabled, chat]);

  const attach = (list: File[]) => {
    if (files === undefined || list.length === 0) return;
    const refused = attachFiles(chat, list, files.upload, files.accept);
    if (refused.length > 0) toast(refused.join(" · "), "error");
  };
  const waiting = uploading(attached);
  const ready = attached.some((one) => one.state === "done");
  const canSend = (allowEmpty || text.trim() !== "" || quotes.length > 0 || ready) && !waiting && !disabled;
  const send = () => {
    if (!canSend) return;
    // The words with each quote where it was put (a quote whose chip is gone from the box goes in front, as before).
    const box = input.current;
    const placed = box === null ? "" : read(box, quotes, true).trim();
    const loose = quotes.filter((one) => box === null || box.querySelector(`[data-quote-id="${one.id}"]`) === null);
    const given = takeFiles(chat);
    const said = takeQuotes(chat);
    const words = placed || (ready && said.length === 0 ? "Here are the files I've attached." : "");
    const sent = quotedMessage(loose, words);
    shown.current = "";
    dropped.current.clear();
    if (box !== null) box.replaceChildren();
    setEmpty(true);
    setText("");
    if (!hq && (running || queue.length > 0)) {
      useQueue.setState(({ chats }) => ({ chats: { ...chats, [chat]: [...(chats[chat] ?? []), { id: ++queuedId, text: sent, files: given, quotes: said }] } }));
      return;
    }
    onSend(sent, given, said);
  };
  const copyOut = (event: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", copied(selection.getRangeAt(0), quotes));
    // Deleted as typing deletes, so it's undone as typing is (and the box is read again).
    if (cut) document.execCommand("delete");
  };
  const hasFiles = (event: DragEvent) => files !== undefined && event.dataTransfer.types.includes("Files");
  const showStop = running && !canSend;
  const unqueue = (id: string | number) => useQueue.setState(({ chats }) => ({ chats: { ...chats, [chat]: (chats[chat] ?? []).filter((one) => one.id !== id) } }));
  const islands = [
    queue.length > 0 && <QueueIsland key="queue" rows={queue.map((one) => ({ id: one.id, text: one.text, files: one.files.length, quotes: one.quotes.length }))} onRemove={unqueue} />,
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
        {/* An editable box of plain text with the quotes as chips among the words (Sphe, Nov 12), labelled as a text box
            for dictation (Wispr Flow) to type into. */}
        <div className="relative">
          {empty && <div className="pointer-events-none absolute inset-x-1 top-0 text-[13px] leading-[19px] text-[#5b5b64]">{armed ? "Drop to attach" : placeholder}</div>}
          <div
            ref={input}
            role="textbox"
            aria-multiline="true"
            aria-label="Message the agent"
            aria-disabled={disabled}
            contentEditable={disabled ? false : "plaintext-only"}
            suppressContentEditableWarning
            onInput={() => {
              const box = input.current;
              if (box === null) return;
              // A chip deleted (Backspace) takes its quote with it, and one an undo brings back brings it back; a chip
              // with no quote to bring back leaves, so what's shown is what's sent.
              const chips = [...box.querySelectorAll<HTMLElement>("[data-quote-id]")];
              const left = new Set(chips.map((chip) => Number(chip.dataset.quoteId)));
              for (const one of quotes) {
                if (left.has(one.id)) continue;
                dropped.current.set(one.id, one);
                removeQuote(chat, one.id);
              }
              const live = quotes.filter((one) => left.has(one.id));
              for (const chip of chips) {
                const id = Number(chip.dataset.quoteId);
                if (live.some((one) => one.id === id)) continue;
                const back = dropped.current.get(id);
                if (back === undefined) chip.remove();
                else {
                  restoreQuote(chat, back);
                  live.push(back);
                }
              }
              shown.current = read(box, live);
              setEmpty(shown.current === "" && live.length === 0);
              setText(shown.current);
            }}
            // A pasted screenshot is attached. Stopped here, so a page's own
            // paste listener (a thumbnail's, an idea's) doesn't attach it again.
            onPaste={(event) => {
              const pasted = [...event.clipboardData.files];
              if (files === undefined || pasted.length === 0) return;
              event.preventDefault();
              event.stopPropagation();
              attach(pasted);
            }}
            // A chip copies as its quote's words in quotation marks, not as its look (“…×).
            onCopy={(event) => copyOut(event, false)}
            onCut={(event) => copyOut(event, true)}
            onKeyDown={(event) => {
              event.stopPropagation();
              // An Enter that picks an input method's word (Japanese, Chinese, Korean) isn't a send: WebKit has ended
              // the composition by then (`isComposing` false) but still marks the key 229.
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (event.nativeEvent as { keyCode?: number }).keyCode !== 229) {
                event.preventDefault();
                send();
              }
            }}
            className="max-h-48 min-h-[60px] w-full overflow-y-auto px-1 text-[13px] leading-[19px] break-words whitespace-pre-wrap text-fg outline-none aria-disabled:opacity-50"
          />
        </div>
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
          {/* A grey pill, its words light enough to read (Sphe, Nov 3); a chat with the model menu opens it there. */}
          {hq ? <ModelMenu name={modelName} revising={false} hq /> : revising === undefined ? <ModelPill name={modelName ?? ""} /> : <ModelMenu name={modelName} revising={revising} />}
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

/** A queued message as the island shows it. */
export interface QueueRow {
  id: string | number;
  text: string;
  files: number;
  quotes: number;
}

/**
 * Messages waiting for the turn to end: each its words, × to take it back,
 * and, where the chat can (`onSteer`: Bodycam HQ's, queued on the server),
 * Steer, which stops the turn and sends it now.
 */
export function QueueIsland({ rows, onRemove, onSteer }: { rows: QueueRow[]; onRemove: (id: QueueRow["id"]) => void; onSteer?: (id: QueueRow["id"]) => void }) {
  return (
    <div role="list" aria-label="Queued messages" className="px-3 pt-2 pb-1.5">
      <div className="pb-1 text-[10.5px] font-medium tracking-wide text-faint uppercase">Queued · {rows.length}</div>
      {rows.map((one) => (
        <div key={one.id} role="listitem" className="group flex min-h-7 items-center gap-2">
          <span className="line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-[18px] text-secondary" title={one.text}>
            {parseQuoted(one.text).words}
          </span>
          {one.quotes > 0 && <span className="shrink-0 text-[11px] text-faint">{one.quotes === 1 ? "1 quote" : `${one.quotes} quotes`}</span>}
          {one.files > 0 && <span className="shrink-0 text-[11px] text-faint">{one.files === 1 ? "1 file" : `${one.files} files`}</span>}
          {onSteer !== undefined && (
            <button
              type="button"
              title="Stop the agent and send this now"
              onClick={() => onSteer(one.id)}
              className="flex h-6 shrink-0 items-center rounded-md px-1.5 text-[11.5px] font-medium text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              Steer
            </button>
          )}
          <button
            type="button"
            aria-label="Remove the queued message"
            title="Remove"
            onClick={() => onRemove(one.id)}
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
/** The model's name, rolling to the next when it changes. */
function RollingName({ name }: { name: string }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={name}
        className="whitespace-nowrap"
        initial={{ y: 12, opacity: 0, filter: "blur(3px)" }}
        animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
        exit={{ y: -12, opacity: 0, filter: "blur(3px)" }}
        transition={{ duration: 0.3, ease: EASE }}
      >
        {name}
      </motion.span>
    </AnimatePresence>
  );
}

const EASE = [0.2, 0, 0, 1] as const;

/** Who answers, where nobody picks it (thumbnails: always Opus). */
function ModelPill({ name }: { name: string }) {
  return (
    <motion.span layout transition={{ layout: { duration: 0.3, ease: EASE } }} className="flex h-7 items-center gap-1.5 overflow-hidden rounded-full bg-white/[0.08] px-2.5 text-[11.5px] font-medium text-secondary">
      {/\b(Opus|Sonnet|Haiku|Fable|Claude)\b/u.test(name) && <ClaudeMark size={12} />}
      <RollingName name={name} />
    </motion.span>
  );
}

/**
 * Who answers and how hard it thinks, and the menu to change them (prototype
 * B in a box, Sphe, Nov 7): the revisions' model with Claude's mark, then the
 * thinking levels, Medium marked as the default. While the chat is being built
 * the models aren't offered (a build is always Opus's). One pick for every
 * chat on this computer (lib/models.ts). A Bodycam HQ chat's (`hq`) offers
 * every model at any time, on its own pick (Fable 5.2 at High until picked).
 */
function ModelMenu({ name: given, revising, hq = false }: { name?: string; revising: boolean; hq?: boolean }) {
  const [open, setOpen] = useState(false);
  const choice = useModelChoice();
  // Bodycam HQ's own pick (Edit V2): every model, at any time, apart from the other chats'.
  const models = hq ? HQ_MODELS : revising ? REVISION_MODELS : [];
  const model = hq ? choice.hq_model : choice.revision;
  const effort = hq ? choice.hq_effort : choice.effort;
  const name = given || (hq ? hqModel(choice) : modelFor(revising, choice)).name;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => void loadModelChoice(), []);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  const row = "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px] text-fg transition-colors hover:bg-menu-hover";
  const tick = (on: boolean) => <span className="flex w-3.5 shrink-0 justify-center">{on && <Check size={13} strokeWidth={2.6} />}</span>;
  return (
    <div ref={box} className="relative">
      <motion.button
        type="button"
        layout
        transition={{ layout: { duration: 0.3, ease: EASE } }}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={cx(
          "flex h-7 items-center gap-1.5 overflow-hidden rounded-full px-2.5 text-[11.5px] font-medium transition-colors",
          open ? "bg-white/[0.14] text-fg" : "bg-white/[0.08] text-secondary hover:bg-white/[0.14] hover:text-fg",
        )}
      >
        <ClaudeMark size={12} />
        <RollingName name={name} />
        <span className="text-[#5b5b64]">·</span>
        <RollingName name={effortName(effort)} />
      </motion.button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: 4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.97 }}
            transition={{ duration: 0.16, ease: EASE }}
            style={{ transformOrigin: "20% 100%" }}
            className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-[216px] rounded-xl border border-line bg-raised p-[5px] shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
          >
            {models.length > 0 && (
              <>
                {models.map((one) => (
                  <button key={one.id} type="button" role="menuitemradio" aria-checked={model === one.id} className={row} onClick={() => void pickModel(hq ? { hq_model: one.id } : { revision: one.id })}>
                    {tick(model === one.id)}
                    <ClaudeMark size={13} />
                    {one.name}
                  </button>
                ))}
                <div className="mx-0.5 my-[5px] h-px bg-line" />
              </>
            )}
            {EFFORTS.map((level) => (
              <button key={level} type="button" role="menuitemradio" aria-checked={effort === level} className={row} onClick={() => void pickModel(hq ? { hq_effort: level } : { effort: level })}>
                {tick(effort === level)}
                {effortName(level)}
                {level === (hq ? HQ_EFFORT : DEFAULT_EFFORT) && <span className="ml-auto text-[11px] text-faint">Default</span>}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
