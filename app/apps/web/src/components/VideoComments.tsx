// Bodycam HQ's comments on the player (Sphe, Nov 11: "we borrow the
// thumbnail comments system"; "we can only set comments when we are paused";
// "areas with comments show up in the playprogress bar"): the team's notes as
// the thumbnail page's pins, over the picture at the paused frame they were
// left on. The comment tool (the note button, or Q) turns the cursor into a
// pin: a click pins a spot, a drag an area, and the comment's words go in the
// bubble there. The open ones stay pinned until the agent settles them; the
// progress bar shows where they are (VideoControls).

import { AnimatePresence } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { AppNote, NoteBox } from "../lib/api";
import { addComment, boxFrom, editComment, numbers, openComments, pictureRect, removeNote, setCommenting, setOpened, SPOT, useNotes } from "../lib/notes";
import { playhead } from "../lib/playback";
import { useEditor } from "../lib/store";
import { rate } from "../lib/types";
import { Draft, Pin, PIN_CURSOR, type PinComment } from "./CommentPins";
import { cx } from "./ui";

/** How near the playhead a comment's moment must be for its pin to show (seconds either side). */
const NEAR_S = 0.5;

const usePaused = () => useSyncExternalStore(playhead.subscribe, () => !playhead.playing);
const useFrame = () => useSyncExternalStore(playhead.subscribe, () => Math.floor(playhead.frame));

/** Where a comment's pin goes on the frame (frame px): the spot, or an area's top-left corner. */
function pinOf(box: NoteBox, width: number, height: number): { x: number; y: number } {
  const spot = box.w < SPOT && box.h < SPOT;
  return spot ? { x: (box.x + box.w / 2) * width, y: (box.y + box.h / 2) * height } : { x: box.x * width, y: box.y * height };
}

/** What its card says while it's open: where it is with the agent. */
function statusOf(note: AppNote): string {
  return note.status === "sent" ? "With the agent" : "Goes to the agent with your next message";
}

