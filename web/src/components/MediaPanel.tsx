import { AudioLines, CircleAlert, HardDrive, Upload as UploadIcon, X } from "lucide-react";
import { motion } from "motion/react";
import { useRef, useState } from "react";

import { mediaUrl, useMachine } from "../lib/api";
import { mediaMenu } from "../lib/menus";
import { openMenu } from "./ContextMenu";
import { placeMedia } from "../lib/edit";
import { playhead } from "../lib/playback";
import { useEditor } from "../lib/store";
import { shortDuration } from "../lib/time";
import type { Media, MediaStatus } from "../lib/types";
import { cancelUpload, uploadFiles, useUploads, type Upload } from "../lib/upload";
import { Button, cx, ProgressRing, spring } from "./ui";

export const MEDIA_MIME = "application/x-edit-media";
export const ELEMENT_MIME = "application/x-edit-element";

export function MediaPanel({ onImport }: { onImport: () => void }) {
  const machine = useMachine();
  return (
    <section className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-line pr-1 pl-3.5">
        <span className="font-medium">Media</span>
        <div className="flex items-center">
          <UploadButton />
          <Button size="sm" variant="ghost" onClick={onImport} title={`Add files already on ${machine} (⌘I)`}>
            <HardDrive size={13} /> {machine}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <MediaGrid onImport={onImport} />
      </div>
    </section>
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

function MediaGrid({ onImport }: { onImport: () => void }) {
  const project = useEditor((state) => state.project)!;
  const statuses = useEditor((state) => state.media);
  const uploads = useUploads((state) => state.uploads);
  const machine = useMachine();
  if (!project.media.length && !uploads.length) {
    return (
      <div className="flex h-44 w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-strong text-center text-muted">
        <UploadIcon size={18} />
        <span className="px-6 text-[12px] leading-relaxed">
          Drop footage here from this device,
          <br />
          or{" "}
          <button onClick={onImport} className="text-fg underline decoration-white/30 underline-offset-2 hover:decoration-white">
            add files on {machine}
          </button>
        </span>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      {uploads.map((upload) => (
        <UploadTile key={upload.id} upload={upload} />
      ))}
      {project.media.map((media, index) => (
        <motion.div key={media.id} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...spring, delay: index * 0.02 }}>
          <MediaTile media={media} status={statuses[media.id]} projectId={project.id} />
        </motion.div>
      ))}
    </div>
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

function MediaTile({ media, status, projectId }: { media: Media; status?: MediaStatus; projectId: string }) {
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
      title={`${media.name}\nDouble-click to place at the playhead, or drag onto the timeline`}
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
