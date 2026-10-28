// Uploads footage from the device the browser runs on to the machine running
// Edit, one file at a time, with byte-level progress (fetch can't report it).

import { create } from "zustand";

import { placeMedia } from "./edit";
import { clientId, useEditor } from "./store";
import type { Project } from "./types";

const MEDIA_FILE = /\.(mp4|mov|m4v|mkv|webm|avi|mts|mxf|wav|mp3|m4a|aac|flac|aif|aiff|ogg|opus)$/i;

export interface Upload {
  id: number;
  name: string;
  size: number;
  loaded: number;
  state: "queued" | "uploading" | "processing" | "done" | "failed";
  error?: string;
}

/** Where to put an upload on the timeline once it lands (drop onto the timeline). */
interface Placement {
  frame: number;
  track?: string;
}

interface Job {
  upload: Upload;
  file: File;
  projectId: string;
  placement?: Placement;
}

export const useUploads = create<{ uploads: Upload[] }>(() => ({ uploads: [] }));

let nextId = 0;
const queue: Job[] = [];
let running = false;
/** No bytes accepted for this long = the server isn't taking the upload. */
const STALL_MS = 20_000;
const active = new Map<number, XMLHttpRequest>();

/** Cancels a queued or running upload. */
export function cancelUpload(id: number) {
  const index = queue.findIndex((job) => job.upload.id === id);
  if (index >= 0) queue.splice(index, 1);
  active.get(id)?.abort();
  useUploads.setState(({ uploads }) => ({ uploads: uploads.filter((upload) => upload.id !== id) }));
}

function patch(id: number, change: Partial<Upload>) {
  useUploads.setState(({ uploads }) => ({ uploads: uploads.map((upload) => (upload.id === id ? { ...upload, ...change } : upload)) }));
}

function forget(id: number, delay: number) {
  setTimeout(() => useUploads.setState(({ uploads }) => ({ uploads: uploads.filter((upload) => upload.id !== id) })), delay);
}

/** Queues files for upload. With `placement`, each lands on the timeline after the previous one. */
export function uploadFiles(files: File[], placement?: Placement) {
  const project = useEditor.getState().project;
  if (!project) return;
  const accepted = files.filter((file) => MEDIA_FILE.test(file.name));
  const rejected = files.length - accepted.length;
  if (rejected) useEditor.getState().toast(`Skipped ${rejected} file${rejected > 1 ? "s" : ""} that aren't video or audio.`, "error");
  for (const [index, file] of accepted.entries()) {
    const upload: Upload = { id: ++nextId, name: file.name, size: file.size, loaded: 0, state: "queued" };
    useUploads.setState(({ uploads }) => ({ uploads: [...uploads, upload] }));
    // Only the first carries an explicit frame; the rest follow it.
    queue.push({ upload, file, projectId: project.id, placement: placement && { ...placement, frame: index === 0 ? placement.frame : -1 } });
  }
  void pump();
}

let followFrame = 0;

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift()!;
    try {
      patch(job.upload.id, { state: "uploading" });
      const result = await send(job);
      patch(job.upload.id, { state: "done", loaded: job.upload.size });
      forget(job.upload.id, 1500);
      land(job, result);
    } catch (error) {
      if ((error as Error).name === "AbortError") continue;
      patch(job.upload.id, { state: "failed", error: (error as Error).message });
      useEditor.getState().toastError(error, `upload ${job.upload.name}`);
      forget(job.upload.id, 8000);
    }
  }
  running = false;
}

function send(job: Job): Promise<{ rev: number; added: string[]; project: Project }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({ name: job.file.name, size: String(job.file.size), origin: `upload-${clientId}` });
    xhr.open("POST", `/api/projects/${job.projectId}/upload?${query}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    let stall: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        reject(new Error("the server stopped accepting the upload (is `edit serve` up to date?)"));
        xhr.abort();
      }, STALL_MS);
    };
    const done = () => {
      clearTimeout(stall);
      active.delete(job.upload.id);
    };
    active.set(job.upload.id, xhr);
    watch();
    xhr.upload.onprogress = (event) => {
      watch();
      patch(job.upload.id, { loaded: event.loaded });
    };
    // Bytes are all sent; the server is now probing the file (no timeout).
    xhr.upload.onload = () => {
      clearTimeout(stall);
      patch(job.upload.id, { state: "processing" });
    };
    xhr.onabort = () => {
      done();
      reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    };
    xhr.onload = () => {
      done();
      const body = (() => {
        try {
          return JSON.parse(xhr.responseText);
        } catch {
          return { error: xhr.responseText };
        }
      })();
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error ?? `upload failed (${xhr.status})`));
    };
    xhr.onerror = () => {
      done();
      reject(new Error("connection lost"));
    };
    try { xhr.send(job.file); } catch (error) { done(); reject(error); }
  });
}

function land(job: Job, result: { rev: number; added: string[]; project: Project }) {
  const state = useEditor.getState();
  if (!state.project || state.project.id !== job.projectId) return;
  // The live event normally beats the HTTP response; catch up if it didn't.
  if (state.rev < result.rev) state.adopt(result.rev, result.project);
  const media = result.added[0];
  if (!job.placement || !media) return;
  const frame = job.placement.frame >= 0 ? job.placement.frame : followFrame;
  let ids: string[] = [];
  useEditor.getState().edit((draft) => {
    ids = placeMedia(draft, media, frame, job.placement!.track);
    const placed = draft.clips.find((clip) => clip.id === ids[0]);
    followFrame = placed ? placed.start + placed.duration : frame;
  });
  useEditor.getState().select(ids);
}
