// The server's export registry: one export at a time on this Mac and any
// number in the cloud (Modal's sections, `modal_exports.ts`, when it's on and
// worth it), their
// `export` events, the files it may hand out, and the Drive upload after a
// subtitled video (or whenever asked). The local rendering, mixing, the partial
// file beside the destination and its rename are the addon's (`ExportJob`).

import { createHash } from "node:crypto";
import * as fs from "node:fs";

import * as diag from "./diag.ts";
import * as jobs from "./jobs.ts";
import { ioMessage, nowMs, writeAtomic } from "./files.ts";
import { catchBugsAsync } from "./guard.ts";
import type { ExportOptions, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { canonical, fileName, join, parent } from "./paths.ts";
import { duration } from "./project.ts";
import { fixed, jsonForSerde } from "./rust.ts";
import * as seams from "./seams.ts";
import type { Store } from "./store.ts";

/** How many finished exports are remembered (handed out, revealed). */
const KEEP_FINISHED = 50;

/** Where an export renders: this Mac, the Relay's worker (v2) or Modal's sections (v3). */
export type Backend = "local" | "cloud" | "modal";

/** How an export is started beyond its options (a restart passes back what it was). */
export interface StartExtra {
  backend?: Backend;
  cloudRequest?: string;
  cloudJob?: string;
  /** Upload the finished file to Drive; by default only a whole subtitled video is (`drive.wanted`). */
  drive?: boolean;
}

interface Running {
  output: string;
  /** Its entry in the jobs a restart resumes. */
  key: string;
  cancelled: boolean;
  job: { cancel(): void } | null;
  backend: Backend;
  /** Rendered elsewhere: no contention with this Mac's own work. */
  remote: boolean;
  cloudRequest: string;
  cloudJob?: string;
  /** The timeline kept for a restart (`snapshotFile`), removed when it ends. */
  snapshot: string | null;
  /** What it exports, as `timelineHash`. */
  timeline: string;
}

/**
 * A finished export, kept per project in `<home>/exports.json` (this
 * machine's files, never shared): the project's exports list, with a
 * download (on the Mac or over Tailscale) and a delete each, survives a
 * restart. A normal edit isn't uploaded anywhere; this is how it's handed out.
 */
export interface ExportRecord {
  path: string;
  name: string;
  finished_ms: number;
  /** How long it took (seconds). */
  seconds: number;
  bytes: number | null;
  /** Frames exported, and whether that was the whole edit. */
  frames: number;
  whole: boolean;
  format: string;
  /** The exported timeline's fingerprint (`timelineHash`): an edit since makes the project "not exported". */
  timeline?: string;
}

/** A project's timeline as a fingerprint: the same whatever revision or machine saved it, different after any edit. */
export function timelineHash(project: Project): string {
  return createHash("sha256").update(jsonForSerde(project)).digest("hex").slice(0, 16);
}

/** The picture clips of an export's timeline ([id, start, duration] frames): a review note's moment finds its clip by them after later edits. */
export function clipMap(project: Project): [string, number, number][] {
  return project.clips.filter((clip) => clip.type === "video").map((clip): [string, number, number] => [clip.id, clip.start, clip.duration]);
}

/** Where an export's clip map is kept, by its timeline (`timelineHash`). */
export function mapFile(home: string, timeline: string): string {
  return join(home, "export-maps", `${timeline}.json`);
}

/** How many exports a project keeps listed (the oldest drop off the list; their files stay). */
const KEEP_LISTED = 30;

/**
 * The project as an export running for it was asked for, kept while it runs
 * so an export a restart cut short carries on with that timeline, not edits
 * made since (`resumeSnapshot`).
 */
function snapshotFile(home: string, id: string): string {
  return join(home, "jobs", `export-${id}.json`);
}

/** The project an export a restart cut short was started with, if it was kept. */
export function resumeSnapshot(home: string, id: string, args: Record<string, unknown>): Project | null {
  const path = args.snapshot;
  // Only the file Edit keeps for it: jobs.json names nothing else to read.
  if (typeof path !== "string" || path !== snapshotFile(home, id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as Project;
  } catch {
    return null;
  }
}

function recordsFile(home: string): string {
  return join(home, "exports.json");
}

function readRecords(home: string): Record<string, ExportRecord[]> {
  try {
    const value = JSON.parse(fs.readFileSync(recordsFile(home), "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, ExportRecord[]>) : {};
  } catch {
    return {};
  }
}

function writeRecords(home: string, records: Record<string, ExportRecord[]>): void {
  writeAtomic(recordsFile(home), JSON.stringify(records, null, 1));
}

/** Project `id`'s exports, newest first, each saying whether its file is still there. */
export function listExports(home: string, id: string): (ExportRecord & { missing: boolean })[] {
  return [...(readRecords(home)[id] ?? [])]
    .reverse()
    .map((record) => ({ ...record, missing: !fs.existsSync(record.path) }));
}

function remember(home: string, id: string, record: ExportRecord): void {
  const records = readRecords(home);
  const own = (records[id] ?? []).filter((one) => one.path !== record.path);
  own.push(record);
  records[id] = own.slice(Math.max(own.length - KEEP_LISTED, 0));
  writeRecords(home, records);
}

/** Whether `path` is one of the listed exports (of any project). */
export function listed(home: string, path: string): boolean {
  return Object.values(readRecords(home)).some((own) => own.some((record) => record.path === path));
}

/**
 * Deletes one of project `id`'s listed exports: its file and its place on
 * the list. Only a listed export's file is ever deleted.
 */
export function deleteExport(home: string, id: string, path: string): void {
  const records = readRecords(home);
  const own = records[id] ?? [];
  if (!own.some((record) => record.path === path)) throw new Error("not one of this project's exports");
  try {
    fs.rmSync(path, { force: true });
  } catch (error) {
    throw new Error(`${path}: ${ioMessage(error)}`);
  }
  records[id] = own.filter((record) => record.path !== path);
  writeRecords(home, records);
  diag.info("export", `${id}: deleted the export ${path}`);
}

export class ExportRegistry implements seams.Exports {
  private jobs = new Map<string, Running>();
  /** Files exported since the server started, newest last: the only ones it hands out or reveals. */
  private finished: string[] = [];

  /** The data folder whose exports list this keeps (`<home>/exports.json`); none in some tests. */
  constructor(private readonly home: string | null = null) {}

  /** Whether `path` is a file this server exported, now or before a restart (and so may be downloaded or revealed). */
  exported(path: string): boolean {
    return this.finished.includes(path) || (this.home !== null && listed(this.home, path));
  }

  running(): boolean {
    return this.jobs.size > 0;
  }

  localRunning(): boolean {
    return [...this.jobs.values()].some(job => !job.remote);
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
   * write (`output` with the format's extension). It renders on Modal when
   * that's on and the export suits it, else here (or the Relay's worker). A
   * whole subtitled video is then uploaded to the team's Drive unless
   * `drive` is false; any whole video export is when it's true.
   */
  async start(
    store: Store,
    library: seams.Library,
    project: Project,
    options: ExportOptions,
    output: string,
    extra: StartExtra = {},
  ): Promise<string> {
    const cloudRequest = extra.cloudRequest ?? crypto.randomUUID();
    const cloudJob = extra.cloudJob;
    const addon = native();
    const { plan } = addon.exportPlan({ json: jsonForSerde(project) }, options);
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
    let backend: Backend;
    if (extra.backend !== undefined) {
      backend = extra.backend;
    } else if (seams.modalExports.enabled()) {
      // Modal when it can take the export and it's worth it (this Mac is
      // exporting or loaded, or it's long); else here, for free.
      const why = seams.modalExports.unsuitable(project, options, plan);
      const reason = why === null ? seams.modalExports.cloudBetter(project, plan, this.localRunning()) : null;
      if (why !== null || reason === null) diag.info("export", `${project.id}: exporting on this Mac: ${why ?? "it's free and about as quick"}`);
      else diag.info("export", `${project.id}: exporting on Modal: ${reason}`);
      backend = reason !== null ? "modal" : seams.cloudExports.enabled() ? "cloud" : "local";
    } else {
      backend = seams.cloudExports.enabled() ? "cloud" : "local";
    }
    if (backend === "modal") {
      const why = seams.modalExports.unsuitable(project, options, plan);
      if (why !== null) throw new Error(`this export can't render in the cloud: ${why}`);
    }
    const whole = ["h264", "hevc", "prores"].includes(options.format) && plan.start === 0 && plan.end >= duration(project) && plan.end > 0;
    if (extra.drive === true && !whole) throw new Error("only a whole video export (MP4 or MOV) uploads to Drive");
    const remote = backend !== "local";
    if (!remote && this.localRunning()) {
      throw new Error("an export is already running; wait for it or cancel it before starting another");
    }
    if (this.jobs.has(project.id)) throw new Error("this project already has an export running");
    if ([...this.jobs.values()].some(job => job.output === path)) throw new Error("another export is writing this output path");
    let snapshot: string | null = null;
    if (this.home !== null) {
      snapshot = snapshotFile(this.home, project.id);
      try {
        fs.mkdirSync(join(this.home, "jobs"), { recursive: true });
        writeAtomic(snapshot, jsonForSerde(project));
      } catch (error) {
        diag.warn("export", `couldn't keep ${project.id}'s timeline for a restart: ${ioMessage(error)}`);
        snapshot = null;
      }
    }
    const args = {
      options, output: path, backend, cloudRequest,
      ...(cloudJob === undefined ? {} : { cloudJob }), ...(extra.drive === undefined ? {} : { drive: extra.drive }), ...(snapshot === null ? {} : { snapshot }),
    };
    const key = jobs.begin(this.home, "export", project.id, args);
    const running: Running = { output: path, key, cancelled: false, job: null, snapshot, backend, remote, cloudRequest, cloudJob, timeline: timelineHash(project) };
    this.jobs.set(project.id, running);
    let upload = false;
    try {
      upload = extra.drive ?? seams.drive.wanted(project, options, plan);
    } catch (error) {
      if (!seams.isUnavailable(error)) {
        this.jobs.delete(project.id);
        jobs.end(this.home, key);
        if (snapshot !== null) fs.rmSync(snapshot, { force: true });
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
        if (running.backend === "modal") {
          await seams.modalExports.run(this.home ?? store.home, project, options, output, () => running.cancelled, progress => emit("running", progress));
          return;
        }
        if (running.backend === "cloud") {
          await seams.cloudExports.run(project, options, plan, output, () => running.cancelled, progress => emit("running", progress), running.cloudRequest, {
            id: running.cloudJob,
            accepted: id => { running.cloudJob = id; jobs.patch(this.home, running.key, { cloudJob: id }); },
          });
          return;
        }
        // Cloud footage: the originals, not the proxies (read from R2 for the export).
        let exported = project;
        let originals: seams.Originals | null = null;
        try {
          [exported, originals] = await seams.cloudMedia.forExport(project, plan.start, plan.end, store.cacheDir());
        } catch (error) {
          if (!seams.isUnavailable(error)) throw error;
        }
        try {
          let pending: string[] = [];
          try {
            pending = seams.broll.smoothingPending(exported.id);
          } catch (error) {
            if (!seams.isUnavailable(error)) throw error;
          }
          if (pending.length > 0) {
            diag.info(
              "export",
              `exporting current timeline snapshot; ${pending.length} optional optical-flow renders still pending`,
            );
          }
          if (running.cancelled) throw new Error("cancelled");
          const job = native().ExportJob.start(
            { project: { json: jsonForSerde(exported) }, options, plan, output, cacheDir: store.cacheDir(), sounds: originals?.sounds ?? {} },
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
      emit("done", 1, { seconds: (performance.now() - started) / 1000, bytes, drive: upload, backend: running.backend });
      try {
        remember(this.home ?? store.home, id, {
          path: output,
          name: fileName(output) ?? output,
          finished_ms: nowMs(),
          seconds: took / 1000,
          bytes,
          frames,
          whole: plan.start === 0 && plan.end >= duration(project),
          format: options.format,
          timeline: running.timeline,
        });
        fs.mkdirSync(join(this.home ?? store.home, "export-maps"), { recursive: true });
        writeAtomic(mapFile(this.home ?? store.home, running.timeline), JSON.stringify(clipMap(project)));
      } catch (error) {
        diag.warn("export", `couldn't list ${output}: ${diag.messageOf(error)}`);
      }
    } else if (running.cancelled) {
      diag.info("export", `${project.name} export cancelled`);
      emit("cancelled", 0, { error: result.error });
    } else {
      diag.record("export", "export", took, `${project.name}: ${result.error}`);
      emit("failed", 0, { error: result.error });
    }
    this.jobs.delete(id);
    jobs.end(this.home, running.key);
    if (running.snapshot !== null) fs.rmSync(running.snapshot, { force: true });
    if (upload && result.ok) {
      try {
        seams.drive.start(store, library, project, output);
      } catch (error) {
        diag.warn("drive", `${project.name}: ${diag.messageOf(error)}`);
      }
    }
  }
}
