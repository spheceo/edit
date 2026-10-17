// Cloud projects (crates/edit/src/cloud_projects.rs): projects kept in the
// team's cloud so a teammate can carry on where someone stopped; one machine
// edits a project at a time (it holds the lock, everyone else is read-only).

import { request } from "./api";
import type { Style } from "./types";

/** A project's cloud state on this machine. */
export interface CloudStatus {
  /** A cloud project (false: only on this machine). */
  cloud: boolean;
  /** Cloud is on here. */
  on: boolean;
  lock?: "unknown" | "provisional" | "held" | "elsewhere";
  /** Who's editing it, when it's someone else. */
  holder?: string | null;
  sync?: "off" | "synced" | "pending" | "syncing" | "offline" | "conflict" | "readonly" | "error";
  rev?: number;
  dirty?: boolean;
  message?: string | null;
  /** Files the edit uses that are neither on this machine nor in the cloud, in a sentence naming them. */
  missing?: string | null;
}

/** Settings → Cloud. */
export interface CloudSettings {
  on: boolean;
  /** Where the token comes from (EDIT_RELAY_TOKEN, or saved here). */
  token: "env" | "saved" | null;
  /** How teammates see this machine. */
  holder: string;
  relay: string;
  connected?: boolean;
  problem?: string | null;
}

/** A project in the cloud, as listed (no body). */
export interface CloudProject {
  id: string;
  name: string;
  rev: number;
  updated_ms: number;
  updated_by: string;
  summary: {
    style?: Style;
    durationFrames?: number;
    clips?: number;
    media?: number;
    cloudMedia?: number;
    fps?: number;
    width?: number;
    height?: number;
    subtitles?: boolean;
  } | null;
  /** Who's editing it now (a live lock), if anyone. */
  holder: string | null;
  /** This machine holds its lock. */
  here: boolean;
  /** It's on this machine too. */
  local: boolean;
}

export interface CloudList {
  on: boolean;
  holder?: string;
  projects?: CloudProject[];
  statuses?: Record<string, CloudStatus>;
  offline?: boolean;
  error?: string;
}

export const cloudApi = {
  settings: (check = true) => request<CloudSettings>("GET", `/api/cloud${check ? "?check=true" : ""}`),
  /** `token: null` forgets the saved token. */
  setSettings: (body: { token?: string | null; holder?: string | null }) => request<CloudSettings>("POST", "/api/cloud", body),
  projects: () => request<CloudList>("GET", "/api/cloud/projects"),
  status: (id: string) => request<CloudStatus>("GET", `/api/projects/${id}/cloud`),
  /** The editor opened it: a cloud-only project is downloaded, the lock asked for. */
  open: (id: string, client: string, heartbeat = false) =>
    request<CloudStatus>("POST", `/api/projects/${id}/cloud/open`, { client, heartbeat }),
  close: (id: string, client: string) => request<{ ok: boolean }>("POST", `/api/projects/${id}/cloud/close`, { client }),
  takeOver: (id: string) => request<CloudStatus>("POST", `/api/projects/${id}/cloud/takeover`),
  moveToCloud: (id: string) => request<CloudStatus>("POST", `/api/projects/${id}/cloud/upload`),
};

/** Someone else is editing it: read-only here. */
export const readOnly = (status: CloudStatus | null | undefined) => status?.lock === "elsewhere";

/** What the top bar says about a project's sync, or null when there's nothing to say. */
export function syncLabel(status: CloudStatus | null | undefined): { text: string; tone: "ok" | "busy" | "warn" | "bad" } | null {
  if (!status?.cloud || !status.on) return null;
  if (status.missing && (status.sync === "synced" || status.sync === "pending" || status.sync === "syncing")) {
    return { text: "Files missing", tone: "bad" };
  }
  switch (status.sync) {
    case "synced":
      return { text: "Saved to cloud", tone: "ok" };
    case "pending":
    case "syncing":
      return { text: "Syncing…", tone: "busy" };
    case "offline":
      return { text: "Offline · will sync", tone: "warn" };
    case "conflict":
      return { text: "Conflict", tone: "bad" };
    case "readonly":
      return { text: "Read-only", tone: "warn" };
    case "error":
      return { text: "Sync problem", tone: "bad" };
    default:
      return null;
  }
}
