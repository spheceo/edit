// A note being left on the player (lib/notes.ts): at the playhead's frame (or
// the In–Out span when the playhead is in it), with a box dragged on the
// picture if wanted. Enter queues it in the row above the chat's composer;
// Esc lets it go. The agent gets the queue when someone tells it to
// implement the feedback.

import { Square, X } from "lucide-react";
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

/** The card the note is written in, over the bottom of the picture. */
export function NoteDraft() {
  const draft = useNotes((state) => state.draft);
  const fps = useEditor((state) => (state.project ? rate(state.project.settings) : 30));
  const duration = useEditor((state) => (state.project ? projectDuration(state.project) : 0));
  const span = inOutSpan(duration, useInOut());
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
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
  const queue = async () => {
    if (text.trim() === "" || busy) return;
    setBusy(true);
    const failed = await queueNote(text);
    setBusy(false);
    if (failed !== null) setError(failed);
  };
  return (
    <form
      className="absolute inset-x-3 bottom-3 z-10 mx-auto max-w-[520px] rounded-xl border border-line-strong bg-panel/95 p-2 shadow-2xl backdrop-blur"
      onSubmit={(event) => {
        event.preventDefault();
        void queue();
      }}
    >
      <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] text-muted">
        <span className="size-2 rounded-full bg-warning" />
        <span>
          Note at <span className="font-mono text-fg tabular">{where}</span>
          {inSpan && <span className="text-faint"> (In–Out)</span>}
        </span>
        <button type="button" aria-label="Cancel the note" title="Cancel (Esc)" onClick={cancelNote} className="ml-auto flex size-6 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-fg">
          <X size={13} />
        </button>
      </div>
      <textarea
        ref={input}
        aria-label="The note"
        value={text}
        rows={2}
        placeholder="What should change here?"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            cancelNote();
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void queue();
          }
        }}
        className="max-h-32 min-h-[40px] w-full resize-none rounded-md bg-black/60 px-2 py-1.5 text-[13px] text-fg outline-none placeholder:text-faint"
      />
      {error !== null && <div className="px-1 pt-1 text-[11px] text-danger">{error}</div>}
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          aria-pressed={draft.drawing || draft.box !== null}
          onClick={() => (draft.box !== null ? setDraftBox(null) : setDraftBox(null, !draft.drawing))}
          className={cx(
            "flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors",
            draft.drawing || draft.box !== null ? "bg-warning-soft text-warning" : "text-muted hover:bg-hover hover:text-fg",
          )}
        >
          <Square size={12} />
          {draft.box !== null ? "Remove the box" : draft.drawing ? "Drawing… (drag on the picture)" : "Draw a box"}
        </button>
        <span className="ml-auto text-[11px] text-faint">Enter to queue</span>
        <button type="submit" disabled={text.trim() === "" || busy} className="h-7 rounded-md bg-white px-3 text-[12px] font-medium text-black transition-opacity disabled:opacity-30">
          Queue
        </button>
      </div>
    </form>
  );
}
