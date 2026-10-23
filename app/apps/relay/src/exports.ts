/** Durable, bounded cloud exports. The DO owns admission and fencing; Modal
 * owns computation. Desktop disconnects and repeated submissions do not
 * repeat renders. Each worker sees signed URLs for its own immutable inputs.
 */
import { allow, type AuthEnv } from "./auth";
import { WORKER_OUTPUT_LIMIT, WORKER_INPUT_LIMIT, WORKER_RATES, WORKER_SECONDS, WORKER_STARTUP_SECONDS, type WorkerManifest, type WorkerGpu } from "@edit/types/worker";
import { BadRequest, Upstream, cloudAuthorized, escapeXml, isObject, needKey, objectUrl, r2Config, r2Fetch, xmlValue, type R2 } from "./cloud";

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  delete(key: string): Promise<boolean>;
  setAlarm(time: number): Promise<void>;
}
interface Context { storage: Storage; blockConcurrencyWhile<T>(work: () => Promise<T>): Promise<T> }
export interface ModalEnv {
  EXPORT_JOBS?: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  MODAL_EXPORT_URL?: string;
  MODAL_WORKER_TOKEN?: string;
  MODAL_RENDER_VERSION?: string;
  MODAL_GPU?: WorkerGpu;
  /** Conservative daily compute reservations, not storage/network billing. Unset = disabled. */
  MODAL_DAILY_BUDGET_USD?: string;
  MODAL_JOB_SECONDS?: string;
  MODAL_STARTUP_SECONDS?: string;
  MODAL_SHUTDOWN_SECONDS?: string;
}
type Env = import("./cloud").CloudEnv;
type State = "queued" | "dispatching" | "running" | "cancelling" | "done" | "failed" | "cancelled";
interface Job {
  id: string; manifest: string; digest: string; build: string; gpu: WorkerGpu;
  state: State; created: number; deadline: number; permit: string;
  progress: number; reservedUsd: number; output: string; bytes?: number;
  started?: number; finished?: number; workerSeconds?: number; estimatedComputeUsd?: number;
  error?: string; uploadId?: string;
  request?: string; retry?: string;
  seconds?: number; startup?: number;
}
const ACTIVE = new Set<State>(["dispatching", "running", "cancelling"]);
const terminal = (state: State) => state === "done" || state === "failed" || state === "cancelled";
const json = (status: number, body: unknown) => Response.json(body, { status });
const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), b => b.toString(16).padStart(2, "0")).join("");

function limits(env: ModalEnv) {
  const seconds = Number(env.MODAL_JOB_SECONDS ?? WORKER_SECONDS);
  const startup = Number(env.MODAL_STARTUP_SECONDS ?? WORKER_STARTUP_SECONDS);
  const shutdown = Number(env.MODAL_SHUTDOWN_SECONDS ?? 60);
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > WORKER_SECONDS || !Number.isInteger(startup) || startup < 30 || startup > WORKER_STARTUP_SECONDS || !Number.isInteger(shutdown) || shutdown < 2 || shutdown > 60) throw new BadRequest("Invalid worker execution limits.");
  return { seconds, startup, shutdown };
}

export function configured(env: ModalEnv): boolean {
  const budget = Number(env.MODAL_DAILY_BUDGET_USD);
  return !!(env.MODAL_EXPORT_URL && env.MODAL_WORKER_TOKEN && env.MODAL_RENDER_VERSION && Number.isFinite(budget) && budget > 0);
}

