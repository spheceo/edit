// Thumbnails (Nov 2 2026): Thumb brought into Edit (Sphe: "have a conversation
// with the agent to have a thumbnail generated… claude gets drafts and stuff
// generated on openart via mcp"; "the ability to add our overlays and work with
// photoshop type stuff like editing exposure and saturation"; "text overlays…
// control the dropshadow spread ETC. like basically bringing photoshop to it but
// only have features we need/use"). The team's, whole in mamagi (`thumbnails`
// module); its pictures on R2 under `edit/thumbnails/<id>/`. One shape for the
// server and the UI; the drawing is `thumbnail_render.ts`.

/** The canvas: YouTube's 1280×720. */
export const WIDTH = 1280;
export const HEIGHT = 720;

/** A picture the thumbnail has: made on OpenArt, uploaded, or a frame of a video. */
export type ThumbImage = {
  id: string;
  name: string;
  /** Under `edit/thumbnails/<id>/`. */
  key: string;
  from: "openart" | "upload" | "render";
  width: number;
  height: number;
  /** What made it on OpenArt: the prompt, the model, the pictures it was given (by id). */
  prompt?: string;
  model?: string;
  references?: string[];
  /** The person's own request in the turn that made it, kept with the prompt so it can be pulled again after the chat has moved on. */
  request?: string;
  at: number;
  by: string;
};

/** Photoshop's few that the team uses, each 0 when untouched. */
export type Adjust = {
  /** -5…+5, in stops as Camera Raw's (0.60 is +0.60 of a stop): darker to brighter. */
  exposure: number;
  /** -100…100. */
  contrast: number;
  /** -100…100: grey to vivid. */
  saturation: number;
  /** -100…100: colour pushed hardest where it's muted, vivid colour (and skin) left nearer alone. */
  vibrance: number;
  /** -100…100: cool (blue) to warm (orange). */
  warmth: number;
  /** -100…100: the dark parts lifted (positive) or crushed. */
  shadows: number;
  /** -100…100: the bright parts pulled down (negative) or pushed. */
  highlights: number;
  /** 0…100: the corners darkened. */
  vignette: number;
  /** 0…100. */
  sharpen: number;
};

export const NO_ADJUST: Adjust = { exposure: 0, contrast: 0, saturation: 0, vibrance: 0, warmth: 0, shadows: 0, highlights: 0, vignette: 0, sharpen: 0 };

/** A drop shadow as Photoshop's: its spread chokes it solid before the blur (size). */
export type Shadow = {
  color: string;
  /** 0…100. */
  opacity: number;
  /** Photoshop's angle in degrees: where the light comes from (90: from above). */
  angle: number;
  /** px: how far the shadow falls. */
  distance: number;
  /** 0…100: how much of the shadow is solid before it softens. */
  spread: number;
  /** px: how soft it is. */
  size: number;
};

export type Box = { color: string; opacity: number; padX: number; padY: number; radius: number };
export type Stroke = { color: string; width: number };

export type Fonts = (typeof FONTS)[number]["family"];

/** White and red captions. The face ships with Edit (assets/thumbnails/fonts). */
export const WHITE_RED_FONT = "Arabic-font-2013" as const;
/** Black-box captions: the bold cut, shipped with Edit. */
export const BLACK_BOX_FONT = "ITC Avant Garde Gothic" as const;

/**
 * Photoshop's drop shadow for the white-and-red captions: opacity 100, spread
 * 36, size 32, angle 90 (the light above, so it falls straight down), distance
 * 6. It lives beside the drawing, which is what the page and Chrome both run.
 */
export { HOUSE_SHADOW, captionShadow } from "./thumbnail_render";

/**
 * The fonts a text can take. The first three ship with Edit
 * (assets/thumbnails/fonts); Helvetica Neue, Arial Black and Impact are the Mac's own.
 */
export const FONTS = [
  { family: WHITE_RED_FONT, note: "the white and red captions" },
  { family: BLACK_BOX_FONT, note: "bold: the black-box captions" },
  { family: "Montserrat", note: "the older black-box face" },
  { family: "Helvetica Neue", note: "the Mac's own" },
  { family: "Arial Black", note: "heavy and wide" },
  { family: "Impact", note: "tall and condensed" },
] as const;

type LayerBase = {
  id: string;
  /** Its name in the layers list ("REC overlay", "caption"). */
  name: string;
  hidden?: boolean;
  /** 0…100. */
  opacity: number;
};

/**
 * A picture on the canvas: one of the thumbnail's images (its id), or an
 * overlay from the library (`asset:<id>`). Its box is in canvas pixels (the
 * canvas is 1280×720); `fit` says how the picture fills it: cover (cropped to
 * fill, at `zoom` around `focusX`/`focusY`), contain, or stretch.
 */
export type ImageLayer = LayerBase & {
  kind: "image";
  source: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fit: "cover" | "contain" | "stretch";
  /** cover only: 1 fills the box; 1.5 is half again closer. */
  zoom?: number;
  /** cover only: the point of the picture kept in the middle, 0…1 each way. */
  focusX?: number;
  focusY?: number;
  flip?: boolean;
  rotation?: number;
  adjust?: Adjust;
  shadow?: Shadow;
};

