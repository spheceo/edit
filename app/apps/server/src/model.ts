// The project model as the server sees it: edit-core's types, generated from
// the Rust by `just types` into packages/edit-types (as serde writes them:
// fields it may leave out are optional), plus the server's own below.
// Timeline times are integer frames; source_in is seconds.

import type { Clip, Creator, DriveFile, Style } from "@edit/types";

export type {
  Blur,
  Chapter,
  Clip,
  ClipColor,
  Creator,
  Crop,
  DriveFile,
  Ease,
  Encoders,
  ExportOptions,
  Fill,
  Format,
  Glitch,
  Glow,
  Grade,
  Gradient,
  Handle,
  Keyframe,
  Leader,
  Marker,
  Media,
  MediaKind,
  Mute,
  Person,
  Plan,
  Probe,
  Project,
  Quality,
  Rgba,
  Rippled,
  Script,
  ScriptBlock,
  Section,
  Sections,
  Segment,
  Settings,
  Shake,
  ShakeDirection,
  ShakeEdges,
  ShakeEnvelope,
  ShakeMotion,
  ShakePreset,
  Shape,
  Style,
  TextAnimation,
  TextBox,
  TextLabel,
  TextPreset,
  TextShadow,
  TextStyle,
  TimelineMarker,
  Track,
  TrackKind,
  Transform,
  WaveformStyle,
} from "@edit/types";

export const CLIP_COLORS = ["blue", "cyan", "green", "yellow", "orange", "red", "purple", "pink"] as const;

/** Each kind of clip, as its own type. */
export type VideoClip = Extract<Clip, { type: "video" }>;
export type AudioClip = Extract<Clip, { type: "audio" }>;
export type TextClip = Extract<Clip, { type: "text" }>;
export type AdjustmentClip = Extract<Clip, { type: "adjustment" }>;
export type SolidClip = Extract<Clip, { type: "solid" }>;
export type WaveformClip = Extract<Clip, { type: "waveform" }>;
export type ClipType = Clip["type"];

export const STYLES: { value: Style; label: string }[] = [
  { value: "bodycam", label: "Bodycam" },
  { value: "interrogation", label: "Interrogation" },
  { value: "courtroom", label: "Courtroom" },
  { value: "commentary", label: "Commentary" },
  { value: "shorts", label: "Shorts" },
];

/**
 * Who narrates each kind of video. Bodycam (FOIA, and its compilations) has
 * Edit's house voice set up; the rest are narrated by the team's own
 * recording, given with the script (the new project's voice-over box) or
 * added later. Until one is there, the house voice stands in so the edit can
 * be built, and says it's a stand-in. (JJ, Oct 28: "I selected the courtroom
 * edit option, but the voice was the one from bodycam".)
 */
export const NARRATION: Record<Style, "house" | "recording" | "none"> = {
  bodycam: "house",
  interrogation: "recording",
  courtroom: "recording",
  commentary: "recording",
  // A Short is the footage's own sound: no narrator.
  shorts: "none",
};

/** A script import's footage downloads (apps/server/src/script.ts `Job`). */
export interface ScriptJob {
  /** `waiting`: some footage couldn't be downloaded, even tried again; the person gives another link or goes on without it. */
  state: "downloading" | "transcribing" | "placing" | "voicing" | "waiting" | "done" | "failed";
  error?: string;
  /** `retry_at`: when Edit tries a failed file again by itself (ms). */
  files: { file: string; name?: string; bytes: number; total?: number; state: "queued" | "downloading" | "cutting" | "done" | "failed"; error?: string; retry_at?: number; cut?: { done: number; total: number } }[];
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
  /** Nothing but footage (or nothing) yet: a subtitled video starting, so open to subtitlers too (`kinds.ts`). */
  footage_only?: boolean;
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
  /**
   * How each voice's person looks and where they sit, as the watch saw them
   * across the whole video (cast.ts), so the seats find that face rather
   * than guess who is who again.
   */
  looks?: Record<string, string>;
}

export const ANIMATABLE: Record<ClipType, string[]> = {
  video: ["opacity", "x", "y", "scale", "rotation", "shake", "crop.left", "crop.right", "crop.top", "crop.bottom"],
  audio: ["volume_db"],
  text: ["opacity", "x", "y", "scale", "rotation", "shake", "size", "tracking", "glow.radius", "glow.strength", "leader.x", "leader.y"],
  adjustment: ["opacity", "shake", "exposure", "contrast", "saturation", "temperature", "vignette", "vignette_x", "vignette_y", "vignette_size", "glitch", "blur", "blur.x", "blur.y", "blur.width", "blur.height"],
  solid: ["opacity"],
  waveform: ["opacity", "x", "y", "scale", "rotation", "gain", "glow.radius", "glow.strength"],
};

// ---------------------------------------------------------------------------
// Engine types (crates/edit-engine), written down from export.rs, media.rs and
// edit-core's timeline.rs (ts-rs generates them too, into packages/edit-types).