/** Called only by cloud.ts; worker routes use a different, restricted token. */
export async function exportRoute(request: Request, url: URL, env: Env & AuthEnv): Promise<Response> {
  const worker = url.pathname.startsWith("/v1/cloud/exports/worker/");
  if (worker) {
    // Modal's own workers: their machine token only.
    if (!(await cloudAuthorized(request, { CLOUD_TOKEN: env.MODAL_WORKER_TOKEN }))) return json(401, { error: "Cloud export authorization required." });
  } else {
    const found = await allow(request, env, "use", url.pathname.slice("/v1/".length));
    if (found instanceof Response) return found;
  }
  if (request.method !== "POST") return json(405, { error: "POST JSON required." });
  if (!env.EXPORT_JOBS) return json(503, { error: "Cloud exports are not configured." });
  // Bound even chunked requests before passing them to the coordinator.
  const body = await request.text();
  if (body.length > 64 * 1024) return json(413, { error: "Control request too large." });
  const stub = env.EXPORT_JOBS.get(env.EXPORT_JOBS.idFromName("exports-v1"));
  return stub.fetch(new Request(`https://jobs/${url.pathname.slice("/v1/cloud/exports/".length)}`, { method: "POST", body }));
}

export class ExportJobs {
  constructor(private readonly ctx: Context, private readonly env: Env) {}

  fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const body: unknown = await request.json();
        if (!isObject(body)) throw new BadRequest("Send an object.");
        return await this.handle(new URL(request.url).pathname.slice(1), body);
      } catch (error) {
        if (error instanceof BadRequest) return json(400, { error: error.message });
        if (error instanceof Upstream) return json(502, { error: error.message });
        throw error;
      }
    });
  }

  private storage() { return this.ctx.storage; }
  private r2(): R2 {
    const found = r2Config(this.env);
    if (!found) throw new Upstream("Cloud storage is not configured.");
    return found;
  }
  private save(job: Job) { return this.storage().put(`job:${job.id}`, job); }
  private public(job: Job) {
    return { id: job.id, status: job.state, progress: job.progress, reservedUsd: job.reservedUsd,
      gpu: job.gpu, build: job.build, deadline: job.deadline, error: job.error,
      started: job.started, finished: job.finished, workerSeconds: job.workerSeconds, estimatedComputeUsd: job.estimatedComputeUsd,
      ...(job.state === "done" ? { output: { key: job.output, size: job.bytes } } : {}) };
  }
  private async job(body: Record<string, unknown>): Promise<Job> {
    if (typeof body.id !== "string" || !/^export-[a-f0-9]{64}$/.test(body.id)) throw new BadRequest("Invalid export id.");
    const job = await this.storage().get<Job>(`job:${body.id}`);
    if (!job) throw new BadRequest("Unknown export.");
    return job;
  }
  private async handle(route: string, body: Record<string, unknown>): Promise<Response> {
    if (route === "config") return json(200, { enabled: configured(this.env), concurrency: 3, build: this.env.MODAL_RENDER_VERSION, gpu: this.env.MODAL_GPU ?? "L4" });
    if (route === "start") {
      if (!configured(this.env)) return json(503, { error: "Cloud exports are disabled; configure the worker and its daily compute budget." });
      const manifest = needKey(body.manifest);
      if (typeof body.digest !== "string" || !/^[a-f0-9]{64}$/.test(body.digest) || manifest !== `edit/exports/manifests/${body.digest}.json`) throw new BadRequest("Invalid manifest digest/key.");
      const build = this.env.MODAL_RENDER_VERSION!;
      const gpu = this.env.MODAL_GPU ?? "L4";
      if (!Object.hasOwn(WORKER_RATES, gpu)) throw new BadRequest("Unsupported worker GPU.");
      if (body.request !== undefined && (typeof body.request !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(body.request))) throw new BadRequest("Invalid export request id.");
      let id = `export-${await hash(`${body.digest}\n${build}\n${gpu}`)}`;
      const previous = await this.storage().get<Job>(`job:${id}`);
      if (previous) {
        // Completed work is reusable. A failure can be retried only by a
        // new explicit desktop request; its UUID survives desktop restarts.
        if (!body.request || previous.request === body.request || (previous.state !== "failed" && previous.state !== "cancelled")) return json(200, this.public(previous));
        if (previous.retry) {
          const latest = await this.storage().get<Job>(`job:${previous.retry}`);
          if (latest && (latest.request === body.request || (latest.state !== "failed" && latest.state !== "cancelled"))) return json(200, this.public(latest));
        }
        id = `export-${await hash(`${id}\n${body.request}`)}`;
        const retry = await this.storage().get<Job>(`job:${id}`);
        if (retry) return json(200, this.public(retry));
      }
      const jobs = await this.storage().list<Job>({ prefix: "job:" });
      for (const [key, job] of jobs) {
        if (terminal(job.state) && Date.now() - job.created > 30 * 86400_000) {
          await this.storage().delete(key); jobs.delete(key);
        }
      }
      if (jobs.size >= 1000 || [...jobs.values()].filter(j => !terminal(j.state)).length >= 100) return json(429, { error: "The cloud export queue is full." });
      const day = `budget:${new Date().toISOString().slice(0, 10)}`;
      const used = await this.storage().get<number>(day) ?? 0;
      // Reserve the full timeout + startup + 60s shutdown allowance. Failed
      // jobs keep the reservation. No paid automatic retry or budget refund.
      const { seconds, startup, shutdown } = limits(this.env);
      const reservedUsd = Math.ceil(WORKER_RATES[gpu] * (seconds + startup + shutdown) * 100) / 100;
      if (used + reservedUsd > Number(this.env.MODAL_DAILY_BUDGET_USD)) return json(429, { error: "Cloud export daily compute reservation limit reached." });
      await this.storage().put(day, used + reservedUsd);
      const job: Job = { id, manifest, digest: body.digest, build, gpu, created: Date.now(), deadline: 0,
        state: "queued", permit: crypto.randomUUID(), progress: 0, reservedUsd, seconds, startup,
        output: `edit/exports/results/${id}.mp4`, ...(typeof body.request === "string" ? { request: body.request } : {}) };
      await this.save(job);
      if (previous && previous.id !== job.id) {
        previous.retry = job.id;
        await this.save(previous);
      }
      await this.storage().setAlarm(Date.now() + 1);
      return json(200, this.public(job));
    }
    const job = await this.job(body);
    if (route === "status") return json(200, this.public(job));
    if (route === "cancel") {
      if (!terminal(job.state)) {
        job.state = job.state === "queued" ? "cancelled" : "cancelling";
        await this.save(job);
        await this.storage().setAlarm(Date.now() + 1);
      }
      return json(200, this.public(job));
    }
    if (!route.startsWith("worker/")) return json(404, { error: "Unknown cloud export operation." });
    if (body.permit !== job.permit || body.build !== job.build || body.gpu !== job.gpu) return json(409, { error: "Worker does not match this export attempt." });
    if (route === "worker/claim") {
      if (job.state !== "dispatching" || Date.now() >= job.deadline) return json(409, { error: "This export is already claimed or expired." });
      const r2 = this.r2();
      const response = await r2Fetch(r2, "GET", job.manifest, {});
      const text = await response.text();
      if (text.length > 8 * 1024 * 1024 || await hash(text) !== job.digest) throw new BadRequest("Manifest checksum mismatch.");
      const manifest = validateManifest(JSON.parse(text));
      const assets = await Promise.all(manifest.assets.map(async asset => ({ ...asset, url: await objectUrl(r2, "GET", asset.key, {}, (job.seconds ?? WORKER_SECONDS) + 300) })));
      job.state = "running";
      job.started = Date.now();
      await this.save(job);
      return json(200, { ...this.public(job), manifest, assets, seconds: job.seconds ?? WORKER_SECONDS, maxOutputBytes: WORKER_OUTPUT_LIMIT });
    }
    if (route === "worker/complete" && job.state === "done") return json(200, this.public(job));
    if (route === "worker/fail" && job.state === "cancelling") {
      await this.abort(job);
      job.state = "cancelled";
      await this.save(job);
      await this.storage().setAlarm(Date.now() + 1);
      return json(200, this.public(job));
    }
    if (job.state !== "running" || Date.now() >= job.deadline) return json(409, { error: "Export cancelled, expired or already finished." });
    if (route === "worker/heartbeat") {
      if (typeof body.progress === "number" && Number.isFinite(body.progress)) job.progress = Math.max(job.progress, Math.min(0.99, Math.max(0, body.progress)));
      await this.save(job);
      return json(200, { ok: true, deadline: job.deadline });
    }
    if (route === "worker/fail") {
      job.state = "failed";
      // Worker errors may contain signed links. Never persist their query strings.
      job.error = String(body.error ?? "Cloud export failed").replace(/https?:\/\/\S+/g, "[link]").slice(0, 1000);
      await this.abort(job);
      await this.save(job);
      await this.storage().setAlarm(Date.now() + 1);
      return json(200, this.public(job));
    }
    const r2 = this.r2();
    if (route === "worker/upload") {
      if (typeof body.bytes !== "number" || !Number.isSafeInteger(body.bytes) || body.bytes <= 0 || body.bytes > WORKER_OUTPUT_LIMIT) throw new BadRequest("Export file exceeds the worker output limit.");
      if (!job.uploadId) {
        const response = await r2Fetch(r2, "POST", job.output, { uploads: "" }, { headers: { "content-type": "video/mp4" } });
        job.uploadId = xmlValue(await response.text(), "UploadId");
        if (!job.uploadId) throw new Upstream("R2 gave no upload id.");
        job.bytes = body.bytes;
        await this.save(job);
      }
      if (body.bytes !== job.bytes) throw new BadRequest("Output size changed during upload.");
      const partSize = 32 * 1024 ** 2;
      const first = typeof body.first === "number" ? body.first : 1;
      const count = Math.ceil(body.bytes / partSize);
      if (!Number.isInteger(first) || first < 1 || first > count) throw new BadRequest("Invalid upload part.");
      const urls = await Promise.all(Array.from({ length: Math.min(16, count - first + 1) }, async (_, i) => ({ number: first + i, url: await objectUrl(r2, "PUT", job.output, { uploadId: job.uploadId!, partNumber: String(first + i) }, 600) })));
      return json(200, { partSize, urls });
    }
    if (route === "worker/complete") {
      if (!job.uploadId || !job.bytes || !Array.isArray(body.parts) || body.parts.length !== Math.ceil(job.bytes / (32 * 1024 ** 2))) throw new BadRequest("Incomplete output upload.");
      const parts = body.parts.map((part, index) => {
        if (!isObject(part) || part.number !== index + 1 || typeof part.etag !== "string" || part.etag.length > 200) throw new BadRequest("Invalid output parts.");
        return `<Part><PartNumber>${index + 1}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`;
      });
      // CompleteMultipartUpload may have succeeded before its response was
      // lost. An exact-size object at this attempt's unique key recovers it.
      const existing = await r2Fetch(r2, "HEAD", job.output, {}, { allow404: true });
      if (existing.status !== 200) {
        const done = await r2Fetch(r2, "POST", job.output, { uploadId: job.uploadId }, { body: `<CompleteMultipartUpload>${parts.join("")}</CompleteMultipartUpload>`, headers: { "content-type": "application/xml" } });
        if ((await done.text()).includes("<Error>")) throw new Upstream("R2 could not complete the export upload.");
      }
      const head = await r2Fetch(r2, "HEAD", job.output, {});
      if (Number(head.headers.get("content-length")) !== job.bytes) throw new Upstream("Export output size mismatch.");
      job.state = "done";
      job.progress = 1;
      job.finished = Date.now();
      if (typeof body.seconds === "number" && Number.isFinite(body.seconds) && body.seconds >= 0) {
        job.workerSeconds = body.seconds;
        job.estimatedComputeUsd = body.seconds * WORKER_RATES[job.gpu];
      }
      delete job.uploadId;
      await this.save(job);
      await this.storage().setAlarm(Date.now() + 1);
      return json(200, this.public(job));
    }
    return json(404, { error: "Unknown worker operation." });
  }

  private async abort(job: Job) {
    if (job.uploadId) {
      await r2Fetch(this.r2(), "DELETE", job.output, { uploadId: job.uploadId }, { allow404: true });
      delete job.uploadId;
    }
  }

  async alarm(): Promise<void> {
    const dispatch = await this.ctx.blockConcurrencyWhile(async () => {
      const jobs = await this.storage().list<Job>({ prefix: "job:" });
      const now = Date.now();
      for (const job of jobs.values()) {
        if (ACTIVE.has(job.state) && now >= job.deadline) {
          await this.abort(job);
          job.state = job.state === "cancelling" ? "cancelled" : "failed";
          job.error = "The cloud export reached its deadline; no paid retry was started.";
          await this.save(job);
        }
        if (terminal(job.state) && now - job.created > 30 * 86400_000) await this.storage().delete(`job:${job.id}`);
      }
      const available = 3 - [...jobs.values()].filter(j => ACTIVE.has(j.state)).length;
      const next = [...jobs.values()].filter(j => j.state === "queued").sort((a, b) => a.created - b.created).slice(0, Math.max(0, available));
      for (const job of next) {
        job.state = "dispatching";
        job.deadline = now + ((job.seconds ?? WORKER_SECONDS) + (job.startup ?? WORKER_STARTUP_SECONDS)) * 1000;
        await this.save(job);
      }
      if ([...jobs.values()].some(j => !terminal(j.state))) await this.storage().setAlarm(now + 15_000);
      return next;
    });
    // Never replay a paid dispatch after an ambiguous response. The worker's
    // claim fences duplicate deliveries; a lost dispatch expires visibly.
    await Promise.allSettled(dispatch.map(async job => {
      const url = new URL(this.env.MODAL_EXPORT_URL!);
      if (url.protocol !== "https:" || !url.hostname.endsWith(".modal.run")) throw new Error("Configure a Modal HTTPS endpoint.");
      const response = await fetch(new URL("start", `${url.href.replace(/\/+$/, "")}/`), {
        method: "POST", headers: { authorization: `Bearer ${this.env.MODAL_WORKER_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ id: job.id, permit: job.permit, build: job.build, gpu: job.gpu, seconds: job.seconds ?? WORKER_SECONDS, startup: job.startup ?? WORKER_STARTUP_SECONDS }), signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if ([400, 401, 403, 404, 409, 413, 422, 429].includes(response.status)) {
        await this.ctx.blockConcurrencyWhile(async () => {
          const current = await this.storage().get<Job>(`job:${job.id}`);
          if (current?.state === "dispatching") {
            current.state = "failed";
            current.error = `Modal rejected this export (${response.status}); no paid retry was started.`;
            await this.save(current);
            await this.storage().setAlarm(Date.now() + 1);
          }
        });
      }
    }));
  }
}

export function validateManifest(value: unknown): WorkerManifest {
  if (!isObject(value) || value.version !== 1 || !isObject(value.project) || !isObject(value.options) || !Array.isArray(value.assets) || value.assets.length > 500) throw new BadRequest("Invalid worker manifest.");
  if (!["h264", "hevc"].includes(String(value.options.format))) throw new BadRequest("Cloud exports support H.264 and HEVC.");
  let bytes = 0;
  const ids = new Set<string>();
  for (const asset of value.assets) {
    if (!isObject(asset) || typeof asset.media !== "string" || ids.has(asset.media) || typeof asset.etag !== "string" || !asset.etag || typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0) throw new BadRequest("Invalid worker asset.");
    needKey(asset.key);
    bytes += asset.size;
    ids.add(asset.media);
  }
  if (bytes > WORKER_INPUT_LIMIT) throw new BadRequest("Cloud export input limit exceeded.");
  return value as unknown as WorkerManifest;
}
