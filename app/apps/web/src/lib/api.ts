import { useEffect, useState } from "react";
import { create } from "zustand";

import { note, recordTiming, routeOf } from "./diagnostics";
import type { ExportOptions } from "./exporting";
import type { Patch } from "./patch";
import type { DriveFile, MediaStatus, Project, ProjectSummary, ScriptJob, Style, Transcript } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

/** Whether Edit's server is reachable (false while it restarts). */
export const useConnection = create<{ down: boolean }>(() => ({ down: false }));

const restarting = async (response: Response) =>
  response.status === 502 ||
  response.status === 504 ||
  (response.status === 503 && Boolean(await response.clone().json().then((body) => body?.restarting).catch(() => false)));

/**
 * Retry reads while the server restarts. A failed network response cannot
 * tell us whether a mutation landed, so mutations are never replayed here.
 */
export async function fetchRetrying(url: string, init?: RequestInit, patienceMs = 120_000): Promise<Response> {
  const started = Date.now();
  const retryable = !init?.method || ["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase());
  for (let attempt = 0; ; attempt++) {
    let response: Response | null = null;
    const route = routeOf(init?.method ?? "GET", url);
    const sent = performance.now();
    try {
      response = await fetch(url, init);
      recordTiming(route, performance.now() - sent, response.status >= 500);
      if (!retryable) return response;
      if (!(await restarting(response))) {
        if (useConnection.getState().down) useConnection.setState({ down: false });
        return response;
      }
    } catch (error) {
      recordTiming(route, performance.now() - sent, true);
      note("warn", "http", `${route}: no response (${error})`);
      // A lost response does not mean the server didn't apply a mutation.
      // Retrying POST can duplicate paid work, projects or media imports.
      if (!retryable || init?.signal?.aborted) throw error;
    }
    if (Date.now() - started > patienceMs) {
      if (response) return response;
      throw new Error("Can't reach Edit's server");
    }
    if (attempt > 0) useConnection.setState({ down: true });
    await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 250 * 2 ** attempt)));
  }
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetchRetrying(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof data === "object" && data && "error" in data ? String(data.error) : String(data);
    note(response.status >= 500 ? "error" : "warn", "http", `${method} ${url} → ${response.status}: ${message}`);
    throw new ApiError(message, response.status, data);
  }
  return data as T;
}

/** How the YouTube sign-in from Chrome stands (server youtube_signin.ts). */
export interface YoutubeSignIn {
  chrome: boolean;
  profile: { dir: string; name: string; signedIn: boolean } | null;
  allowed: boolean | null;
  problem: string | null;
}

export interface Live {
  rev: number;
  project: Project;
}

export interface FsEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  places: { name: string; path: string }[];
}

/** An image found by research, waiting for review (or reviewed). */
export interface FoundImage {
  id: string;
  file: string;
  width: number;
  height: number;
  title: string;
  /** The page it's on. */
  page: string;
  image: string;
  query: string;
  status: "new" | "kept" | "rejected";
  /** The media it became once kept. */
  media?: string;
}

/** A news article about the case, saved by research. */
export interface FoundArticle {
  id: string;
  url: string;
  title: string;
  outlet: string;
  published?: string;
  /** What it adds to the case. */
  summary: string;
  text: string;
}

/** A finished export of a project (apps/server/src/exports.ts ExportRecord). */
export interface ExportRecord {
  path: string;
  name: string;
  finished_ms: number;
  seconds: number;
  bytes: number | null;
  frames: number;
  whole: boolean;
  format: string;
  /** Its file is gone from the machine. */
  missing: boolean;
}

/** Jobs on this Mac, independent of the project open in the editor. */
export interface ExportActivity {
  id: string;
  name: string;
  path: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  backend: "local" | "cloud" | "modal";
  updated_ms: number;
  error?: string;
}

