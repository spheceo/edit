// Folders on the Mac running Edit (`/api/fs`, so it works over Tailscale too),
// browsed the same way wherever Edit asks for one: importing media, and where
// exports go.

import { AudioLines, ChevronRight, Film, Folder, HardDrive } from "lucide-react";
import type { ReactNode } from "react";

import type { FsEntry, FsListing } from "../lib/api";
import { cx, Spinner } from "./ui";

const AUDIO = /\.(wav|mp3|m4a|aac|flac|aif|aiff|ogg|opus)$/i;

function formatSize(bytes: number) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

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
              <Spinner />
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
                {!entry.dir && <span className="shrink-0 text-[11px] text-faint tabular">{formatSize(entry.size)}</span>}
                {isPicked && <span className="size-1.5 shrink-0 rounded-full bg-white" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
