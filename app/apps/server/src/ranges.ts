// Stretches of the edit marked to export (Sphe, Nov 12: "I want to be able to
// tell the agents, go to all of the cut-ins and then set all the in and out
// points for me. Once those are set up, I can then click to export"). The
// agent marks them (`set_ranges`: by time, or every cut-in at once); the
// Export dialog makes a video of each, or one of them joined (the person picks,
// each time). Each is the house export of its stretch, one after another
// through the export line; joined, their files are put end to end without
// encoding again (they're made with the same settings).

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { exportsDir } from "./export_folder.ts";
import { chunkFolder, listExports, listMade, unlist } from "./exports.ts";
import { writeAtomic } from "./files.ts";
import { bad, json } from "./http/errors.ts";
import { readJson, type RouteContext, type Router } from "./http/router.ts";
import { registerTool, text } from "./mcp/registry.ts";
import type { ExportOptions, Project, Range } from "./model.ts";
import { native } from "./native/index.ts";
import { join } from "./paths.ts";
import { clipEnd, duration as durationOf, fps as fpsOf } from "./project.ts";
import { fixed, isAlphanumeric, jsonForSerde } from "./rust.ts";
import * as tools from "./tools.ts";

/** Frames of `ranges` made valid: in order, inside the edit, none empty, none overlapping (a later one starts where the one before ends). */
export function tidy(ranges: Range[], length: number): Range[] {
  const sorted = ranges
    .map((one) => ({ start: Math.max(0, Math.round(one.start)), end: Math.min(length, Math.round(one.end)), name: one.name.trim() }))
    .filter((one) => one.end > one.start)
    .sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const one of sorted) {
    const before = out.at(-1);
    const start = before === undefined ? one.start : Math.max(one.start, before.end);
    if (one.end > start) out.push({ ...one, start });
  }
  return out;
}

/**
 * The cut-ins, each named as its clips are ("Cut-in 36"): from the first of
 * its clips to the end of the last. An edit with no clip so named has its
 * B-roll sections instead (a Bodycam HQ edit's sections are slivers between
 * its voice clips, Nov 12: 16 found where it has 30).
 */
export function cutIns(project: Project): Range[] {
  const named = new Map<string, Range>();
  for (const clip of project.clips) {
    const name = /^(Cut-in \d+)/u.exec(clip.name ?? "")?.[1];
    if (name === undefined) continue;
    const before = named.get(name);
    named.set(name, { name, start: Math.min(before?.start ?? clip.start, clip.start), end: Math.max(before?.end ?? 0, clipEnd(clip)) });
  }
  if (named.size > 0) return [...named.values()].sort((a, b) => a.start - b.start);
  let parts: { kind: string; start: number; end: number }[] = [];
  try {
    parts = native().sections({ json: jsonForSerde(project) }).parts;
  } catch {
    return [];
  }
  // A sliver under a second isn't a cut-in to export.
  const fps = fpsOf(project);
  return parts.filter((part) => part.kind === "broll" && part.end - part.start >= fps).map((span, index) => ({ start: span.start, end: span.end, name: `Cut-in ${index + 1}` }));
}

registerTool("set_ranges", async ({ app, args, projectId }) => {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  const fps = fpsOf(live.project);
  const length = durationOf(live.project);
  let wanted: Range[];
  if (args.cut_ins === true) {
    wanted = cutIns(live.project);
    if (wanted.length === 0) throw new Error("this edit has no cut-ins to mark (its script's B-roll sections)");
  } else if (Array.isArray(args.ranges)) {
    wanted = (args.ranges as unknown[]).map((given, index) => {
      const one = (given ?? {}) as Record<string, unknown>;
      if (typeof one.start !== "number" || typeof one.end !== "number") throw new Error(`ranges[${index}]: start and end are seconds on the timeline`);
      return { start: one.start * fps, end: one.end * fps, name: typeof one.name === "string" && one.name.trim() !== "" ? one.name : `Part ${index + 1}` };
    });
  } else {
    throw new Error("give ranges (a list of {start, end, name}, seconds; [] clears them) or cut_ins: true");
  }
  const ranges = tidy(wanted, length);
  await app.store.update(projectId, "agent", (project) => {
    if (ranges.length === 0) delete project.ranges;
    else project.ranges = ranges;
  });
  if (ranges.length === 0) return text("marked stretches cleared");
  const listed = ranges.map((one) => `${one.name} ${fixed(one.start / fps, 2)}–${fixed(one.end / fps, 2)}s`).join("; ");
  return text(`${ranges.length} stretch${ranges.length === 1 ? "" : "es"} marked to export (on the progress bar; the person exports each, or them joined, from Export): ${listed}`);
});

