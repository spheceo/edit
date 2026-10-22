// Self-update from the repo's GitHub Releases (built by the release
// workflow): releases (`v0.0.1`) and nightlies (`nightly-12`, pre-releases).
// The channel (`<home>/update.json`, Settings → Updates) picks which: Nightly
// offers whichever of the two came out last, Stable releases only.
// `GET /api/update` says whether a newer build is out;
// `POST /api/update` downloads it, checks its SHA-256, swaps it in for the
// running binary and restarts in place. On Unix that's an exec
// (`native.reexec`), so `edit serve` keeps its terminal, PID and flags, and the
// open editor reloads once the new version answers.
//
// Only release builds update themselves (the workflow builds with
// `--define EDIT_RELEASE=true`); a dev build would otherwise swap out bun.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { ioMessage } from "./files.ts";
import { catchBugsAsync } from "./guard.ts";
import { native } from "./native/index.ts";
import { join, parent } from "./paths.ts";
import type { Updater as UpdaterSeam } from "./seams.ts";
import { BUILD, NIGHTLY, RELEASE, VERSION } from "./version.ts";

export { BUILD, VERSION } from "./version.ts";

const REPO = "spheceo/edit";

/**
 * A new release shows up within this long of the editor asking. Each look
 * reads the releases' Atom feed, which GitHub's API limit (60 anonymous asks
 * an hour, every one counted) doesn't cover; the API is asked only when the
 * feed's tags change.
 */
const CHECK_EVERY_MS = 60 * 1000;
const FEED = `https://github.com/${REPO}/releases.atom`;

/** Whether this build installs updates itself. */
export function enabled(): boolean {
  return process.platform !== "win32" && RELEASE;
}

/** The release archive for this machine, as the release workflow names it. */
export function assetTarget(): string {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin") return "x86_64-apple-darwin";
  if (process.platform === "linux" && process.arch === "arm64") return "aarch64-unknown-linux-gnu";
  return "x86_64-unknown-linux-gnu";
}

/** Which builds are offered: every nightly as it's out, or releases only. */
export type Channel = "nightly" | "stable";

/** The channel set in `<home>/update.json`: nightly unless set to stable. */
export function readChannel(home: string): Channel {
  try {
    const value = JSON.parse(fs.readFileSync(join(home, "update.json"), "utf8")) as { channel?: unknown };
    return value?.channel === "stable" ? "stable" : "nightly";
  } catch {
    return "nightly";
  }
}

function writeChannel(home: string, channel: Channel): void {
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(join(home, "update.json"), `${JSON.stringify({ channel })}\n`);
  } catch (error) {
    throw new Error(`${join(home, "update.json")}: ${ioMessage(error)}`);
  }
}

/** The newest release with a build for this machine. */
export interface Release {
  tag: string;
  url: string;
  size: number;
  sha256: string;
}

export type Phase = "idle" | "downloading" | "restarting";

export interface Status {
  /** This build: "nightly-12", or "v0.0.0". */
  current: string;
  /** A newer build's tag ("v0.2.0", "nightly-13"), if there is one. */
  latest: string | null;
  channel: Channel;
  phase: Phase;
  /** 0–1 while downloading. */
  progress: number;
  error: string | null;
  /** False for builds that don't update themselves (dev builds). */
  enabled: boolean;
}

/** What runs just before the restart (app mode closes its window: the new `edit app` opens a fresh one). */
const beforeRestart: (() => void)[] = [];

export function onRestart(hook: () => void): void {
  beforeRestart.push(hook);
}

export class Updater implements UpdaterSeam {
  private latest: Release | null = null;
  private checked: number | null = null;
  private checking = false;
  private phase: Phase = "idle";
  private progress = 0;
  private error: string | null = null;
  private channel: Channel;

  /** Downloads are staged in `<home>/updates`. */
  constructor(private home: string) {
    this.channel = readChannel(home);
  }

