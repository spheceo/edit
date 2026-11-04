// Folders on the Mac running Edit (`/api/fs`, so it works over Tailscale too),
// browsed the same way wherever Edit asks for one: importing media, and where
// exports go.

import { AudioLines, ChevronRight, Film, Folder, HardDrive } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { api, type FsEntry, type FsListing } from "../lib/api";
import { formatBytes } from "../lib/time";
import { Button, cx, DialogTitle, Modal } from "./ui";
import { Loader } from "./Logo";

const AUDIO = /\.(wav|mp3|m4a|aac|flac|aif|aiff|ogg|opus)$/i;


/**
 * The places down the side, the path across the top, and what's in the folder.
 * `foldersOnly` lists folders alone (choosing a folder); otherwise files can be
 * picked (`picked`, `onPick`) and double-clicked (`onChoose`). `side` goes
 * under the places; `heading` over them.
 */
export function FolderBrowser({
  listing,
  problem,
  onGo,
  foldersOnly,
  picked = [],
  onPick,
  onChoose,
  heading,
  side,
  empty,
}: {
  listing: FsListing | null;
  problem?: string | null;
  onGo: (path: string) => void;
  foldersOnly?: boolean;
  picked?: string[];
  onPick?: (entry: FsEntry, adding: boolean) => void;
  onChoose?: (entry: FsEntry) => void;
  heading?: ReactNode;
  side?: ReactNode;
  empty: string;
}) {
  const crumbs = listing ? listing.path.split("/").filter(Boolean) : [];
  const entries = (listing?.entries ?? []).filter((entry) => !foldersOnly || entry.dir);
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-2">
        {heading && <div className="px-2 pt-1 pb-2 text-[13px] font-medium text-muted">{heading}</div>}
        {listing?.places.map((place) => (
          <button
            key={place.path}
            type="button"
            onClick={() => onGo(place.path)}
            className={cx(
              "flex h-8 shrink-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors",
              listing.path === place.path ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
            )}
          >
            {place.name === "Home" ? <HardDrive size={14} /> : <Folder size={14} />}
            <span className="min-w-0 flex-1 truncate">{place.name}</span>
          </button>
        ))}
        {side}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-3 text-[12px] whitespace-nowrap text-muted">
          <button type="button" onClick={() => onGo("/")} className="rounded px-1 hover:text-fg">
            /
          </button>
          {crumbs.map((crumb, index) => (
            <span key={`${crumb}-${index}`} className="flex items-center">
              <ChevronRight size={12} className="text-faint" />
              <button type="button" onClick={() => onGo(`/${crumbs.slice(0, index + 1).join("/")}`)} className={cx("rounded px-1", index === crumbs.length - 1 ? "text-fg" : "hover:text-fg")}>
                {crumb}
              </button>
            </span>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {problem && <p className="px-2 py-1.5 text-[12px] text-danger">{problem}</p>}
          {listing === null && !problem && (
            <div className="flex h-full items-center justify-center text-muted">
              <Loader size={28} />
            </div>
          )}
          {listing !== null && entries.length === 0 && <p className="p-6 text-center text-[13px] text-muted">{empty}</p>}
          {entries.map((entry) => {
            const isPicked = picked.includes(entry.path);
            return (
              <button
                key={entry.path}
                type="button"
                onClick={(event) => (entry.dir ? onGo(entry.path) : onPick?.(entry, event.metaKey || event.shiftKey || event.ctrlKey))}
                onDoubleClick={() => !entry.dir && onChoose?.(entry)}
                className={cx("flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors", isPicked ? "bg-white/10 text-fg" : "text-fg/90 hover:bg-hover")}
              >
                {entry.dir ? <Folder size={15} className="shrink-0 text-info" /> : AUDIO.test(entry.name) ? <AudioLines size={15} className="shrink-0 text-success" /> : <Film size={15} className="shrink-0 text-pink-300" />}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {!entry.dir && <span className="shrink-0 text-[11px] text-faint tabular">{formatBytes(entry.size)}</span>}
                {isPicked && <span className="size-1.5 shrink-0 rounded-full bg-white" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * A dialog for choosing a folder on this Mac: where exports go, where a copy
 * is saved. Opens at `start` (or home), says what went wrong in place, and
 * stays open with the error when `onPick` fails. `aside` sits at the foot's
 * left, given the folder shown and the way to pick a path.
 */
export function FolderPicker({
  open,
  onClose,
  title,
  detail,
  start,
  confirm,
  cancel = "Cancel",
  onPick,
  aside,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  detail: string;
  start?: string;
  /** The answer's words ("Use this folder", "Copy here"). */
  confirm: string;
  cancel?: string;
  onPick: (path: string) => Promise<void>;
  aside?: (here: string, pick: (path: string) => void, busy: boolean) => ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose} width={640}>
      <Picking title={title} detail={detail} start={start} confirm={confirm} cancel={cancel} onClose={onClose} onPick={onPick} aside={aside} />
    </Modal>
  );
}

/** The picker's inside, mounted only while it's open: each opening starts fresh at `start`. */
function Picking({ title, detail, start, confirm, cancel, onClose, onPick, aside }: { title: string; detail: string; start?: string; confirm: string; cancel: string; onClose: () => void; onPick: (path: string) => Promise<void>; aside?: (here: string, pick: (path: string) => void, busy: boolean) => ReactNode }) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = (path?: string) => {
    setProblem(null);
    api
      .browse(path)
      .then(setListing)
      .catch((error: Error) => {
        // A folder that's gone opens home instead.
        if (path !== undefined) return go();
        setProblem(error.message);
      });
  };
  useEffect(() => {
    go(start);
    // Where it opens is decided as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pick = (path: string) => {
    setBusy(true);
    setProblem(null);
    onPick(path).then(
      () => setBusy(false),
      (error: unknown) => {
        setProblem(error instanceof Error ? error.message : String(error));
        setBusy(false);
      },
    );
  };
  const here = listing?.path ?? "";
  return (
    <div className="flex h-[520px] flex-col">
      <div className="border-b border-line px-6 pt-6 pb-4">
        <DialogTitle title={title} detail={detail} />
      </div>
      <FolderBrowser listing={listing} problem={problem} onGo={go} foldersOnly empty="No folders in here. You can still pick this one." />
      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        {aside?.(here, pick, busy)}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {cancel}
          </Button>
          <Button variant="primary" busy={busy} disabled={here === ""} onClick={() => pick(here)}>
            {confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}
