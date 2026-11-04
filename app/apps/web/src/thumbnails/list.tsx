// The thumbnails (Nov 2 2026): the team's, newest change first, each its
// last drawing; New thumbnail opens a fresh one, where the conversation with
// Claude starts. A thumbnail is deleted from here (its ⋯ on hover, or a right
// click): its own page has no menu. Home shows the grid in its own panel (Sphe, Nov 2:
// thumbnails "should sort of happen on that right hand side").

import { Image as ImageIcon, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { StartedBy } from "../components/StartedBy";
import { openMenu, toggleMenu, type MenuItem } from "../components/ContextMenu";
import { Button, ConfirmDialog, Pulse } from "../components/ui";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { renderUrl, thumbnailsApi, type ThumbRow } from "../lib/thumbnails";
import { Loader } from "../components/Logo";

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
  const [deleting, setDeleting] = useState<ThumbRow | null>(null);
  const toastError = useEditor((state) => state.toastError);
  const menu = (row: ThumbRow): MenuItem[] => [{ label: "Delete thumbnail", danger: true, icon: <Trash2 size={14} />, onSelect: () => setDeleting(row) }];
  if (rows === null) return <div className="flex h-full min-h-40 items-center justify-center text-[13px] text-muted">{problem ?? <Loader size={32} />}</div>;
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
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete “${deleting?.summary.title || "this thumbnail"}”?`}
        detail="It goes for everyone on the team, with its versions, pictures and conversation."
        confirm="Delete"
        onConfirm={() => {
          const row = deleting;
          setDeleting(null);
          if (row === null) return;
          setRows((list) => list?.filter((one) => one.id !== row.id) ?? null);
          void thumbnailsApi.remove(row.id).catch((error: unknown) => {
            toastError(error, "delete it");
            void load();
          });
        }}
      />
      {rows.map((row) => (
        <div
          key={row.id}
          role="button"
          tabIndex={0}
          onClick={() => navigate(`/thumbnails/${row.id}`)}
          onKeyDown={(event) => event.key === "Enter" && navigate(`/thumbnails/${row.id}`)}
          onContextMenu={(event) => openMenu(event, menu(row), { width: 190 })}
          className="group flex cursor-pointer flex-col gap-2 rounded-xl p-1.5 text-left transition-colors hover:bg-hover"
        >
          <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black ring-1 ring-line">
            {row.summary.render !== null || (row.summary.layers ?? 1) > 0 ? (
              <Drawing id={row.id} at={row.updatedAt} />
            ) : (
              <div className="flex size-full items-center justify-center text-[12px] text-faint">Nothing drawn yet</div>
            )}
            <button
              type="button"
              aria-label="More"
              onClick={(event) => {
                event.stopPropagation();
                toggleMenu(event.currentTarget, menu(row), { width: 190 });
              }}
              className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-md bg-black/70 text-white/85 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 hover:text-white focus-visible:opacity-100"
            >
              <MoreHorizontal size={15} />
            </button>
            {(row.summary.run === "running" || row.summary.run === "queued") && (
              <span className="absolute top-2 left-2 flex max-w-[calc(100%-16px)] items-center gap-1.5 rounded-full bg-black/75 px-2 py-0.5 text-[11px] text-white backdrop-blur-sm">
                <Pulse size={10} /> <span className="truncate">{row.summary.step ?? "Working"}</span>
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-2 px-0.5">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{row.summary.title}</span>
            <StartedBy by={row.createdBy} size={20} />
          </div>
        </div>
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
