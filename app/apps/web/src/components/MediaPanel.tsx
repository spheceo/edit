import { AudioLines, Check, ChevronLeft, CircleAlert, Ellipsis, Folder, HardDrive, Trash2, Upload as UploadIcon, X } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useRef, useState } from "react";

import { isLocal, mediaUrl, useMachine } from "../lib/api";
import { folderOf, isUsed, MEDIA_FOLDERS, mediaUses, placeMedia, removeUnusedMedia, type MediaFolder, type MediaUse } from "../lib/edit";
import { mediaMenu } from "../lib/menus";
import { openMenu, toggleMenu } from "./ContextMenu";
import { playhead } from "../lib/playback";
import { useEditor } from "../lib/store";
import { shortDuration } from "../lib/time";
import type { Media, MediaStatus } from "../lib/types";
import { cancelUpload, uploadFiles, useUploads, type Upload } from "../lib/upload";
import { ResearchTile } from "./Research";
import { Button, cx, IconButton, ProgressRing, spring } from "./ui";

export const MEDIA_MIME = "application/x-edit-media";
export const ELEMENT_MIME = "application/x-edit-element";

/** Which media the bin lists: everything, or what the edit does / doesn't use. */
type Show = "all" | "used" | "unused";

const FOLDER_TINT: Record<MediaFolder, string> = {
  footage: "text-sky-300",
  audio: "text-green-300",
  sfx: "text-amber-300",
  images: "text-violet-300",
};

export function MediaPanel({ onImport, onResearch }: { onImport: () => void; onResearch: () => void }) {
  const machine = useMachine();
  const project = useEditor((state) => state.project)!;
  const [opened, setOpened] = useState<MediaFolder | null>(null);
  const [show, setShow] = useState<Show>("all");
  const uses = useMemo(() => mediaUses(project), [project]);
  // A folder emptied (everything in it removed) closes itself.
  const folder = opened && project.media.some((media) => folderOf(media) === opened) ? opened : null;
  const label = MEDIA_FOLDERS.find((candidate) => candidate.id === folder)?.label;
  return (
    <section className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex h-11 shrink-0 items-center justify-between gap-1 border-b border-line pr-1 pl-3.5">
        <div className="flex min-w-0 items-center gap-1">
          {folder ? (
            <button
              onClick={() => setOpened(null)}
              title="Back to all media"
              className="-ml-1.5 flex min-w-0 items-center gap-0.5 rounded-md py-1 pr-1.5 pl-0.5 font-medium transition-colors hover:bg-hover"
            >
              <ChevronLeft size={15} className="shrink-0 text-muted" />
              <span className="truncate">{label}</span>
            </button>
          ) : (
            <span className="font-medium">Media</span>
          )}
        </div>
        <div className="flex shrink-0 items-center">
          {isLocal ? (
            // Upload and "files on" are the same disk here: add them in place.
            <Button size="sm" variant="ghost" onClick={onImport} title="Add files (⌘I)">
              <UploadIcon size={13} /> Add files
            </Button>
          ) : (
            <>
              <UploadButton />
              <Button size="sm" variant="ghost" onClick={onImport} title={`Add files already on ${machine} (⌘I)`}>
                <HardDrive size={13} /> {machine}
              </Button>
            </>
          )}
          <MediaOptions show={show} setShow={setShow} uses={uses} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <MediaGrid onImport={onImport} onResearch={onResearch} folder={folder} open={setOpened} show={show} uses={uses} />
      </div>
    </section>
  );
}

/** The bin's ⋯: what to list, and clearing out what the edit doesn't use. */
function MediaOptions({ show, setShow, uses }: { show: Show; setShow: (show: Show) => void; uses: Map<string, MediaUse> }) {
  const edit = useEditor((state) => state.edit);
  const toast = useEditor((state) => state.toast);
  const used = [...uses.values()].filter(isUsed).length;
  const unused = uses.size - used;
  return (
    <IconButton
      label="Media options"
      onClick={(event) =>
        toggleMenu(
          event.currentTarget,
          [
            { heading: "Show" },
            { label: "All media", checked: show === "all", hint: String(uses.size), onSelect: () => setShow("all") },
            { label: "Used in the edit", checked: show === "used", hint: String(used), onSelect: () => setShow("used") },
            { label: "Unused", checked: show === "unused", hint: String(unused), onSelect: () => setShow("unused") },
            { separator: true },
            {
              label: "Remove unused media",
              icon: <Trash2 size={14} />,
              danger: true,
              disabled: !unused,
              onSelect: () => {
                let removed = 0;
                edit((draft) => {
                  removed = removeUnusedMedia(draft);
                });
                toast(`Removed ${removed} unused file${removed === 1 ? "" : "s"} from the project (⌘Z to undo). Nothing was deleted from disk.`);
              },
            },
          ],
          { width: 220 },
        )
      }
    >
      <Ellipsis size={16} />
    </IconButton>
  );
}

