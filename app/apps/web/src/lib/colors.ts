import type { ClipColor, Rgba } from "./types";

/** Timeline label colours: vivid on black, readable with white text. */
export const CLIP_HEX: Record<ClipColor, string> = {
  blue: "#3b82f6",
  cyan: "#06b6d4",
  green: "#22c55e",
  yellow: "#eab308",
  orange: "#f97316",
  red: "#ef4444",
  purple: "#a855f7",
  pink: "#ec4899",
};

export const rgbaToHex = ([r, g, b]: Rgba) =>
  `#${[r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}`;

export const hexToRgba = (hex: string, alpha = 1): Rgba => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255, alpha];
};
