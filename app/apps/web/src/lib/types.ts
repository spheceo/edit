// The project model: edit-core's types, generated from the Rust by `just
// types` into packages/edit-types (as serde writes them: fields it may leave
// out are optional), plus what the UI adds. Timeline times are integer frames.

import type {
  Clip,
  Creator,
  DriveFile,
  Glitch,
  Glow,
  Settings,
  Shake,
  ShakePreset,
  Style,
  TextBox,
  TextShadow,
} from "@edit/types";

export type {
  Creator,
  Rgba,
  Settings,
  MediaKind,
  Media,
  Marker,
  TimelineMarker,
  TrackKind,
  Track,
  ClipColor,
  Ease,
  Keyframe,
  Handle,
  Transform,
  Glow,
  TextStyle,
  Leader,
  TextLabel,
  TextBox,
  TextShadow,
  TextPreset,
  TextAnimation,
  Grade,
  Glitch,
  Blur,
  ShakePreset,
  ShakeDirection,
  ShakeEnvelope,
  ShakeEdges,
  ShakeMotion,
  Shake,
  Crop,
  Gradient,
  Mute,
  WaveformStyle,
  Clip,
  Style,
  Project,
  Person,
  DriveFile,
  Script,
  ScriptBlock,
  Segment,
  Section,
  Sections,
} from "@edit/types";

/** Frames per second: `fps`, ×1000/1001 when `ntsc` (edit-core `Project::fps`). Timeline frames are at this rate. */
export function rate(settings: Settings): number {
  const whole = Math.max(settings.fps, 1);
  return settings.ntsc === true ? (whole * 1000) / 1001 : whole;
}

/** The rate as people say it: "30", "23.976". */
export function rateText(settings: Settings): string {
  return settings.ntsc === true ? (Math.round((Math.max(settings.fps, 1) * 1000 * 1000) / 1001) / 1000).toString() : String(settings.fps);
}

export const CLIP_COLORS = ["blue", "cyan", "green", "yellow", "orange", "red", "purple", "pink"] as const;

export const HOUSE_GLOW: Glow = {
  enabled: true,
  color: null,
  radius: 46,
  strength: 0.5,
};

export const HOUSE_BOX: TextBox = {
  color: [0, 0, 0, 1],
  opacity: 0.75,
  pad_x: 12,
  pad_y: 8,
  border_color: [1, 1, 1, 1],
};
export const HOUSE_SHADOW: TextShadow = {
  color: [0, 0, 0, 1],
  opacity: 0.65,
  distance: 3,
  angle: 112,
  size: 6,
  blur: 8,
};

export type ShakeSettings = Required<Omit<Shake, "preset">>;

/** `shake` with `change` made (no shake yet: no preset, only the numbers given, as serde reads it). */
export function changedShake(shake: Shake | undefined, change: Partial<Shake>): Shake {
  return { preset: "none", ...shake, ...change };
}

/** `glitch` with `change` made (none yet: edit-core's defaults for the rest). */
export function changedGlitch(glitch: Glitch | undefined, change: Partial<Glitch>): Glitch {
  return { amount: 0, slices: 6, rgb: 0.08, ...glitch, ...change };
}

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

/** Each kind of clip, as its own type. */
export type VideoClip = Extract<Clip, { type: "video" }>;
export type AudioClip = Extract<Clip, { type: "audio" }>;
export type TextClip = Extract<Clip, { type: "text" }>;
export type AdjustmentClip = Extract<Clip, { type: "adjustment" }>;
export type SolidClip = Extract<Clip, { type: "solid" }>;
export type WaveformClip = Extract<Clip, { type: "waveform" }>;
/** How long a mute fades out and back in, outside its stretch (seconds): a cosine ramp, as edit-core's. */
export const MUTE_FADE_SECONDS = 0.012;

export type ClipType = Clip["type"];

export const STYLES: { value: Style; label: string }[] = [
  { value: "bodycam", label: "Bodycam" },
  { value: "interrogation", label: "Interrogation" },
  { value: "courtroom", label: "Courtroom" },
];

/** A script import's footage downloads (apps/server/src/script.ts `Job`). */
export interface ScriptJob {
  state: "downloading" | "transcribing" | "placing" | "voicing" | "done" | "failed";
  error?: string;
  files: { file: string; name?: string; bytes: number; total?: number; state: "queued" | "downloading" | "cutting" | "done" | "failed"; error?: string; cut?: { done: number; total: number } }[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  style: Style;
  modified_ms: number;
  width: number;
  height: number;
  fps: number;
  duration_frames: number;
  clips: number;
  /** A subtitled video: Repack-style subtitles (repack_subtitles) over its footage. */
  subtitles?: boolean;
  /** Its export on the team's Drive. */
  drive?: DriveFile;
  /** Why it can't be opened (its file is left as it is). */
  problem?: string;
  /** Media its timeline uses: how many, and how many aren't on this machine (or in the cloud) any more. */
  media_used?: number;
  missing?: number;
  /** Media in the cloud not fetched to this machine yet (they come when it opens). */
  remote?: number;
  /** The frame its card shows: plain footage running (no cut-in, graphic or transition on screen) whose file is here; null when there's none. */
  cover_frame?: number | null;
  /** Who started it (`Project::created_by`); absent for projects from before. */
  created_by?: Creator;
}

export type Stage = "pending" | "working" | "ready" | "failed" | "skipped";

export interface MediaStatus {
  proxy: Stage;
  proxy_progress: number;
  /** The light (720p) preview, for watching from another machine. */
  light?: Stage;
  thumbs: Stage;
  thumb_count: number;
  peaks: Stage;
  /** "pending" = not requested yet (transcription costs money). */
  transcript: Stage;
  transcript_error?: string;
  error?: string;
  /** Each preview file's version, for URLs the browser can cache for good. */
  stamps?: { preview?: string | null; light?: string | null };
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
  text: ["opacity", "x", "y", "scale", "rotation", "shake", "size", "tracking", "glow.radius", "glow.strength", "leader.x", "leader.y"],
  adjustment: ["opacity", "shake", "exposure", "contrast", "saturation", "temperature", "vignette", "vignette_x", "vignette_y", "vignette_size", "leak", "leak_x", "glitch", "blur", "blur.x", "blur.y", "blur.width", "blur.height"],
  solid: ["opacity"],
  waveform: ["opacity", "x", "y", "scale", "rotation", "gain", "glow.radius", "glow.strength"],
};

