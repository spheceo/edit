// Whether this Mac is short of memory, as macOS judges it (the server's
// memory.ts decides when, and which app to name). Asked every 10 s while a
// window shows the chip.

import { create } from "zustand";

export interface MemoryStatus {
  low: boolean;
  /** macOS's red: things will slow or stall now. */
  critical?: boolean;
  /** The app using the most memory, other than Edit. */
  app?: { name: string; bytes: number } | null;
}

export const useMemory = create<MemoryStatus>(() => ({ low: false }));

const POLL_MS = 10_000;
let timer: ReturnType<typeof setTimeout> | undefined;

async function poll() {
  try {
    const response = await fetch("/api/memory", { signal: AbortSignal.timeout(5_000) });
    if (response.ok) useMemory.setState((await response.json()) as MemoryStatus, true);
  } catch {
    // The server is away; the chip keeps what it last knew.
  }
  timer = setTimeout(() => void poll(), POLL_MS);
}

/** Mount once: keeps the memory status fresh. */
export function watchMemory() {
  if (timer === undefined) void poll();
}
