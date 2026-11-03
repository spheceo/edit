// What's attached to the next message, in the tray on top of the chat's
// composer (lib/attachments.ts): a picture as a small preview, anything else
// as a chip with its kind and size; each with its upload's progress and × to
// take it off.

import { AlertCircle, FileText, Film, Music, X } from "lucide-react";

import { detach, useAttachments, type Attachment } from "../lib/attachments";
import { cx } from "./ui";

export function AttachmentTray() {
  const items = useAttachments((state) => state.items);
  if (items.length === 0) return null;
  return (
    <div role="list" aria-label="Attached files" className="flex gap-1.5 overflow-x-auto px-1.5 pt-1.5 pb-1.5 [scrollbar-width:none]">
      {items.map((item) => (item.preview !== null ? <Picture key={item.id} item={item} /> : <Chip key={item.id} item={item} />))}
    </div>
  );
}

const ICONS = { video: Film, audio: Music, file: FileText, image: FileText } as const;

/** Its share sent, 0–1; a finished one is whole. */
function progress(item: Attachment): number {
  if (item.state === "done" || item.state === "processing") return 1;
  return item.size > 0 ? Math.min(1, item.loaded / item.size) : 0;
}

function status(item: Attachment): string {
  if (item.state === "failed") return item.error ?? "Couldn't upload";
  if (item.state === "queued") return "Waiting…";
  if (item.state === "uploading") return `${Math.round(progress(item) * 100)}%`;
  if (item.state === "processing") return "Adding…";
  return size(item.size);
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function Remove({ item, className }: { item: Attachment; className?: string }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${item.name}`}
      title="Remove"
      onClick={() => detach(item.id)}
      className={cx("flex size-5 shrink-0 items-center justify-center rounded-full", className)}
    >
      <X size={11} strokeWidth={2.4} />
    </button>
  );
}

function Picture({ item }: { item: Attachment }) {
  const busy = item.state !== "done" && item.state !== "failed";
  return (
    <div role="listitem" title={`${item.name} · ${status(item)}`} className="group relative size-14 shrink-0 overflow-hidden rounded-lg border border-line-strong bg-black">
      <img src={item.preview ?? undefined} alt={item.name} className={cx("size-full object-cover transition-opacity", busy && "opacity-50")} />
      {busy && <Ring value={progress(item)} className="absolute inset-0 m-auto" />}
      {item.state === "failed" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-danger">
          <AlertCircle size={16} />
        </div>
      )}
      <Remove item={item} className="absolute top-1 right-1 bg-black/70 text-fg opacity-0 backdrop-blur group-hover:opacity-100 focus-visible:opacity-100" />
    </div>
  );
}

function Chip({ item }: { item: Attachment }) {
  const Icon = ICONS[item.kind];
  const failed = item.state === "failed";
  return (
    <div
      role="listitem"
      title={item.name}
      className={cx("group relative flex h-14 w-[188px] shrink-0 items-center gap-2 overflow-hidden rounded-lg border bg-panel pr-1 pl-2", failed ? "border-danger/40" : "border-line-strong")}
    >
      <span className={cx("flex size-8 shrink-0 items-center justify-center rounded-md", failed ? "bg-danger-soft text-danger" : "bg-hover text-secondary")}>
        {failed ? <AlertCircle size={15} /> : <Icon size={15} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px] text-fg">{item.name}</span>
        <span className={cx("truncate text-[11px] tabular", failed ? "text-danger" : "text-faint")}>{status(item)}</span>
      </span>
      <Remove item={item} className="self-start mt-1 text-faint hover:bg-hover hover:text-fg" />
      {item.state === "uploading" && (
        <span className="absolute bottom-0 left-0 h-0.5 bg-white/70 transition-[width]" style={{ width: `${progress(item) * 100}%` }} />
      )}
    </div>
  );
}

/** A small progress ring over a picture still uploading. */
function Ring({ value, className }: { value: number; className?: string }) {
  const r = 8;
  const length = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 20 20" className={cx("size-5 -rotate-90", className)} aria-hidden>
      <circle cx="10" cy="10" r={r} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2.5" />
      <circle cx="10" cy="10" r={r} fill="none" stroke="white" strokeWidth="2.5" strokeDasharray={length} strokeDashoffset={length * (1 - value)} strokeLinecap="round" />
    </svg>
  );
}
