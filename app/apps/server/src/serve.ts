// Starting the server: the log, FFmpeg, the store and the
// addon, the data folder's lock, the hosts it answers to, the App with every
// package's services, the speaker watcher, cloud projects, Ctrl-C, and one
// listener per address `bindAddresses` gives.

import { TIMING } from "./sync_core.ts";
import * as writerLocks from "./writer/locks.ts";
import type { Server } from "bun";
import * as fs from "node:fs";

import * as accounts from "./accounts.ts";
import { keepAwakeWhile } from "./awake.ts";
import { importing } from "./drive_import.ts";
import { createApp, hostname, type App } from "./app.ts";
import { pauseForExports, setListening, smoothsFast } from "./broll.ts";
import { makeRoom, startCleaning } from "./cache_cleanup.ts";
import * as cloud from "./cloud.ts";
import { setSmoothByDefault } from "./cutin.ts";
import * as diag from "./diag.ts";
import * as modelChoice from "./model_choice.ts";
import * as lastRun from "./last_run.ts";
import { agentHooks } from "./agent.ts";
import { registerEditingTools, unfinishedNote } from "./edit_tools.ts";
import { archiveGoing, ExportRegistry, room as exportRoom, resumeSnapshot, type ExportRecord, type StartExtra } from "./exports.ts";
import * as encoder from "./encoder.ts";
import * as jobs from "./jobs.ts";
import type { ExportOptions } from "./model.ts";
import { listen } from "./http/server.ts";
import { registerMediaTools } from "./media_tools.ts";
import { allowedHosts } from "./http/host.ts";
import { initNative, native } from "./native/index.ts";
import { join } from "./paths.ts";
import * as archive from "./archive.ts";
import * as firstPrompt from "./first_prompt.ts";
import * as researchCloud from "./research_cloud.ts";
import * as playbackRender from "./playback_render.ts";
import * as exportAhead from "./export_ahead.ts";
import * as remoteAsk from "./remote_ask.ts";
import * as reviews from "./reviews.ts";
import * as retryAfterUpdate from "./retry_after_update.ts";
import { buildRouter } from "./routes.ts";
import * as seams from "./seams.ts";
import { Store } from "./store.ts";
import * as tools from "./tools.ts";
import * as update from "./update.ts";
import * as exactAfter from "./writer/exact_after.ts";
import * as writer from "./writer/index.ts";
import * as writerImports from "./writer/imports.ts";
import * as writerStore from "./writer/store.ts";
import * as ideas from "./ideas/index.ts";
import * as thumbnails from "./thumbnails/index.ts";
import { BUILD, NIGHTLY, RELEASE } from "./version.ts";

/** A place to listen: an IP and port, as Rust's SocketAddr shows it ("127.0.0.1:7700", "[::1]:7700"). */
export interface Address {
  ip: string;
  port: number;
  v6: boolean;
}

export function showAddress(address: Address): string {
  return address.v6 ? `[${address.ip}]:${address.port}` : `${address.ip}:${address.port}`;
}

/** `text` as Rust parses a SocketAddr: `a.b.c.d:port` or `[v6]:port`; null otherwise (a host name, say). */
export function parseSocketAddr(text: string): Address | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(text);
  if (v4 !== null) {
    const parts = v4.slice(1, 5).map(Number);
    const port = Number(v4[5]);
    if (parts.some((part, index) => part > 255 || (v4[index + 1]!.length > 1 && v4[index + 1]!.startsWith("0")))) {
      return null;
    }
    if (port > 65535) return null;
    return { ip: parts.join("."), port, v6: false };
  }
  const v6 = /^\[([0-9A-Fa-f:.]+)\]:(\d{1,5})$/.exec(text);
  if (v6 !== null && v6[1]!.includes(":") && Number(v6[2]) <= 65535) {
    return { ip: v6[1]!, port: Number(v6[2]), v6: true };
  }
  return null;
}

/**
 * Where to listen: the address asked for, else 127.0.0.1 alone. Never this
 * machine's Tailscale IP by itself (Nov 4, the security audit): the API has no
 * sign-in of its own, so a listener there let any device on the tailnet run
 * the agent (a shell on this Mac) and use this person's account. Another
 * device reaches Edit through `tailscale serve --bg http://127.0.0.1:7700`,
 * which the owner turns on and Tailscale's own access rules guard.
 */
export function bindAddresses(host: string | null, port: number): Address[] {
  if (host !== null) {
    const parsed = parseSocketAddr(`${host}:${port}`);
    return parsed === null ? [] : [parsed];
  }
  return [{ ip: "127.0.0.1", port, v6: false }];
}