/** Picks files on the device you're browsing from and uploads them. */
function UploadButton() {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => input.current?.click()} title="Upload from this device (or drop files anywhere)">
        <UploadIcon size={13} /> Upload
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        accept="video/*,audio/*,.mkv,.mts,.mxf"
        className="hidden"
        onChange={(event) => {
          uploadFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
    </>
  );
}

function MediaGrid({
  onImport,
  onResearch,
  folder,
  open,
  show,
  uses,
}: {
  onImport: () => void;
  onResearch: () => void;
  folder: MediaFolder | null;
  open: (folder: MediaFolder) => void;
  show: Show;
  uses: Map<string, MediaUse>;
}) {
  const project = useEditor((state) => state.project)!;
  const statuses = useEditor((state) => state.media);
  const uploads = useUploads((state) => state.uploads);
  const machine = useMachine();
  if (!project.media.length && !uploads.length) {
    return (
      <div className="flex h-44 w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-strong text-center text-muted">
        <UploadIcon size={18} />
        <span className="px-6 text-[12px] leading-relaxed">
          Drop footage here{isLocal ? "" : " from this device"},
          <br />
          or{" "}
          <button onClick={onImport} className="text-fg underline decoration-white/30 underline-offset-2 hover:decoration-white">
            {isLocal ? "add files" : `add files on ${machine}`}
          </button>
        </span>
      </div>
    );
  }
  const listed = project.media.filter((media) => show === "all" || isUsed(uses.get(media.id)) === (show === "used"));
  const folders = MEDIA_FOLDERS.map((entry) => ({ ...entry, items: listed.filter((media) => folderOf(media) === entry.id) })).filter(
    (entry) => entry.items.length,
  );
  const items = folder ? listed.filter((media) => folderOf(media) === folder) : [];
  const nothing = folder ? !items.length : !folders.length;
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(116px,1fr))] gap-2">
        {uploads.map((upload) => (
          <UploadTile key={upload.id} upload={upload} />
        ))}
        {folder
          ? items.map((media, index) => (
              <motion.div key={media.id} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...spring, delay: index * 0.02 }}>
                <MediaTile media={media} status={statuses[media.id]} projectId={project.id} use={uses.get(media.id)} />
              </motion.div>
            ))
          : folders.map((entry, index) => (
              <motion.div key={entry.id} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...spring, delay: index * 0.03 }}>
                <FolderTile folder={entry.id} label={entry.label} count={entry.items.length} onOpen={() => open(entry.id)} />
              </motion.div>
            ))}
        {!folder && (
          <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...spring, delay: folders.length * 0.03 }}>
            <ResearchTile onOpen={onResearch} />
          </motion.div>
        )}
      </div>
      {nothing && project.media.length > 0 && (
        <div className="px-4 py-8 text-center text-[12px] text-muted">
          {show === "unused" ? "Everything here is in the edit." : show === "used" ? "Nothing here is in the edit yet." : "Empty."}
        </div>
      )}
    </>
  );
}

/** A bin folder; media sorts into these by kind. */
function FolderTile({ folder, label, count, onOpen }: { folder: MediaFolder; label: string; count: number; onOpen: () => void }) {
  return (
    <button onClick={onOpen} title={`Open ${label}`} className="group block w-full text-left">
      <div className="flex aspect-video items-center justify-center rounded-lg bg-raised ring-1 ring-line transition-[box-shadow] group-hover:ring-line-strong">
        <Folder size={24} strokeWidth={1.6} className={cx("transition-transform duration-150 group-hover:scale-105", FOLDER_TINT[folder])} />
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 px-0.5 text-[12px] text-muted group-hover:text-fg">
        <span className="truncate">{label}</span>
        <span className="shrink-0 font-mono text-[11px] text-faint tabular">{count}</span>
      </div>
    </button>
  );
}