export function VideoComments({ wrap }: { wrap: HTMLDivElement | null }) {
  const settings = useEditor((state) => state.project?.settings);
  const notes = useNotes((state) => state.notes);
  const commenting = useNotes((state) => state.commenting);
  const opened = useNotes((state) => state.opened);
  const paused = usePaused();
  const frame = useFrame();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState<{ at: { x: number; y: number }; box: NoteBox; frame: number } | null>(null);
  const [drag, setDrag] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (wrap === null) return;
    const observer = new ResizeObserver(() => setSize({ width: wrap.clientWidth, height: wrap.clientHeight }));
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [wrap]);
  // Comments are left on a paused frame: playing puts the tool and an unsent comment down.
  useEffect(() => {
    if (paused) return;
    setDraft(null);
    setDrag(null);
    if (useNotes.getState().commenting) setCommenting(false);
    if (useNotes.getState().opened !== null) setOpened(null);
  }, [paused]);
  // Escape puts the tool down (an unsent comment first); Delete takes the open comment off.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))) return;
      if (event.key === "Escape") {
        if (draft !== null) setDraft(null);
        else if (opened !== null) setOpened(null);
        else if (commenting) setCommenting(false);
      } else if ((event.key === "Delete" || event.key === "Backspace") && opened !== null) {
        event.preventDefault();
        void removeNote(opened);
        setOpened(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [draft, opened, commenting]);
  // A click away from a comment puts the open one down.
  useEffect(() => {
    if (opened === null) return;
    const away = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest("[data-comment]") === null) setOpened(null);
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [opened]);
  if (settings === undefined || size.width === 0) return null;
  const bounds = { width: settings.width, height: settings.height };
  const rect = pictureRect(size.width, size.height, settings.width, settings.height);
  const scale = rect.width / settings.width;
  const near = NEAR_S * rate(settings);
  const numbered = numbers(notes);
  // The open ones at this moment, while paused (the one opened from the progress bar whatever the moment).
  const shown = paused ? openComments(notes).filter((note) => note.box !== null && (Math.abs(note.now - frame) <= near || note.id === opened)) : [];
  const outlined = shown.find((note) => (note.id === opened || note.id === hovered) && note.box !== null && !(note.box.w < SPOT && note.box.h < SPOT));
  const dragged = drag === null ? null : boxFrom(drag.a, drag.b, rect);
  const local = (event: React.PointerEvent) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const pinned = (note: AppNote): PinComment => ({
    id: note.id,
    n: numbered.get(note.id) ?? 0,
    ...pinOf(note.box!, settings.width, settings.height),
    text: note.text,
    by: note.by?.name ?? "You",
    at: note.at,
  });
  return (
    <div
      ref={layer}
      data-comment-layer
      className={cx("absolute", commenting && paused ? "pointer-events-auto" : "pointer-events-none")}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, ...(commenting && paused ? { cursor: PIN_CURSOR } : {}) }}
      onPointerDown={(event) => {
        if (!commenting || !paused || (event.target as Element).closest("[data-comment]") !== null) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = local(event);
        setDraft(null);
        setDrag({ a: point, b: point });
      }}
      onPointerMove={(event) => {
        if (drag !== null) setDrag({ ...drag, b: local(event) });
      }}
      onPointerUp={() => {
        if (drag === null) return;
        // A drag is an area (the pin at its corner); a click, a spot.
        const area = boxFrom(drag.a, drag.b, rect);
        const spot: NoteBox = { x: Math.min(1 - SPOT / 2, Math.max(0, drag.a.x / rect.width - SPOT / 4)), y: Math.min(1 - SPOT / 2, Math.max(0, drag.a.y / rect.height - SPOT / 4)), w: SPOT / 2, h: SPOT / 2 };
        const box = area ?? spot;
        setDraft({ at: pinOf(box, settings.width, settings.height), box, frame });
        setDrag(null);
      }}
    >
      {/* The area being dragged, or the open comment's. */}
      {(dragged ?? (draft !== null && !(draft.box.w < SPOT && draft.box.h < SPOT) ? draft.box : outlined?.box ?? null)) !== null && (
        <div
          className="pointer-events-none absolute rounded-[3px] border-2 border-dashed border-white/90 bg-white/5 shadow-[0_0_0_1px_#0006]"
          style={(() => {
            const box = (dragged ?? (draft !== null && !(draft.box.w < SPOT && draft.box.h < SPOT) ? draft.box : outlined!.box))!;
            return { left: box.x * rect.width, top: box.y * rect.height, width: box.w * rect.width, height: box.h * rect.height };
          })()}
        />
      )}
      {commenting && paused && draft === null && drag === null && shown.length === 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-3 mx-auto w-fit rounded-md bg-black/75 px-2.5 py-1.5 text-[11px] text-fg">Click to comment on a spot, or drag over an area</div>
      )}
      <AnimatePresence>
        {shown.map((note) => (
          <Pin
            key={note.id}
            comment={pinned(note)}
            bounds={bounds}
            scale={scale}
            opened={opened === note.id}
            movable={false}
            status={statusOf(note)}
            onOpen={() => setOpened(opened === note.id ? null : note.id)}
            onKeepOpen={() => setOpened(note.id)}
            onHover={(on) => setHovered(on ? note.id : null)}
            onEdit={(change) => {
              if (change.text !== undefined) void editComment(note.id, change.text);
            }}
            onRemove={() => {
              void removeNote(note.id);
              setOpened(null);
            }}
          />
        ))}
        {draft !== null && (
          <Draft
            key="draft"
            at={draft.at}
            bounds={bounds}
            scale={scale}
            n={notes.length + 1}
            onCancel={() => setDraft(null)}
            onSave={(text) => {
              void addComment(draft.frame, draft.box, text);
              setDraft(null);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