/** Words on the canvas, centred on (x, y), wrapped at `width`. */
export type TextLayer = LayerBase & {
  kind: "text";
  text: string;
  x: number;
  y: number;
  /** The widest a line may run before it wraps (px). */
  width: number;
  font: string;
  /** 100…900. */
  weight: number;
  size: number;
  color: string;
  align: "left" | "center" | "right";
  /** Lines apart, as a multiple of the size. */
  lineHeight: number;
  /** Shown in lower case unless asked otherwise: "upper" for capitals, "keep" for the words as written. */
  casing?: "lower" | "upper" | "keep";
  /** Older layers: capitals. Prefer `casing`. */
  uppercase?: boolean;
  italic?: boolean;
  rotation?: number;
  box?: Box;
  stroke?: Stroke;
  shadow?: Shadow;
};

export type Layer = ImageLayer | TextLayer;

/** The thumbnail as it's drawn: the layers bottom first. */
export type Design = { layers: Layer[] };

export type ThumbTool = { id?: string; name: string; state: "running" | "done" | "error"; detail?: string };

/** One step of a live turn, in the order it happened. `thinking` with `active` is the block being written. */
export type ThumbTrace =
  | { kind: "thinking"; text: string; active: boolean }
  | { kind: "text"; text: string }
  | { kind: "tools"; calls: ThumbTool[] };

export type ThumbTurn = {
  role: "you" | "claude";
  text: string;
  at: number;
  by?: string;
  workedMs?: number;
  tools?: ThumbTool[];
  failed?: boolean;
  /** The pictures the person gave with the message (image ids). */
  images?: string[];
};

export type ThumbRun = {
  state: "queued" | "running" | "done" | "failed" | "stopped";
  holder: string;
  by: string;
  startedAt: number;
  endedAt?: number;
  step?: string;
  error?: string;
  said?: string;
  tools?: ThumbTool[];
  /** Words, reasoning and tools in order, while the turn is running on this Mac. */
  trace?: ThumbTrace[];
};

/** A layout as it was before a change, and what the change was (Sphe, Nov 2: "we should have undo both for us and for the agent"). */
export type Step = {
  design: Design;
  /** "claude", or the person's name. */
  by: string;
  at: number;
  /** What the change did, in a few words ("changed the caption", "added the REC overlay"). */
  label: string;
};

/** One saved version of a thumbnail's layout (V1, V2…): switching keeps each one's layers as they were. */
export type ThumbVersion = { id: string; name: string; design: Design; at: number; by: string };

export type Thumbnail = {
  id: string;
  title: string;
  /** What it's for, in a line (the video's title, the idea). */
  brief: string;
  images: ThumbImage[];
  design: Design;
  /** The thumbnail as last drawn, under its folder, for lists and the card. */
  render: { key: string; at: number } | null;
  chat: ThumbTurn[];
  run: ThumbRun | null;
  /** Every change to the layout, the person's and Claude's on one timeline: undo steps back through it, newest last. */
  history?: Step[];
  /** What undo stepped back from, for redo (cleared by a new change). */
  future?: Step[];
  /** Its versions, once it has more than one; the one showing is `activeVersion`, its layout also in `design`. */
  versions?: ThumbVersion[];
  activeVersion?: string;
  /** The version taken as final (the one the team ships), picked apart from whichever is showing. */
  finalVersion?: string;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
};

export type ThumbSummary = {
  title: string;
  run: ThumbRun["state"] | null;
  step: string | null;
  render: string | null;
  /** How many layers it has: one with any is drawn for the list even when no drawing was kept. */
  layers?: number;
  images: number;
};

export type ThumbRow = {
  id: string;
  rev: number;
  summary: ThumbSummary;
  updatedAt: number;
  updatedBy: string;
  createdBy: { sub: string; name: string; picture?: string } | null;
};

/** An overlay or picture in the team's library: Edit's own, or one the team uploaded. */
export type Asset = {
  id: string;
  name: string;
  /** What it is and where it goes, for Claude ("REC in the top left, AXON 1 top right…"). */
  note: string;
  kind: "overlay" | "sticker";
  width: number;
  height: number;
  /** Edit's own (shipped with it), or the team's (R2 `key`). */
  builtIn: boolean;
  key?: string;
  by?: string;
  at?: number;
};

/** The thumbnail's pictures by id, the library's as `asset:<id>`. */
export const assetRef = (id: string): string => `asset:${id}`;
export const assetOf = (source: string): string | null => (source.startsWith("asset:") ? source.slice("asset:".length) : null);

export function summarize(thumb: Thumbnail): ThumbSummary {
  return {
    title: thumb.title || "New thumbnail",
    run: thumb.run?.state ?? null,
    step: thumb.run?.state === "running" || thumb.run?.state === "queued" ? (thumb.run.step ?? null) : (thumb.run?.error ?? null),
    render: thumb.render?.key ?? null,
    layers: thumb.design.layers.length,
    images: thumb.images.length,
  };
}