export const api = {
  projects: () => request<{ projects: ProjectSummary[] }>("GET", "/api/projects"),
  createProject: (body: { name: string; style: Style; width: number; height: number; fps: number }) =>
    request<Live>("POST", "/api/projects", body),
  project: (id: string) => request<Live>("GET", `/api/projects/${id}`),
  saveProject: (id: string, baseRev: number, project: Project, origin: string) =>
    request<{ rev: number }>("PUT", `/api/projects/${id}`, { base_rev: baseRev, project, origin }),
  /** Saves only what changed since `baseRev` (patch.ts). */
  saveChanges: (id: string, baseRev: number, patch: Patch, origin: string) =>
    request<{ rev: number }>("PUT", `/api/projects/${id}`, { base_rev: baseRev, patch, origin }),
  deleteProject: (id: string) => request<{ ok: boolean }>("DELETE", `/api/projects/${id}`),
  importMedia: (id: string, paths: string[], place: boolean, origin: string) =>
    request<{ rev: number; added: string[]; errors: string[]; project: Project }>("POST", `/api/projects/${id}/import`, {
      paths,
      place,
      origin,
    }),
  /** Footage from a Google Drive folder or file link: downloaded on the machine running Edit, then imported. */
  importDrive: (id: string, url: string, place: boolean, origin: string) =>
    request<{ rev: number; added: string[]; errors: string[]; project: Project }>("POST", `/api/projects/${id}/import-drive`, { url, place, origin }),
  research: (id: string) =>
    request<{ items: FoundImage[]; articles: FoundArticle[]; collecting: boolean }>("GET", `/api/projects/${id}/research`),
  /** Deletes the found images with a status (unreviewed or rejected). */
  clearResearch: (id: string, status: "new" | "rejected") =>
    request<{ removed: number }>("POST", `/api/projects/${id}/research/clear?status=${status}`),
  collectResearch: (id: string, queries: string[], perQuery: number) =>
    request<{ started: boolean }>("POST", `/api/projects/${id}/research`, { queries, per_query: perQuery }),
  /** Keeping adds the image to the media bin (once). */
  reviewResearch: (id: string, item: string, status: FoundImage["status"], origin: string) =>
    request<{ item: FoundImage; rev: number; project: Project }>("POST", `/api/projects/${id}/research/${item}`, { status, origin }),
  mediaStatus: (id: string) => request<{ media: Record<string, MediaStatus> }>("GET", `/api/projects/${id}/media-status`),
  /** The footage the timeline plays that isn't on this machine and can't be fetched. */
  missingFootage: (id: string) =>
    request<{ used: number; missing: { id: string; name: string; path: string }[] }>("GET", `/api/projects/${id}/missing`),
  browse: (path?: string) => request<FsListing>("GET", `/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  /** `drive`: upload the finished file to Drive (by default only a whole subtitled video is). */
  exportProject: (id: string, path: string, options: ExportOptions, drive?: boolean) =>
    request<{ path: string }>("POST", `/api/projects/${id}/export`, drive === undefined ? { path, options } : { path, options, drive }),
  /** Shows a finished export in Finder on the machine running Edit. */
  /** The project's Drive link, checked that the file is still there (null once it's gone). */
  driveLink: (id: string) => request<{ drive: DriveFile | null }>("GET", `/api/projects/${id}/drive`),
  /** Uploads a finished export of a subtitled video to Drive again. */
  driveUpload: (id: string, path: string) => request<{ ok: boolean }>("POST", `/api/projects/${id}/drive`, { path }),
  revealExport: (path: string) => request<{ ok: boolean }>("POST", "/api/exports/reveal", { path }),
  /** The project's exports on the machine running Edit, newest first. */
  exports: (id: string) => request<ExportRecord[]>("GET", `/api/projects/${id}/exports`),
  exportActivity: () => request<ExportActivity[]>("GET", "/api/exports/activity"),
  youtubeSignIn: () => request<YoutubeSignIn>("GET", "/api/youtube/sign-in"),
  checkYoutubeSignIn: () => request<YoutubeSignIn>("POST", "/api/youtube/sign-in/check"),
  /** Deletes one of them (its file too); the list after. */
  deleteExport: (id: string, path: string) => request<ExportRecord[]>("POST", `/api/projects/${id}/exports/delete`, { path }),
  transcribe: (id: string, media: string) => request<{ status: MediaStatus }>("POST", `/api/projects/${id}/media/${media}/transcribe`),
  transcript: (id: string, media: string) => request<Transcript>("GET", `/api/projects/${id}/media/${media}/transcript`),
  cancelExport: (id: string) => request<{ cancelled: boolean }>("POST", `/api/projects/${id}/export/cancel`),
  /** Sets who a voice is (its role decides its colour); returns the updated transcript. */
  setSpeaker: (id: string, media: string, voice: string, role: string) =>
    request<Transcript>("POST", `/api/projects/${id}/media/${media}/speakers`, { voice, role }),
  /** Reads a Google Doc script (on the server, as its public link) without importing it. */
  scriptPreview: (url: string) =>
    request<{ title: string; footage: number; narration: number; files: number; seconds: number; whole?: number }>("POST", "/api/scripts/preview", { url }),
  /** Attaches a Doc's script to a project and starts downloading its footage. */
  attachScript: (id: string, url: string) => request<{ rev: number; project: Project; job: ScriptJob | null }>("POST", `/api/projects/${id}/script`, { url }),
  scriptJob: (id: string) => request<{ job: ScriptJob | null; unfinished: boolean }>("GET", `/api/projects/${id}/script/job`),
  /** Picks up a stopped import; `recut` lays the script out again from fresh transcript cuts. */
  /** Footage the import couldn't fetch: another link for it, or go on without it. */
  answerFootage: (id: string, file: string, answer: { url: string } | { skip: true }) =>
    request<{ job: ScriptJob | null }>("POST", `/api/projects/${id}/script/footage`, { file, ...answer }),
  resumeScript: (id: string, recut = false) => request<{ job: ScriptJob | null }>("POST", `/api/projects/${id}/script/job${recut ? "?recut=true" : ""}`),
  /** Where Edit keeps big media files (the media drive, set in code or with `edit media use`). */
  mediaDrive: () => request<MediaDrive>("GET", "/api/media-drive"),
  /** Per project: open review notes, a finished edit, and whether what it is now is exported. */
  projectStatus: () => request<Record<string, ProjectStatus>>("GET", "/api/projects/status"),
  /** The project's Repack review: its link, its notes with their frames, the agent's fixes. */
  review: (id: string) => request<Review>("GET", `/api/projects/${id}/review`),
  /** Shares a whole export for review (the newest without `path`); `started` while it uploads. */
  shareReview: (id: string, path?: string) =>
    request<{ started?: boolean; url?: string; version?: number }>("POST", `/api/projects/${id}/review/share`, path === undefined ? {} : { path }),
  /** Approves the latest shared version: the review closes and the other versions' files (and their exports here) are deleted. */
  /** Share: exports the whole edit, then puts it on the project's review link (a new version after the first). */
  shareProject: (id: string, options: ExportOptions, replace = false) => request<{ started?: boolean; url?: string; version?: number }>("POST", `/api/projects/${id}/share`, { options, replace }),
  /** A reset the agent is asking about (`reset_edit`), and the user's answer to it. */
  resetAsked: (id: string) => request<{ pending: { asked_ms: number } | null }>("GET", `/api/projects/${id}/reset`),
  answerReset: (id: string, accept: boolean) => request<{ answered: boolean }>("POST", `/api/projects/${id}/reset`, { accept }),
  approveReview: (id: string) => request<{ version: number; deleted: string[] }>("POST", `/api/projects/${id}/review/approve`),
  /** Brings an archived project's footage back from Drive and YouTube. */
  restoreProject: (id: string) => request<{ started: boolean }>("POST", `/api/projects/${id}/restore`),
  /** Writer's scripts in the cloud, newest first, each with the project made from it here. */
  writerScripts: () => request<{ scripts: WriterScriptRow[] }>("GET", "/api/writer/scripts"),
  /** Makes an Edit project from a Writer script and starts its import. */
  importWriter: (id: string) => request<{ project: string }>("POST", `/api/writer/scripts/${id}/import`),
};

export interface WriterScriptRow {
  id: string;
  title: string;
  rev: number;
  updatedAt: number;
  updatedBy: string | null;
  project: string | null;
  /** Sent to Edit from Writer ("Send to Edit"): when, by whom, and whether the script changed since. */
  handoff: { at: number; by: string | null; changed: boolean } | null;
  /** Its footage clips and running time; `built` when it has clips to edit (not a source still being researched). */
  clips: number;
  durationMs: number;
  built: boolean;
  /** Its kind of video, when Writer says. */
  style: Style | null;
}

export interface ProjectStatus {
  feedback: number;
  complete: boolean;
  exported: boolean;
  /** The version approved on its review (the others' files deleted), or null. */
  approved: number | null;
  /** Archived on Repack (its big files freed), with a restore under way or failed. */
  archived: { restoring: boolean; error: string | null } | null;
}

/** A note on a project's Repack review, as Edit has it. */
export interface ReviewNote {
  id: string;
  version: number;
  author: string;
  text: string;
  status: "open" | "done";
  reply_to: string | null;
  /** Its moment on the timeline now (null: no moment). */
  frame: number | null;
  /** What the agent changed for it: its words, and the stretches (frames) on the timeline now. */
  fix: { summary: string; ranges: [number, number][] } | null;
  unfixed: string | null;
  fixing: boolean;
}

export interface Review {
  sharing: string | null;
  review: { url: string; versions: { n: number; path: string }[]; approved: { version: number; by: string; at: number } | null } | null;
  notes: ReviewNote[];
}

/** The media drive: an optional folder (usually on an external drive) for downloads, uploads and exports. */
export interface MediaDrive {
  dir: string | null;
  /** Set by EDIT_MEDIA_DIR (the setting can't change it). */
  env: boolean;
  state: "off" | "connected" | "offline";
  problem: string | null;
  home: string;
  /** Where exports go by default. */
  exports: string;
  /** Media still in the data folder (media/ and uploads/). */
  internal_bytes: number;
  /** The command that moves it to the media drive. */
  move_command: string | null;
  /** Drives mounted under /Volumes. */
  volumes: { name: string; path: string }[];
}

export const mediaUrl = (project: string, media: string, kind: "proxy" | "light" | "audio" | "thumbs" | "peaks") =>
  `/api/projects/${project}/media/${media}/${kind}`;

let machine: Promise<string> | null = null;

/** The page is open on the machine running Edit (the desktop app, or a browser there). */
export const isLocal = typeof location !== "undefined" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);

/** Name of the computer running Edit (e.g. "kenobi"), for labels like "Files on kenobi". */
export function useMachine() {
  const [name, setName] = useState("server");
  useEffect(() => {
    machine ??= fetchRetrying("/api/health")
      .then((response) => response.json())
      .then((health) => String(health.machine ?? "server"))
      .catch(() => "server");
    void machine.then(setName);
  }, []);
  return name;
}
