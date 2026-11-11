// A comment pinned on a picture, as the thumbnail page made them (Sphe, Nov 4-5)
// and Bodycam HQ's player uses them too (Nov 11: "we borrow the thumbnail
// comments system"): the numbered bubble, its point at the bottom left on the
// spot; hovered, its words; clicked, the comment with Claude's answers, its
// words edited in place; dragged (where it can move), set elsewhere. And the
// new one being written where someone clicked.

import { MessageSquare, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";

import { ago } from "../lib/time";
import { Button, cx, IconButton, spring } from "./ui";

/** The picture's size in the units comments are placed in (a thumbnail's canvas px, a video's frame px). */
export interface Bounds {
  width: number;
  height: number;
}

/** What a pin shows of a comment. */
export interface PinComment {
  id: string;
  /** Its number, for both the team and Claude to speak of. */
  n: number;
  /** Where it's pinned, in `Bounds` units. */
  x: number;
  y: number;
  text: string;
  by: string;
  at: number;
  replies?: { by: string; text: string; at: number }[];
}

/** The cursor while commenting: a pin, its point at the bottom left where the comment goes. */
export const PIN_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><path d="M2 24V12C2 6.5 6.5 2 12 2h2c5.5 0 10 4.5 10 10s-4.5 10-10 10H4z" fill="#fff" stroke="#000" stroke-width="1.5"/><path d="M9 12h8M13 8v8" stroke="#000" stroke-width="1.8" stroke-linecap="round"/></svg>')}") 2 24, crosshair`;

/** A comment's bubble, its point at the bottom left on the spot. */
export function Bubble({ n, active, replied }: { n: number | null; active: boolean; replied?: boolean }) {
  return (
    <span className={cx("relative flex size-7 items-center justify-center rounded-full rounded-bl-none text-[12px] font-semibold shadow-[0_2px_10px_#0008] ring-2 transition-colors duration-150 tabular", active ? "bg-fg text-black ring-black" : "bg-black/85 text-white ring-white/90")}>
      {n ?? <MessageSquare size={12} />}
      {replied && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-agent ring-2 ring-black" />}
    </span>
  );
}

/** Where a comment's card goes beside its pin: to the right, or the left near the right edge; below, or above near the bottom. */
function cardSide(at: { x: number; y: number }, bounds: Bounds): string {
  return cx(at.x > bounds.width * 0.62 ? "right-full mr-2" : "left-full ml-2", at.y > bounds.height * 0.6 ? "bottom-0" : "top-0");
}

/** Past this many screen px a press on the bubble is a drag, not a click. */
const DRAG_PX = 3;

/**
 * A pinned comment (Sphe, Nov 5): its bubble dragged moves it, set where it's
 * let go; its words clicked are edited in place, Enter to save (Shift+Enter a
 * new line), Escape to leave them as they were.
 */
export function Pin({ comment, bounds, scale, opened, movable = true, status, onOpen, onKeepOpen, onHover, onEdit, onRemove }: { comment: PinComment; bounds: Bounds; scale: number; opened: boolean; movable?: boolean; status?: string; onOpen: () => void; onKeepOpen: () => void; onHover?: (hovered: boolean) => void; onEdit: (change: { x?: number; y?: number; text?: string }) => void; onRemove: () => void }) {
  const [hover, setHover] = useState(false);
  const replies = comment.replies ?? [];
  // Where the pin is while it's dragged (canvas px), and whether the press became a drag (its click then opens nothing).
  const [dragAt, setDragAt] = useState<{ x: number; y: number } | null>(null);
  // The press, and the newest spot it dragged to: read on release, where `dragAt` may not have caught up yet.
  const press = useRef<{ x: number; y: number; dragged: boolean; to: { x: number; y: number } | null } | null>(null);
  // A release that ended a drag: the click that follows it opens nothing.
  const dropped = useRef(false);
  const [editing, setEditing] = useState<string | null>(null);
  // Escape leaves the words as they were: the blur that follows saves nothing.
  const dropping = useRef(false);
  const at = dragAt ?? { x: comment.x, y: comment.y };
  const clamp = (value: number, most: number) => Math.min(most, Math.max(0, value));
  const saveText = () => {
    if (editing === null) return;
    const words = editing.trim();
    setEditing(null);
    if (words !== "" && words !== comment.text) onEdit({ text: words });
  };
  return (
    <motion.div
      data-comment
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.14 } }}
      transition={{ type: "spring", stiffness: 520, damping: 32 }}
      style={{ left: at.x * scale, top: at.y * scale, transformOrigin: "bottom left" }}
      className={cx("pointer-events-auto absolute -translate-y-full", opened || dragAt !== null || editing !== null ? "z-30" : "z-20 hover:z-30")}
      onPointerEnter={() => {
        setHover(true);
        onHover?.(true);
      }}
      onPointerLeave={() => {
        setHover(false);
        onHover?.(false);
      }}
    >
      <button
        type="button"
        aria-label={`Comment ${comment.n}`}
        onPointerDown={(event) => {
          if (event.button !== 0 || !movable) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          press.current = { x: event.clientX, y: event.clientY, dragged: false, to: null };
        }}
        onPointerMove={(event) => {
          const start = press.current;
          if (start === null) return;
          const [dx, dy] = [event.clientX - start.x, event.clientY - start.y];
          if (!start.dragged && Math.hypot(dx, dy) < DRAG_PX) return;
          start.dragged = true;
          start.to = { x: clamp(comment.x + dx / scale, bounds.width), y: clamp(comment.y + dy / scale, bounds.height) };
          setDragAt(start.to);
        }}
        onPointerUp={(event) => {
          const start = press.current;
          press.current = null;
          if (start === null) return;
          // Where it's let go, even if no move was heard at that spot.
          const [dx, dy] = [event.clientX - start.x, event.clientY - start.y];
          if (!start.dragged && Math.hypot(dx, dy) < DRAG_PX) return;
          const to = { x: clamp(comment.x + dx / scale, bounds.width), y: clamp(comment.y + dy / scale, bounds.height) };
          dropped.current = true;
          setDragAt(to);
          onEdit(to);
          // Held until the page shows where it went, so the pin doesn't jump back for a frame.
          requestAnimationFrame(() => setDragAt(null));
        }}
        onPointerCancel={() => {
          press.current = null;
          setDragAt(null);
        }}
        onClick={() => {
          if (dropped.current) {
            dropped.current = false;
            return;
          }
          onOpen();
        }}
        className={cx("block touch-none", dragAt !== null ? "cursor-grabbing" : "cursor-pointer")}
      >
        <Bubble n={comment.n} active={opened || hover} replied={replies.length > 0} />
      </button>
      <AnimatePresence>
        {(opened || hover || editing !== null) && dragAt === null && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={spring}
            // Padding, not a margin, between the pin and its card: the pointer crosses to the card without leaving it.
            className={cx("absolute", at.x > bounds.width * 0.62 ? "right-full pr-2" : "left-full pl-2", at.y > bounds.height * 0.6 ? "bottom-0" : "top-0")}
          >
            <div className="w-[264px] rounded-xl border border-line-strong bg-raised p-3 text-left shadow-[0_16px_40px_#000a]">
              <div className="flex items-center gap-2 text-[11.5px]">
                <span className="truncate font-medium text-fg">{comment.by.split(" ")[0]}</span>
                <span className="text-faint">{ago(comment.at)}</span>
                <div className="flex-1" />
                <IconButton label={opened ? "Remove the comment (Delete)" : "Remove the comment"} onClick={onRemove} className="-my-1 size-6">
                  <Trash2 size={12} />
                </IconButton>
              </div>
              {editing !== null ? (
                <textarea
                  autoFocus
                  rows={Math.min(6, Math.max(2, editing.split("\n").length))}
                  value={editing}
                  aria-label="The comment's words"
                  onFocus={(event) => event.currentTarget.setSelectionRange(event.currentTarget.value.length, event.currentTarget.value.length)}
                  onChange={(event) => setEditing(event.target.value)}
                  onBlur={() => {
                    if (dropping.current) dropping.current = false;
                    else saveText();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      dropping.current = true;
                      setEditing(null);
                    } else if (event.key === "Enter" && !event.shiftKey) {
                      // Saved as it loses focus, once.
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                  className="-mx-1 mt-1 block w-[calc(100%+8px)] resize-none rounded-md bg-hover px-1 py-0.5 text-[13px] leading-snug text-fg outline-none"
                />
              ) : (
                <p
                  title="Click to edit"
                  onClick={() => {
                    if (!opened) onKeepOpen();
                    setEditing(comment.text);
                  }}
                  className={cx("-mx-1 mt-1 cursor-text rounded-md px-1 text-[13px] leading-snug whitespace-pre-wrap text-secondary transition-colors hover:bg-hover", !opened && "line-clamp-3")}
                >
                  {comment.text}
                </p>
              )}
              {opened &&
                replies.map((reply) => (
                  <div key={reply.at} className="mt-2.5 border-t border-line pt-2.5">
                    <div className="flex items-center gap-2 text-[11.5px]">
                      <span className={cx("font-medium", reply.by === "claude" ? "text-agent" : "text-fg")}>{reply.by === "claude" ? "Claude" : reply.by.split(" ")[0]}</span>
                      <span className="text-faint">{ago(reply.at)}</span>
                    </div>
                    <p className="mt-1 text-[13px] leading-snug whitespace-pre-wrap text-secondary">{reply.text}</p>
                  </div>
                ))}
              {!opened && replies.length > 0 && <p className="mt-1.5 text-[11.5px] text-agent">Claude answered</p>}
              {status !== undefined && replies.length === 0 && <p className="mt-1.5 text-[11.5px] text-faint">{status}</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** A new comment where the person clicked: its words, Enter to leave it, Escape to drop it. */
export function Draft({ at, bounds, scale, n, placeholder = "What should change here?", onCancel, onSave }: { at: { x: number; y: number }; bounds: Bounds; scale: number; n: number; placeholder?: string; onCancel: () => void; onSave: (text: string) => void }) {
  const [text, setText] = useState("");
  const save = () => {
    if (text.trim() !== "") onSave(text);
  };
  return (
    <motion.div
      data-comment
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.12 } }}
      transition={{ type: "spring", stiffness: 520, damping: 32 }}
      style={{ left: at.x * scale, top: at.y * scale, transformOrigin: "bottom left", cursor: "auto" }}
      className="pointer-events-auto absolute z-40 -translate-y-full"
    >
      <Bubble n={n} active />
      <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={spring} className={cx("absolute w-[280px] rounded-xl border border-line-strong bg-raised p-2 shadow-[0_16px_40px_#000a]", cardSide(at, bounds))}>
        <textarea
          autoFocus
          rows={2}
          value={text}
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onCancel();
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              save();
            }
          }}
          className="block w-full resize-none bg-transparent px-1.5 py-1 text-[13px] leading-snug text-fg outline-none placeholder:text-faint"
        />
        <div className="flex items-center justify-end gap-1.5 pt-1">
          <Button variant="light" size="sm" disabled={text.trim() === ""} onClick={save}>
            Comment
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