  /** Switches channel and asks GitHub again. */
  async setChannel(channel: string): Promise<Status> {
    if (channel !== "nightly" && channel !== "stable") throw new Error(`no such channel: ${channel} (nightly or stable)`);
    writeChannel(this.home, channel);
    if (channel !== this.channel) {
      this.channel = channel;
      this.latest = null;
      this.checked = null;
    }
    return this.status();
  }

  /** The current state, asking GitHub first if it's been a while. */
  async status(): Promise<Status> {
    const due =
      enabled() &&
      !this.checking &&
      this.phase === "idle" &&
      (this.checked === null || performance.now() - this.checked >= CHECK_EVERY_MS);
    if (due) {
      this.checking = true;
      // Offline or a GitHub hiccup just means no update to offer; retry next time.
      let found: Release | null | undefined;
      try {
        found = await check(this.channel);
      } catch {
        found = undefined;
      }
      this.checking = false;
      if (found !== undefined) {
        this.latest = found;
        this.checked = performance.now();
      }
    }
    return this.snapshot();
  }

  private snapshot(): Status {
    return {
      current: BUILD,
      latest: this.latest?.tag ?? null,
      channel: this.channel,
      phase: this.phase,
      progress: this.progress,
      error: this.error,
      enabled: enabled(),
    };
  }

  /** Starts installing the newest release; the server restarts into it when done. */
  async install(): Promise<Status> {
    return this.start();
  }

  start(): Status {
    if (!enabled()) throw new Error("this build doesn't update itself; pull and rebuild");
    if (this.phase !== "idle") return this.snapshot();
    const release = this.latest;
    if (release === null) throw new Error("Edit is up to date");
    this.phase = "downloading";
    this.progress = 0;
    this.error = null;
    void (async () => {
      try {
        const exe = await catchBugsAsync("the update", () =>
          install(release, join(this.home, "updates"), (progress) => {
            this.progress = progress;
          }),
        );
        this.phase = "restarting";
        console.log(`edit: updated to ${release.tag}; restarting`);
        // Let the request that started this (and a status poll) answer first.
        await Bun.sleep(500);
        restart(exe);
      } catch (error) {
        const said = diag.messageOf(error);
        diag.error("update", `update to ${release.tag} failed: ${said}`);
        this.phase = "idle";
        this.progress = 0;
        this.error = said;
      }
    })();
    return this.snapshot();
  }
}

/**
 * Asks GitHub for the newest build on `channel`; null when this one is current
 * (or the newest has no build for this machine).
 */
export async function check(channel: Channel, api = `https://api.github.com/repos/${REPO}/releases`, feed: string | null = FEED): Promise<Release | null> {
  // The feed's tags as they were at the last answer: unchanged, so is the answer.
  const tags = feed === null ? null : await feedTags(feed).catch(() => null);
  const last = lastAnswer.get(`${channel} ${api}`);
  if (tags !== null && last !== undefined && last.tags === tags && Date.now() - last.at < ASK_ANYWAY_MS) return last.release;
  const release = await ask(channel, api);
  if (tags !== null) lastAnswer.set(`${channel} ${api}`, { tags, release, at: Date.now() });
  return release;
}

/** The last answer from the API for each channel, the feed's tags then, and when. */
const lastAnswer = new Map<string, { tags: string; release: Release | null; at: number }>();
/** The API is asked again after this long even with the feed unchanged (a release whose builds were still uploading). */
const ASK_ANYWAY_MS = 30 * 60_000;

