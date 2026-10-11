export const AUDIO_CHUNK_SECONDS = 0.5;

export type DecodeRequest =
  | { type: "video"; id: number; key: string; url: string; lane: string; times: number[]; playing: boolean }
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
  | { type: "video"; id: number; key: string; time: number; frame: VideoFrame }
  | { type: "audio"; id: number; key: string; chunk: number; speed: number; pcm: PcmChunk }
  | { type: "done"; id: number; lane: string }
  | { type: "error"; id: number; key: string; lane: string; error: string };
