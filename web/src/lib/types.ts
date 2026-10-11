// Mirrors crates/edit-core/src/model.rs. Timeline times are integer frames.

export type Rgba = [number, number, number, number];

export interface Settings {
  width: number;
  height: number;
  fps: number;
}

export type MediaKind = "video" | "audio" | "image";

export interface Media {
  id: string;
  name: string;
  path: string;
  kind: MediaKind;
  duration: number;
  width: number;
  height: number;
  fps: number;
  has_audio: boolean;
  /** Points marked in the source, carried by every clip of it (a sound's hit, a beat). */
  markers?: Marker[];
}

export interface Marker {
  /** Seconds into the source. */
  time: number;
  name: string;
}

export type TrackKind = "video" | "audio";

export interface Track {
  id: string;
  kind: TrackKind;
  hidden: boolean;
  muted: boolean;
  locked: boolean;
}

export const CLIP_COLORS = ["blue", "cyan", "green", "yellow", "orange", "red", "purple", "pink"] as const;
export type ClipColor = (typeof CLIP_COLORS)[number];

export type Ease = "linear" | "in_out" | "in" | "out" | "hold";

export interface Keyframe {
  frame: number;
  value: number;
  /** Preset for the segment to the next keyframe; explicit handles override its ends. */
  ease: Ease;
  handle_in?: Handle;
  handle_out?: Handle;
}

/** After Effects-style temporal ease (edit-core `Handle`). */
export interface Handle {
  /** Value units per frame at the keyframe. */
  speed: number;
  /** Share of the segment the handle reaches, 0 < influence <= 1. */
  influence: number;
}

export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  /** Handheld camera shake: how far it wanders, in project pixels (0 or absent = still). */
  shake?: number;
}

/** Repack's house glow: the text's colour, blurred close and wide, under the letters. */
export interface Glow {
  enabled: boolean;
  /** null follows the text colour. */
  color: Rgba | null;
  /** Blur in px (the wide layer's radius). Default 46. */
  radius: number;
  /** Opacity of each layer, 0–1. Default 0.5. */
  strength: number;
}

export const HOUSE_GLOW: Glow = {
  enabled: true,
  color: null,
  radius: 46,
  strength: 0.5,
};

export interface TextStyle {
  font: string;
  weight: number;
  size: number;
  color: Rgba;
  tracking: number;
  line_height: number;
  glow: Glow;
  /** Wrap lines wider than this (project pixels); absent = only at newlines. */
  max_width?: number;
  background?: TextBox;
  shadow?: TextShadow;
}

/** A box behind the lines (project pixels). */
export interface TextBox {
  color: Rgba;
  opacity: number;
  pad_x: number;
  pad_y: number;
}

/** Premiere-style drop shadow: angle in degrees clockwise from up. */
export interface TextShadow {
  color: Rgba;
  opacity: number;
  distance: number;
  angle: number;
  size: number;
  blur: number;
}

export const HOUSE_BOX: TextBox = {
  color: [0, 0, 0, 1],
  opacity: 0.75,
  pad_x: 12,
  pad_y: 8,
};
export const HOUSE_SHADOW: TextShadow = {
  color: [0, 0, 0, 1],
  opacity: 0.65,
  distance: 3,
  angle: 112,
  size: 6,
  blur: 8,
};

export type TextPreset = "none" | "fade" | "rise" | "pop" | "typewriter" | "words";

export interface TextAnimation {
  preset: TextPreset;
  duration: number;
  stagger: number;
}

export interface Grade {
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  vignette: number;
}

export type ShakePreset = "none" | "handheld" | "vertical" | "horizontal" | "impact" | "earthquake";
export type ShakeDirection = "both" | "vertical" | "horizontal";
export type ShakeEnvelope = "steady" | "build" | "hit" | "swell";
export type ShakeEdges = "mirror" | "zoom";
export type ShakeMotion = "wiggle" | "drop";

/** Camera shake on everything below an adjustment layer (after Sapphire S_Shake): a preset, any number overriding it. */
export interface Shake {
  preset?: ShakePreset;
  /** Pixels at its peak, at 1080p (scaled with the frame). */
  amount?: number;
  /** Wiggles per second. */
  frequency?: number;
  /** Degrees of tilt at its peak. */
  rotation?: number;
  direction?: ShakeDirection;
  /** Strength over the clip: steady, build (into the end), hit (dies away), swell. */
  envelope?: ShakeEnvelope;
  /** Motion blur length in frames of movement: 0 = sharp, 1 = a full frame. */
  motion_blur?: number;
  /** Past the frame's edges: mirror the picture, or zoom so they never show. */
  edges?: ShakeEdges;
  /** Random jolts, or one accelerating move (down / right; a negative amount goes up / left). */
  motion?: ShakeMotion;
}

export type ShakeSettings = Required<Omit<Shake, "preset">>;

/** Mirrors edit-core `ShakePreset::settings`. */
export const SHAKE_PRESETS: Record<ShakePreset, ShakeSettings & { label: string }> = {
  none: { label: "None", amount: 0, frequency: 8, rotation: 0, direction: "both", envelope: "steady", motion_blur: 1, edges: "mirror", motion: "wiggle" },
  handheld: { label: "Handheld", amount: 8, frequency: 1.2, rotation: 0.4, direction: "both", envelope: "steady", motion_blur: 0, edges: "zoom", motion: "wiggle" },
  vertical: { label: "Vertical drop", amount: 540, frequency: 0, rotation: 0, direction: "vertical", envelope: "steady", motion_blur: 2, edges: "mirror", motion: "drop" },
  horizontal: { label: "Horizontal whip", amount: 540, frequency: 0, rotation: 0, direction: "horizontal", envelope: "steady", motion_blur: 2, edges: "mirror", motion: "drop" },
  impact: { label: "Impact", amount: 160, frequency: 30, rotation: 3, direction: "both", envelope: "hit", motion_blur: 1.5, edges: "mirror", motion: "wiggle" },
  earthquake: { label: "Earthquake", amount: 60, frequency: 16, rotation: 1.5, direction: "both", envelope: "steady", motion_blur: 1, edges: "mirror", motion: "wiggle" },
};