function UploadTile({ upload }: { upload: Upload }) {
  const progress = upload.size ? upload.loaded / upload.size : 0;
  const label =
    upload.state === "queued"
      ? "Waiting…"
      : upload.state === "uploading"
        ? `${Math.round(progress * 100)}%`
        : upload.state === "processing"
          ? "Reading…"
          : upload.state === "failed"
            ? "Failed"
            : "Done";
  return (
    <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={spring} title={upload.error ?? upload.name}>
      <div className="group relative flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-raised ring-1 ring-line">
        {(upload.state === "queued" || upload.state === "uploading" || upload.state === "failed") && (
          <button
            title={upload.state === "failed" ? "Dismiss" : "Cancel upload"}
            onClick={() => cancelUpload(upload.id)}
            className="absolute top-1 right-1 z-10 flex size-5 items-center justify-center rounded-full bg-black/70 text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg"
          >
            <X size={12} />
          </button>
        )}
        <motion.div
          className={cx("absolute inset-y-0 left-0", upload.state === "failed" ? "bg-red-500/20" : "bg-white/[0.07]")}
          animate={{ width: `${(upload.state === "uploading" ? progress : upload.state === "queued" ? 0 : 1) * 100}%` }}
          transition={{ ease: "easeOut", duration: 0.3 }}
        />
        <span className={cx("relative flex items-center gap-1.5 font-mono text-[11px] tabular", upload.state === "failed" ? "text-red-300" : "text-fg/90")}>
          {upload.state === "uploading" ? <ProgressRing value={progress} size={14} /> : <UploadIcon size={12} />}
          {label}
        </span>
      </div>
      <div className="mt-1 truncate px-0.5 text-[12px] text-muted">{upload.name}</div>
    </motion.div>
  );
}

/** How a file is used, for its tooltip. */
function usage(use: MediaUse | undefined) {
  if (!use?.clips) return use?.script ? "In the script" : "Not used in the edit";
  return `In the edit: ${use.clips} clip${use.clips === 1 ? "" : "s"}${use.script ? ", and the script" : ""}`;
}

function MediaTile({ media, status, projectId, use }: { media: Media; status?: MediaStatus; projectId: string; use?: MediaUse }) {
  const [skim, setSkim] = useState<number | null>(null);
  const edit = useEditor((state) => state.edit);
  const select = useEditor((state) => state.select);
  const thumbs = status?.thumbs === "ready" ? status.thumb_count : 0;
  const index = thumbs ? Math.min(thumbs - 1, Math.floor((skim ?? 0) * thumbs)) : 0;
  const working = status?.proxy === "working" || status?.proxy === "pending";
  const failed = status?.proxy === "failed";
  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(MEDIA_MIME, media.id);
        event.dataTransfer.effectAllowed = "copy";
      }}
      onDoubleClick={() => {
        let ids: string[] = [];
        edit((draft) => {
          ids = placeMedia(draft, media.id, Math.round(playhead.frame));
        });
        select(ids);
      }}
      title={`${media.name}\n${usage(use)}\nDouble-click to place at the playhead, or drag onto the timeline`}
      onContextMenu={(event) => openMenu(event, mediaMenu(media.id))}
      className="group cursor-grab active:cursor-grabbing"
    >
      <div
        className="relative aspect-video overflow-hidden rounded-lg bg-raised ring-1 ring-line transition-[box-shadow] group-hover:ring-line-strong"
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setSkim((event.clientX - rect.left) / rect.width);
        }}
        onPointerLeave={() => setSkim(null)}
      >
        {media.kind === "audio" ? (
          <div className="flex size-full items-center justify-center bg-green-500/15 text-green-300">
            <AudioLines size={22} />
          </div>
        ) : thumbs ? (
          <div
            className="size-full bg-cover"
            style={{
              backgroundImage: `url(${mediaUrl(projectId, media.id, "thumbs")})`,
              backgroundSize: `${thumbs * 100}% 100%`,
              backgroundPosition: `${thumbs > 1 ? (index / (thumbs - 1)) * 100 : 0}% 0`,
            }}
          />
        ) : (
          <div className="size-full animate-pulse bg-hover" />
        )}
        {isUsed(use) && (
          <span className="absolute top-1 left-1 flex items-center gap-0.5 rounded bg-black/70 px-1 font-mono text-[10px] text-fg/90 tabular">
            <Check size={10} strokeWidth={3} className="text-green-300" />
            {use?.clips || "script"}
          </span>
        )}
        {skim !== null && thumbs > 0 && <div className="absolute inset-y-0 w-px bg-playhead" style={{ left: `${skim * 100}%` }} />}
        <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 font-mono text-[10px] text-fg/90 tabular">{shortDuration(media.duration)}</span>
        {working && (
          <span className="absolute top-1 right-1 rounded-full bg-black/70 p-0.5" title="Building scrub proxy">
            <ProgressRing value={status?.proxy_progress ?? 0} size={16} />
          </span>
        )}
        {failed && (
          <span className="absolute top-1 right-1 text-red-400" title={status?.error}>
            <CircleAlert size={15} />
          </span>
        )}
      </div>
      <div className="mt-1 truncate px-0.5 text-[12px] text-muted group-hover:text-fg">{media.name}</div>
    </div>
  );
}
