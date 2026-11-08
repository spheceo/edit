// What an admin can ask a teammate's Edit to do besides updating
// (remote_support.ts), so that whatever goes wrong on their Mac can be found,
// fixed in code and shipped (update), and unblocked from here (the user,
// Oct 29: "if anything goes wrong … we're able to do things on our end, and
// they reflect on someone else's computer"; Oct 30: "so that they come back
// to something that works"):
//   - diagnostics: a report that leads with what needs attention (the disk,
//     the sign-in, setup, imports and syncs that stopped, turns gone quiet,
//     fixes waiting), then the machine, the work under way, every recurring
//     error grouped with its count and latest example, timings and the log;
//   - resume <project|script>: one stopped import picked up;
//   - unstick: everything that's stuck, unstuck at once (syncs waiting out a
//     failure tried again, stopped imports started again, agent turns quiet
//     for 15 minutes stopped, jobs given up after restarts started again, the cache cleaned when the disk is nearly full);
//   - restart: Edit started again in place, only when nothing's running;
//   - update-when-idle: the update installs itself once nobody has used the
//     window for 20 minutes and nothing's running (Sphe, Nov 1: "dont
//     restart the app while mathias is using it, wait for idle");
//   - ask-<question>: anything read-only an admin wants to know (remote_ask.ts);
//   - probe-<project or script>: a report of one import's whole error, its
//     source files' streams and a decode of their sound, so a damaged file
//     is seen from here without fetching it (Nov 1: Mom Secretly's 5.3 GB).
// None of these runs an agent turn, so nothing spends beyond what an import
// itself would.

import * as fs from "node:fs";
import * as os from "node:os";

import * as accounts from "./accounts.ts";
import type { App } from "./app.ts";
import { cleanCache, cleanCloudPreviews } from "./cache_cleanup.ts";
import { importing } from "./drive_import.ts";
import * as cloudProjects from "./cloud_projects.ts";
import * as diag from "./diag.ts";
import { memorySummary } from "./export_capacity.ts";
import { useNow as memoryUse } from "./memory.ts";
import * as ideaRuns from "./ideas/run.ts";
import * as jobs from "./jobs.ts";
import * as thumbnailRuns from "./thumbnails/run.ts";
import * as planUse from "./plan_use.ts";
import * as editTime from "./edit_time.ts";
import { join } from "./paths.ts";
import * as presence from "./presence.ts";
import * as problemReports from "./problem_reports.ts";
import * as relay from "./relay.ts";
import * as script from "./script.ts";
import * as seams from "./seams.ts";
import { restartSelf } from "./update.ts";
import { BUILD } from "./version.ts";
import * as writerCloud from "./writer/cloud.ts";
import * as writerImports from "./writer/imports.ts";
import * as writerJobs from "./writer/jobs.ts";
import * as writerStore from "./writer/store.ts";
import { THIS_MACHINE } from "./machine.ts";

/** The kinds this build carries out (Convex sends an older build only updates). */
export const KINDS = ["update", "diagnostics", "resume"] as const;
export type Kind = (typeof KINDS)[number];

/**
 * Actions that ride on a resume's target: the database knows update,
 * diagnostics and resume, and these words are never a project's (`p<ms>-<n>`)
 * or a script's (a UUID) id, so they needed no deploy of the database. A
 * build from before them answers "There's no project unstick" and changes
 * nothing.
 */
export const UNSTICK = "unstick";
export const RESTART = "restart";
export const IDLE_UPDATE = "update-when-idle";
export const PROBE = "probe-";

/** Idle: nobody has used the window this long (presence.ts), and nothing would be cut off (busyWith). */
export const IDLE_MS = 20 * 60_000;

/** An agent turn whose chat hasn't changed this long is stuck, not thinking. */
const QUIET_MS = 15 * 60_000;
/** Under this much free disk, Edit can't import or export. */
const LOW_DISK = 5e9;

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** The disk's free bytes where Edit keeps its data (tests stand in for it: the Mac running them may be short). */
export const disk = { free: (app: App): number | null => diskFree(app) };

