/**
 * Exports on Modal's v3 sections pool: eight L40S GPUs render a whole edit
 * in eight pieces, every frame of the joined file is decoded in the cloud,
 * and the checked file is copied here (`apps/worker/export_v3.py`, one
 * process per export, so several run at once). Unchanged pieces, the sound
 * and the footage stay in Modal's cache: exporting again after a small
 * change renders only what it touched.
 *
 * On when the server starts with `EDIT_MODAL_EXPORTS=1` and `EDIT_WORKER_ROOT`
 * (the checkout's `app/`, whose worker it runs); Infisical's CLI gives the
 * driver R2's keys for that process only (`infisical run`, Platform's
 * `/edit-relay` folder), so nothing needs Repack's checkout or project; Modal is signed in on the Mac. The house export of a whole edit whose footage is all in the
 * cloud goes there when this Mac is busy or it's long (`cloudBetter`); anything else (another format, size or shape, a span,
 * chapters, footage only on this Mac) is exported here as before.
 */
import * as fs from "node:fs";
import * as os from "node:os";

import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { subtitleVideo } from "./drive.ts";
import { writeAtomic } from "./files.ts";
import type { ExportOptions, Plan, Project } from "./model.ts";
import { join } from "./paths.ts";
import { duration } from "./project.ts";
import { jsonForSerde } from "./rust.ts";

/** The checkout's app/ folder, whose worker runs the cloud exports: EDIT_WORKER_ROOT, else this server's own checkout (none in a release build). */
function workerRoot(): string {
  return process.env.EDIT_WORKER_ROOT ?? join(import.meta.dir, "..", "..", "..");
}

/**
 * Whether exports go to Modal: by default whenever its worker is here (the
 * team, Oct 29: "we use Modal as the default … we should only revert to the
 * local Mac if there's something wrong with Modal"); EDIT_MODAL_EXPORTS=0
 * keeps them on this Mac.
 */
export const enabled = () => process.env.EDIT_MODAL_EXPORTS !== "0" && (here() || relayOn);

