import { useEffect, useState } from "react";
import { create } from "zustand";

import { note, recordTiming, routeOf } from "./diagnostics";
import type { Encoders, ExportOptions } from "./exporting";
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

/** A sound in the team's library (Google Drive). */
export interface LibrarySound {
  /** The Drive file id. */
  id: string;
  name: string;
  kind: "music" | "sfx";
  category: string;
  note?: string;
  bytes: number;
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

export const api = {
  projects: () => request<{ projects: ProjectSummary[] }>("GET", "/api/projects"),
  createProject: (body: { name: string; style: Style; width: number; height: number; fps: number }) =>
    request<Live>("POST", "/api/projects", body),
  project: (id: string) => request<Live>("GET", `/api/projects/${id}`),
  saveProject: (id: string, baseRev: number, project: Project, origin: string) =>
    request<{ rev: number }>("PUT", `/api/projects/${id}`, { base_rev: baseRev, project, origin }),
  deleteProject: (id: string) => request<{ ok: boolean }>("DELETE", `/api/projects/${id}`),
  importMedia: (id: string, paths: string[], place: boolean, origin: string) =>
    request<{ rev: number; added: string[]; errors: string[]; project: Project }>("POST", `/api/projects/${id}/import`, {
      paths,
      place,
      origin,
    }),
  library: (refresh = false) => request<{ sounds: LibrarySound[]; guide: string }>("GET", `/api/library${refresh ? "?refresh=true" : ""}`),
  /** Downloads a library sound (first time) and adds it to the project's media. */
  importLibrary: (id: string, sound: string, origin: string) =>
    request<{ rev: number; media: string; project: Project }>("POST", `/api/projects/${id}/library`, { sound, origin }),
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
  browse: (path?: string) => request<FsListing>("GET", `/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  exportProject: (id: string, path: string, options: ExportOptions) =>
    request<{ path: string }>("POST", `/api/projects/${id}/export`, { path, options }),
  exportEncoders: () => request<Encoders>("GET", "/api/export/encoders"),
  /** Shows a finished export in Finder on the machine running Edit. */
  /** The project's Drive link, checked that the file is still there (null once it's gone). */
  driveLink: (id: string) => request<{ drive: DriveFile | null }>("GET", `/api/projects/${id}/drive`),
  /** Uploads a finished export of a subtitled video to Drive again. */
  driveUpload: (id: string, path: string) => request<{ ok: boolean }>("POST", `/api/projects/${id}/drive`, { path }),
  revealExport: (path: string) => request<{ ok: boolean }>("POST", "/api/exports/reveal", { path }),
  transcribe: (id: string, media: string) => request<{ status: MediaStatus }>("POST", `/api/projects/${id}/media/${media}/transcribe`),
  transcript: (id: string, media: string) => request<Transcript>("GET", `/api/projects/${id}/media/${media}/transcript`),
  cancelExport: (id: string) => request<{ cancelled: boolean }>("POST", `/api/projects/${id}/export/cancel`),
  /** Sets who a voice is (its role decides its colour); returns the updated transcript. */
  setSpeaker: (id: string, media: string, voice: string, role: string) =>
    request<Transcript>("POST", `/api/projects/${id}/media/${media}/speakers`, { voice, role }),
  /** Reads a Google Doc script (on the server, as its public link) without importing it. */
  scriptPreview: (url: string) =>
    request<{ title: string; footage: number; narration: number; files: number; seconds: number }>("POST", "/api/scripts/preview", { url }),
  /** Attaches a Doc's script to a project and starts downloading its footage. */
  attachScript: (id: string, url: string) => request<{ rev: number; project: Project; job: ScriptJob | null }>("POST", `/api/projects/${id}/script`, { url }),
  scriptJob: (id: string) => request<{ job: ScriptJob | null; unfinished: boolean }>("GET", `/api/projects/${id}/script/job`),
  /** Picks up a stopped import; `recut` lays the script out again from fresh transcript cuts. */
  resumeScript: (id: string, recut = false) => request<{ job: ScriptJob | null }>("POST", `/api/projects/${id}/script/job${recut ? "?recut=true" : ""}`),
  /** Where Edit keeps big media files (Settings → Media drive). */
  mediaDrive: () => request<MediaDrive>("GET", "/api/media-drive"),
  /** Sets the media folder; null turns the media drive off. */
  setMediaDrive: (dir: string | null) => request<MediaDrive>("POST", "/api/media-drive", { dir }),
};

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
