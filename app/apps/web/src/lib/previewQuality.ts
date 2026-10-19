// Which preview picture to stream: the full preview (≤1080p, ~5 Mbit/s) or the
// light one (720p, ~1.5 Mbit/s) for watching from another machine.

import { create } from "zustand";

import { isLocal as local } from "./api";
import { readSetting, writeSetting } from "./storage";

export type PreviewQuality = "auto" | "full" | "light";

export const usePreviewQuality = create<{ quality: PreviewQuality }>(() => ({
  quality: (readSetting("edit.previewQuality") as PreviewQuality | null) ?? "auto",
}));

export function setPreviewQuality(quality: PreviewQuality) {
  writeSetting("edit.previewQuality", quality);
  usePreviewQuality.setState({ quality });
}

/** Whether to stream the light preview (when it's ready). */
export const wantsLight = (quality: PreviewQuality) => quality === "light" || (quality === "auto" && !local);
