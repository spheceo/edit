// The server's export registry (render.rs Exports): one export at a time, its
// `export` events, the files it may hand out, and the Drive upload after a
// subtitled video. The rendering, mixing, the partial file beside the
// destination and its rename are the addon's (`ExportJob`).

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { ioMessage } from "./files.ts";
import { catchBugsAsync } from "./guard.ts";
import type { ExportOptions, Project } from "./model.ts";
import { native, type ExportJob } from "./native/index.ts";
import { canonical, fileName, join, parent } from "./paths.ts";
import { fixed } from "./rust.ts";
import * as seams from "./seams.ts";
import type { Store } from "./store.ts";

/** How many finished exports are remembered (handed out, revealed). */
const KEEP_FINISHED = 50;

interface Running {
  output: string;
  cancelled: boolean;
  job: ExportJob | null;
}

export class ExportRegistry implements seams.Exports {
  private jobs = new Map<string, Running>();
  /** Files exported since the server started, newest last: the only ones it hands out or reveals. */
  private finished: string[] = [];

  /** Whether `path` is a file this server exported (and so may be downloaded or revealed). */
  exported(path: string): boolean {
    return this.finished.includes(path);
  }

  running(): boolean {
    return this.jobs.size > 0;
  }

  cancel(project: string): boolean {
    const running = this.jobs.get(project);
    if (running === undefined) return false;
    running.cancelled = true;
    running.job?.cancel();
    return true;
  }

  /**
   * Starts exporting `project` as `options` ask; returns the file it will
   * write (`output` with the format's extension). A whole subtitled video is
   * then uploaded to the team's Drive (`drive`).
   */
  async start(
    store: Store,
    library: seams.Library,
    project: Project,
    options: ExportOptions,
    output: string,
  ): Promise<string> {
    const addon = native();
    const { plan } = addon.exportPlan({ json: JSON.stringify(project) }, options);
    let path = addon.withExtension(output, options.format);
    // Never into an unplugged media drive's folder (or the empty mount point it leaves behind).
    store.layout().writable(path);
    const above = parent(path);
    const folder = above === null || above === "" ? "." : above;
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    const name = fileName(path);
    if (name === null) throw new Error("export needs a file name");
    let real: string;
    try {
      real = fs.realpathSync(folder);
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    path = join(real, name);
    if (fs.existsSync(path)) {
      const existing = canonical(path);
      if (project.media.some((media) => fs.existsSync(media.path) && canonical(media.path) === existing)) {
        throw new Error("export would overwrite source footage; choose another file");
      }
    }
    if (this.jobs.size > 0) {
      throw new Error("an export is already running; wait for it or cancel it before starting another");
    }
    const running: Running = { output: path, cancelled: false, job: null };
    this.jobs.set(project.id, running);
    let upload = false;
    try {
      upload = seams.drive.wanted(project, options, plan);
    } catch (error) {
      if (!seams.isNotPorted(error)) {
        this.jobs.delete(project.id);
        throw error;
      }
    }
    void this.run(store, library, project, options, plan, path, running, upload);
    return path;
  }

  private async run(
    store: Store,
    library: seams.Library,
    project: Project,
    options: ExportOptions,
    plan: import("./model.ts").Plan,
    output: string,
    running: Running,
    upload: boolean,
  ): Promise<void> {
    const id = project.id;
    const emit = (state: string, progress: number, extra: Record<string, unknown> = {}) => {
      store.emit({ type: "export", id, state, progress, path: output, ...extra });
    };
    emit("running", 0);
    const started = performance.now();
    let result: { ok: true } | { ok: false; error: string };
    try {
      await catchBugsAsync("the export", async () => {
        // Cloud footage: the originals, not the proxies (read from R2 for the export).
        let exported = project;
        let originals: seams.Originals | null = null;
        try {
          [exported, originals] = await seams.cloudMedia.forExport(project, plan.start, plan.end, store.cacheDir());
        } catch (error) {
          if (!seams.isNotPorted(error)) throw error;
        }
        try {
          let pending: string[] = [];
          try {
            pending = seams.broll.smoothingPending(exported.id);
          } catch (error) {
            if (!seams.isNotPorted(error)) throw error;
          }
          if (pending.length > 0) {
            diag.info(
              "export",
              `exporting current timeline snapshot; ${pending.length} optional optical-flow renders still pending`,
            );
          }
          if (running.cancelled) throw new Error("cancelled");
          const job = native().ExportJob.start(
            { project: { json: JSON.stringify(exported) }, options, plan, output, cacheDir: store.cacheDir() },
            (progress) => {
              try {
                emit("running", progress);
              } catch (error) {
                diag.warn("export", `progress: ${diag.messageOf(error)}`);
              }
            },
          );
          running.job = job;
          if (running.cancelled) job.cancel();
          await job.wait();
          if (running.cancelled) throw new Error("cancelled");
        } finally {
          originals?.release();
        }
      });
      this.finished = this.finished.filter((done) => done !== output);
      this.finished.push(output);
      this.finished.splice(0, Math.max(this.finished.length - KEEP_FINISHED, 0));
      result = { ok: true };
    } catch (error) {
      result = { ok: false, error: diag.messageOf(error) };
    }
    const frames = Math.max(plan.end - plan.start, 0);
    const took = performance.now() - started;
    if (result.ok) {
      diag.info(
        "export",
        `${project.name} exported ${frames} frames in ${diag.human(took)} (${fixed(frames / Math.max(took / 1000, 1e-3), 1)} frames/s) to ${output}`,
      );
      diag.record("export", "export", took, null);
      let bytes: number | null = null;
      try {
        bytes = fs.statSync(output).size;
      } catch {
        bytes = null;
      }
      emit("done", 1, { seconds: (performance.now() - started) / 1000, bytes, drive: upload });
    } else if (running.cancelled) {
      diag.info("export", `${project.name} export cancelled`);
      emit("cancelled", 0, { error: result.error });
    } else {
      diag.record("export", "export", took, `${project.name}: ${result.error}`);
      emit("failed", 0, { error: result.error });
    }
    this.jobs.delete(id);
    if (upload && result.ok) {
      try {
        seams.drive.start(store, library, project, output);
      } catch (error) {
        diag.warn("drive", `${project.name}: ${diag.messageOf(error)}`);
      }
    }
  }
}
