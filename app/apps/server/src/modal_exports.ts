/**
 * Exports on Modal's v3 sections pool: eight L40S GPUs render a whole edit
 * in eight pieces, every frame of the joined file is decoded in the cloud,
 * and the checked file is copied here (`apps/worker/export_v3.py`, one
 * process per export, so several run at once). Unchanged pieces, the sound
 * and the footage stay in Modal's cache: exporting again after a small
 * change renders only what it touched.
 *
 * On when the server starts with `EDIT_MODAL_EXPORTS=1`, `EDIT_WORKER_ROOT`
 * (the checkout's `app/`, whose worker it runs) and Repack beside it
 * (`EDIT_REPACK_ROOT`, default `<root>/../../repack`: its Infisical injection
 * gives the driver R2's keys for that process only); Modal is signed in on
 * the Mac. The house export of a whole edit whose footage is all in the
 * cloud goes there when this Mac is busy or it's long (`cloudBetter`); anything else (another format, size or shape, a span,
 * chapters, footage only on this Mac) is exported here as before.
 */
import * as fs from "node:fs";
import * as os from "node:os";

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
export const enabled = () => {
  if (process.env.EDIT_MODAL_EXPORTS === "0") return false;
  try {
    command();
    return true;
  } catch {
    return false;
  }
};

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

/** The driver's command (Repack's injection, then uv's Python with the worker's requirements), or why there's none. */
function command(): { cwd: string; cmd: string[] } {
  const root = workerRoot();
  if (!fs.existsSync(join(root, "apps", "worker", "export_v3.py"))) {
    throw new Error("cloud exports need EDIT_WORKER_ROOT (the checkout's app/ folder)");
  }
  const repack = process.env.EDIT_REPACK_ROOT ?? join(root, "..", "..", "repack");
  const env = join(repack, "scripts", "env.ts");
  const bun = Bun.which("bun");
  const uv = Bun.which("uv");
  if (!fs.existsSync(env) || bun === null || uv === null) throw new Error("cloud exports need Bun, uv and Repack's scripts/env.ts on this Mac");
  return {
    cwd: root,
    cmd: [bun, "--no-env-file", env, "--path=/media", "--", uv, "run", "--python", "3.12", "--with-requirements", "apps/worker/requirements.txt",
      "--with", "boto3==1.40.31", "python", "apps/worker/export_v3.py"],
  };
}

/**
 * Exports `project` on Modal to `output` (the whole edit, as `options` ask:
 * `unsuitable` said yes), reporting progress 0..1; throws "cancelled" once
 * `cancelled()` and the cloud work is stopped.
 */
export async function run(home: string, project: Project, options: ExportOptions, output: string,
  cancelled: () => boolean, onProgress: (progress: number) => void): Promise<void> {
  const { cwd, cmd } = command();
  const id = `${project.id.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60)}-${crypto.randomUUID().slice(0, 8)}`;
  const dir = join(home, "jobs");
  fs.mkdirSync(dir, { recursive: true });
  const file = join(dir, `modal-${id}.json`);
  const sent = { ...project, media: used(project) };
  // A SIGTERM may not get through Infisical and uv: the driver also looks for this file.
  const stop = `${file}.cancel`;
  writeAtomic(file, JSON.stringify({ id, project: JSON.parse(jsonForSerde(sent)), options: { ...options, range: null }, output, host: process.pid, cancel: stop }));
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
          if (said.phase === "deploying") diag.info("export", `${project.id}: deploying the cloud exporter (a new build)`);
          onProgress(Math.min(0.99, said.progress));
        }
      }
    }
    const code = await child.exited;
    if (cancelled()) throw new Error("cancelled");
    if (done === null) throw new Error(error ?? `the cloud export stopped (exit ${code}): ${(await stderr).trim().split("\n").slice(-3).join(" ")}`);
    diag.info("export", `${project.id}: cloud export ${id}: ${done.rendered}/${done.sections} sections rendered (the rest reused), sound ${done.sound_cached ? "reused" : "mixed"}`);
  } finally {
    clearInterval(watch);
    if (child.exitCode === null) child.kill("SIGTERM");
    fs.rmSync(file, { force: true });
    fs.rmSync(stop, { force: true });
  }
}
