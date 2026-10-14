// Voice-over projects (crates/edit/src/voice.rs): lines spoken by an
// ElevenLabs voice, each kept as takes to choose between.

import { ApiError, fetchRetrying } from "./api";

export interface VoiceSettings {
  voice_id: string | null;
  voice_name: string | null;
  model_id: string;
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  speed: number;
}

export interface Take {
  id: string;
  created_ms: number;
  text: string;
  settings: VoiceSettings;
  duration: number | null;
  characters: number;
}

export interface VoiceLine {
  id: string;
  text: string;
  label?: string;
  takes: Take[];
  chosen: string | null;
}

export interface VoiceProject {
  id: string;
  name: string;
  created_ms: number;
  modified_ms: number;
  voice: VoiceSettings;
  source?: string;
  lines: VoiceLine[];
}

export interface VoiceSummary {
  id: string;
  name: string;
  modified_ms: number;
  lines: number;
  done: number;
  voice_name: string | null;
}

export interface Voice {
  voice_id: string;
  name: string;
  category?: string;
  labels: Record<string, string>;
  description: string;
  preview_url: string | null;
}

/** ElevenLabs' text-to-speech models worth offering. */
export const MODELS: { value: string; label: string }[] = [
  { value: "eleven_multilingual_v2", label: "Multilingual v2" },
  { value: "eleven_v3", label: "Eleven v3" },
  { value: "eleven_turbo_v2_5", label: "Turbo v2.5" },
  { value: "eleven_flash_v2_5", label: "Flash v2.5" },
];

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetchRetrying(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(data.error ?? `HTTP ${response.status}`, response.status, data);
  return data as T;
}

export const voiceApi = {
  list: () => call<{ projects: VoiceSummary[] }>("GET", "/api/voice"),
  create: (body: { name?: string; from_project?: string }) => call<{ project: VoiceProject }>("POST", "/api/voice", body),
  get: (id: string) => call<{ project: VoiceProject }>("GET", `/api/voice/${id}`),
  save: (project: VoiceProject) =>
    call<{ project: VoiceProject }>("PUT", `/api/voice/${project.id}`, {
      name: project.name,
      voice: project.voice,
      lines: project.lines.map((line) => ({ id: line.id.startsWith("new-") ? null : line.id, text: line.text, label: line.label ?? null, chosen: line.chosen })),
    }),
  remove: (id: string) => call<{ ok: boolean }>("DELETE", `/api/voice/${id}`),
  generate: (id: string, line: string) => call<{ project: VoiceProject }>("POST", `/api/voice/${id}/lines/${line}/generate`),
  deleteTake: (id: string, line: string, take: string) => call<{ project: VoiceProject }>("DELETE", `/api/voice/${id}/lines/${line}/takes/${take}`),
  voices: (refresh = false) => call<{ voices: Voice[] }>("GET", `/api/voice/voices${refresh ? "?refresh=true" : ""}`),
};

export const takeUrl = (project: string, line: string, take: string) => `/api/voice/${project}/lines/${line}/takes/${take}`;

/** "0:04.2" */
export function seconds(value: number | null | undefined) {
  if (value == null) return "";
  const minutes = Math.floor(value / 60);
  return `${minutes}:${(value - minutes * 60).toFixed(1).padStart(4, "0")}`;
}
