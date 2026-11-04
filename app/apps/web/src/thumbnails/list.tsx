// The thumbnails (Nov 2 2026): the team's, newest change first, each its
// last drawing; New thumbnail opens a fresh one, where the conversation with
// Claude starts. Home shows the grid in its own panel (Sphe, Nov 2:
// thumbnails "should sort of happen on that right hand side").

import { Image as ImageIcon, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { StartedBy } from "../components/StartedBy";
import { Button, Spinner } from "../components/ui";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { renderUrl, thumbnailsApi, type ThumbRow } from "../lib/thumbnails";

/** New thumbnail: makes one and opens it. */
export function useMakeThumbnail(): { making: boolean; make: () => void } {
  const [making, setMaking] = useState(false);
  const toastError = useEditor((state) => state.toastError);
  const make = () => {
    setMaking(true);
    void thumbnailsApi
      .create()
      .then(({ id }) => navigate(`/thumbnails/${id}`))
      .catch((error: unknown) => toastError(error, "start a thumbnail"))
      .finally(() => setMaking(false));
  };
  return { making, make };
}

/** The thumbnails' grid (or the way to the first), looked at again every 10 s. */
export function ThumbnailGrid({ making, onMake }: { making: boolean; onMake: () => void }) {
  const [rows, setRows] = useState<ThumbRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(
    () =>
      thumbnailsApi
        .list()
        .then(({ thumbnails }) => {
          setRows(thumbnails);
          setProblem(null);
        })
        .catch((error: unknown) => setProblem((error as Error).message)),
    [],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 10_000);
    return () => clearInterval(timer);
  }, [load]);
  if (rows === null) return <div className="flex h-full min-h-40 items-center justify-center text-[13px] text-muted">{problem ?? <Spinner size={20} />}</div>;
  if (rows.length === 0) {
    return (
      <div className="mt-[14vh] flex flex-col items-center text-center">
        <ImageIcon size={36} className="text-faint" />
        <h2 className="mt-5 text-[20px] font-semibold tracking-[-0.02em]">Make a thumbnail with Claude</h2>
        <p className="mt-2 max-w-[400px] text-muted">Give it a frame or a thumbnail to start from, or describe one. It makes pictures on the team's OpenArt account, cleans the base of overlays, and lays out the REC overlay and captions as the team does.</p>
        <Button variant="light" className="mt-6" disabled={making} onClick={onMake}>
          <Plus size={15} strokeWidth={2.2} /> New thumbnail
        </Button>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4 p-5">
      {rows.map((row) => (
        <button key={row.id} onClick={() => navigate(`/thumbnails/${row.id}`)} className="group flex flex-col gap-2 rounded-xl p-1.5 text-left transition-colors hover:bg-hover">
          <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black ring-1 ring-line">
            {row.summary.render !== null || (row.summary.layers ?? 1) > 0 ? (
              <Drawing id={row.id} at={row.updatedAt} />
            ) : (
              <div className="flex size-full items-center justify-center text-[12px] text-faint">Nothing drawn yet</div>
            )}
            {(row.summary.run === "running" || row.summary.run === "queued") && (
              <span className="absolute top-2 left-2 flex max-w-[calc(100%-16px)] items-center gap-1.5 rounded-full bg-black/75 px-2 py-0.5 text-[11px] text-white backdrop-blur-sm">
                <Spinner size={10} /> <span className="truncate">{row.summary.step ?? "Working"}</span>
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-2 px-0.5">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{row.summary.title}</span>
            <StartedBy by={row.createdBy} size={20} />
          </div>
        </button>
      ))}
    </div>
  );
}

/** The thumbnail as its canvas is now: the drawing kept, or drawn by the server when none was. */
function Drawing({ id, at }: { id: string; at: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [at]);
  if (failed) return <div className="flex size-full items-center justify-center text-[12px] text-faint">Nothing drawn yet</div>;
  return <img src={renderUrl(id, at)} alt="" loading="lazy" onError={() => setFailed(true)} className="size-full object-cover" />;
}
