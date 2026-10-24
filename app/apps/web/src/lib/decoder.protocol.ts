import type { NetworkStats } from "./range-source";

export const AUDIO_CHUNK_SECONDS = 0.5;

export type DecodeRequest =
  /** `rough`: a scrub mid-drag, answered with the keyframe at or before the time (a fraction of the bytes). */
  | { type: "video"; id: number; key: string; url: string; lane: string; times: number[]; playing: boolean; rough?: boolean }
  | { type: "audio"; id: number; key: string; url: string; lane: string; chunks: number[]; speed: number }
  | { type: "retain"; lanes: string[] }
  | { type: "forget"; key: string };

export type DecodeJob = Extract<DecodeRequest, { type: "video" | "audio" }>;

export interface PcmChunk {
  start: number;
  sampleRate: number;
  channels: Float32Array<ArrayBuffer>[];
}

export type DecodeResponse =
  /** `time` is the frame's own source time when `rough` (a keyframe near the one asked for). */
  | { type: "video"; id: number; key: string; time: number; frame: VideoFrame; rough?: boolean }
  | { type: "audio"; id: number; key: string; chunk: number; speed: number; pcm: PcmChunk }
  | { type: "done"; id: number; lane: string; network?: NetworkStats }
  | { type: "error"; id: number; key: string; lane: string; error: string }
  /** Reads are arriving (at most once a second): a slow file isn't a hung decoder. */
  | { type: "alive"; network: NetworkStats };