/** Every tag in the releases' feed, sorted and joined: it changes when a build is published or taken down. */
export async function feedTags(url: string): Promise<string> {
  const [code, body] = await fetchText(url);
  if (code !== 200) throw new Error(`the releases feed answered ${code}`);
  return [...body.matchAll(/\/releases\/tag\/([^"<\s]+)/g)].map((match) => match[1]!).sort().join(" ");
}

async function ask(channel: Channel, api: string): Promise<Release | null> {
  if (channel === "stable") {
    const [code, body] = await fetchText(`${api}/latest`);
    if (code === 404) return null; // nothing released yet
    if (code !== 200) throw new Error(`GitHub answered ${code}: ${body.trim()}`);
    const value = parseJson(body);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("unexpected answer: not a release");
    return offered(value as Record<string, unknown>);
  }
  const [code, body] = await fetchText(`${api}?per_page=30`);
  if (code !== 200) throw new Error(`GitHub answered ${code}: ${body.trim()}`);
  const list = parseJson(body);
  if (!Array.isArray(list)) throw new Error("unexpected answer: not a list of releases");
  const newest = latestBuild(list as Record<string, unknown>[]);
  return newest === null ? null : offered(newest);
}

/**
 * The release or nightly published last that has a build for this machine.
 * Going by when it came out keeps the order across both: nightly-5, then
 * v0.0.1, then nightly-6 (built at 0.0.1).
 */
export function latestBuild(releases: Record<string, unknown>[]): Record<string, unknown> | null {
  const name = assetName();
  let newest: Record<string, unknown> | null = null;
  for (const release of releases) {
    if (release === null || typeof release !== "object" || release.draft === true) continue;
    const published = release.published_at;
    if (typeof published !== "string") continue;
    const assets = Array.isArray(release.assets) ? (release.assets as Record<string, unknown>[]) : [];
    if (!assets.some((asset) => asset?.name === name)) continue;
    // ISO 8601 times in UTC compare as text.
    if (newest === null || published > (newest.published_at as string)) newest = release;
  }
  return newest;
}

/** Whether `tag` ("v0.0.1", "nightly-12") is ahead of this build: a nightly by its number, a release by its version. */
export function ahead(tag: string, version = VERSION, nightly = NIGHTLY): boolean {
  const number = /^nightly-(\d+)$/.exec(tag);
  if (number !== null) return nightly === null || Number(number[1]) > nightly;
  return newer(tag, version);
}

/** What this install updates from: Edit.app's zip when it runs inside one, else the `edit` archive. */
function assetName(): string {
  return runningBundle() !== null ? `Edit-${assetTarget()}.zip` : `edit-${assetTarget()}.tar.gz`;
}

/** The Edit.app this server runs from (`…/Edit.app/Contents/Resources/edit`), or null. */
export function appBundle(exe: string): string | null {
  const match = /^(.+\.app)\/Contents\/Resources\/edit$/.exec(exe);
  return match === null ? null : match[1]!;
}

function runningBundle(): string | null {
  try {
    return appBundle(fs.realpathSync(process.execPath));
  } catch {
    return null;
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`unexpected answer: ${diag.messageOf(error)}`);
  }
}

/** `value` (a GitHub release) as an update, when it's ahead of this build. */
async function offered(value: Record<string, unknown>): Promise<Release | null> {
  const tag = value.tag_name;
  if (typeof tag !== "string") throw new Error("a release without a tag");
  if (!ahead(tag)) return null;
  const name = assetName();
  const assets = Array.isArray(value.assets) ? (value.assets as Record<string, unknown>[]) : [];
  const asset = assets.find((candidate) => candidate?.name === name);
  if (asset === undefined) return null;
  const url = asset.browser_download_url;
  if (typeof url !== "string") throw new Error("an asset without a download link");
  // GitHub hashes uploads itself; the .sha256 beside the archive is the fallback.
  let sha256: string;
  const digest = typeof asset.digest === "string" && asset.digest.startsWith("sha256:") ? asset.digest.slice(7) : null;
  if (digest !== null) {
    sha256 = digest;
  } else {
    const [sumCode, sumBody] = await fetchText(`${url}.sha256`);
    const first = sumBody.split(/\s+/).find((part) => part !== "") ?? "";
    if (sumCode !== 200 || first === "") throw new Error(`${tag} has no checksum for ${name}`);
    sha256 = first;
  }
  const size = typeof asset.size === "number" && asset.size >= 0 ? Math.floor(asset.size) : 0;
  return { tag, url, size, sha256 };
}

/** GETs `url` with curl (following redirects): the status code and body. */
async function fetchText(url: string): Promise<[number, string]> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(["curl", "-sSL", "--max-time", "10", "-w", "\n%{http_code}", url], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new Error(`curl: ${diag.messageOf(error)}`);
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`could not reach GitHub: ${stderr.trim()}`);
  const at = stdout.lastIndexOf("\n");
  const body = at < 0 ? stdout : stdout.slice(0, at);
  const status = at < 0 ? "0" : stdout.slice(at + 1);
  const parsed = Number.parseInt(status.trim(), 10);
  return [Number.isFinite(parsed) && /^\d+$/.test(status.trim()) ? parsed : 0, body];
}

/** Whether `version` ("0.2.0") is newer than `current`. */
export function newer(version: string, current: string): boolean {
  const parse = (text: string): [bigint, bigint, bigint] | null => {
    const parts = text.replace(/^v+/, "").split(".");
    if (parts.length !== 3 || !parts.every((part) => /^\+?\d+$/.test(part))) return null;
    return parts.map((part) => BigInt(part.replace(/^\+/, ""))) as [bigint, bigint, bigint];
  };
  const a = parse(version);
  const b = parse(current);
  if (a === null || b === null) return false;
  for (let index = 0; index < 3; index++) {
    if (a[index]! !== b[index]!) return a[index]! > b[index]!;
  }
  return false;
}

/** Downloads, verifies and swaps in `release`; returns the binary to restart into. */
export async function install(release: Release, staged: string, progress: (progress: number) => void): Promise<string> {
  fs.rmSync(staged, { recursive: true, force: true });
  try {
    fs.mkdirSync(staged, { recursive: true });
  } catch (error) {
    throw new Error(`${staged}: ${ioMessage(error)}`);
  }
  const bundle = runningBundle();
  const archive = join(staged, bundle !== null ? "Edit.zip" : "edit.tar.gz");
  await download(release.url, archive, release.size, progress);
  const digest = await sha256(archive);
  if (digest.toLowerCase() !== release.sha256.toLowerCase()) {
    throw new Error(`the download is corrupt (SHA-256 ${digest}, expected ${release.sha256})`);
  }
  if (bundle !== null) {
    const exe = installApp(archive, bundle);
    fs.rmSync(staged, { recursive: true, force: true });
    progress(1);
    return exe;
  }
  const unpacked = join(staged, "unpacked");
  try {
    fs.mkdirSync(unpacked, { recursive: true });
  } catch (error) {
    throw new Error(ioMessage(error));
  }
  let tar: Bun.SyncSubprocess<"pipe", "pipe">;
  try {
    tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", unpacked], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new Error(`tar: ${diag.messageOf(error)}`);
  }
  if (tar.exitCode !== 0) throw new Error(`could not unpack the update: ${tar.stderr.toString().trim()}`);
  let running: string;
  try {
    running = fs.realpathSync(process.execPath);
  } catch (error) {
    throw new Error(`could not find the running binary: ${ioMessage(error)}`);
  }
  const exe = swapAll(unpacked, running);
  fs.rmSync(staged, { recursive: true, force: true });
  progress(1);
  return exe;
}

/**
 * Replaces Edit.app at `bundle` with the one in `zip`, whole: a signed app
 * can't have files swapped inside it. Unpacked beside it (same disk, so the
 * swap is two renames), its signature checked (and, when this one is signed by
 * a team, that it's the same team), then the old one moved aside and removed.
 * Returns the server to restart into: the new app's, at the same path. The
 * window stays the one running until Edit is next opened.
 */
export function installApp(zip: string, bundle: string): string {
  const dir = parent(bundle);
  if (dir === null || dir === "") throw new Error("Edit.app has no folder");
  const name = bundle.slice(dir.length + 1);
  const unpacked = join(dir, `.Edit-update-${process.pid}`);
  const unwritable = (error: unknown) =>
    new Error(`can't write to ${dir} (${ioMessage(error)}); install the new Edit from its disk image`);
  fs.rmSync(unpacked, { recursive: true, force: true });
  try {
    fs.mkdirSync(unpacked);
  } catch (error) {
    throw unwritable(error);
  }
  try {
    // ditto keeps the bundle's signature, links and attributes as zipped.
    const unzip = run(["ditto", "-x", "-k", zip, unpacked]);
    if (unzip.code !== 0) throw new Error(`could not unpack the update: ${unzip.stderr}`);
    const entries = fs.readdirSync(unpacked).filter((entry) => entry.endsWith(".app"));
    if (entries.length !== 1) throw new Error("the update has no Edit.app");
    const fresh = join(unpacked, entries[0]!);
    if (!fs.existsSync(join(fresh, "Contents", "Resources", "edit"))) throw new Error("the update's Edit.app has no server");
    const verify = run(["codesign", "--verify", "--deep", "--strict", fresh]);
    if (verify.code !== 0) throw new Error(`the update's signature is broken: ${verify.stderr}`);
    const team = teamOf(bundle);
    if (team !== null && teamOf(fresh) !== team) throw new Error(`the update isn't signed by ${team}, who signed this Edit`);
    const old = join(dir, `.Edit-old-${process.pid}.app`);
    try {
      fs.renameSync(bundle, old);
    } catch (error) {
      throw unwritable(error);
    }
    try {
      fs.renameSync(fresh, bundle);
    } catch (error) {
      fs.renameSync(old, bundle);
      throw unwritable(error);
    }
    // The running server's files stay readable until it execs; they go with the folder.
    fs.rmSync(old, { recursive: true, force: true });
  } finally {
    fs.rmSync(unpacked, { recursive: true, force: true });
  }
  return join(dir, name, "Contents", "Resources", "edit");
}

/** The team that signed `app` (Developer ID), or null when it's signed ad hoc. */
function teamOf(app: string): string | null {
  const shown = run(["codesign", "-dv", app]);
  const team = /^TeamIdentifier=(.+)$/m.exec(shown.stderr)?.[1]?.trim();
  return team === undefined || team === "not set" ? null : team;
}

function run(command: string[]): { code: number; stderr: string } {
  try {
    const child = Bun.spawnSync(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    return { code: child.exitCode, stderr: child.stderr.toString().trim() };
  } catch (error) {
    return { code: -1, stderr: `${command[0]}: ${diag.messageOf(error)}` };
  }
}

/**
 * The programs in an unpacked release besides `edit`: every executable file at
 * its top (and the FFmpeg it ships, whatever its mode), sorted. Whatever a
 * later release adds is swapped in with the rest, so the archive's layout can change.
 */
export function programs(unpacked: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(unpacked);
  } catch (error) {
    throw new Error(ioMessage(error));
  }
  const names: string[] = [];
  for (const name of entries) {
    let meta: fs.Stats;
    try {
      meta = fs.lstatSync(join(unpacked, name));
    } catch {
      continue;
    }
    if (name === "edit" || name.startsWith(".") || !meta.isFile()) continue;
    const executable = (meta.mode & 0o111) !== 0;
    if (executable || name === "edit-ffmpeg" || name === "edit-ffprobe") names.push(name);
  }
  return names.sort();
}

/**
 * Swaps every program in `unpacked` in beside `running`: the others first, so
 * the new `edit` finds its own FFmpeg and helpers, then `edit` itself over
 * `running`. Returns the binary to restart into.
 */
export function swapAll(unpacked: string, running: string): string {
  const binary = join(unpacked, "edit");
  let isBinary = false;
  try {
    isBinary = fs.statSync(binary).isFile();
  } catch {
    isBinary = false;
  }
  if (!isBinary) throw new Error("the update has no edit binary");
  const dir = parent(running);
  if (dir === null || dir === "") throw new Error("the running binary has no folder");
  for (const name of programs(unpacked)) swapIn(join(unpacked, name), dir, join(dir, name), name);
  swapIn(binary, dir, running, "edit");
  return running;
}

/** Fetches `url` into `path` with curl, reporting 0–1 as the file grows. */
async function download(url: string, path: string, size: number, progress: (progress: number) => void): Promise<void> {
  let curl: Bun.Subprocess<"ignore", "ignore", "pipe">;
  try {
    curl = Bun.spawn(
      ["curl", "-fsSL", "--retry", "2", "--connect-timeout", "15", "--max-time", "1800", "-o", path, url],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
  } catch (error) {
    throw new Error(`curl: ${diag.messageOf(error)}`);
  }
  const stderr = new Response(curl.stderr).text();
  const timer = setInterval(() => {
    let have = 0;
    try {
      have = fs.statSync(path).size;
    } catch {
      have = 0;
    }
    progress(Math.min(have / Math.max(size, 1), 0.99));
  }, 200);
  try {
    const code = await curl.exited;
    if (code !== 0) throw new Error(`download failed: ${(await stderr).trim()}`);
  } finally {
    clearInterval(timer);
  }
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  try {
    for await (const chunk of Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>) hasher.update(chunk);
  } catch (error) {
    throw new Error(ioMessage(error));
  }
  return hasher.digest("hex");
}

/**
 * Replaces `exe` (in `dir`) with `fresh`. The copy lands beside it first so the
 * final rename is atomic (and works when ~/.edit is on another disk); a fresh
 * file rather than an overwrite also keeps macOS's signature check happy.
 */
function swapIn(fresh: string, dir: string, exe: string, name: string): void {
  const temp = join(dir, `.${name}-update`);
  const unwritable = (error: unknown) =>
    new Error(`can't write to ${dir} (${ioMessage(error)}); reinstall with the install script`);
  try {
    fs.copyFileSync(fresh, temp);
    fs.chmodSync(temp, 0o755);
  } catch (error) {
    throw unwritable(error);
  }
  try {
    fs.renameSync(temp, exe);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw unwritable(error);
  }
}

/** The arguments this process was started with (after the program). */
export function startArgs(): string[] {
  // Compiled, argv is ["bun", "/$bunfs/root/…", …]; run by bun, ["bun", "<script>", …].
  return compiled() ? process.argv.slice(2) : process.argv.slice(1);
}

/** Whether this is the compiled `edit` (its code inside the binary). */
export function compiled(): boolean {
  return Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:\\~BUN\\");
}

/** Becomes `exe`, with the same arguments; every descriptor above stderr closes on exec, so the new server binds the same ports. */
function restart(exe: string): never {
  for (const hook of beforeRestart) {
    try {
      hook();
    } catch (error) {
      diag.warn("update", `before restarting: ${diag.messageOf(error)}`);
    }
  }
  try {
    native().reexec(exe, startArgs());
  } catch (error) {
    console.error(`edit: could not restart (${diag.messageOf(error)}); start \`edit serve\` again`);
  }
  process.exit(1);
}

/** `edit update`. */
export async function runCli(home: string): Promise<void> {
  if (!enabled()) {
    console.log(`This build of Edit (${BUILD}) doesn't update itself; pull and rebuild.`);
    return;
  }
  let release: Release | null;
  try {
    release = await check(readChannel(home));
  } catch (error) {
    console.error(`edit: could not check for updates: ${diag.messageOf(error)}`);
    process.exit(1);
  }
  if (release === null) {
    console.log(`Edit is up to date (${BUILD}, ${readChannel(home)} channel).`);
    return;
  }
  console.log(`Updating Edit ${BUILD} → ${release.tag}…`);
  try {
    await install(release, join(home, "updates"), () => {});
    console.log("Done. Restart `edit serve` if it's running.");
  } catch (error) {
    console.error(`edit: ${diag.messageOf(error)}`);
    process.exit(1);
  }
}
