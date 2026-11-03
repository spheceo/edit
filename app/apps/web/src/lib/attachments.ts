// Files attached to the next message in the editor's chat (Sphe, Nov 3: a +
// beside the model opens Finder, a file dropped on the composer is uploaded,
// a picture shows a small preview above it). Each is uploaded at once
// (lib/upload.ts) into the project, as a drop on the window is: media goes in
// the project's media, anything else is kept as one of its files. The message
// names them, and the agent's context lists every upload by that name.

import { create } from "zustand";

import { cancelUpload, uploadFiles, useUploads, type Upload } from "./upload";

export interface Attachment {
  /** The upload's id. */
  id: number;
  name: string;
  size: number;
  kind: "image" | "video" | "audio" | "file";
  /** A picture's own pixels, shown before it's uploaded (an object URL). */
  preview: string | null;
  state: Upload["state"];
  loaded: number;
  error?: string;
}

interface AttachmentsState {
  project: string | null;
  items: Attachment[];
}

export const useAttachments = create<AttachmentsState>(() => ({ project: null, items: [] }));

function kindOf(file: File): Attachment["kind"] {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "file";
}

/** Pictures a browser draws itself: the preview; anything else (HEIC, PSD) shows its icon. */
const DRAWN = /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/u;

/** Attaches `files` to the next message in `project`'s chat, uploading each. */
export function attach(project: string, files: File[]): void {
  if (useAttachments.getState().project !== project) clear(project);
  const added: Attachment[] = uploadFiles(files, undefined, { quiet: true }).map(({ id, file }) => ({
    id,
    name: file.name,
    size: file.size,
    kind: kindOf(file),
    preview: DRAWN.test(file.type) ? URL.createObjectURL(file) : null,
    state: "queued",
    loaded: 0,
  }));
  useAttachments.setState(({ items }) => ({ project, items: [...items, ...added] }));
}

/** Takes one off the message: a running upload is cancelled, one already in stays in the project. */
export function detach(id: number): void {
  const item = useAttachments.getState().items.find((one) => one.id === id);
  if (item === undefined) return;
  if (item.state === "queued" || item.state === "uploading") cancelUpload(id);
  if (item.preview !== null) URL.revokeObjectURL(item.preview);
  useAttachments.setState(({ items }) => ({ items: items.filter((one) => one.id !== id) }));
}

/** Empties the tray (sent, or another project opened). */
export function clear(project: string | null = useAttachments.getState().project): void {
  for (const item of useAttachments.getState().items) if (item.preview !== null) URL.revokeObjectURL(item.preview);
  useAttachments.setState({ project, items: [] });
}

/** Still on their way: a message waits for them, so the agent finds them in the project. */
export function uploading(items: Attachment[]): boolean {
  return items.some((item) => item.state !== "done" && item.state !== "failed");
}

/** The message with what's attached named under it (the agent's context lists uploads by name). */
export function withAttachments(message: string, items: Attachment[]): string {
  const names = items.filter((item) => item.state === "done").map((item) => item.name);
  return names.length === 0 ? message : `${message}\n\nAttached: ${names.join(", ")}`;
}

// Progress follows the upload queue's own (an upload leaves that list a moment after it's done; the tray keeps its last state).
useUploads.subscribe(({ uploads }) => {
  const items = useAttachments.getState().items;
  let changed = false;
  const next = items.map((item) => {
    const upload = uploads.find((one) => one.id === item.id);
    if (upload === undefined || (upload.state === item.state && upload.loaded === item.loaded)) return item;
    changed = true;
    return { ...item, state: upload.state, loaded: upload.loaded, error: upload.error };
  });
  if (changed) useAttachments.setState({ items: next });
});
