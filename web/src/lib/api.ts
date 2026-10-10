import { useEffect, useState } from "react";
import { create } from "zustand";

import type { MediaStatus, Project, ProjectSummary, ScriptJob, Transcript } from "./types";

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
 * fetch that waits out a server restart (cargo watch, a crash) instead of
 * failing: unreachable means the request never arrived, so retrying is safe.
 */
export async function fetchRetrying(url: string, init?: RequestInit, patienceMs = 120_000): Promise<Response> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    let response: Response | null = null;
    try {
      response = await fetch(url, init);
      if (!(await restarting(response))) {
        if (useConnection.getState().down) useConnection.setState({ down: false });
        return response;
      }
    } catch (error) {
      if (init?.signal?.aborted) throw error;
    }
    if (Date.now() - started > patienceMs) {
      if (response) return response;
      throw new Error("Can't reach Edit's server");
    }
    if (attempt > 0) useConnection.setState({ down: true });
    await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 250 * 2 ** attempt)));
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetchRetrying(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof data === "object" && data && "error" in data ? String(data.error) : String(data);
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

export const api = {
  projects: () => request<{ projects: ProjectSummary[] }>("GET", "/api/projects"),
  createProject: (body: { name: string; width: number; height: number; fps: number }) =>
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
  mediaStatus: (id: string) => request<{ media: Record<string, MediaStatus> }>("GET", `/api/projects/${id}/media-status`),
  browse: (path?: string) => request<FsListing>("GET", `/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  exportProject: (id: string, path?: string) => request<{ path: string }>("POST", `/api/projects/${id}/export`, { path }),
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
};

export const mediaUrl = (project: string, media: string, kind: "proxy" | "thumbs" | "peaks") =>
  `/api/projects/${project}/media/${media}/${kind}`;

let machine: Promise<string> | null = null;

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