/** Whether this Mac drives Modal itself (a developer's checkout with the worker, Repack, Bun and uv); EDIT_MODAL_VIA_RELAY=1 goes through the relay as an installed Edit does. */
function here(): boolean {
  if (process.env.EDIT_MODAL_VIA_RELAY === "1") return false;
  try {
    command();
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the relay starts cloud exports for this Edit (an installed one,
 * with no worker of its own): asked when an export starts (`ready`), again
 * after ten minutes, so `enabled` stays a plain answer.
 */
let relayOn = false;
let askedAt = 0;
export async function ready(): Promise<void> {
  if (process.env.EDIT_MODAL_EXPORTS === "0" || here() || Date.now() - askedAt < 10 * 60_000 || !cloud.enabled()) return;
  askedAt = Date.now();
  try {
    relayOn = (await cloud.relayJson("v3/config", {})).enabled === true;
  } catch (error) {
    relayOn = false;
    diag.warn("export", `asking the relay about cloud exports: ${diag.messageOf(error)}`);
  }
}

/**
 * A job run on the v3 pool through the relay (`start_export` / `start_review`),
 * polled until it's done, reporting progress; cancelled when `cancelled()`.
 */
async function throughRelay(kind: "export" | "review", job: Record<string, unknown>, cancelled: () => boolean, onProgress: (progress: number) => void): Promise<Record<string, unknown>> {
  const started = await cloud.relayJson(`v3/start_${kind}`, { job });
  const call = started.call;
  if (typeof call !== "string") throw new Error(typeof started.error === "string" ? started.error : "the cloud didn't start it");
  for (;;) {
    await Bun.sleep(3000);
    if (cancelled()) {
      await cloud.relayJson("v3/cancel", { call }).catch(() => ({}));
      throw new Error("cancelled");
    }
    let said: Record<string, unknown>;
    try {
      said = await cloud.relayJson("v3/status", { call, id: job.id });
    } catch (error) {
      diag.warn("export", `${job.id}: asking the cloud how it's going: ${diag.messageOf(error)}`);
      continue;
    }
    if (said.state === "done" && typeof said.result === "object" && said.result !== null) return said.result as Record<string, unknown>;
    if (said.state === "failed" || typeof said.error === "string") throw new Error(String(said.error ?? "the cloud job failed"));
    if (typeof said.progress === "number") onProgress(Math.min(0.99, said.progress));
  }
}

/** Why `project` can't export on Modal as `options` ask (it exports here), or null when it can. */
export function unsuitable(project: Project, options: ExportOptions, plan: Plan): string | null {
  const { width, height } = project.settings;
  if (options.format !== "h264" || !options.audio || !options.hardware) return "only H.264 with sound renders in the cloud";
  if (options.shape !== "original" || options.fps != null || options.target_mb != null) return "only the project's own shape and rate render in the cloud";
  if (options.size != null && options.size !== Math.min(width, height)) return "only the project's own size renders in the cloud";
  if (plan.start !== 0 || plan.end < duration(project)) return "only a whole edit renders in the cloud";
  if (options.chapters.length > 0) return "chapters are added here";
  const here = used(project).filter((media) => !media.cloud?.original);
  if (here.length > 0) return `${here.map((media) => media.name).join(", ")} isn't in the cloud`;
  return null;
}

// How fast this Mac renders the house export, from its log: a subtitle video
// (one source and its text) 150–200 frames/s, an edit 45–75 (Corrupt Cop 44,
// 13 min). A cloud export spends 2–3 min before and after its frames
// (planning, decoding every frame to check it, copying it back), so Cop
// Father's subtitles took 5:05 there and 3:29 here (Oct 19).
const MAC_FPS = { subtitles: 150, edit: 45 };
// Longer than this here, the cloud is quicker (Killer Couple's 53 min of
// subtitles took 8:36 here).
const MAC_SECONDS = 6 * 60;
// A load average per core above this leaves the Mac no room for an export.
const MAC_LOAD = 0.75;

/**
 * Why an export Modal can take should go there rather than this Mac, or
 * null to keep it here for free: the Mac isn't exporting, isn't loaded and
 * would finish within about six minutes.
 */
export function cloudBetter(project: Project, plan: Plan, macExporting: boolean,
  load = os.loadavg()[0]! / os.availableParallelism()): string | null {
  if (macExporting) return "this Mac is already exporting";
  if (load > MAC_LOAD) return `this Mac is busy (load ${load.toFixed(2)} a core)`;
  const seconds = (plan.end - plan.start) / (subtitleVideo(project) ? MAC_FPS.subtitles : MAC_FPS.edit);
  if (seconds > MAC_SECONDS) return `it would take about ${Math.round(seconds / 60)} min on this Mac`;
  return null;
}

function used(project: Project): Project["media"] {
  const ids = new Set(project.clips.flatMap((clip) => (clip.type === "video" || clip.type === "audio" ? [clip.media] : [])));
  return project.media.filter((media) => ids.has(media.id));
}

/** The platform's Infisical project, Platform (R2's keys are in `/edit-relay`; Repack's project until Oct 30). */
const INFISICAL_PROJECT = "979fe56c-c4d0-4809-b64f-5ebc75eeaf05";

/** The driver's command (Infisical's injection, then uv's Python with the worker's requirements), or why there's none. */
function command(): { cwd: string; cmd: string[] } {
  const root = workerRoot();
  if (!fs.existsSync(join(root, "apps", "worker", "export_v3.py"))) {
    throw new Error("cloud exports need EDIT_WORKER_ROOT (the checkout's app/ folder)");
  }
  const infisical = Bun.which("infisical");
  const uv = Bun.which("uv");
  if (infisical === null || uv === null) throw new Error("cloud exports need Infisical's CLI (signed in) and uv on this Mac");
  return {
    cwd: root,
    cmd: [infisical, "run", `--projectId=${INFISICAL_PROJECT}`, `--env=${process.env.INFISICAL_ENV ?? "dev"}`, "--path=/edit-relay", "--silent", "--", uv, "run", "--python", "3.12", "--with-requirements", "apps/worker/requirements.txt",
      "--with", "boto3==1.40.31", "python", "apps/worker/export_v3.py"],
  };
}

/**
 * Exports `project` on Modal to `output` (the whole edit, as `options` ask:
 * `unsuitable` said yes), reporting progress 0..1; throws "cancelled" once
 * `cancelled()` and the cloud work is stopped.
 */
export async function run(home: string, project: Project, options: ExportOptions, output: string,
  cancelled: () => boolean, onProgress: (progress: number) => void, keep: string | null = null): Promise<{ bytes: number | null; key: string | null }> {
  const id = `${project.id.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60)}-${crypto.randomUUID().slice(0, 8)}`;
  const sent = { ...project, media: used(project) };
  if (!here()) {
    // Through the relay: kept in the cloud (fetched here only when it's wanted here).
    const key = keep ?? `edit/exports/${project.id}/${crypto.randomUUID().slice(0, 8)}-${output.split("/").pop() ?? "export.mp4"}`;
    const made = await throughRelay("export", { id, project: JSON.parse(jsonForSerde(sent)), options: { ...options, range: null }, key }, cancelled, onProgress);
    diag.info("export", `${project.id}: cloud export ${id}: ${made.rendered}/${made.sections} sections rendered (the rest reused), sound ${made.sound_cached ? "reused" : "mixed"}, kept at ${key}`);
    if (keep === null) {
      await cloud.download(key, output);
      return { bytes: typeof made.bytes === "number" ? made.bytes : null, key: null };
    }
    return { bytes: typeof made.bytes === "number" ? made.bytes : null, key };
  }
  // `keep`: the export stays in the cloud at that key, never copied to this Mac.
  const done = await drive(home, id, { project: JSON.parse(jsonForSerde(sent)), options: { ...options, range: null }, output, ...(keep === null ? {} : { key: keep, deliver: false }) }, cancelled, onProgress);
  diag.info("export", `${project.id}: cloud export ${id}: ${done.rendered}/${done.sections} sections rendered (the rest reused), sound ${done.sound_cached ? "reused" : "mixed"}${keep === null ? "" : `, kept in the cloud at ${keep}`}`);
  return { bytes: typeof done.bytes === "number" ? done.bytes : null, key: typeof done.key === "string" ? done.key : null };
}

/** What a cloud review copy gives back: the files' details and the review copy's waveform. */
export interface Reviewed {
  review: Record<string, unknown>;
  export: Record<string, unknown>;
  peaks: number[];
}

/**
 * A review copy made in the cloud from an export kept there (`source`): its
 * 720p copy at `video`, its poster at `poster` (from `posterSecond`), the
 * export copied to `full`; all within R2, nothing through this Mac.
 */
export async function review(home: string, project: string, keys: { source: string; video: string; poster: string; full: string }, posterSecond: number, fps: number, frames: number,
  onProgress: (progress: number) => void = () => {}): Promise<Reviewed> {
  const id = `review-${project.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50)}-${crypto.randomUUID().slice(0, 8)}`;
  const job = { id, source_key: keys.source, review_key: keys.video, poster_key: keys.poster, full_key: keys.full, poster_second: posterSecond, fps, frames };
  const done = !here() ? await throughRelay("review", job, () => false, onProgress) : await drive(home, id, { review: true, source_key: keys.source, review_key: keys.video, poster_key: keys.poster, full_key: keys.full, poster_second: posterSecond, fps, frames }, () => false, onProgress);
  diag.info("review", `${project}: review copy made in the cloud from ${done.pieces} pieces in ${Math.round(Number(done.seconds ?? 0))} s (${JSON.stringify(done.took ?? {})})`);
  return { review: (done.review ?? {}) as Record<string, unknown>, export: (done.export ?? {}) as Record<string, unknown>, peaks: Array.isArray(done.peaks) ? (done.peaks as number[]) : [] };
}

/** Runs the cloud driver on `job` until it says it's done (its last line), reporting progress. */
async function drive(home: string, id: string, job: Record<string, unknown>, cancelled: () => boolean, onProgress: (progress: number) => void): Promise<Record<string, unknown>> {
  const { cwd, cmd } = command();
  const dir = join(home, "jobs");
  fs.mkdirSync(dir, { recursive: true });
  const file = join(dir, `modal-${id}.json`);
  // A SIGTERM may not get through Infisical and uv: the driver also looks for this file.
  const stop = `${file}.cancel`;
  writeAtomic(file, JSON.stringify({ id, ...job, host: process.pid, cancel: stop }));
  const child = Bun.spawn([...cmd, file], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  let stopped = false;
  const watch = setInterval(() => {
    if (cancelled() && !stopped) {
      stopped = true;
      fs.writeFileSync(stop, "");
      child.kill("SIGTERM");
    }
  }, 500);
  let error: string | null = null;
  let done: Record<string, unknown> | null = null;
  try {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        let said: Record<string, unknown>;
        try {
          said = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof said.error === "string") error = said.error;
        else if (said.done === true) done = said;
        else if (typeof said.progress === "number") {
          if (said.phase === "deploying") diag.info("export", `${id}: deploying the cloud exporter (a new build)`);
          onProgress(Math.min(0.99, said.progress));
        }
      }
    }
    const code = await child.exited;
    if (cancelled()) throw new Error("cancelled");
    if (done === null) throw new Error(error ?? `the cloud export stopped (exit ${code}): ${(await stderr).trim().split("\n").slice(-3).join(" ")}`);
    return done;
  } finally {
    clearInterval(watch);
    if (child.exitCode === null) child.kill("SIGTERM");
    fs.rmSync(file, { force: true });
    fs.rmSync(stop, { force: true });
  }
}
