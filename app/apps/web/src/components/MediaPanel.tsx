import { AudioLines, Check, ChevronRight, CircleAlert, Ellipsis, Film, HardDrive, Image as ImageIcon, Images, Music, Trash2, Upload as UploadIcon, X, Zap } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { importProgress } from "../lib/import_progress";
import { isLocal, useMachine } from "../lib/api";
import { folderOf, isUsed, MEDIA_FOLDERS, mediaUses, placeMedia, removeUnusedMedia, type MediaFolder, type MediaUse } from "../lib/edit";
import { mediaMenu } from "../lib/menus";
import { openMenu, toggleMenu } from "./ContextMenu";
import { playhead } from "../lib/playback";
import { readSetting, writeSetting } from "../lib/storage";
import { useEditor, type MediaTab } from "../lib/store";
import { shortDuration } from "../lib/time";
import type { Media, MediaStatus, Project } from "../lib/types";
import { cancelUpload, uploadFiles, useUploads, type Upload } from "../lib/upload";
import { useResearch } from "./Research";
import { ScriptDownloads, ScriptPanel } from "./ScriptPanel";
import { cx, IconButton, ProgressRing, Spinner, Tabs } from "./ui";

export const MEDIA_MIME = "application/x-edit-media";
export const ELEMENT_MIME = "application/x-edit-element";

/** Which media the bin lists: everything, or what the edit does / doesn’t use. */
type Show = "all" | "used" | "unused";

const FOLDER_ICON: Record<MediaFolder, [typeof Film, string]> = {
  footage: [Film, "text-info"],
  audio: [AudioLines, "text-success"],
  music: [Music, "text-violet-300"],
  sfx: [Zap, "text-warning"],
  images: [ImageIcon, "text-pink-300"],
};

/** The left panel: the media bin, and the script beside it (its downloads while they run). */
export function MediaPanel({ onImport, onResearch }: { onImport: () => void; onResearch: () => void }) {
  const tab = useEditor((state) => state.mediaTab);
  const setTab = useEditor((state) => state.setMediaTab);
  const job = useEditor((state) => state.scriptJob);
  const downloading = Boolean(job && job.state !== "done");
  const [show, setShow] = useState<Show>("all");
  const project = useEditor((state) => state.project)!;
  const uses = useMemo(() => mediaUses(project), [project]);
  // Downloads finished: back to the script they were for.
  const shown: MediaTab = tab === "downloads" && !downloading ? "script" : tab;
  return (
    <section className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex h-11 shrink-0 items-center justify-between gap-1 border-b border-line px-2">
        <Tabs<MediaTab>
          id="media"
          value={shown}
          onChange={setTab}
          tabs={[
            { value: "media", label: "Media" },
            { value: "script", label: "Script" },
            ...(downloading && job ? [{ value: "downloads" as const, label: job.state === "failed" ? "Downloads ⚠" : `${Math.round(importProgress(job).fraction * 100)}%` }] : []),
          ]}
        />
        {shown === "media" && (
          <div className="flex shrink-0 items-center">
            <AddButtons onImport={onImport} />
            <MediaOptions show={show} setShow={setShow} uses={uses} />
          </div>
        )}
      </div>
      {shown === "script" ? (
        <ScriptPanel />
      ) : shown === "downloads" ? (
        <ScriptDownloads />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <MediaTable project={project} onImport={onImport} onResearch={onResearch} show={show} uses={uses} />
        </div>
      )}
    </section>
  );
}

/** Adding files: in place on this Mac; from another device, an upload or files already on the machine running Edit. */
function AddButtons({ onImport }: { onImport: () => void }) {
  const machine = useMachine();
  const input = useRef<HTMLInputElement>(null);
  if (isLocal) {
    return (
      <IconButton label="Add files (⌘I)" onClick={onImport}>
        <UploadIcon size={15} />
      </IconButton>
    );
  }
  return (
    <>
      <IconButton label="Upload from this device (or drop files anywhere)" onClick={() => input.current?.click()}>
        <UploadIcon size={15} />
      </IconButton>
      <IconButton label={`Add files already on ${machine} (⌘I)`} onClick={onImport}>
        <HardDrive size={15} />
      </IconButton>
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

/** The bin’s ⋯: what to list, and clearing out what the edit doesn’t use. */
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

/** Folders closed in the bin, kept between launches. */
function useClosed() {
  const [closed, setClosed] = useState<Set<MediaFolder>>(() => new Set(JSON.parse(readSetting("edit.mediaClosed") ?? "[]") as MediaFolder[]));
  const toggle = (folder: MediaFolder) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      writeSetting("edit.mediaClosed", JSON.stringify([...next]));
      return next;
    });
  return [closed, toggle] as const;
}

