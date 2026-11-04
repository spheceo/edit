// Add to chat over words selected on a page, as the script's own pill does
// (writer/script-selection.tsx). A page opts in by rendering this once and
// marking what can be quoted with `data-quote` (what it's from, as Claude
// reads it: "title 2", "the thumbnail guide"); a selection across several
// marked pieces is from the nearest mark holding them all ("the titles").
// The quote goes to the chat's composer (chatQuotes.ts), and the chat opens.

import { Quote } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { addQuote } from "../lib/chatQuotes";
import { useEditor } from "../lib/store";

type Picked = { from: string; text: string; left: number; top: number };

const markOf = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-quote]") ?? null;

/**
 * The innermost mark holding all the selected words: where it starts or ends
 * when the words are all there (a triple-click runs on to the start of the next
 * title), or else the nearest mark holding the whole selection.
 */
function innermost(range: Range, text: string): HTMLElement | null {
  for (const mark of [markOf(range.startContainer), markOf(range.endContainer)]) {
    if (mark === null) continue;
    const inside = range.cloneRange();
    if (!mark.contains(range.startContainer)) inside.setStart(mark, 0);
    if (!mark.contains(range.endContainer)) inside.setEnd(mark, mark.childNodes.length);
    if (inside.toString().trim() === text) return mark;
  }
  return markOf(range.commonAncestorContainer);
}

/** The marked piece the selection sits in, and its words; null when it's in none (or in a field). */
function picked(): Picked | null {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const text = selection.toString().trim();
  const mark = innermost(range, text);
  const from = mark?.dataset.quote;
  if (from === undefined || from === "" || text === "") return null;
  const box = range.getClientRects()[0] ?? range.getBoundingClientRect();
  return { from, text, left: box.left + box.width / 2, top: box.top };
}

export function QuoteSelection({ chat }: { chat: string }) {
  const [shown, setShown] = useState<Picked | null>(null);
  const pill = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Read once the pointer's up (not mid-drag), and on a keyboard selection.
    const read = () => setShown(picked());
    const change = () => {
      if (window.getSelection()?.isCollapsed !== false) setShown(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShown(null);
      else if (event.shiftKey) read();
    };
    const away = () => setShown(null);
    document.addEventListener("pointerup", read);
    document.addEventListener("selectionchange", change);
    document.addEventListener("keyup", key);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("pointerup", read);
      document.removeEventListener("selectionchange", change);
      document.removeEventListener("keyup", key);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, []);
  if (shown === null) return null;
  const width = pill.current?.offsetWidth ?? 112;
  return createPortal(
    <div
      ref={pill}
      role="toolbar"
      aria-label="Selected text"
      className="fixed z-[70] rounded-[10px] border border-line-strong bg-raised p-[3px] shadow-[0_12px_32px_#0009]"
      style={{ left: Math.max(8, Math.min(shown.left - width / 2, window.innerWidth - width - 8)), top: Math.max(8, shown.top - 42) }}
      // Keeps the selection while the pill is pressed.
      onMouseDown={(event) => event.preventDefault()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => {
          addQuote(chat, { from: shown.from, text: shown.text });
          window.getSelection()?.removeAllRanges();
          setShown(null);
          if (!useEditor.getState().showAgent) useEditor.getState().toggle("showAgent");
        }}
        className="flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-[12px] whitespace-nowrap text-secondary transition-colors hover:bg-hover hover:text-fg"
      >
        <Quote size={13} />
        Add to chat
      </button>
    </div>,
    document.body,
  );
}
