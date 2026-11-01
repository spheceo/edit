/**
 * Exports on Modal's v3 sections pool: four L40S GPUs render a whole edit
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
 * cloud goes there, whatever this Mac is doing, its chapters added when the file is joined; anything else (another
 * format, size or shape, a span, footage only on this Mac) is exported here as before.
 */
import * as fs from "node:fs";
import * as os from "node:os";

import { Effect, Fiber, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { inArea, runPromise } from "./effect/runtime.ts";
import * as service from "./effect/service.ts";
import { subtitleVideo } from "./drive.ts";
import { writeAtomic } from "./files.ts";
import type { ExportOptions, Plan, Project } from "./model.ts";
import { join } from "./paths.ts";
import { duration } from "./project.ts";
import * as relay from "./relay.ts";
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

// ── Modal's answers (in Effect since Nov 1: docs/plans/2026-11-01-effect.md, round 2, area 7) ──
//
// A job's start and status answers are read through Schemas; the status is
// asked every `timing.pollMs` until done, failed, cancelled, or past
// `timing.deadlineMs` (cancelled in the cloud then: it polled for ever). A
// status that fails for a moment (offline, a 5xx, a 429) is asked again
// until it has gone unanswered for `timing.statusLostMs`; any other failure
// (a refusal, an answer that isn't the relay's) ends it at once. A
// cancel, or the export being interrupted, cancels the job in the cloud.

/** The job ended in the cloud without its result (Modal's own error, or the driver's). */
export class ModalJobFailed extends Schema.TaggedError<ModalJobFailed>()("ModalJobFailed", { message: Schema.String }) {}
/** Nobody could say how the job was going for too long, or it ran past its deadline. */
export class ModalUnanswered extends Schema.TaggedError<ModalUnanswered>()("ModalUnanswered", { message: Schema.String }) {}
/** Cancelled from here (the words exports.ts has always read). */
export class ExportCancelled extends Schema.TaggedError<ExportCancelled>()("ExportCancelled", { message: Schema.Literal("cancelled") }) {}

service.kinds({ ModalJobFailed: "later", ModalUnanswered: "temporary", ExportCancelled: "later" });

/** How often a job is asked how it's going, how long its status may go unanswered, and the longest a job may take (tests make them short). */
export const timing = { pollMs: 3000, statusLostMs: 10 * 60_000, deadlineMs: 3 * 3600_000 };

const Started = Schema.Struct({ call: Schema.optional(Schema.String), error: Schema.optional(Schema.NullOr(Schema.String)) });
const Status = Schema.Struct({
  state: Schema.optional(Schema.String),
  result: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  error: Schema.optional(Schema.NullOr(Schema.String)),
  progress: Schema.optional(Schema.NullOr(Schema.Number)),
});

const askCloud = <S extends Schema.Top>(route: string, body: unknown, schema: S) => relay.askJson("POST", `/v1/cloud/${route}`, body, "cloud storage", 120_000, schema);

/**
 * A job run on the v3 pool through the relay (`start_export` / `start_review`),
 * polled until it's done, reporting progress; cancelled when `cancelled()`.
 */
const throughRelayEffect = Effect.fn("modal.throughRelay")(function* (kind: "export" | "review", job: Record<string, unknown>, cancelled: () => boolean, onProgress: (progress: number) => void) {
  const started = yield* askCloud(`v3/start_${kind}`, { job }, Started);
  const call = started.call;
  if (call === undefined) return yield* new ModalJobFailed({ message: started.error ?? "the cloud didn't start it" });
  const cancel = askCloud("v3/cancel", { call }, Schema.Unknown).pipe(Effect.ignore);
  const began = Date.now();
  let heard = Date.now();
  const polling = Effect.gen(function* () {
    for (;;) {
      yield* Effect.sleep(timing.pollMs);
      if (cancelled()) {
        yield* cancel;
        return yield* new ExportCancelled({ message: "cancelled" });
      }
      if (Date.now() - began > timing.deadlineMs) {
        yield* cancel;
        return yield* new ModalUnanswered({ message: `the cloud job ran for more than ${Math.round(timing.deadlineMs / 60_000)} min and was cancelled` });
      }
      const asked = yield* askCloud("v3/status", { call, id: job.id }, Status).pipe(Effect.result);
      if (asked._tag === "Failure") {
        // Only a failure that may pass (offline, a 5xx, a 429) is waited out: a refusal won't change by asking.
        if (!service.isTemporary(asked.failure)) return yield* asked.failure;
        if (Date.now() - heard > timing.statusLostMs) return yield* new ModalUnanswered({ message: `nobody could say how the cloud job was going for ${Math.round(timing.statusLostMs / 60_000)} min: ${asked.failure.message}` });
        yield* Effect.logWarning(`${String(job.id)}: asking the cloud how it's going: ${asked.failure.message}`);
        continue;
      }
      heard = Date.now();
      const said = asked.success;
      if (said.state === "done" && said.result !== undefined && said.result !== null) return said.result;
      if (said.state === "failed" || typeof said.error === "string") return yield* new ModalJobFailed({ message: said.error ?? "the cloud job failed" });
      if (typeof said.progress === "number") onProgress(Math.min(0.99, said.progress));
    }
  });
  // The export interrupted from here (Edit quitting, a stop): the cloud's work is stopped too.
  return yield* polling.pipe(Effect.onInterrupt(() => cancel));
});

/** `throughRelayEffect` for the Promise side (exported for tests). */
export function throughRelay(kind: "export" | "review", job: Record<string, unknown>, cancelled: () => boolean, onProgress: (progress: number) => void): Promise<Record<string, unknown>> {
  return runPromise(throughRelayEffect(kind, job, cancelled, onProgress).pipe(inArea("export")));
}

/** Why `project` can't export on Modal as `options` ask (it exports here), or null when it can. */
export function unsuitable(project: Project, options: ExportOptions, plan: Plan): string | null {
  const { width, height } = project.settings;
  if (options.format !== "h264" || !options.audio || !options.hardware) return "only H.264 with sound renders in the cloud";
  if (options.shape !== "original" || options.fps != null || options.target_mb != null) return "only the project's own shape and rate render in the cloud";
  if (options.size != null && options.size !== Math.min(width, height)) return "only the project's own size renders in the cloud";
  if (plan.start !== 0 || plan.end < duration(project)) return "only a whole edit renders in the cloud";
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
// Longer than this here, the export goes to the cloud. It was six minutes
// (the cloud is quicker past that), which sent nearly every edit to Modal at
// about $1 an export, the same videos four to six times a day: $32 in Oct
// 29–31 and the month's spend limit reached (the user, Oct 31: send them
// "only when the Mac really can't"). A typical 25-minute edit takes ~15 min
// here, for free.
const MAC_SECONDS = 25 * 60;
// A load average per core above this leaves the Mac no room for an export
// (0.75 was passed by an import's preview encode alone).
const MAC_LOAD = 1.25;

/**
 * Why an export Modal can take should go there rather than this Mac, or
 * null to keep it here for free: the Mac isn't exporting, isn't overloaded and
 * would finish within about 25 minutes.
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
  /** The copy's and the export's picture and sound lengths, as the worker measured them (review_check.ts); absent from older workers. */
  lengths?: { review?: unknown; export?: unknown };
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
  const lengths = typeof done.lengths === "object" && done.lengths !== null ? (done.lengths as Reviewed["lengths"]) : undefined;
  return { review: (done.review ?? {}) as Record<string, unknown>, export: (done.export ?? {}) as Record<string, unknown>, peaks: Array.isArray(done.peaks) ? (done.peaks as number[]) : [], ...(lengths ? { lengths } : {}) };
}

/** A line the driver writes (JSON): an error, the done answer, or progress. */
const DriverLine = Schema.Struct({
  error: Schema.optional(Schema.String),
  done: Schema.optional(Schema.Boolean),
  progress: Schema.optional(Schema.Number),
  phase: Schema.optional(Schema.String),
});

/**
 * Runs `cmd` (the cloud driver, in `cwd`) on `file` until it says it's done
 * (its last line), reporting progress. Infisical, uv and the Python driver
 * are one process group the run owns: a cancel (polled every 500 ms, which
 * also leaves the driver its cancel file), a failure or `timing.deadlineMs`
 * ends all of them; a SIGTERM to Infisical alone may not have reached the
 * driver.
 */
export const driving = Effect.fn("modal.drive")(function* (cmd: readonly string[], cwd: string, file: string, stop: string, id: string, cancelled: () => boolean, onProgress: (progress: number) => void) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  let error: string | null = null;
  let done: Record<string, unknown> | null = null;
  const line = (text: string) => {
    if (!text.startsWith("{")) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    const said = Schema.decodeUnknownOption(DriverLine)(value);
    if (Option.isNone(said)) return;
    if (typeof said.value.error === "string") error = said.value.error;
    else if (said.value.done === true) done = value as Record<string, unknown>;
    else if (typeof said.value.progress === "number") {
      if (said.value.phase === "deploying") diag.info("export", `${id}: deploying the cloud exporter (a new build)`);
      onProgress(Math.min(0.99, said.value.progress));
    }
  };
  const run = Effect.gen(function* () {
    const [program = "", ...args] = cmd;
    const handle = yield* spawner
      .spawn(ChildProcess.make(program, [...args, file], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", forceKillAfter: "10 seconds" }))
      .pipe(Effect.mapError((cause) => new ModalJobFailed({ message: `the cloud driver couldn't start: ${cause.message}` })));
    const stderr = yield* Stream.mkString(Stream.decodeText(handle.stderr)).pipe(Effect.orElseSucceed(() => ""), Effect.forkScoped);
    let pending = "";
    yield* Stream.runForEach(Stream.decodeText(handle.stdout), (text) =>
      Effect.sync(() => {
        pending += text;
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          line(pending.slice(0, newline).trim());
          pending = pending.slice(newline + 1);
        }
      }),
    ).pipe(Effect.ignore);
    const code = Number(yield* handle.exitCode.pipe(Effect.orElseSucceed(() => -1)));
    const said: Record<string, unknown> | null = done;
    if (said === null) return yield* new ModalJobFailed({ message: error ?? `the cloud export stopped (exit ${code}): ${(yield* Fiber.join(stderr)).trim().split("\n").slice(-3).join(" ")}` });
    return said;
  }).pipe(Effect.scoped);
  const watch = Effect.gen(function* () {
    for (;;) {
      yield* Effect.sleep(500);
      if (cancelled()) {
        fs.writeFileSync(stop, "");
        return yield* new ExportCancelled({ message: "cancelled" });
      }
    }
  });
  return yield* Effect.raceFirst(run, watch).pipe(
    Effect.timeoutOrElse({ duration: timing.deadlineMs, orElse: () => Effect.fail(new ModalUnanswered({ message: `the cloud export ran for more than ${Math.round(timing.deadlineMs / 60_000)} min and was stopped` })) }),
  );
});

/** Runs the cloud driver on `job` until it says it's done (its last line), reporting progress. */
async function drive(home: string, id: string, job: Record<string, unknown>, cancelled: () => boolean, onProgress: (progress: number) => void): Promise<Record<string, unknown>> {
  const { cwd, cmd } = command();
  const dir = join(home, "jobs");
  fs.mkdirSync(dir, { recursive: true });
  const file = join(dir, `modal-${id}.json`);
  // A SIGTERM may not get through Infisical and uv: the driver also looks for this file.
  const stop = `${file}.cancel`;
  writeAtomic(file, JSON.stringify({ id, ...job, host: process.pid, cancel: stop }));
  try {
    return await runPromise(driving(cmd, cwd, file, stop, id, cancelled, onProgress).pipe(inArea("export")));
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(stop, { force: true });
  }
}