/**
 * What a row calls a file: its name less what every file of the project
 * shares. Slowed copies ("…[id]-0.80x-886fd702ec56.mp4") are numbered, voice-overs
 * named by their cut-in, a YouTube id and the extension dropped.
 */
export function displayNames(project: Project) {
  const names = new Map<string, string>();
  const slowed = new Map<string, number>();
  for (const media of project.media) {
    const stem = media.name.replace(/\.[a-z0-9]{2,4}$/i, "");
    const slow = /-(\d+(?:\.\d+)?)x-[0-9a-f]{6,}$/.exec(stem);
    if (slow) {
      const count = (slowed.get(slow[1]) ?? 0) + 1;
      slowed.set(slow[1], count);
      names.set(media.id, `Slow-mo ${Number(slow[1]).toFixed(2)}× · ${count}`);
      continue;
    }
    const cutIn = /\(voice-over\)\s*-\s*(Cut-in \d+)$/i.exec(stem);
    if (cutIn) {
      names.set(media.id, `Voice-over · ${cutIn[1]}`);
      continue;
    }
    names.set(media.id, stem.replace(/\s*\[[\w-]{11}\]$/, ""));
  }
  return names;
}

function MediaTable({
  project,
  onImport,
  onResearch,
  show,
  uses,
}: {
  project: Project;
  onImport: () => void;
  onResearch: () => void;
  show: Show;
  uses: Map<string, MediaUse>;
}) {
  const statuses = useEditor((state) => state.media);
  const uploads = useUploads((state) => state.uploads);
  const machine = useMachine();
  const [closed, toggle] = useClosed();
  const names = useMemo(() => displayNames(project), [project.media]);
  if (!project.media.length && !uploads.length) {
    return (
      <div className="p-2">
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
        <ResearchRow onOpen={onResearch} />
      </div>
    );
  }
  const listed = project.media.filter((media) => show === "all" || isUsed(uses.get(media.id)) === (show === "used"));
  const folders = MEDIA_FOLDERS.map((entry) => ({ ...entry, items: listed.filter((media) => folderOf(media) === entry.id) })).filter((entry) => entry.items.length);
  return (
    <div className="pb-2" role="table" aria-label="Media">
      {uploads.map((upload) => (
        <UploadRow key={upload.id} upload={upload} />
      ))}
      {folders.map((folder) => {
        const open = !closed.has(folder.id);
        const [Icon, tint] = FOLDER_ICON[folder.id];
        return (
          <div key={folder.id} role="rowgroup">
            <button
              onClick={() => toggle(folder.id)}
              aria-expanded={open}
              className="sticky top-0 z-10 flex h-8 w-full items-center gap-1.5 border-b border-line bg-panel px-2.5 text-left text-[12px] font-medium text-muted transition-colors hover:text-fg"
            >
              <ChevronRight size={13} className={cx("shrink-0 transition-transform duration-150", open && "rotate-90")} />
              <Icon size={13} className={cx("shrink-0", tint)} />
              <span className="flex-1 truncate">{folder.label}</span>
              <span className="font-mono text-[11px] text-faint tabular">{folder.items.length}</span>
            </button>
            {open && folder.items.map((media) => <MediaRow key={media.id} media={media} name={names.get(media.id) ?? media.name} status={statuses[media.id]} use={uses.get(media.id)} />)}
          </div>
        );
      })}
      {!folders.length && project.media.length > 0 && (
        <div className="px-4 py-8 text-center text-[12px] text-muted">{show === "unused" ? "Everything here is in the edit." : "Nothing here is in the edit yet."}</div>
      )}
      <div className="px-2 pt-2">
        <ResearchRow onOpen={onResearch} />
      </div>
    </div>
  );
}

