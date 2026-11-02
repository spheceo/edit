// The team's queued notes, in a row attached to the top of the chat's
// composer (Sphe, Nov 2: "you can see it qued up in line a row just above the
// composer almost looking attatched to it"): each its moment and its words; a
// click goes there, × takes a queued one away. Notes with the agent say so
// until it answers them. Telling the agent to implement the feedback sends
// them ("i rpefer this", over a button).

import { Loader2, Square, X } from "lucide-react";

import type { AppNote } from "../lib/api";
import { queued, removeNote, useNotes } from "../lib/notes";
import { preview } from "../lib/playback";
import { useEditor } from "../lib/store";
import { rate } from "../lib/types";
import { cx } from "./ui";

/** m:ss of a frame. */
export function clock(frame: number, fps: number): string {
  const seconds = Math.max(0, Math.floor(frame / fps));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function NoteQueue() {
  const notes = useNotes((state) => state.notes);
  const fps = useEditor((state) => (state.project ? rate(state.project.settings) : 30));
  const shown = queued(notes);
  if (shown.length === 0) return null;
  const waiting = shown.filter((note) => note.status === "queued").length;
  return (
    <div role="list" aria-label="Queued notes" className="rounded-t-xl border border-b-0 border-line bg-raised px-1.5 pt-1.5 pb-1">
      <div className="flex gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none]">
        {shown.map((note) => (
          <Chip key={note.id} note={note} fps={fps} />
        ))}
      </div>
      <div className="flex items-center px-1 pt-1 text-[10.5px] text-faint">
        {waiting > 0 ? (
          <span>
            {waiting} note{waiting === 1 ? "" : "s"} queued · say <span className="text-muted">“implement the feedback”</span> to send
          </span>
        ) : (
          <span>With the agent</span>
        )}
      </div>
    </div>
  );
}

function Chip({ note, fps }: { note: AppNote; fps: number }) {
  const sent = note.status === "sent";
  return (
    <div
      role="listitem"
      className={cx(
        "group flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-lg border pl-2 text-[12px] transition-colors",
        sent ? "border-line bg-panel text-muted" : "border-warning/30 bg-warning-soft text-fg hover:border-warning/60",
        sent ? "pr-2" : "pr-0.5",
      )}
    >
      <button
        type="button"
        title={`${note.text}${note.by ? ` — ${note.by.name}` : ""}`}
        onClick={() => preview.seek(note.now)}
        className="flex min-w-0 items-center gap-1.5 text-left"
      >
        {sent ? <Loader2 size={11} className="shrink-0 animate-spin text-faint" /> : <span className="size-1.5 shrink-0 rounded-full bg-warning" />}
        <span className="shrink-0 font-mono text-[11px] text-muted tabular">
          {clock(note.now, fps)}
          {note.nowEnd !== null && `–${clock(note.nowEnd, fps)}`}
        </span>
        {note.box !== null && <Square size={10} className="shrink-0 text-warning" aria-label="with a box" />}
        <span className="truncate">{note.text}</span>
      </button>
      {!sent && (
        <button
          type="button"
          aria-label={`Remove the note at ${clock(note.now, fps)}`}
          title="Remove"
          onClick={() => void removeNote(note.id)}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint opacity-60 hover:bg-hover hover:text-fg group-hover:opacity-100"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
