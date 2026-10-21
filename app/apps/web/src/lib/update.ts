// Self-update. The server asks the relay for new releases; one click has it
// download the new version and restart into it, and this page reloads once
// the new version answers (see apps/server/src/update.ts).

import { create } from "zustand";

import { request } from "./api";
import { useEditor } from "./store";

export type UpdateChannel = "nightly" | "stable";

export interface UpdateStatus {
  /** This build: "nightly-12", or "v0.0.0". */
  current: string;
  /** A newer build's tag ("v0.2.0", "nightly-13"), if there is one. */
  latest: string | null;
  /** Nightly offers every nightly as it's out; Stable, releases only. */
  channel: UpdateChannel;
  phase: "idle" | "downloading" | "restarting";
  /** 0–1 while downloading. */
  progress: number;
  error: string | null;
  /** False for builds that don't update themselves (dev builds). */
  enabled: boolean;
}

export const useUpdate = create<{
  status: UpdateStatus | null;
  /** The version being updated from, while an update is underway. */
  from: string | null;
}>(() => ({ status: null, from: null }));

/** The server only asks the relay every ten minutes anyway. */
const IDLE_POLL_MS = 10 * 60_000;
const BUSY_POLL_MS = 500;
/** How long to wait for the new version before giving up on it. */
const RESTART_PATIENCE_MS = 120_000;

let timer: ReturnType<typeof setTimeout> | undefined;
let startedAt = 0;

function schedule(ms: number) {
  clearTimeout(timer);
  timer = setTimeout(() => void poll(), ms);
}

async function poll() {
  const { from } = useUpdate.getState();
  try {
    const response = await fetch("/api/update");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = (await response.json()) as UpdateStatus;
    if (from && status.current !== from) {
      // The new version is up; load its UI.
      location.reload();
      return;
    }
    useUpdate.setState({ status });
    if (from && status.phase === "idle") {
      useUpdate.setState({ from: null });
      if (status.error) useEditor.getState().toast(`Update failed: ${status.error}`, "error");
    }
  } catch {
    // Down while it restarts.
    if (from && Date.now() - startedAt > RESTART_PATIENCE_MS) {
      useUpdate.setState({ from: null });
      useEditor.getState().toast("Edit didn't come back after updating; run `edit serve` again.", "error");
    }
  }
  schedule(useUpdate.getState().from ? BUSY_POLL_MS : IDLE_POLL_MS);
}

/** Mount once: keeps the update status fresh. */
export function watchUpdates() {
  if (timer === undefined) void poll();
}

/** Switches channel; the server asks GitHub again straight away. */
export async function chooseChannel(channel: UpdateChannel): Promise<void> {
  useUpdate.setState({ status: await request<UpdateStatus>("PUT", "/api/update/channel", { channel }) });
}

/** Downloads the newest version; the server restarts into it and the page reloads. */
export async function installUpdate() {
  const { status, from } = useUpdate.getState();
  if (!status?.latest || from) return;
  startedAt = Date.now();
  useUpdate.setState({ from: status.current, status: { ...status, phase: "downloading", progress: 0, error: null } });
  try {
    const response = await fetch("/api/update", { method: "POST" });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
    useUpdate.setState({ status: body as UpdateStatus });
  } catch (error) {
    useUpdate.setState({ from: null, status: { ...status, phase: "idle" } });
    useEditor.getState().toast(`Couldn't update: ${error instanceof Error ? error.message : error}`, "error");
    return;
  }
  schedule(BUSY_POLL_MS);
}
