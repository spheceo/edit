// Exports made ahead, before anyone asks (Nov 6 plan, "exports ready before
// Export is pressed"): JJ's full exports took 15–33 minutes, 2.5–16.5 of them
// cutting the footage from the cloud and most of the rest the Mac's one video
// encoder, while re-exporting an edit whose chunks were made took 2 min 47 s
// (Cops Realize, Nov 6: 31 min 52 s the first time). So once a project's
// edits rest, its export is made here in the background with the settings its
// next share uses (reviews' `shareOptions`, the YouTube preset, its channel's
// watermark) into `<cache>/ahead/<id>.mp4`; its manifest then names that
// file, and the export or share someone asks for copies every chunk that
// didn't change out of it and renders only the rest.
//
// It takes the encoder only when nothing else wants it (exports.ts
// `startAhead`: no export rendering or waiting, room for it now) and gives it
// up to anything that asks: an export or share (of any project), or smooth
// playback for someone watching; what it made is kept and it carries on from
// there next time. Nothing lists it, nothing waits on it, and it never keeps
// the Mac awake. Not on battery, not while the project's slowed shots are
// still being smoothed (they'd change the picture), and not for an edit its
// last export already shows.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { aheadFile, type ExportRegistry, listExports, optionsKey, timelineHash, withWatermarkKey } from "./exports.ts";
import type { ExportOptions, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { duration } from "./project.ts";
import { read as reviewState } from "./reviews.ts";
import * as seams from "./seams.ts";
import { THE_MACHINE } from "./machine.ts";

/** How long a project's edits rest before its export is made ahead (tests make it quick). */
export const hooks = { restMs: 2 * 60_000, onBattery: (): boolean => onBattery() };

type Ahead = Pick<ExportRegistry, "startAhead" | "aheadFor" | "stopAhead">;

/** The settings `id`'s next share exports with, and its watermark (reviews.exportAndShare). */
export function nextShare(home: string, id: string): { options: ExportOptions; watermark: string | undefined } {
  const state = reviewState(home);
  const settings = state.shareOptions?.[id] ?? {};
  const options = { ...native().exportDefaults(), ...settings, preset: "youtube", range: null, chapters: [] } as ExportOptions;
  return { options, watermark: state.shareWatermark?.[id] };
}

/** Whether `project`'s export made ahead, or its last export, already shows it as `options` (with `watermark`) would. */
export function upToDate(home: string, cache: string, project: Project, options: ExportOptions, watermark: string | undefined): boolean {
  const timeline = timelineHash(project);
  const wanted = withWatermarkKey(optionsKey(options), watermark);
  try {
    const made = JSON.parse(fs.readFileSync(`${aheadFile(cache, project.id)}.json`, "utf8")) as { timeline?: string; options?: string };
    if (made.timeline === timeline && made.options === wanted && fs.existsSync(aheadFile(cache, project.id))) return true;
  } catch {
    // None made ahead.
  }
  // Exported as it is since its last change: nothing to make (its record doesn't keep its options, so any whole export of this picture counts).
  return listExports(home, project.id).some((one) => one.whole && one.timeline === timeline);
}

/** Whether this machine runs on its battery now (pmset; Linux's power supplies); false when it can't tell. */
function onBattery(): boolean {
  if (process.platform === "linux") {
    try {
      const supplies = fs.readdirSync("/sys/class/power_supply");
      const read = (name: string, what: string) => fs.readFileSync(`/sys/class/power_supply/${name}/${what}`, "utf8").trim();
      return supplies.some((name) => name.startsWith("BAT") && read(name, "status") === "Discharging");
    } catch {
      return false;
    }
  }
  if (process.platform !== "darwin") return false;
  const result = spawnSync("pmset", ["-g", "batt"], { encoding: "utf8", timeout: 2000 });
  return result.status === 0 && result.stdout.includes("'Battery Power'");
}

function agentsWorking(app: App): boolean {
  return (app.agents as { hasRunningTurns?: () => boolean }).hasRunningTurns?.() === true;
}

/** Makes `id`'s export ahead if it's worth it now; why not, when it isn't (for the log and tests). */
export function tryNow(app: App, id: string): string | null {
  const registry = app.exports as Partial<Ahead>;
  if (registry.startAhead === undefined) return "no exports here";
  const live = app.store.get(id);
  if (live === null) return "gone";
  const project = live.project;
  if (duration(project) <= 0 || !project.clips.some((clip) => clip.type === "video")) return "nothing to export";
  if (hooks.onBattery()) return "on battery";
  // Its footage downloads and encoding would slow every agent's frames (Nov 6: four review fixes, each look at the edit 1–3 minutes).
  if (agentsWorking(app)) return "an agent is working";
  let pending: string[] = [];
  try {
    pending = seams.broll.smoothingPending(id, project);
  } catch (error) {
    if (!seams.isUnavailable(error)) throw error;
  }
  if (pending.length > 0) return "slowed shots still smoothing";
  const { options, watermark } = nextShare(app.store.home, id);
  if (upToDate(app.store.home, app.store.cacheDir(), project, options, watermark)) return "up to date";
  let other: string | null;
  try {
    other = registry.aheadFor!();
  } catch (error) {
    if (seams.isUnavailable(error)) return "no exports here";
    throw error;
  }
  if (other !== null) return other === id ? "already making it" : "making another's";
  return registry.startAhead(app.store, app.library, project, options, aheadFile(app.store.cacheDir(), id), watermark) ? null : `${THE_MACHINE} is busy`;
}

/** Projects whose edits are resting, each with its timer. */
const resting = new Map<string, ReturnType<typeof setTimeout>>();

/** `id` changed (or its agent's turn ended): its export is made ahead once it rests, after an older one of it stops. */
function changed(app: App, id: string): void {
  const timer = resting.get(id);
  if (timer !== undefined) clearTimeout(timer);
  const registry = app.exports as Partial<Ahead>;
  // Being made of an older picture, or of any while an agent works: stopped (what it made is kept, and reused by the next).
  const making = registry.aheadFor?.() ?? null;
  if (making !== null && (making === id || agentsWorking(app))) void registry.stopAhead?.(making);
  const wait = (): void => {
    const later = setTimeout(() => {
      resting.delete(id);
      let why: string | null;
      try {
        why = tryNow(app, id);
      } catch (error) {
        diag.warn("export", `${id}: making its export ahead: ${diag.messageOf(error)}`);
        return;
      }
      if (why === null) diag.info("export", `${app.store.get(id)?.project.name ?? id}: making its export ahead, for the next export or share`);
      // Busy, smoothing or making another's: looked at again after another rest.
      else if (why === `${THE_MACHINE} is busy` || why === "slowed shots still smoothing" || why === "making another's" || why === "an agent is working") wait();
    }, hooks.restMs);
    later.unref?.();
    resting.set(id, later);
  };
  wait();
}

/** Watches this Mac's edits: an agent's turn, or a change made here (not one pulled from another Mac's cloud copy). Never on a trial server. */
export function start(app: App): void {
  if (process.env.EDIT_TRIALS === "1") return;
  app.store.subscribe((event) => {
    if (event.type === "project" && typeof event.id === "string" && event.origin !== "cloud") changed(app, event.id);
    else if (event.type === "agent" && event.event === "status" && event.running === false && typeof event.project === "string") changed(app, event.project.split("~")[0]!);
  });
}