const TAILSCALE = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

function run(binary: string, args: string[]): string | null {
  try {
    const output = Bun.spawnSync([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000 });
    return output.stdout.toString();
  } catch {
    return null;
  }
}

/** This machine's Tailscale IPv4 address, if Tailscale runs. */
export function tailscaleIp(): string | null {
  for (const binary of TAILSCALE) {
    const first = run(binary, ["ip", "-4"])?.split("\n")[0]?.trim();
    if (first !== undefined && parseSocketAddr(`${first}:0`) !== null) return first;
  }
  return null;
}

/** This machine's Tailscale DNS name (lowercase, no trailing dot), if Tailscale runs. */
export function tailscaleName(): string | null {
  for (const binary of TAILSCALE) {
    const out = run(binary, ["status", "--json"]);
    if (out === null) continue;
    try {
      const status = JSON.parse(out) as { Self?: { DNSName?: unknown } };
      const name = status.Self?.DNSName;
      if (typeof name !== "string") continue;
      const trimmed = name.replace(/\.+$/, "").toLowerCase();
      if (trimmed !== "") return trimmed;
    } catch {
      continue;
    }
  }
  return null;
}

/** "edit: <why>" on stderr, exit 2. */
export function fail(message: string): never {
  console.error(`edit: ${message}`);
  process.exit(2);
}

/** Opens the store and starts listening. */
/**
 * Ends the work a restart left running under this process: a reload (bun
 * --watch) and an update's exec keep the process id, so the agent's
 * `claude` and FFmpeg the last run started are still its
 * children, working for nobody (and, run as the server exits, what it leaves). Their turns and jobs are resumed afresh, so
 * the old ones went on in parallel (Oct 30: a review fix's agent ran twice
 * on one project, both editing it). Nothing of this run has started yet.
 */
export function endLeftovers(pid = process.pid): string[] {
  const listed = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore" });
  const ended: string[] = [];
  for (const line of new TextDecoder().decode(listed.stdout).split("\n")) {
    const found = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (found === null || Number(found[2]) !== pid) continue;
    const program = /(?:^|\/)(claude|ffmpeg|edit-ffmpeg|ffprobe|edit-ffprobe)(?:\s|$)/.exec(found[3]!)?.[1] ?? null;
    if (program === null) continue;
    try {
      process.kill(Number(found[1]), "SIGTERM");
      ended.push(program);
    } catch {
      // Gone already.
    }
  }
  return ended;
}

/** The data folder's lock for the life of this process, so a second Edit on the same folder is noticed. */
function holdDataLock(home: string): void {
  try {
    if (!native().holdLock(join(home, "server.lock"))) diag.warn("edit", `another Edit is using ${home}`);
  } catch {
    // No addon: nothing to lock with.
  }
}