/** How a file is used, for its tooltip. */
function usage(use: MediaUse | undefined) {
  if (!use?.clips) return use?.script ? "In the script" : "Not used in the edit";
  return `In the edit: ${use.clips} clip${use.clips === 1 ? "" : "s"}${use.script ? ", and the script" : ""}`;
}

function MediaRow({ media, name, status, use }: { media: Media; name: string; status?: MediaStatus; use?: MediaUse }) {
  const edit = useEditor((state) => state.edit);
  const select = useEditor((state) => state.select);
  const working = status?.proxy === "working" || status?.proxy === "pending";
  const failed = status?.proxy === "failed";
  const used = isUsed(use);
  return (
    <div
      role="row"
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
      className="group flex h-8 cursor-grab items-center gap-2 pr-2.5 pl-[30px] text-[12px] transition-colors hover:bg-hover active:cursor-grabbing"
    >
      <span role="cell" className={cx("min-w-0 flex-1 truncate", used ? "text-fg" : "text-muted group-hover:text-fg")}>
        {name}
      </span>
      <span role="cell" className="flex shrink-0 items-center gap-2">
        {working && (
          <span title="Building scrub proxy">
            <ProgressRing value={status?.proxy_progress ?? 0} size={13} />
          </span>
        )}
        {failed && (
          <span className="text-danger" title={status?.error}>
            <CircleAlert size={13} />
          </span>
        )}
        {used && (
          <span className="flex items-center gap-0.5 font-mono text-[10px] text-faint tabular" title={usage(use)}>
            <Check size={10} strokeWidth={3} className="text-success" />
            {use?.clips || ""}
          </span>
        )}
        {media.kind !== "image" && <span className="w-11 text-right font-mono text-[11px] text-faint tabular">{shortDuration(media.duration)}</span>}
      </span>
    </div>
  );
}

function UploadRow({ upload }: { upload: Upload }) {
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
    <div className="group relative flex h-8 items-center gap-2 overflow-hidden border-b border-line px-2.5 text-[12px]" title={upload.error ?? upload.name}>
      <div
        className={cx("absolute inset-y-0 left-0 transition-[width] duration-300", upload.state === "failed" ? "bg-danger-soft" : "bg-white/[0.05]")}
        style={{ width: `${(upload.state === "uploading" ? progress : upload.state === "queued" ? 0 : 1) * 100}%` }}
      />
      <span className="relative shrink-0">{upload.state === "uploading" ? <ProgressRing value={progress} size={13} /> : <UploadIcon size={12} className="text-faint" />}</span>
      <span className="relative min-w-0 flex-1 truncate text-muted">{upload.name}</span>
      <span className={cx("relative shrink-0 font-mono text-[11px] tabular", upload.state === "failed" ? "text-danger" : "text-faint")}>{label}</span>
      {(upload.state === "queued" || upload.state === "uploading" || upload.state === "failed") && (
        <button
          title={upload.state === "failed" ? "Dismiss" : "Cancel upload"}
          onClick={() => cancelUpload(upload.id)}
          className="relative flex size-5 shrink-0 items-center justify-center rounded text-muted hover:text-fg"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

/** Images found for the project, waiting to be kept or rejected. */
function ResearchRow({ onOpen }: { onOpen: () => void }) {
  const project = useEditor((state) => state.project)!;
  const { items, collecting } = useResearch(project.id, false);
  const waiting = items.filter((item) => item.status === "new").length;
  return (
    <button
      onClick={onOpen}
      title="Review images found for this project"
      className="mt-2 flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-[12px] text-muted ring-1 ring-line transition-colors hover:bg-hover hover:text-fg"
    >
      {collecting ? <Spinner /> : <Images size={14} className="shrink-0 text-danger" />}
      <span className="flex-1 truncate text-left">Research</span>
      {waiting > 0 && <span className="rounded-full bg-playhead px-1.5 text-[10px] leading-4 font-semibold text-white tabular-nums">{waiting} new</span>}
      <span className="font-mono text-[11px] text-faint tabular">{items.length}</span>
    </button>
  );
}