/** Every number of a shake: the preset's unless given. */
export function resolvedShake(shake: Shake | undefined): ShakeSettings {
  const { label: _label, ...preset } = SHAKE_PRESETS[shake?.preset ?? "none"];
  return {
    amount: shake?.amount ?? preset.amount,
    frequency: shake?.frequency ?? preset.frequency,
    rotation: shake?.rotation ?? preset.rotation,
    direction: shake?.direction ?? preset.direction,
    envelope: shake?.envelope ?? preset.envelope,
    motion_blur: shake?.motion_blur ?? preset.motion_blur,
    edges: shake?.edges ?? preset.edges,
    motion: shake?.motion ?? preset.motion,
  };
}

interface ClipBase {
  id: string;
  track: string;
  start: number;
  duration: number;
  color: ClipColor;
  name?: string;
  link?: string;
  fade_in: number;
  fade_out: number;
  keyframes?: Record<string, Keyframe[]>;
}

export interface VideoClip extends ClipBase {
  type: "video";
  media: string;
  source_in: number;
  speed: number;
  transform: Transform;
  opacity: number;
}

export interface AudioClip extends ClipBase {
  type: "audio";
  media: string;
  source_in: number;
  speed: number;
  volume_db: number;
}

export interface TextClip extends ClipBase {
  type: "text";
  text: string;
  style: TextStyle;
  transform: Transform;
  animation: TextAnimation;
  opacity: number;
  /** Frames from the clip start at which each word appears (the "words" preset). */
  word_times?: number[];
}

export interface AdjustmentClip extends ClipBase {
  type: "adjustment";
  grade: Grade;
  shake?: Shake;
  opacity: number;
}

export interface SolidClip extends ClipBase {
  type: "solid";
  fill: Rgba;
  opacity: number;
}

export type Clip = VideoClip | AudioClip | TextClip | AdjustmentClip | SolidClip;
export type ClipType = Clip["type"];

export interface Project {
  version: number;
  id: string;
  name: string;
  settings: Settings;
  media: Media[];
  tracks: Track[];
  clips: Clip[];
  next_id: number;
  /** The script the edit follows (edit-core `Script`). */
  script?: Script;
}

export interface Script {
  /** Where it came from (a Google Doc link). */
  source?: string;
  blocks: ScriptBlock[];
}

export type ScriptBlock =
  | {
      kind: "footage";
      /** The link as written (a Google Drive file). */
      url: string;
      /** Drive file id: ranges of one file share it. */
      file: string;
      /** Seconds into that file. */
      start: number;
      end: number;
      /** As the script wrote it ("01:31 - 01:37"). */
      label: string;
      notes?: string[];
      media?: string;
      /** Seconds into the file where `media` begins (an excerpt of it). */
      media_start?: number;
      /** First and last spoken words, from the Doc's "word....word" comment. */
      words?: [string, string];
      /** Where it really plays (seconds of the file), found from `words` in the transcript. */
      cut?: [number, number];
      clip?: string;
    }
  | { kind: "narration"; text: string; notes?: string[]; clip?: string };

/** A script import's footage downloads (crates/edit/src/script.rs `Job`). */
export interface ScriptJob {
  state: "downloading" | "transcribing" | "placing" | "done" | "failed";
  error?: string;
  files: { file: string; name?: string; bytes: number; total?: number; state: "queued" | "downloading" | "cutting" | "done" | "failed"; error?: string }[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  modified_ms: number;
  width: number;
  height: number;
  fps: number;
  duration_frames: number;
  clips: number;
}

export type Stage = "pending" | "working" | "ready" | "failed" | "skipped";

export interface MediaStatus {
  proxy: Stage;
  proxy_progress: number;
  thumbs: Stage;
  thumb_count: number;
  peaks: Stage;
  /** "pending" = not requested yet (transcription costs money). */
  transcript: Stage;
  transcript_error?: string;
  error?: string;
}

/** A spoken word; times are seconds into the source. */
export interface Word {
  text: string;
  start: number;
  end: number;
  speaker?: string;
}

export interface Transcript {
  model: string;
  language?: string | null;
  words: Word[];
  /** Who each voice is ("speaker_0" → "Officer"), named from the conversation. */
  speakers?: Record<string, string>;
  /** Each voice's role in Repack's colour code (officer, suspect, witness…). */
  roles?: Record<string, string>;
  /** Each voice's colour ("#00e5c7"), from its role. */
  colors?: Record<string, string>;
}

export const ANIMATABLE: Record<ClipType, string[]> = {
  video: ["opacity", "x", "y", "scale", "rotation", "shake"],
  audio: ["volume_db"],
  text: ["opacity", "x", "y", "scale", "rotation", "shake", "size", "tracking", "glow.radius", "glow.strength"],
  adjustment: ["opacity", "shake", "exposure", "contrast", "saturation", "temperature", "vignette"],
  solid: ["opacity"],
};
