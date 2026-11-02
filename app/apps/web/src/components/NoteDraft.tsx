// A note being left on the player (lib/notes.ts): at the playhead's frame (or
// the In–Out span when the playhead is in it), with a box dragged on the
// picture if wanted, written in a small bubble at the player's bottom left.
// Enter queues it in the row above the chat's composer; Esc lets it go. The agent gets the queue when someone tells it to
// implement the feedback.

import { ArrowUp, SquareDashed } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
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
 * The note, in a small bubble that pops out of the player's bottom left, just
 * above the playhead's time (Sphe, Nov 2: first "it makes no sense to have the
 * comment box be HUGE … and be in FRONT of the thing we're giving feedback
 * for", then "like a poped out buble but maybe have it more on the left but
 * make it minimal and animate in and out well"). One line: the time, the
 * note, a box to mark the spot, send. Enter queues, Esc lets it go.
 */
export function NoteDraft() {
  const draft = useNotes((state) => state.draft);
  return <AnimatePresence>{draft !== null && <NoteBubble key="note" />}</AnimatePresence>;
}

function NoteBubble() {
  const draft = useNotes((state) => state.draft);
  const fps = useEditor((state) => (state.project ? rate(state.project.settings) : 30));
  const duration = useEditor((state) => (state.project ? projectDuration(state.project) : 0));
  const span = inOutSpan(duration, useInOut());
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  // Kept while it animates out, after the draft is gone.
  const last = useRef(draft);
  if (draft !== null) last.current = draft;
  const shown = draft ?? last.current;
  if (shown === null) return null;
  const inSpan = span !== null && shown.frame >= span[0] && shown.frame < span[1];
  const where = inSpan ? `${clock(span[0], fps)}–${clock(span[1], fps)}` : clock(shown.frame, fps);
  const boxed = shown.drawing || shown.box !== null;
  const queue = async () => {
    if (text.trim() === "" || busy) return;
    setBusy(true);
    const failed = await queueNote(text);
    setBusy(false);
    if (failed !== null) setError(failed);
  };
  return (
    <motion.form
      initial={{ opacity: 0, y: 10, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.97, transition: { duration: 0.12 } }}
      transition={{ type: "spring", stiffness: 520, damping: 34, mass: 0.7 }}
      style={{ transformOrigin: "16px 100%" }}
      className="@container absolute bottom-3 left-3 z-10 w-[min(360px,calc(100%-24px))]"
      onSubmit={(event) => {
        event.preventDefault();
        void queue();
      }}
    >
      <div className="flex h-10 items-center gap-1 rounded-full border border-line-strong bg-[#161616]/95 py-1 pr-1 pl-3 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur">
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-muted tabular @max-[260px]:hidden" title={inSpan ? "On the In–Out span" : "At the playhead"}>
          <span className="size-1.5 rounded-full bg-warning" />
          {where}
        </span>
        <input
          ref={input}
          aria-label="The note"
          value={text}
          placeholder={error ?? "Add a note…"}
          title={error ?? undefined}
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
          className={cx("h-8 min-w-0 flex-1 bg-transparent px-1.5 text-[13px] text-fg outline-none placeholder:text-faint", error !== null && "placeholder:text-danger")}
        />
        <button
          type="button"
          aria-pressed={boxed}
          aria-label={shown.box !== null ? "Remove the box" : "Mark the spot on the picture"}
          title={shown.box !== null ? "Remove the box" : shown.drawing ? "Drag on the picture to mark the spot" : "Mark the spot on the picture"}
          onClick={() => (shown.box !== null ? setDraftBox(null) : setDraftBox(null, !shown.drawing))}
          className={cx("flex size-8 shrink-0 items-center justify-center rounded-full transition-colors", boxed ? "bg-warning-soft text-warning" : "text-muted hover:bg-hover hover:text-fg")}
        >
          <SquareDashed size={14} />
        </button>
        <button
          type="submit"
          aria-label="Queue"
          title={error ?? "Queue it for the agent (Enter) · Esc to cancel"}
          disabled={text.trim() === "" || busy}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white text-black transition-[transform,opacity] active:scale-90 disabled:opacity-25"
        >
          <ArrowUp size={14} strokeWidth={2.4} />
        </button>
      </div>
    </motion.form>
  );
}
