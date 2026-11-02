// The Repack review’s notes on the timeline’s ruler (and the team’s own, left in Edit, in amber): each open note’s moment
// as a dot, and each fix the agent made as a band over the stretch it
// changed. Hovering shows the reviewer’s words, who said them, what the agent
// did and the version, so it’s quick to check the agent did what was asked
// ("even if we’ve forgotten what we said, we can very easily be reminded").

import { useEffect, useState } from "react";

import { api, type AppNote, type ReviewNote } from "../lib/api";
import { useNotes } from "../lib/notes";
import { RULER, useView } from "../lib/timelineView";

/** How often the review is looked at while the timeline is up. */
const REFRESH_MS = 20_000;

export function FeedbackBands({ projectId, fps }: { projectId: string; fps: number }) {
  const { ppf, scrollX } = useView();
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [shown, setShown] = useState<{ note: ReviewNote; x: number; range: [number, number] | null } | null>(null);
  useEffect(() => {
    let live = true;
    const look = () =>
      void api
        .review(projectId)
        .then((review) => live && setNotes(review.notes))
        .catch(() => {});
    look();
    const timer = setInterval(look, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [projectId]);
  const own = useNotes((state) => state.notes);
  const [ownShown, setOwnShown] = useState<{ note: AppNote; x: number; range: [number, number] | null } | null>(null);
  if (notes.length === 0 && own.length === 0) return null;
  const x = (frame: number) => frame * ppf - scrollX;
  const time = (frame: number) => {
    const seconds = Math.max(frame / fps, 0);
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  };
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {notes.flatMap((note) =>
        (note.fix?.ranges ?? []).map(([start, end], index) => (
          <div
            key={`${note.id}-${index}`}
            className="pointer-events-auto absolute h-[5px] cursor-help rounded-full bg-info/80 hover:bg-info"
            style={{ left: x(start), width: Math.max(x(end) - x(start), 3), top: RULER - 6 }}
            onPointerEnter={() => setShown({ note, x: x(start), range: [start, end] })}
            onPointerLeave={() => setShown(null)}
          />
        )),
      )}
      {notes
        .filter((note) => note.frame !== null && note.reply_to === null)
        .map((note) => (
          <div
            key={note.id}
            className={`pointer-events-auto absolute size-[9px] -translate-x-1/2 cursor-help rounded-full border border-black/60 ${note.status === "open" ? "bg-info" : "bg-info/40"}`}
            style={{ left: x(note.frame!), top: RULER - 16 }}
            onPointerEnter={() => setShown({ note, x: x(note.frame!), range: null })}
            onPointerLeave={() => setShown(null)}
          />
        ))}
      {shown !== null && (
        <>
          {shown.range !== null && (
            <div className="absolute bottom-0 bg-info-soft ring-1 ring-info/40 ring-inset" style={{ left: x(shown.range[0]), width: Math.max(x(shown.range[1]) - x(shown.range[0]), 3), top: RULER }} />
          )}
          <div
            className="absolute z-20 w-72 rounded-lg border border-line-strong bg-panel/95 p-2.5 text-[12px] leading-snug shadow-xl backdrop-blur"
            style={{ left: Math.max(shown.x, 4), top: RULER + 4 }}
          >
            <div className="mb-1 flex items-center gap-1.5 text-[11px] text-faint">
              <span className="font-medium text-fg">{shown.note.author}</span>
              <span>· v{shown.note.version}</span>
              {shown.note.frame !== null && <span>· {time(shown.note.frame)}</span>}
              <span className={shown.note.status === "open" ? "text-info" : "text-success"}>· {shown.note.status === "open" ? (shown.note.fixing ? "being fixed" : "open") : "done"}</span>
            </div>
            <div className="text-fg">“{shown.note.text}”</div>
            {shown.note.fix !== null && <div className="mt-1.5 border-t border-line pt-1.5 text-muted">Agent: {shown.note.fix.summary}</div>}
            {shown.note.unfixed !== null && <div className="mt-1.5 border-t border-line pt-1.5 text-warning">Left: {shown.note.unfixed}</div>}
          </div>
        </>
      )}
      {/* The team's own notes, left in Edit (lib/notes.ts): amber, where review notes are blue. */}
      {own.flatMap((note) =>
        (note.fix?.ranges ?? []).map(([start = 0, end = 0], index) => (
          <div
            key={`own-${note.id}-${index}`}
            className="pointer-events-auto absolute h-[5px] cursor-help rounded-full bg-warning/70 hover:bg-warning"
            style={{ left: x(start), width: Math.max(x(end) - x(start), 3), top: RULER - 6 }}
            onPointerEnter={() => setOwnShown({ note, x: x(start), range: [start, end] })}
            onPointerLeave={() => setOwnShown(null)}
          />
        )),
      )}
      {own.map((note) => (
        <div
          key={`own-${note.id}`}
          className={`pointer-events-auto absolute size-[9px] -translate-x-1/2 rotate-45 cursor-pointer rounded-[2px] border border-black/60 ${note.status === "done" ? "bg-warning/40" : "bg-warning"}`}
          style={{ left: x(note.now), top: RULER - 16 }}
          onPointerEnter={() => setOwnShown({ note, x: x(note.now), range: note.nowEnd === null ? null : [note.now, note.nowEnd] })}
          onPointerLeave={() => setOwnShown(null)}
        />
      ))}
      {ownShown !== null && (
        <>
          {ownShown.range !== null && (
            <div className="absolute bottom-0 bg-warning-soft ring-1 ring-warning/40 ring-inset" style={{ left: x(ownShown.range[0]), width: Math.max(x(ownShown.range[1]) - x(ownShown.range[0]), 3), top: RULER }} />
          )}
          <div
            className="absolute z-20 w-72 rounded-lg border border-line-strong bg-panel/95 p-2.5 text-[12px] leading-snug shadow-xl backdrop-blur"
            style={{ left: Math.max(ownShown.x, 4), top: RULER + 4 }}
          >
            <div className="mb-1 flex items-center gap-1.5 text-[11px] text-faint">
              <span className="font-medium text-fg">{ownShown.note.by?.name ?? "The team"}</span>
              <span>· in Edit</span>
              <span>· {time(ownShown.note.now)}</span>
              <span className={ownShown.note.status === "done" ? "text-success" : ownShown.note.status === "left" ? "text-warning" : "text-muted"}>
                · {{ queued: "queued", sent: "with the agent", done: "done", left: "left" }[ownShown.note.status]}
              </span>
            </div>
            <div className="text-fg">“{ownShown.note.text}”</div>
            {ownShown.note.fix !== null && <div className="mt-1.5 border-t border-line pt-1.5 text-muted">Agent: {ownShown.note.fix.summary}</div>}
            {ownShown.note.reason !== null && <div className="mt-1.5 border-t border-line pt-1.5 text-warning">Left: {ownShown.note.reason}</div>}
          </div>
        </>
      )}
    </div>
  );
}
