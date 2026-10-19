/** Optional export backend. No local native job or background-work pause;
 * preparing small local assets, monitoring and fetching a finished file are
 * all the desktop does. The Relay owns the durable queue and compute cap.
 */
import type { ExportOptions, Plan, Project } from "./model.ts";
import * as cloud from "./cloud.ts";
import * as seams from "./seams.ts";
import * as diag from "./diag.ts";
import { jsonForSerde } from "./rust.ts";
import { WORKER_STARTUP_SECONDS, WORKER_SECONDS, type WorkerManifest } from "@edit/types/worker";

export const enabled = () => process.env.EDIT_CLOUD_EXPORTS === "1";
export const timing = { poll: 3000, sleep: (ms: number) => Bun.sleep(ms) };

export async function run(project: Project, options: ExportOptions, plan: Plan, output: string,
  cancelled: () => boolean, onProgress: (progress: number) => void, request: string = crypto.randomUUID(),
  receipt: { id?: string; accepted?: (id: string) => void } = {},
): Promise<void> {
  if (!["h264", "hevc"].includes(options.format)) throw new Error("Cloud exports currently support H.264 and HEVC; use a local export for this format");
  let started: Record<string, unknown>;
  if (receipt.id !== undefined) {
    if (!/^export-[a-f0-9]{64}$/.test(receipt.id)) throw new Error("Invalid saved cloud export id");
    started = await cloud.relayJson("exports/status", { id: receipt.id });
  } else {
    const config = await cloud.relayJson("exports/config", {});
    if (config.enabled !== true) throw new Error("Cloud exports are disabled on the Relay; configure its worker and daily compute budget first");
    const staged = await seams.cloudMedia.forWorker(project, plan.start, plan.end);
    if (cancelled()) throw new Error("cancelled");
    const manifest: WorkerManifest = { version: 1, ...staged, options };
    const text = jsonForSerde(manifest);
    const digest = new Bun.CryptoHasher("sha256").update(text).digest("hex");
    const key = `edit/exports/manifests/${digest}.json`;
    if (await cloud.head(key) === null) await cloud.uploadStream(cloud.bytesSource(new TextEncoder().encode(text)), key, new TextEncoder().encode(text).byteLength);
    if (cancelled()) throw new Error("cancelled");
    started = await cloud.relayJson("exports/start", { manifest: key, digest, request });
  }
  if (typeof started.id !== "string" || !/^export-[a-f0-9]{64}$/.test(started.id)) throw new Error("Relay returned no cloud export id");
  if (receipt.id !== undefined && started.id !== receipt.id) throw new Error("Relay returned a different cloud export id");
  const id = started.id;
  receipt.accepted?.(id);
  diag.info("export", `${project.id}: cloud job ${id}; reserved up to $${started.reservedUsd} compute`);
  let status = started;
  let requestedCancel = false;
  // Queueing is free; a generous deadline lets several batches run. The
  // worker itself has a separate, enforced 30-minute execution timeout.
  const deadline = Date.now() + 12 * (WORKER_SECONDS + WORKER_STARTUP_SECONDS) * 1000;
  while (Date.now() < deadline) {
    if (cancelled() && !requestedCancel) {
      await cloud.relayJson("exports/cancel", { id });
      requestedCancel = true;
    }
    if (status.status === "done") {
      if (cancelled()) throw new Error("cancelled");
      const result = status.output as { key?: unknown } | undefined;
      if (typeof result?.key !== "string" || result.key !== `edit/exports/results/${id}.mp4`) throw new Error("Invalid cloud export result");
      await cloud.download(result.key, output, (sent, total) => onProgress(0.95 + 0.05 * sent / Math.max(1, total)));
      return;
    }
    if (status.status === "failed" || status.status === "cancelled") throw new Error(String(status.error ?? status.status));
    onProgress(typeof status.progress === "number" ? Math.min(0.94, status.progress * 0.94) : 0);
    await timing.sleep(timing.poll);
    try {
      status = await cloud.relayJson("exports/status", { id });
    } catch (error) {
      // Losing the Mac's connection never starts a replacement render.
      diag.warn("export", `cloud export status temporarily unavailable: ${diag.messageOf(error)}`);
    }
  }
  throw new Error(`Cloud export ${id} is still queued or unreachable; its result stays on the Relay`);
}
