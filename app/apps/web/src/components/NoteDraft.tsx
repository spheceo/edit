// A note being left on the player (lib/notes.ts): at the playhead's frame (or
// the In–Out span when the playhead is in it), with a box dragged on the
// picture if wanted, written in the player's bar. Enter queues it in the row
// above the chat's composer; Esc lets it go. The agent gets the queue when someone tells it to
// implement the feedback.

import { CornerDownLeft, SquareDashed, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { inOutSpan, useInOut } from "../lib/inOut";
import { projectDuration } from "../lib/edit";
import { boxFrom, cancelNote, pictureRect, queueNote, setDraftBox, useNotes } from "../lib/notes";
import { useEditor } from "../lib/store";
import { rate } from "../lib/types";
import { clock } from "./NoteQueue";
import { cx } from "./ui";

/** The box being drawn, or drawn, over the picture; the drag that draws it while drawing. */
export function NoteBoxLayer({ wrap }: { wrap: HTMLDivElement | null }) {
  const draft = useNotes((state) => state.draft);
  const settings = useEditor((state) => state.project?.settings);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  useEffect(() => {
    if (wrap === null) return;
    const observer = new ResizeObserver(() => setSize({ width: wrap.clientWidth, height: wrap.clientHeight }));
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [wrap]);
  if (draft === null || settings === undefined || size.width === 0) return null;
  const rect = pictureRect(size.width, size.height, settings.width, settings.height);
  const shown = drag !== null ? boxFrom(drag.a, drag.b, rect) : draft.box;
  const at = (event: React.PointerEvent) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  return (
    <div
      className={cx("absolute", draft.drawing ? "cursor-crosshair" : "pointer-events-none")}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      onPointerDown={(event) => {
        if (!draft.drawing) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = at(event);
        setDrag({ a: point, b: point });
      }}
      onPointerMove={(event) => {
        if (drag !== null) setDrag({ ...drag, b: at(event) });
      }}
      onPointerUp={() => {
        if (drag === null) return;
        setDraftBox(boxFrom(drag.a, drag.b, rect), false);
        setDrag(null);
      }}
    >
      {draft.drawing && shown === null && (
        <div className="pointer-events-none absolute inset-x-0 top-3 mx-auto w-fit rounded-md bg-black/75 px-2.5 py-1.5 text-[11px] text-fg">Drag over what the note is about</div>
      )}
      {shown !== null && (
        <div
          className="pointer-events-none absolute rounded-sm border-2 border-warning shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]"
          style={{ left: `${shown.x * 100}%`, top: `${shown.y * 100}%`, width: `${shown.w * 100}%`, height: `${shown.h * 100}%` }}
        />
      )}
    </div>
  );
}

/**
 * The note, written in the player's own bar while it's open (Sphe, Nov 2: "it
 * makes no sense to have the comment box be HUGE and have so many details and
 * be in FRONT of the thing we're giving feedback for"): one line at the
 * transport's height in place of the transport, so the picture stays whole and
 * nothing moves. The time, the note, a box to mark the spot, Queue; Enter
 * queues, Esc lets it go.
 */
export function NoteDraft() {
  const draft = useNotes((state) => state.draft);
  const fps = useEditor((state) => (state.project ? rate(state.project.settings) : 30));
  const duration = useEditor((state) => (state.project ? projectDuration(state.project) : 0));
  const span = inOutSpan(duration, useInOut());
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const open = draft !== null;
  useEffect(() => {
    if (!open) return;
    setText("");
    setError(null);
    input.current?.focus();
  }, [open]);
  if (draft === null) return null;
  const inSpan = span !== null && draft.frame >= span[0] && draft.frame < span[1];
  const where = inSpan ? `${clock(span[0], fps)}–${clock(span[1], fps)}` : clock(draft.frame, fps);
  const boxed = draft.drawing || draft.box !== null;
  const queue = async () => {
    if (text.trim() === "" || busy) return;
    setBusy(true);
    const failed = await queueNote(text);
    setBusy(false);
    if (failed !== null) setError(failed);
  };
  return (
    <form
      className="@container flex h-11 shrink-0 items-center gap-2 border-t border-line px-3"
      onSubmit={(event) => {
        event.preventDefault();
        void queue();
      }}
    >
      {/* A narrow player (the editor squeezes it to ~140 px at 1100) keeps the note, the box and Queue: the time and × go first; Esc still cancels. */}
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[12px] text-fg tabular @max-[320px]:hidden" title={inSpan ? "The note is on the In–Out span" : "The note is at the playhead"}>
        <span className="size-1.5 rounded-full bg-warning" />
        {where}
      </span>
      <input
        ref={input}
        aria-label="The note"
        value={text}
        placeholder={error ?? "What should change here?"}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            cancelNote();
          }
        }}
        className={cx("h-7 min-w-0 flex-1 rounded-md bg-black/60 px-2.5 text-[13px] text-fg outline-none placeholder:text-faint", error !== null && "placeholder:text-danger")}
      />
      {error !== null && text !== "" && <span className="max-w-[40%] shrink truncate text-[11px] text-danger" title={error}>{error}</span>}
      <button
        type="button"
        aria-pressed={boxed}
        aria-label={draft.box !== null ? "Remove the box" : "Mark the spot on the picture"}
        title={draft.box !== null ? "Remove the box" : draft.drawing ? "Drag on the picture to mark the spot" : "Mark the spot on the picture"}
        onClick={() => (draft.box !== null ? setDraftBox(null) : setDraftBox(null, !draft.drawing))}
        className={cx("flex size-7 shrink-0 items-center justify-center rounded-md transition-colors", boxed ? "bg-warning-soft text-warning" : "text-muted hover:bg-hover hover:text-fg")}
      >
        <SquareDashed size={14} />
      </button>
      <button type="submit" aria-label="Queue" title="Queue it for the agent (Enter)" disabled={text.trim() === "" || busy} className="flex h-7 shrink-0 items-center rounded-md bg-white px-2.5 text-[12px] font-medium text-black transition-opacity disabled:opacity-30 @max-[320px]:px-1.5">
        <span className="@max-[320px]:hidden">Queue</span>
        <CornerDownLeft size={14} className="hidden @max-[320px]:block" />
      </button>
      <button type="button" aria-label="Cancel the note" title="Cancel (Esc)" onClick={cancelNote} className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-fg @max-[320px]:hidden">
        <X size={14} />
      </button>
    </form>
  );
}
