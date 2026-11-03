// Files attached to the next message in a chat on the right (Sphe, Nov 3:
// "the changes we've made to ui and files functionality on the composer must
// apply to ALL chat's"): + beside the model opens Finder, a file dropped on
// the composer or pasted into it is attached. Each is uploaded at once by the
// chat's own uploader (the editor's into the project, a thumbnail's into its
// images, an idea's beside its pictures) and sent with the message, which
// waits until they're in. Kept per chat (`key`), so a chat's files never ride
// along with another's.

import { create } from "zustand";

export type FileKind = "image" | "video" | "audio" | "file";

export interface ChatFile {
  id: number;
  name: string;
  size: number;
  kind: FileKind;
  /** A picture's own pixels, shown before it's uploaded (an object URL), or where it already is. */
  preview: string | null;
  state: "queued" | "uploading" | "processing" | "done" | "failed";
  loaded: number;
  error?: string;
  /** What the upload made (the chat's own: a media id, an image id, a stored picture). */
  landed?: unknown;
}

/** Uploads one file, saying how much is sent; answers what it became. */
export type Uploader = (file: File, progress: (loaded: number) => void, signal: AbortSignal) => Promise<unknown>;

/** Why a chat won't take this file (thumbnails and ideas take pictures), or null. */
export type Accept = (file: File) => string | null;

interface State {
  chats: Record<string, ChatFile[]>;
}

export const useChatFiles = create<State>(() => ({ chats: {} }));

const NONE: ChatFile[] = [];

/** A chat's attached files. */
export function useFilesOf(key: string): ChatFile[] {
  return useChatFiles((state) => state.chats[key] ?? NONE);
}

let next = 0;
const running = new Map<number, AbortController>();

export function kindOf(file: { type: string; name: string }): FileKind {
  if (file.type.startsWith("image/") || /\.(heic|heif|avif|psd|tiff?)$/iu.test(file.name)) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "file";
}

/** Pictures a browser draws itself get a preview; anything else (HEIC, PSD) shows its icon. */
const DRAWN = /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/u;

function patch(key: string, id: number, change: Partial<ChatFile>): void {
  useChatFiles.setState(({ chats }) => ({ chats: { ...chats, [key]: (chats[key] ?? []).map((one) => (one.id === id ? { ...one, ...change } : one)) } }));
}

/** Attaches `files` to `key`'s next message, uploading each (two at a time). Answers the refusals' words. */
export function attachFiles(key: string, files: File[], upload: Uploader, accept?: Accept): string[] {
  const refused: string[] = [];
  const taken: { item: ChatFile; file: File }[] = [];
  for (const file of files) {
    if (file.name === "" || file.name.startsWith(".")) continue;
    const no = accept?.(file) ?? null;
    if (no !== null) {
      refused.push(`${file.name}: ${no}`);
      continue;
    }
    const item: ChatFile = { id: ++next, name: file.name, size: file.size, kind: kindOf(file), preview: DRAWN.test(file.type) ? URL.createObjectURL(file) : null, state: "queued", loaded: 0 };
    taken.push({ item, file });
  }
  if (taken.length > 0) useChatFiles.setState(({ chats }) => ({ chats: { ...chats, [key]: [...(chats[key] ?? []), ...taken.map((one) => one.item)] } }));
  const queue = [...taken];
  const worker = async () => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      const { item, file } = job;
      const abort = new AbortController();
      running.set(item.id, abort);
      patch(key, item.id, { state: "uploading" });
      try {
        const landed = await upload(
          file,
          (loaded) => patch(key, item.id, loaded >= file.size ? { loaded, state: "processing" } : { loaded }),
          abort.signal,
        );
        patch(key, item.id, { state: "done", loaded: file.size, landed });
      } catch (error) {
        if (!abort.signal.aborted) patch(key, item.id, { state: "failed", error: error instanceof Error ? error.message : String(error) });
      } finally {
        running.delete(item.id);
      }
    }
  };
  void worker();
  void worker();
  return refused;
}

/** Attaches something already uploaded (a thumbnail's image picked from its list). */
export function attachLanded(key: string, file: { name: string; kind: FileKind; preview: string | null; landed: unknown }): void {
  const list = useChatFiles.getState().chats[key] ?? [];
  if (list.some((one) => one.landed === file.landed)) return;
  const item: ChatFile = { id: ++next, size: 0, state: "done", loaded: 0, ...file };
  useChatFiles.setState(({ chats }) => ({ chats: { ...chats, [key]: [...list, item] } }));
}

/** Takes one off the message: its upload stops (one already in stays where it went). */
export function detachFile(key: string, id: number): void {
  running.get(id)?.abort();
  const item = (useChatFiles.getState().chats[key] ?? []).find((one) => one.id === id);
  if (item?.preview?.startsWith("blob:")) URL.revokeObjectURL(item.preview);
  useChatFiles.setState(({ chats }) => ({ chats: { ...chats, [key]: (chats[key] ?? []).filter((one) => one.id !== id) } }));
}

/** The files that made it in, taken off the composer for a message (its bubble keeps their previews). */
export function takeFiles(key: string): ChatFile[] {
  const list = useChatFiles.getState().chats[key] ?? [];
  for (const item of list) if (item.state !== "done" && item.preview?.startsWith("blob:")) URL.revokeObjectURL(item.preview);
  useChatFiles.setState(({ chats }) => ({ chats: { ...chats, [key]: [] } }));
  return list.filter((item) => item.state === "done");
}

/** Still on their way: a message waits for them. */
export function uploading(list: ChatFile[]): boolean {
  return list.some((item) => item.state !== "done" && item.state !== "failed");
}

/** Only pictures (thumbnails and ideas). */
export const picturesOnly: Accept = (file) => (kindOf(file) === "image" ? null : "only pictures can be attached here");

/** An upload by XHR (fetch can't say how much is sent), its JSON answer back. */
export function postFile(url: string, file: File, progress: (loaded: number) => void, signal: AbortSignal, headers: Record<string, string> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => progress(event.loaded);
    xhr.upload.onload = () => progress(file.size);
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = { error: xhr.responseText };
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error((body as { error?: string } | null)?.error ?? `the upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("connection lost"));
    xhr.onabort = () => reject(new Error("cancelled"));
    signal.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

/** A file as a message carries it into the transcript: the bubble above the person's words. */
export interface SentFile {
  name: string;
  kind: FileKind;
  /** A picture to show, or null (its icon). */
  url: string | null;
}