function diskFree(app: App): number | null {
  try {
    const stat = fs.statfsSync(app.store.home);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

/** The projects whose agent turn is running, with how long each chat has been quiet. */
function turns(app: App): [project: string, quietMs: number][] {
  const running = (app.agents as { runningProjects?: () => string[] }).runningProjects?.() ?? [];
  return running.map((project) => {
    let quiet = 0;
    try {
      quiet = Date.now() - fs.statSync(join(app.store.home, "projects", `${project}.chat.json`)).mtimeMs;
    } catch {
      quiet = 0;
    }
    return [project, quiet];
  });
}

/** What needs someone's attention on this Mac, most likely to block work first. */
export async function attention(app: App, setup: { id: string; ok: boolean; title: string; fix: string }[], relayOk: boolean): Promise<string[]> {
  const out: string[] = [];
  const free = diskFree(app);
  if (free !== null && free < LOW_DISK) out.push(`The disk has ${gb(free)} free: imports and exports fail under a few GB (unstick cleans the cache).`);
  const account = accounts.status() as { person?: { email?: string } | null };
  if (!account.person) out.push("Nobody is signed in: the cloud, transcription and voices are off.");
  if (!relayOk) out.push(`Edit's relay (${relay.url()}) doesn't answer: transcription, voices and the cloud are off.`);
  for (const check of setup) if (!check.ok) out.push(`${check.title} isn't ready: ${check.fix}`);
  const cloud = cloudProjects.cloudOf(app);
  for (const summary of app.store.list()) {
    const job = app.scripts.get(summary.id);
    if (job?.state === "failed") out.push(`Project ${summary.id} "${summary.name}": its import stopped${job.error ? ` (${job.error})` : ""} (resume or unstick starts it again).`);
    const status = (cloud?.status(summary.id) ?? {}) as { sync?: string; message?: string | null };
    if (status.message && status.sync !== "synced") out.push(`Project ${summary.id} "${summary.name}": cloud ${status.sync ?? "?"}: ${status.message}`);
  }
  const data = writerStore.dataDir(app.store.home);
  for (const row of writerStore.list(data)) {
    const refused = writerCloud.refused(row.id);
    if (refused !== null) out.push(`Script ${row.id} "${row.title}": NOT IN THE CLOUD: ${refused}`);
    if (row.status === "error" && !writerImports.importing(row.id)) out.push(`Script ${row.id} "${row.title}": its import stopped${row.error ? ` (${row.error})` : ""}${row.retryHelps === false ? "; this build stops there again however often it's retried: it needs a fix in Edit, then an update" : ""}.`);
    if (row.status === "needs_choice") out.push(`Script ${row.id} "${row.title}": its import waits on their choice: ${row.decision?.summary ?? ""}`);
  }
  for (const [project, quiet] of turns(app)) if (quiet > QUIET_MS) out.push(`Project ${project}: its agent turn has said nothing for ${Math.round(quiet / 60_000)} min (unstick stops it).`);
  for (const job of jobs.givenUp(app.store.home)) out.push(`Job ${job.key}: not started again (${job.given_up}) (unstick starts it again).`);
  // An idea's or thumbnail's ending that never reached the cloud: its page still says Claude is working.
  for (const job of jobs.list(app.store.home)) if ((job.kind === "idea" || job.kind === "thumbnail") && job.state === "failed") out.push(`Job ${job.key}: ${job.error ?? "how it ended never reached the cloud"}.`);
  return out;
}

/** Every recurring warning and error of the last two days: grouped by what it says (numbers, ids and quotes aside), each with its count, latest time and latest example. */
/** "last used: 3 min ago (…)": when someone last used the window (presence.ts). */
export function lastUsed(at: number | null, now = Date.now()): string {
  return at === null ? "last used: not since Edit started (no key, click or scroll in its window)" : `last used: ${diag.human(Math.max(0, now - at))} ago (a key, click or scroll in its window)`;
}

/**
 * The warnings and errors of the last two days, each kind once with its count,
 * and how many came since Edit last started (`started`): a kind with none since
 * is history, listed after those still happening (Nov 1: two days of a warning
 * already fixed on the running build read as a live flood).
 */
export function problems(lines: string[], now = Date.now(), started = 0): string[] {
  const since = now - 48 * 3600_000;
  const groups = new Map<string, { count: number; recent: number; last: string; example: string }>();
  for (const line of lines) {
    const found = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\.\d+ (ERROR|WARN) \[([\w-]+)\] (.*)$/.exec(line);
    if (found === null || Date.parse(found[1]!.replace(" ", "T")) < since) continue;
    const shape = `${found[2]} [${found[3]}] ${found[4]!
      .replace(/"[^"]*"/g, '"…"')
      .replace(/\bp\d{10,}-\d+\b/g, "<project>")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<script>")
      .replace(/\b[0-9a-f]{12,}\b/gi, "<id>")
      .replace(/\d+(\.\d+)?/g, "#")
      .slice(0, 160)}`;
    const group = groups.get(shape) ?? { count: 0, recent: 0, last: "", example: "" };
    group.count++;
    if (Date.parse(found[1]!.replace(" ", "T")) >= started) group.recent++;
    group.last = found[1]!;
    group.example = `${found[2]} [${found[3]}] ${found[4]!.slice(0, 300)}`;
    groups.set(shape, group);
  }
  return [...groups.values()]
    .sort((a, b) => Number(b.recent > 0) - Number(a.recent > 0) || b.count - a.count || b.last.localeCompare(a.last))
    .slice(0, 40)
    .map((group) => `${String(group.count).padStart(5)}× (${group.recent > 0 ? `${group.recent} since Edit started` : "none since Edit started"}) last ${group.last} · ${group.example}`);
}

/** The work under way: exports, imports, agent turns, Claude on scripts, the scripts' cloud. */
export function work(app: App): string[] {
  const out: string[] = [];
  out.push(`exports running: ${app.exports.running() ? "yes" : "no"}`);
  for (const summary of app.store.list()) {
    const job = app.scripts.get(summary.id);
    if (job !== null && job.state !== "done") out.push(`import ${summary.id} "${summary.name}": ${job.state}${job.error ? ` (${job.error})` : ""}`);
  }
  for (const [project, quiet] of turns(app)) out.push(`agent turn on ${project}: last said something ${Math.round(quiet / 1000)} s ago`);
  for (const [id, title, job] of writerJobs.runningList()) out.push(`Claude on script ${id} "${title}": ${(job as { stage?: string }).stage ?? "working"}`);
  out.push(`scripts' cloud: ${JSON.stringify(writerCloud.statusNow())}`);
  for (const job of jobs.list(app.store.home)) {
    out.push(`background job: ${job.kind}${job.project ? ` on ${job.project}` : ""}: ${job.state}${job.step ? `, ${job.step}` : ""}${job.error ? ` (${job.error})` : ""}${job.given_up ? ` (given up: ${job.given_up})` : ""}`);
  }
  return out;
}

/** Each project here: its name, cloud state and import, one line each. */
function projectLines(app: App): string[] {
  const cloud = cloudProjects.cloudOf(app);
  return app.store.list().map((summary) => {
    const id = summary.id;
    const status = (cloud?.status(id) ?? { cloud: false }) as { cloud?: boolean; sync?: string; message?: string | null };
    const job = app.scripts.get(id);
    const where = status.cloud ? `cloud ${status.sync ?? "?"}${status.message ? ` (${status.message})` : ""}` : `only on ${THIS_MACHINE}`;
    const importing = job ? ` · import ${job.state}${job.error ? `: ${job.error}` : ""}` : "";
    return `${id} "${summary.name}" · ${where}${importing}`;
  });
}

/** Each script here: its title, cloud state, import and whether Claude is writing it, one line each. */
function scriptLines(app: App): string[] {
  const data = writerStore.dataDir(app.store.home);
  return writerStore.list(data).map((row) => {
    const refused = writerCloud.refused(row.id);
    const rev = writerCloud.revOf(data, row.id);
    const where = refused !== null ? `NOT IN THE CLOUD (${refused})` : rev === null ? `only on ${THIS_MACHINE}` : `cloud rev ${rev}`;
    const imported = row.status === "ready" ? "" : ` · import ${row.status}${row.error ? `: ${row.error}` : ""}`;
    const choice = row.decision ? ` · waits on a choice: ${row.decision.summary}` : "";
    const writing = writerJobs.running(row.id) ? " · Claude is writing" : "";
    return `${row.id} "${row.title}" · ${where}${imported}${choice}${writing}`;
  });
}

/** The log's last `count` lines: the file's (from before a restart too), else what's in memory. */
function logTail(app: App, count: number): string[] {
  try {
    const text = fs.readFileSync(join(app.store.home, "logs", "edit.log"), "utf8");
    return text.split("\n").filter((line) => line !== "").slice(-count);
  } catch {
    return diag.lines(count).map((line) => `${diag.stamp(line.at)} ${line.level.toUpperCase()} [${line.area}] ${line.message}`);
  }
}

/** Sends this Mac's report to the team's reports; where it went. */
export async function diagnostics(app: App): Promise<string> {
  const { key } = await problemReports.send(app.store.home, app.machine, diag.scrub(await report(app)));
  return key;
}

/** How often this Mac looks whether its latest report has changed, and the longest it goes without sending one. */
const LATEST_EVERY_MS = 5 * 60_000;
const LATEST_AT_LEAST_MS = 60 * 60_000;
const keeping = new WeakSet<App>();

/**
 * Keeps this Mac's latest report in the cloud while Edit runs
 * (problem_reports.publishLatest): sent when what needs attention changes
 * (looked at every five minutes), else once an hour, so an admin sees what
 * failed on a Mac that has since been closed.
 */
export function keepLatest(app: App): void {
  if (keeping.has(app)) return;
  keeping.add(app);
  let sent = "";
  let sentAt = 0;
  const look = async () => {
    try {
      const text = diag.scrub(await report(app, `Kept up to date by Edit itself (the latest from ${THIS_MACHINE}).`));
      const needs = text.slice(text.indexOf("Needs attention:"), text.indexOf("Machine:"));
      if (needs === sent && Date.now() - sentAt < LATEST_AT_LEAST_MS) return;
      await problemReports.publishLatest(app.store.home, app.machine, text);
      sent = needs;
      sentAt = Date.now();
    } catch (error) {
      diag.warn("reports", `keeping ${THIS_MACHINE}'s latest report: ${diag.messageOf(error)}`);
    }
  };
  setTimeout(() => void look(), 60_000).unref?.();
  setInterval(() => void look(), LATEST_EVERY_MS).unref?.();
}

/** This Mac's report: what needs attention, the machine, the work under way, the problems, projects, scripts, timings and log. */
export async function report(app: App, why = "Diagnostics asked for by an admin (edit remote diagnostics)."): Promise<string> {
  const log = logTail(app, 3000);
  const slow = diag.timings().slice(0, 30).map((timing) => JSON.stringify(timing));
  const setup = await fetch(`http://127.0.0.1:${app.port}/api/setup`, { signal: AbortSignal.timeout(15_000) })
    .then(async (answer) => ((await answer.json()) as { checks: { id: string; ok: boolean; title: string; fix: string }[] }).checks)
    .catch(() => [] as { id: string; ok: boolean; title: string; fix: string }[]);
  const began = Date.now();
  const relayOk = await fetch(`${relay.url()}/health`, { signal: AbortSignal.timeout(10_000) }).then((answer) => answer.ok, () => false);
  const relayMs = Date.now() - began;
  const account = accounts.status() as { person?: { email?: string } | null; admin?: boolean; perms?: string[] };
  const free = diskFree(app);
  const needs = await attention(app, setup, relayOk);
  const use = await memoryUse();
  let errors: string[] = [];
  try {
    errors = problems(fs.readFileSync(join(app.store.home, "logs", "edit.log"), "utf8").split("\n").slice(-200_000), Date.now(), Date.now() - diag.uptime());
  } catch {
    errors = [];
  }
  return [
    why,
    `Edit ${BUILD} · ${diag.osName()} ${diag.archName()} · up ${diag.human(diag.uptime())}`,
    lastUsed(presence.lastUsedAt()),
    "",
    "Needs attention:",
    ...(needs.length > 0 ? needs : ["nothing found"]),
    "",
    "Machine:",
    `disk: ${free === null ? "?" : gb(free)} free · memory: ${memorySummary()} · load ${os.loadavg()[0]!.toFixed(2)} on ${os.availableParallelism()} cores`,
    ...(use === null ? [] : [`memory use: ${use}`]),
    `signed in: ${account.person?.email ?? "nobody"}${account.admin ? " (admin)" : ""} · capabilities: ${(account.perms ?? []).join(", ") || "none"}`,
    `relay: ${relayOk ? `answers in ${relayMs} ms` : "doesn't answer"} (${relay.url()})`,
    ...setup.map((check) => `${check.ok ? "ok" : "NOT READY"}: ${check.title}`),
    "",
    "Work under way:",
    ...work(app),
    "",
    "Problems in the last two days (each kind once, with its count):",
    ...(errors.length > 0 ? errors : ["none"]),
    "",
    "Projects:",
    ...projectLines(app),
    "",
    "Scripts:",
    ...scriptLines(app),
    "",
    // How long each edit took the agent (JJ, Nov 3: "a tracker on how long each edit takes").
    "Agent time (the last week's edits, every turn added up):",
    ...(() => {
      const lines = editTime.reportLines(app);
      return lines.length > 0 ? lines : ["none"];
    })(),
    "",
    // What the person's Claude plan paid for (Nov 4: Max plans used up in hours), and whether it was Edit (Nov 5).
    "Claude plan (Anthropic's meter; Edit's calls and other Claude Code on this Mac, at API prices; `ask usage` for every stretch):",
    ...(await planUse.reportLines()),
    "",
    "Timings:",
    ...slow,
    "",
    "Log:",
    ...log,
  ].join("\n");
}

/**
 * Picks up `projectId`'s import: a project only on this Mac goes to the
 * cloud first (so the team can open it), then an unfinished import starts
 * again. What happened, in a line.
 */
export async function resume(app: App, projectId: string): Promise<string> {
  if (projectId === UNSTICK) return unstick(app);
  if (projectId === RESTART) return restart(app);
  if (projectId === IDLE_UPDATE) return updateWhenIdle(app);
  if (projectId.startsWith(PROBE)) return probe(app, projectId.slice(PROBE.length));
  // An admin's question (remote_ask.ts): answered and sent up, nothing changed.
  if (projectId.startsWith("ask-")) return (await import("./remote_ask.ts")).answer(app, projectId);
  const live = app.store.get(projectId);
  if (live === null && writerStore.idOk(projectId) && writerStore.ids(writerStore.dataDir(app.store.home)).includes(projectId)) return resumeScript(app, projectId);
  if (live === null) throw new Error(`There's no project or script ${projectId} on ${THIS_MACHINE}.`);
  const done: string[] = [];
  const cloud = cloudProjects.cloudOf(app);
  if (cloud?.on() && (cloud.status(projectId) as { cloud?: boolean }).cloud !== true) {
    await cloudProjects.moveToCloud(app, projectId, true);
    done.push("moved to the cloud");
  }
  if (script.unfinished(live.project)) {
    const running = app.scripts.get(projectId);
    if (running && ["downloading", "transcribing", "placing", "voicing"].includes(running.state)) done.push(`import already ${running.state}`);
    else if (script.start(app, projectId, false) !== null) done.push("import started again");
  } else {
    done.push("its import had finished (laid out): open it and Resume edit to finish the rest");
  }
  const status = (cloud?.status(projectId) ?? {}) as { sync?: string; message?: string | null };
  if (status.message) done.push(`cloud: ${status.message}`);
  diag.info("remote", `resume ${projectId}: ${done.join("; ")}`);
  return `"${live.project.name}": ${done.join("; ")}`;
}

/**
 * Picks up a script: one the cloud refused or never got is tried again at
 * once, and an import that stopped (failed, interrupted when Edit closed, or
 * ready without its words) starts again from what it kept.
 */
function resumeScript(app: App, id: string): string {
  const data = writerStore.dataDir(app.store.home);
  const found = writerStore.read(writerStore.scriptDir(data, id));
  const done: string[] = [];
  const refused = writerCloud.refused(id);
  if (refused !== null || writerCloud.revOf(data, id) === null) {
    writerCloud.tryAgain(id);
    done.push(refused !== null ? `its cloud save tried again (it said: ${refused})` : "sent to the cloud");
  }
  const stopped = found.status === "error" || (found.status === "ready" && found.words.length === 0 && !found.noSpeech);
  if (writerImports.importing(id)) done.push("its import is already running");
  else if (stopped) {
    void writerImports.resume(app, data, id, { kind: "retry" }).catch((error: unknown) => diag.warn("remote", `resume ${id}: ${diag.messageOf(error)}`));
    done.push("import started again");
  } else if (found.status === "needs_choice") done.push(`its import waits on a choice they make: ${found.decision?.summary ?? ""}`);
  else done.push("its import had finished");
  diag.info("remote", `resume ${id}: ${done.join("; ")}`);
  return `"${found.title}": ${done.join("; ")}`;
}

/** Everything stuck on this Mac, unstuck at once, as the module notes say: what it did. */
export async function unstick(app: App): Promise<string> {
  const done: string[] = [];
  const cloud = cloudProjects.cloudOf(app);
  const projects = cloud?.retryNow() ?? 0;
  if (projects > 0) done.push(`${projects} project sync${projects === 1 ? "" : "s"} waiting out a failure tried again`);
  const scripts = writerCloud.tryAllAgain();
  if (scripts > 0) done.push(`${scripts} script${scripts === 1 ? "" : "s"} the cloud refused tried again`);
  for (const summary of app.store.list()) {
    if (app.scripts.get(summary.id)?.state !== "failed") continue;
    const live = app.store.get(summary.id);
    if (live !== null && script.unfinished(live.project) && script.start(app, summary.id, false) !== null) done.push(`project "${summary.name}": import started again`);
  }
  const data = writerStore.dataDir(app.store.home);
  for (const row of writerStore.list(data)) {
    if (row.status !== "error" || writerImports.importing(row.id)) continue;
    // Stopped on a failure this build meets again (a 413): started again it would only stop there again, after its download (Nov 1).
    if (row.retryHelps === false) {
      done.push(`script "${row.title}": left stopped, as this build stops there again (${row.error ?? ""}); update ${THIS_MACHINE}, then resume it`);
      continue;
    }
    void writerImports.resume(app, data, row.id, { kind: "retry" }).catch((error: unknown) => diag.warn("remote", `unstick: script ${row.id}: ${diag.messageOf(error)}`));
    done.push(`script "${row.title}": import started again`);
  }
  for (const [project, quiet] of turns(app)) {
    if (quiet <= QUIET_MS) continue;
    await (app.agents as { stop?: (project: string) => Promise<void> }).stop?.(project);
    done.push(`project ${project}: its agent turn, quiet ${Math.round(quiet / 60_000)} min, stopped`);
  }
  const revived = jobs.startGivenUp(app.store.home);
  void revived.started.catch((error: unknown) => diag.warn("remote", `unstick: jobs: ${diag.messageOf(error)}`));
  for (const key of revived.keys) done.push(`job ${key}: started again`);
  const free = disk.free(app);
  if (free !== null && free < LOW_DISK) {
    const cleaned = (await cleanCloudPreviews(app, false)).bytes + cleanCache(app, false).bytes;
    done.push(`the disk had ${gb(free)} free: ${gb(cleaned)} of cache cleaned`);
  }
  const said = done.length > 0 ? done.join("; ") : "nothing was stuck";
  diag.info("remote", `unstick: ${said}`);
  return said;
}

/**
 * What a restart would cut off now: an export, a share (from jobs.json, so one
 * a restart cut short and that is about to carry on counts too), an import,
 * Claude on a script, an agent turn. One list for everything that restarts Edit from afar (a
 * restart, an update), so none of them cuts off what another waits for
 * (Nov 1: an update waited only for agent turns, and would have stopped an
 * export part-way).
 */
export function busyWith(app: App, agentTurns = true): string[] {
  let uploading = false;
  try {
    uploading = seams.drive.uploading();
  } catch (error) {
    if (!seams.isUnavailable(error)) throw error;
  }
  const shares = jobs.list(app.store.home ?? null, "share").filter(jobs.live).length;
  return [
    app.exports.running() ? "an export" : "",
    shares > 0 ? (shares === 1 ? "a share" : `${shares} shares`) : "",
    uploading ? "an upload to Drive" : "",
    (app.scripts as { running?: () => boolean } | undefined)?.running?.() || importing() ? "a footage import" : "",
    writerImports.anyImporting() ? "a script's import" : "",
    writerJobs.runningList().length > 0 ? "Claude on a script" : "",
    agentTurns && ((app.agents as { hasRunningTurns?: () => boolean }).hasRunningTurns?.() ?? turns(app).length > 0) ? "an agent turn" : "",
    agentTurns && thumbnailRuns.anyRunning() ? "Claude on a thumbnail" : "",
    agentTurns && ideaRuns.anyRunning() ? "Claude on an idea" : "",
  ].filter(Boolean);
}

/** Starts Edit again in place once the answer has gone back, unless something's running (it would be cut off). */
export function restart(app: App): string {
  const running = busyWith(app);
  if (running.length > 0) throw new Error(`Not restarted: ${running.join(", ")} would be cut off. Try again when it's done, or unstick first.`);
  diag.info("remote", "restarting, as an admin asked");
  setTimeout(() => restartSelf(), 3_000).unref?.();
  return "restarting in 3 s";
}

// ---------------------------------------------------------------------------
// Update when idle

const idleIntent = (app: App) => join(app.store.home, "update-when-idle.json");
const watchingIdle = new WeakSet<App>();

/** Whether this Mac is idle now: nobody used the window for IDLE_MS (or since Edit started, that long ago) and nothing's running. */
export function idleNow(app: App, now = Date.now(), started = now - process.uptime() * 1000): { idle: boolean; why: string } {
  const used = presence.lastUsedAt() ?? started;
  if (now - used < IDLE_MS) return { idle: false, why: `the window was used ${Math.round((now - used) / 60_000)} min ago` };
  const running = busyWith(app);
  if (running.length > 0) return { idle: false, why: `${running.join(", ")} running` };
  return { idle: true, why: "idle" };
}

/** Asked from afar: the update waits for idle, kept across restarts, looked at every minute. */
export function updateWhenIdle(app: App): string {
  fs.writeFileSync(idleIntent(app), JSON.stringify({ at: Date.now() }));
  watchIdle(app);
  const now = idleNow(app);
  diag.info("remote", `update when idle asked (${now.why})`);
  return `will update once idle (nobody using the window for ${IDLE_MS / 60_000} min and nothing running); now: ${now.why}`;
}

/** Looks every minute whether an update asked for "when idle" can go in; started at boot, so an intent survives restarts. */
export function watchIdle(app: App, install: () => Promise<unknown> = () => app.updater.install()): void {
  if (watchingIdle.has(app)) return;
  watchingIdle.add(app);
  const look = async () => {
    if (!fs.existsSync(idleIntent(app))) return;
    const status = (await app.updater.status().catch(() => null)) as { enabled?: boolean; latest?: string | null } | null;
    if (status?.enabled !== true || !status.latest || status.latest === BUILD) {
      fs.rmSync(idleIntent(app), { force: true });
      diag.info("remote", `update when idle: nothing newer than ${BUILD}; forgotten`);
      return;
    }
    const now = idleNow(app);
    if (!now.idle) return;
    fs.rmSync(idleIntent(app), { force: true });
    diag.info("remote", `update when idle: idle, installing ${status.latest}`);
    await install().catch((error: unknown) => {
      // Not this time (work began meanwhile): asked again at the next look.
      fs.writeFileSync(idleIntent(app), JSON.stringify({ at: Date.now() }));
      diag.warn("remote", `update when idle: ${diag.messageOf(error)}; trying again when idle`);
    });
  };
  // A look that throws is said, never left unhandled (a test's Mac with no updater threw into whatever ran a minute later).
  setInterval(() => void look().catch((error: unknown) => diag.warn("remote", `update when idle: ${diag.messageOf(error)}`)), 60_000).unref?.();
}

// ---------------------------------------------------------------------------
// Probe one import

/** One import's whole error, its source files' streams and a decode of their sound, sent as a report; the report's key. */
export async function probe(app: App, id: string, send: typeof problemReports.send = problemReports.send): Promise<string> {
  const lines: string[] = [`Probe of ${id}, asked for by an admin (edit remote probe), on ${app.machine}, Edit ${BUILD}.`, ""];
  const files: string[] = [];
  const data = writerStore.dataDir(app.store.home);
  if (writerStore.idOk(id) && writerStore.ids(data).includes(id)) {
    const dir = writerStore.scriptDir(data, id);
    const found = writerStore.read(dir);
    lines.push(`Script "${found.title}": ${found.status} at ${found.stage} (${found.progress}%), source ${found.sourceKind} ${found.sourceUrl.split("\n").join(" ")}`);
    lines.push(`Its error, whole: ${found.error ?? "none"}`, "");
    const walk = (folder: string) => {
      if (!fs.existsSync(folder)) return;
      for (const name of fs.readdirSync(folder)) {
        const path = join(folder, name);
        if (fs.statSync(path).isDirectory()) walk(path);
        else if (/\.(mp4|mov|m4v|mkv|m4a|mp3|wav|webm|ts)$/iu.test(name)) files.push(path);
      }
    };
    for (const sub of ["drive", "compilation", "pieces"]) walk(join(dir, sub));
    if (fs.existsSync(writerStore.proxyPath(dir))) files.push(writerStore.proxyPath(dir));
    if (found.originalPath && fs.existsSync(found.originalPath) && !files.includes(found.originalPath)) files.push(found.originalPath);
  } else {
    const live = app.store.get(id);
    if (live === null) throw new Error(`There's no project or script ${id} on ${THIS_MACHINE}.`);
    lines.push(`Project "${live.project.name}"`, "");
    for (const media of live.project.media) if (fs.existsSync(media.path)) files.push(media.path);
  }
  const ffmpeg = (await import("./tools.ts")).ffmpeg();
  const ffprobe = (await import("./tools.ts")).ffprobe();
  for (const file of files.slice(0, 20)) {
    const size = fs.statSync(file).size;
    lines.push(`== ${file} (${(size / 1e6).toFixed(1)} MB)`);
    const streams = await ran([ffprobe, "-v", "error", "-show_entries", "stream=index,codec_type,codec_name,profile,channels,sample_rate,duration,nb_frames:format=duration", "-of", "compact", file], 60_000);
    lines.push(streams.stdout.trim() || `ffprobe: ${streams.stderr.trim().slice(0, 400)}`);
    // The sound decoded through, as transcription reads it: how many errors, and the first of them.
    const decoded = await ran([ffmpeg, "-hide_banner", "-v", "error", "-nostdin", "-i", file, "-map", "0:a:0?", "-f", "null", "-"], 15 * 60_000);
    const errors = decoded.stderr.split("\n").filter((line) => line.trim() !== "");
    lines.push(`sound decoded: exit ${decoded.code}, ${errors.length} error lines${errors.length > 0 ? `; the first: ${errors.slice(0, 12).join(" | ")}` : ""}`, "");
  }
  if (files.length === 0) lines.push(`No footage of its own on ${THIS_MACHINE}.`);
  const { key } = await send(app.store.home, app.machine, diag.scrub(lines.join("\n")));
  diag.info("remote", `probe ${id}: sent ${key}`);
  return `Sent: ${key}`;
}

/** A program run without holding up the server, ended after `ms`. */
async function ran(cmd: string[], ms: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => child.kill(), ms);
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const code = await child.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}