// ---------------------------------------------------------------- exporting them

export type Mode = "each" | "joined";

export interface Batch {
  mode: Mode;
  total: number;
  done: number;
  /** The stretch being exported now. */
  current: string | null;
  /** The files made (each), or the one file (joined) once it's whole. */
  outputs: string[];
  error: string | null;
  cancelled: boolean;
  finished: boolean;
  /** When it ended (one kept before this was noted reads its file's time). */
  finished_ms: number | null;
}

const batches = new Map<string, Batch>();

/** Where a project's last batch is kept, so a restart doesn't take its Download away (Sphe, Nov 12: on another computer, the file can't be fetched any other way). */
const keptAt = (app: App, id: string) => join(app.store.cacheDir(), "range-exports", `${safe(id)}.json`);

/** The project's batch: the one running or last run, else the one kept from before a restart. */
export function batchOf(app: App, id: string): Batch | null {
  const known = batches.get(id);
  if (known !== undefined) return known;
  try {
    const kept = JSON.parse(fs.readFileSync(keptAt(app, id), "utf8")) as Batch;
    return kept.finished ? { ...kept, finished_ms: kept.finished_ms ?? fs.statSync(keptAt(app, id)).mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * The batch as the Export dialog shows it: one running, or one finished that
 * is still the last thing to happen to the project's exports. Kept for good,
 * yesterday's "Saved to … 36 marked.mp4" stood in for today's share.
 */
export function latestBatch(app: App, id: string): Batch | null {
  const batch = batchOf(app, id);
  if (batch === null || !batch.finished) return batch;
  const at = batch.finished_ms ?? 0;
  if ((app.exports.runningFor?.(id) ?? null) !== null) return null;
  if ((app.exports.activity?.() ?? []).some((one) => one.id === id && one.updated_ms > at)) return null;
  return listExports(app.store.home, id).some((one) => one.finished_ms > at) ? null : batch;
}

/** Seams for tests: what's held in memory goes, as after a restart. */
export const forgetBatches = () => batches.clear();

/** Seams for tests. */
export const timing = { poll: 500, sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

const safe = (name: string) => {
  const kept = [...name].map((char) => (isAlphanumeric(char) || " -_".includes(char) ? char : "_")).join("").trim();
  return kept === "" ? "Edit" : kept;
};

/** A file's time, or null when it isn't there. */
const timeOf = (path: string): bigint | null => {
  try {
    return fs.statSync(path, { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
};

/** Waits for `id`'s export to end; whether it wrote `output` anew (`before`: its time then): the engine renames over it only on success, so a failure leaves the last run's file. */
async function finished(app: App, id: string, output: string, before: bigint | null): Promise<boolean> {
  while ((app.exports.runningFor?.(id) ?? null) !== null) await timing.sleep(timing.poll);
  const now = timeOf(output);
  return now !== null && now !== before;
}

/** A file's first sound: its codec, rate and channel layout; null when it has none (a stretch where nothing is heard is exported picture alone). */
async function soundOf(path: string): Promise<{ codec: string; rate: string; layout: string } | null> {
  const said = JSON.parse(new TextDecoder().decode(await tools.run([tools.ffprobe(), "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channel_layout,channels", "-of", "json", path], { timeoutMs: 60_000 }))) as {
    streams?: { codec_name?: string; sample_rate?: string; channel_layout?: string; channels?: number }[];
  };
  const stream = said.streams?.[0];
  if (stream?.codec_name === undefined) return null;
  return { codec: stream.codec_name, rate: stream.sample_rate ?? "48000", layout: stream.channel_layout ?? (stream.channels === 1 ? "mono" : "stereo") };
}

/**
 * `parts` ready to join: a silent one gets a silent track like the others'
 * when some have sound (the join takes its streams from the first file, so a
 * silent first stretch left the whole video without sound).
 */
async function withSound(parts: string[]): Promise<string[]> {
  const sounds = await Promise.all(parts.map(soundOf));
  const like = sounds.find((one) => one !== null);
  if (like === undefined) return parts;
  return Promise.all(
    parts.map(async (part, index) => {
      if (sounds[index] !== null) return part;
      const out = part.replace(/(\.[^./]+)$/u, ".sound$1");
      await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-i", part, "-f", "lavfi", "-i", `anullsrc=r=${like.rate}:cl=${like.layout}`, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", like.codec, "-shortest", out], { timeoutMs: 10 * 60_000 });
      return out;
    }),
  );
}

/** Exports `project`'s marked stretches with `options` (the house's), each its own file or one of them joined, in the background. */
export function exportRanges(app: App, project: Project, options: ExportOptions, mode: Mode, watermark: string | null): Batch {
  const running = batches.get(project.id);
  if (running !== undefined && !running.finished) throw new Error("its marked stretches are already being exported");
  // What's left of them in the edit as it is now: one past an end shortened since it was marked was refused, and stopped the batch.
  const ranges = tidy(project.ranges ?? [], durationOf(project));
  if (ranges.length === 0) throw new Error("no stretches are marked: ask the agent to mark them (set_ranges)");
  if ((app.exports.runningFor?.(project.id) ?? null) !== null) throw new Error("an export of this edit is running: wait for it, or cancel it");
  const batch: Batch = { mode, total: ranges.length, done: 0, current: null, outputs: [], error: null, cancelled: false, finished: false, finished_ms: null };
  batches.set(project.id, batch);
  const dir = exportsDir(app.store.home);
  const parts = join(app.store.cacheDir(), "range-exports", safe(project.id));
  // The project's chunk manifest, put back after: each stretch's export writes its own, and the next export of the
  // edit then reused nothing of the last one (minutes of rendering again).
  const manifest = join(chunkFolder(app.store.cacheDir(), project.id), "manifest-v1.json");
  let manifestBefore: string | null = null;
  try {
    manifestBefore = fs.readFileSync(manifest, "utf8");
  } catch {
    // None yet.
  }
  const began = Date.now();
  void (async () => {
    const made: string[] = [];
    // Every part asked for (joined): its export lists it, and it comes off the list however the batch ends.
    const asked: string[] = [];
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (mode === "joined") fs.mkdirSync(parts, { recursive: true });
      for (const [index, range] of ranges.entries()) {
        if (batch.cancelled) return;
        batch.current = range.name;
        const output = mode === "each" ? join(dir, `${safe(project.name)} - ${safe(range.name)}.mp4`) : join(parts, `part-${String(index).padStart(3, "0")}.mp4`);
        // Its file as it was (the export writes `output` with its format's extension).
        const before = timeOf(native().withExtension(output, options.format));
        const path = await app.exports.start(app.store, app.library, project, { ...options, range: [range.start, range.end], chapters: [] }, output, {
          // On this computer only: no cloud copy, no Drive (a part of the edit, not the edit).
          keepLocal: true,
          stretch: true,
          ...(watermark === null ? {} : { watermark }),
        });
        asked.push(path);
        if (!(await finished(app, project.id, path, before))) {
          if (!batch.cancelled) batch.error = `${range.name} didn't export`;
          return;
        }
        made.push(path);
        batch.done = index + 1;
        if (mode === "each") batch.outputs.push(path);
      }
      if (mode === "joined") {
        if (batch.cancelled) return;
        batch.current = "joining them";
        const list = join(parts, "list.txt");
        fs.writeFileSync(list, (await withSound(made)).map((file) => `file '${file.replace(/'/gu, "'\\''")}'`).join("\n"));
        const name = `${safe(project.name)} - ${ranges.length} marked.mp4`;
        const output = join(dir, name);
        // Beside it until whole: the last run's file under this name is listed for Download, and a join that failed
        // or was stopped wrote over it.
        const partial = join(dir, `${name.slice(0, -".mp4".length)}.partial.mp4`);
        try {
          await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", partial], { timeoutMs: 30 * 60_000 });
          fs.renameSync(partial, output);
        } finally {
          fs.rmSync(partial, { force: true });
        }
        // Listed as the export it is (downloaded from the dialog, shown with the project's exports), its parts not
        // (below): the download hands out listed exports alone (Sphe, Nov 12: "I clicked download. I got file.json twice").
        listMade(app.store.home, project.id, {
          path: output,
          name,
          finished_ms: Date.now(),
          seconds: (Date.now() - began) / 1000,
          bytes: fs.statSync(output).size,
          frames: ranges.reduce((sum, range) => sum + range.end - range.start, 0),
          whole: false,
          start: ranges[0]!.start,
          format: options.format,
        });
        batch.outputs.push(output);
      }
      diag.info("export", `${project.name}: ${ranges.length} marked stretch${ranges.length === 1 ? "" : "es"} exported (${mode})`);
    } catch (error) {
      batch.error = diag.messageOf(error);
      diag.warn("export", `${project.name}: exporting its marked stretches: ${batch.error}`);
    } finally {
      batch.current = null;
      batch.finished = true;
      batch.finished_ms = Date.now();
      try {
        fs.mkdirSync(join(app.store.cacheDir(), "range-exports"), { recursive: true });
        fs.writeFileSync(keptAt(app, project.id), JSON.stringify(batch));
      } catch (error) {
        diag.warn("export", `${project.name}: its marked stretches' export wasn't kept: ${diag.messageOf(error)}`);
      }
      try {
        if (manifestBefore === null) fs.rmSync(manifest, { force: true });
        else writeAtomic(manifest, manifestBefore);
      } catch (error) {
        diag.warn("export", `${project.name}: putting its last export's chunk list back: ${diag.messageOf(error)}`);
      }
      if (mode === "joined") {
        unlist(app.store.home, project.id, asked);
        fs.rmSync(parts, { recursive: true, force: true });
      }
    }
  })();
  return batch;
}

/** Stops a batch: the stretch being exported, and the rest. */
export function cancel(app: App, id: string): boolean {
  const batch = batches.get(id);
  if (batch === undefined || batch.finished) return false;
  batch.cancelled = true;
  app.exports.cancel(id);
  return true;
}

export function routes(router: Router<App>): void {
  router
    .get("/api/projects/{id}/export-ranges", ({ app, params }) => json(latestBatch(app, params.id ?? "")))
    .post("/api/projects/{id}/export-ranges", async (context: RouteContext<App>) => {
      const { app, params } = context;
      const live = app.store.get(params.id ?? "");
      if (live === null) throw bad("no such project");
      const given = (await readJson(context)) as { mode?: unknown; options?: unknown; watermark?: unknown };
      const mode = given.mode === "joined" ? "joined" : given.mode === "each" ? "each" : null;
      if (mode === null) throw bad("mode is each or joined");
      const options: ExportOptions = { ...app.native.exportDefaults(), ...((given.options ?? {}) as Partial<ExportOptions>) };
      try {
        return json(exportRanges(app, live.project, options, mode, typeof given.watermark === "string" && given.watermark !== "" ? given.watermark : null));
      } catch (error) {
        throw bad(diag.messageOf(error));
      }
    })
    .delete("/api/projects/{id}/export-ranges", ({ app, params }) => json({ cancelled: cancel(app, params.id ?? "") }));
}
