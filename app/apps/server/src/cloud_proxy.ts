// Cloud proxy generation (cloud-first plan, Phase 4): the proxy is made in
// the cloud from the uploaded original, never by heavy transcode on the
// user's machine. This module owns the spec (mirroring the engine's
// `make_cloud_proxy`), the job manifest on R2, and the request to the relay.
// The worker (`apps/worker/proxy.py`) does the encode with presigned URLs,
// so it never holds R2 keys.

import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { jsonForSerde } from "./rust.ts";

/** The proxy spec, mirroring `edit-engine` media.rs (`make_cloud_proxy`). */
export const PROXY_SPEC = {
  maxWidth: 1920,
  maxHeight: 1080,
  /** Top video bitrate; smaller pictures scale down (800 kbit/s floor). */
  bitrate: 4_000_000,
  minBitrate: 800_000,
  audioBitrate: 160_000,
  /** Keyframe every half second; seeking decodes only a few frames. */
  gopSeconds: 0.5,
  codec: "h264",
} as const;

/** The video bitrate for a picture of `width`×`height`, as the engine clamps it. */
export function proxyBitrate(width: number, height: number): number {
  const full = PROXY_SPEC.maxWidth * PROXY_SPEC.maxHeight;
  const scaled = Math.floor((PROXY_SPEC.bitrate * Math.max(width, 0) * Math.max(height, 0)) / full);
  return Math.min(Math.max(scaled, PROXY_SPEC.minBitrate), PROXY_SPEC.bitrate);
}

export interface ProxyJob {
  version: 1;
  source: string;
  originalKey: string;
  proxyKey: string;
  width: number;
  height: number;
  spec: { maxWidth: number; maxHeight: number; bitrate: number; minBitrate: number; audioBitrate: number; gopSeconds: number; codec: string };
}

/** The deterministic job manifest for one original (same input, same job). */
export function proxyJob(source: string, originalKey: string, proxyKey: string, width: number, height: number): ProxyJob {
  return { version: 1, source, originalKey, proxyKey, width, height, spec: { ...PROXY_SPEC, bitrate: proxyBitrate(width, height) } };
}

export type ProxyState =
  | { state: "ready"; proxyKey: string }
  | { state: "preparing"; proxyKey: string }
  | { state: "unavailable"; proxyKey: string; error: string };

/** Injectable cloud IO (tests stand in for R2 and the relay). */
export const proxyCloud = {
  head: (key: string): Promise<{ size: number } | null> => cloud.head(key),
  uploadManifest: async (key: string, text: string): Promise<void> => {
    const bytes = new TextEncoder().encode(text);
    await cloud.uploadStream(cloud.bytesSource(bytes), key, bytes.byteLength);
  },
  request: (body: Record<string, unknown>): Promise<Record<string, unknown>> => cloud.relayJson("jobs/proxy", body),
};

/**
 * Asks the cloud to make `job`'s proxy. Ready when R2 already holds it;
 * preparing when the worker accepted (or is already running) the job;
 * unavailable when no worker answers — the caller then keeps the local
 * file and retries later, never transcoding heavily by default.
 */
export async function requestProxy(job: ProxyJob, io: typeof proxyCloud = proxyCloud): Promise<ProxyState> {
  try {
    if ((await io.head(job.proxyKey)) !== null) return { state: "ready", proxyKey: job.proxyKey };
    const text = jsonForSerde(job);
    const digest = new Bun.CryptoHasher("sha256").update(text).digest("hex");
    const manifest = `edit/proxies/jobs/${digest}.json`;
    if ((await io.head(manifest)) === null) await io.uploadManifest(manifest, text);
    const answer = await io.request({ manifest, digest });
    if (answer.accepted === true || answer.state === "preparing" || answer.state === "ready") {
      return { state: answer.state === "ready" ? "ready" : "preparing", proxyKey: job.proxyKey };
    }
    return { state: "unavailable", proxyKey: job.proxyKey, error: "the cloud proxy worker did not accept the job" };
  } catch (error) {
    const message = diag.messageOf(error);
    diag.warn("cloud", `cloud proxy for ${job.source}: ${message}`);
    return { state: "unavailable", proxyKey: job.proxyKey, error: message };
  }
}