export function start(home: string, host: string | null, port: number): { app: App; servers: Server<unknown>[] } {
  diag.open(home);
  lastRun.begin(home);
  const ended = endLeftovers();
  if (ended.length > 0) diag.info("edit", `ended ${ended.length} process(es) the last run left (${[...new Set(ended)].join(", ")}): their work starts again`);
  // And on the way out: a quit, Edit.app closed or a server stopped leaves its FFmpeg and `claude` running for
  // nobody, with a new process id the next start can't tell apart (the 10-hour trial, Nov 4: a sound copy and a
  // thumbnail pass went on reading 58 GB beside the restarted server's own). Their jobs start again with the next run.
  process.on("exit", () => {
    endLeftovers();
  });
  for (const [tool, path] of [
    ["ffmpeg", tools.ffmpeg()],
    ["ffprobe", tools.ffprobe()],
  ] as const) {
    let found = false;
    try {
      Bun.spawnSync([path, "-version"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      found = true;
    } catch {
      found = false;
    }
    if (!found) diag.warn("edit", `${tool} not found; importing and export need FFmpeg`);
  }
  diag.info("edit", `FFmpeg: ${tools.ffmpeg()} (${tools.bundled() ? "shipped with Edit" : "from PATH"})`);
  let store: Store;
  try {
    store = Store.open(home);
  } catch (error) {
    fail(`${home}: ${diag.messageOf(error)}`);
  }
  initNative({
    home: store.home,
    cacheDir: store.cacheDir(),
    ffmpeg: tools.ffmpeg(),
    ffprobe: tools.ffprobe(),
  });
  holdDataLock(store.home);
  cloud.keepUploadJournalsIn(join(store.home, "uploads"));
  modelChoice.use(store.home);
  const ip = tailscaleIp();
  const app = createApp({
    store,
    port,
    allowedHosts: allowedHosts({ host, tailscale: [ip, tailscaleName()] }),
    machine: hostname() ?? "this machine",
    services: { exports: new ExportRegistry(home), updater: new update.Updater(home) },
  });
  seams.cloudMedia.configurePlayback(app);
  // Smoothing waits while an export runs (previews and proxies do in the addon).
  pauseForExports(() => app.exports.localRunning?.() ?? app.exports.running());
  // Slowed cut-in shots are smoothed unless asked not to, where it takes seconds.
  setSmoothByDefault(app.native.smoothSupported());
  // On Linux, RIFE on the GPU (rife.ts), looked for just after start (it runs a two-frame check).
  if (process.platform === "linux") setTimeout(() => setSmoothByDefault(smoothsFast(app)), 2_000).unref();
  // The cache kept to what's used.
  startCleaning(app);
  exportRoom.make = (wanted) => void makeRoom(app, wanted);
  seams.broll.stopLeftoverMaps?.();
  // Tools register here; the subtitles' and captions' register as their modules load (through seams).
  registerEditingTools();
  registerMediaTools();
  // A whole edit that ends with fixable flags gets one follow-up from Edit.
  agentHooks.unfinished = (project) => unfinishedNote(app, project);
  seams.speakers.watch(app);
  // Cloud projects (on with the built-in token): sync, locks, and letting them go on the way out.
  // Signed in before: the access token renewed quietly, before the cloud's first call.
  // The sign-in restored before anything resumes (below): a smoothing resumed
  // at once read its footage before it, got "Sign in to Edit", and kept its
  // shot unsmoothed (the full run-through, Oct 28).
  let signedIn: Promise<unknown> = Promise.resolve();
  optional("accounts", () => {
    signedIn = accounts.start(app);
  });
  optional("cloud", () => seams.cloudProjects.start(app));
  // A trial server (EDIT_TRIALS=1, the teaching loop's: app/scripts/trial-server.sh) signs in and syncs
  // cloud projects but takes no team work: this Mac's id is the one Ready for changes is asked of, and two servers on
  // it would both fix the same review notes and Writer jobs (Oct 31, the user: a server for training
  // agents and trials that other sessions' saves never restart).
  const trials = process.env.EDIT_TRIALS === "1";
  if (trials) diag.info("edit", "a trial server: no review fixes, Writer folder or archives, idea runs or remote support here");
  // Repack reviews of exports: their notes followed, and fixed by the agent once they settle.
  if (!trials) optional("review", () => reviews.start(app));
  // What failed on the build before, tried again once on this one, when the Mac is idle.
  if (!trials) optional("retry after update", () => retryAfterUpdate.start(app));
  // Smooth playback: the open edit rendered small in the background, out of the way of exports.
  optional("playback", () => playbackRender.start(app));
  // Exports made ahead: once a project's edits rest, its next share's export is made in the background, so the share reuses it.
  if (!trials) optional("export ahead", () => exportAhead.start(app));
  // Projects archived on Repack: their big files freed here, and restores asked for done.
  if (!trials) optional("archive", () => archive.start(app));
  // Script mode: Writer's scripts on this Mac brought in once, and its background work.
  optional("writer", () => writer.start(app, { trials }));
  // Ideas: runs this Mac had going when it stopped, marked stopped in the cloud.
  if (!trials) optional("ideas", () => ideas.start(app));
  if (!trials) optional("thumbnails", () => thumbnails.start(app));
  // A new project's first message, sent to its agent once its import is done.
  // Kept on a trial server too: its prompts are its own projects' (first-prompts.json in its home).
  optional("first prompt", () => firstPrompt.start(app));
  // Research goes to the cloud, so the project opened on another Mac has it.
  optional("research cloud", () => researchCloud.start(app));
  let quitting = false;
  const quit = (code: number) => {
    // A second signal, or a cloud push that never answers, doesn't hold Edit open: Edit.app's window
    // kills what's left after 6 s (crates/edit-window), and macOS 27 shows Edit "running in background" meanwhile.
    if (quitting) process.exit(code);
    quitting = true;
    lastRun.quitting();
    // TIMING.QUIT_BUDGET: one cloud call fits (sync_core.ts); a push left over is sent by the next start.
    setTimeout(() => process.exit(code), TIMING.QUIT_BUDGET).unref();
    // The agents first: a turn left running goes on editing (and spending) with no Edit to answer it.
    try {
      app.agents.shutdown?.();
    } catch (error) {
      diag.warn("agent", `on the way out: ${diag.messageOf(error)}`);
    }
    void (async () => {
      try {
        // Edits' and scripts' locks let go together, inside the quit budget.
        await Promise.all([seams.cloudProjects.shutdown(), writerLocks.releaseAll()]);
      } catch (error) {
        if (!seams.isUnavailable(error)) diag.warn("cloud", `on the way out: ${diag.messageOf(error)}`);
      }
      process.exit(code);
    })();
  };
  process.on("SIGINT", () => quit(130));
  process.on("SIGTERM", () => quit(143));
  // A promise nobody waited on that failed: said in the log, where it used to go unseen (the audit, Oct 23).
  process.on("unhandledRejection", (reason) => diag.error("server", `unhandled failure: ${diag.messageOf(reason)}${reason instanceof Error && reason.stack ? `\n${reason.stack}` : ""}`));
  // A throw nobody caught (a timer's, a stream's): said in the log, and Edit carries on, as for a
  // promise. It stopped the server, and Edit.app's window keeps no stderr, so nothing said why.
  process.on("uncaughtException", (error) => diag.error("server", `uncaught failure: ${diag.messageOf(error)}${error.stack ? `\n${error.stack}` : ""}`));
  const router = buildRouter();
  remoteAsk.useRouter(router);
  const servers: Server<unknown>[] = [];
  for (const address of bindAddresses(host, port)) {
    const shown = showAddress(address);
    try {
      servers.push(listen(app, router, address.ip, address.port) as Server<unknown>);
      console.log(`edit: http://${shown}`);
      // The first address is where map pages reach this server .
      if (servers.length === 1) setListening(address.ip, address.port);
    } catch (error) {
      console.error(`edit: could not bind ${shown}: ${diag.messageOf(error)}`);
    }
  }
  if (servers.length === 0) fail(`nothing to listen on (is port ${port} taken?)`);
  console.log(`edit: data in ${home}`);
  // First start of each installed nightly only (also works when an older
  // updater installed this build). Ordinary launches do no maintenance.
  if (RELEASE && NIGHTLY !== null && !process.env.CI && process.env.EDIT_CLAUDE_MAINTENANCE !== "0") seams.agentPanel(app).claudeSupport?.afterNightly(BUILD);
  keepAwakeWhile(() => {
    if (app.exports.running()) return "an export";
    if (app.exports.archiving?.()) return "an export going up to the cloud";
    if (app.scripts.running() || importing()) return "a footage import";
    try {
      if (seams.drive.uploading()) return "a Drive upload";
    } catch (error) {
      if (!seams.isUnavailable(error)) throw error;
    }
    if ((app.agents as { hasRunningTurns?: () => boolean }).hasRunningTurns?.()) return "the agent";
    return null;
  });
  // Once listening (the agents reach Edit's MCP on this port) and signed in
  // again (or 20 s on, signed out): the jobs and agent turns a restart cut short.
  // An export holds the hardware encoder (encoder.ts): an import's encode beside it isn't called stuck, and one that waits for it is woken when it ends.
  encoder.register(() => (app.exports.running() ? "an export" : null));
  void Promise.race([signedIn.catch(() => undefined), Bun.sleep(20_000)]).then(() => resumeJobs(app));
  if (update.enabled()) {
    void update
      .check(update.readChannel(home))
      .then((release) => {
        if (release !== null) {
          console.log(
            `edit: ${release.tag} is out (this is ${update.BUILD}); update from the editor or run \`edit update\``,
          );
        }
      })
      .catch(() => {});
  }
  return { app, servers };
}

/** Runs a package's start-up step, whose service may not be available (then it's skipped, quietly). */
function optional(area: string, work: () => void): void {
  try {
    work();
  } catch (error) {
    if (!seams.isUnavailable(error)) diag.warn(area, diag.messageOf(error));
  }
}

/**
 * Starts again everything a restart cut short (jobs.ts), from the one table:
 * exports, archives, shares, fixes, agent turns, Ideas and Thumbnails runs,
 * uploads, smoothing, watches and map renders.
 */
function resumeJobs(app: App): void {
  const project = (id: string) => {
    const live = app.store.get(id);
    if (live === null) throw new jobs.Gone("the project is gone");
    return live.project;
  };
  void jobs.resume(app.store.home, {
    case: (job) => {
      project(job.project);
      // Carried on from what the job kept (script.carryOn: the same way Retry, a remote resume and unstick do). Nothing left to do: crossed off.
      const did = seams.script.carryOn(app, job.project);
      if (did === "finished" || did === "nothing") throw new jobs.Gone("its import has nothing left to do");
    },
    export: async (job) => {
      const { options, output, drive, keepLocal, share, note, watermark, replace } = job.args as unknown as { options: ExportOptions; output: string } & StartExtra;
      // The timeline it was started with, not edits made since.
      const current = project(job.project);
      const asked = resumeSnapshot(app.store.home, job.project, job.args) ?? current;
      // A share's export is its share's: the share job carries it on (and starts it again under this key).
      if (share === true) {
        const owner = jobs.get(app.store.home, jobs.keyOf("share", job.project));
        if (owner !== undefined && jobs.live(owner)) throw new jobs.Gone("its share carries it on");
        // From a build before shares were jobs: listed as a share now, at its export.
        void reviews
          .resumeShare(app, job.project, asked, options, { ...(replace === true ? { replace } : {}), ...(note === undefined ? {} : { note }), ...(watermark === undefined ? {} : { watermark }) })
          .catch((error: unknown) => diag.warn("review", `sharing ${job.project} after the restart (key ${job.key}): ${diag.messageOf(error)}`));
        return;
      }
      await app.exports.start(app.store, app.library, asked, options, output, { drive, ...(keepLocal === true ? { keepLocal } : {}), ...(note === undefined ? {} : { note }), ...(watermark === undefined ? {} : { watermark }) });
    },
    archive: async (job) => {
      // The export finished before the restart: only its upload is done again.
      const { output, key, record } = job.args as { output: string; key: string; record: ExportRecord };
      await (app.exports.sendUp?.(app.store.home, job.project, output, key, record) ?? archiveGoing(app.store.home, job.project, output, key, record));
    },
    drive: (job) => {
      const { path } = job.args as { path: string };
      if (!fs.existsSync(path)) throw new jobs.Gone(`${path} is gone`);
      seams.drive.start(app.store, app.library, project(job.project), path);
    },
    smooth: (job) => {
      const { clip } = job.args as { clip: string };
      if (!project(job.project).clips.some((one) => one.id === clip)) throw new jobs.Gone("the clip is gone");
      seams.broll.smoothInBackground(app, job.project, [clip]);
    },
    watch: (job) => {
      project(job.project);
      seams.watch.watchInBackground(app, job.project);
    },
    upload: (job) => {
      seams.cloudMedia.resumeUpload(app.store.home, job.args);
    },
    full: (job) => {
      // A review version's full-quality file for its Download button: the rest of its parts.
      const { name, path, key, version } = job.args as { name: string; path: string; key: string; version?: number };
      if (!fs.existsSync(path)) throw new jobs.Gone(`${path} is gone`);
      void reviews.fullBehind(app.store.home, job.project, name, path, key, version);
    },
    share: (job) => reviews.resumeShareJob(app, job),
    fix: (job) => reviews.resumeFix(app, job),
    turn: (job) => {
      if (app.agents.resumeTurn === undefined) throw new jobs.Gone("no agent panel here");
      app.agents.resumeTurn(job);
    },
    // A Writer script's import, or its chosen footage's exact hearing (writer/exact_after.ts), that waited on the transcription plan's credit: tried again (it waits again if there's still none).
    script: async (job) => {
      const data = writerStore.dataDir(app.store.home);
      if (!writerStore.ids(data).includes(job.project)) throw new jobs.Gone("the script is gone");
      if (job.args.waiting_on === "exact") {
        jobs.end(app.store.home, job.key);
        exactAfter.soon(data, job.project);
        return;
      }
      if (writerImports.importing(job.project)) return;
      jobs.end(app.store.home, job.key);
      void writerImports.resume(app, data, job.project, { kind: "retry" }).catch((error: unknown) => diag.warn("writer", `trying ${job.project}'s import again: ${diag.messageOf(error)}`));
    },
    idea: (job) => ideas.resumeRun(app, job),
    thumbnail: (job) => thumbnails.resumeRun(app, job),
    // Smooth playback renders are made again when wanted; listed only so a restart or an update waits for them.
    playback: () => {
      throw new jobs.Gone("made again when it's wanted");
    },
    map: (job) => {
      const { first } = job.args as { first: string };
      if (!seams.broll.resumeMap?.(app, job.project, first)) throw new jobs.Gone("its stand-in or job file is gone");
    },
  });
}
