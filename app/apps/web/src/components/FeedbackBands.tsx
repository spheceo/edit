// The Repack review's notes on the timeline's ruler: each open note's moment
// as a dot, and each fix the agent made as a band over the stretch it
// changed. Hovering shows the reviewer's words, who said them, what the agent
// did and the version, so it's quick to check the agent did what was asked
// ("even if we've forgotten what we said, we can very easily be reminded").

import { useEffect, useState } from "react";

import { api, type ReviewNote } from "../lib/api";
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
  if (notes.length === 0) return null;
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
            className="pointer-events-auto absolute h-[5px] cursor-help rounded-full bg-sky-400/80 hover:bg-sky-300"
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
            className={`pointer-events-auto absolute size-[9px] -translate-x-1/2 cursor-help rounded-full border border-black/60 ${note.status === "open" ? "bg-sky-300" : "bg-sky-700"}`}
            style={{ left: x(note.frame!), top: RULER - 16 }}
            onPointerEnter={() => setShown({ note, x: x(note.frame!), range: null })}
            onPointerLeave={() => setShown(null)}
          />
        ))}
      {shown !== null && (
        <>
          {shown.range !== null && (
            <div className="absolute bottom-0 bg-sky-400/10 ring-1 ring-sky-400/40 ring-inset" style={{ left: x(shown.range[0]), width: Math.max(x(shown.range[1]) - x(shown.range[0]), 3), top: RULER }} />
          )}
          <div
            className="absolute z-20 w-72 rounded-lg border border-line-strong bg-panel/95 p-2.5 text-[12px] leading-snug shadow-xl backdrop-blur"
            style={{ left: Math.max(shown.x, 4), top: RULER + 4 }}
          >
            <div className="mb-1 flex items-center gap-1.5 text-[11px] text-faint">
              <span className="font-medium text-fg">{shown.note.author}</span>
              <span>· v{shown.note.version}</span>
              {shown.note.frame !== null && <span>· {time(shown.note.frame)}</span>}
              <span className={shown.note.status === "open" ? "text-sky-300" : "text-green-300"}>· {shown.note.status === "open" ? (shown.note.fixing ? "being fixed" : "open") : "done"}</span>
            </div>
            <div className="text-fg">“{shown.note.text}”</div>
            {shown.note.fix !== null && <div className="mt-1.5 border-t border-line pt-1.5 text-muted">Agent: {shown.note.fix.summary}</div>}
            {shown.note.unfixed !== null && <div className="mt-1.5 border-t border-line pt-1.5 text-amber-300">Left: {shown.note.unfixed}</div>}
          </div>
        </>
      )}
    </div>
  );
}
