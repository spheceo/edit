// YouTube footage for script imports: a Doc's ranges can link YouTube as
// well as Drive. A YouTube video is a script file named `youtube:<video id>`
// (Drive ids never hold a colon). It's downloaded whole with yt-dlp (H.264 up
// to 1080p, as YouTube serves it without a sign-in, and the original sound,
// never a dub), then cut into excerpts like a Drive file: on this disk
// (`script.footageToDisk`), or put on R2 as `youtube:<id>` and cut there
// (`cloud_media`).
//
// yt-dlp: `EDIT_YTDLP`, else on PATH, else `<home>/bin/yt-dlp` (the release
// for macOS from GitHub, checked against its SHA2-256SUMS, fetched on first
// use). Every run names a JavaScript runtime (`--js-runtimes` below), which
// YouTube extraction now needs. YouTube is asked straight from this Mac; when
// it refuses (a bot check, 403s) or a route gives no video, and `PROXY_URL`
// is set (Repack's download proxy; `just dev` borrows it), once more through
// the proxy. The proxy URL is a credential: never in a log line or an error.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import * as tools from "./tools.ts";
import { compiled } from "./update.ts";
import { cookieArgs } from "./youtube_signin.ts";
import { join, parent } from "./paths.ts";

/** The prefix of a script file that's a YouTube video. */
export const PREFIX = "youtube:";

/** The video id in a YouTube link (watch?v=, youtu.be/, /shorts/, /live/, /embed/), else null. */
export function videoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = parsed.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const parts = parsed.pathname.split("/").filter((part) => part !== "");
    if (parts[0] === "watch") id = parsed.searchParams.get("v");
    else if (["shorts", "live", "embed", "v"].includes(parts[0] ?? "")) id = parts[1] ?? null;
  }
  return id !== null && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** The script file a YouTube link names, else null. */
export function fileOf(url: string): string | null {
  const id = videoId(url);
  return id === null ? null : `${PREFIX}${id}`;
}

/** The video id of a script file that's a YouTube video, else null. */
export function idOf(file: string): string | null {
  if (!file.startsWith(PREFIX)) return null;
  const id = file.slice(PREFIX.length);
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** A YouTube `t` (`86`, `86s`, `1m26s`, `1h2m3s`) in seconds, else null. */
export function startOf(t: string): number | null {
  const plain = /^(\d+(?:\.\d+)?)s?$/.exec(t);
  if (plain !== null) return Number(plain[1]);
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (parts === null || t === "") return null;
  return Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0);
}

// ---------------------------------------------------------------------------
// yt-dlp.

const RELEASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const ASSET = "yt-dlp_macos";
/** How often Edit's yt-dlp is checked against the newest release. */
const FRESH_MS = 24 * 3600_000;
let fetching: Promise<string> | null = null;

/**
 * The yt-dlp to run: `EDIT_YTDLP`, else Edit's own copy, kept current. Never
 * one found on PATH first: a Homebrew yt-dlp two months old (this Mac, Oct
 * 28) broke YouTube imports the way YouTube breaks every old yt-dlp, and
 * nobody knew it was the one running. PATH is only the last resort, when
 * GitHub can't be reached and Edit has no copy yet.
 */
export async function ytdlp(home: string): Promise<string> {
  const set = process.env.EDIT_YTDLP;
  if (set !== undefined && set !== "") return set;
  const own = join(home, "bin", "yt-dlp");
  if (fs.existsSync(own)) {
    // Checked once a day, in the background: this run uses the copy there is.
    if (stale(own)) void freshen(own, false).catch((error) => diag.warn("youtube", `checking for a newer yt-dlp: ${diag.messageOf(error)}`));
    return own;
  }
  try {
    return await freshen(own, true);
  } catch (error) {
    const found = Bun.which("yt-dlp");
    if (found !== null) {
      diag.warn("youtube", `couldn't fetch yt-dlp (${diag.messageOf(error)}); using ${found} for now`);
      return found;
    }
    throw error;
  }
}

function stale(path: string): boolean {
  try {
    return Date.now() - fs.statSync(path).mtimeMs > FRESH_MS;
  } catch {
    return true;
  }
}

/**
 * Brings Edit's yt-dlp up to the newest release (checksum-verified): only the
 * small checksum list is fetched when it's current already. `force` checks
 * even when it was checked today. Returns its path.
 */
export function freshen(to: string, force: boolean): Promise<string> {
  if (!force && !stale(to)) return Promise.resolve(to);
  fetching ??= fetchYtdlp(to).finally(() => {
    fetching = null;
  });
  return fetching;
}

/** Whether yt-dlp's words say it's out of date for what YouTube does now (a newer yt-dlp is the fix). */
export function outdated(stderr: string): boolean {
  return /Unable to extract|nsig extraction failed|[Ss]ignature extraction failed|n challenge|Precondition check failed|Confirm you are on the latest version|please report this issue/i.test(stderr);
}

async function fetchYtdlp(to: string): Promise<string> {
  return diag.timeOnAsync("youtube", "youtube: fetch yt-dlp", to, async () => {
    const get = async (name: string): Promise<Uint8Array> => {
      const response = await fetch(`${RELEASE}/${name}`, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`fetching yt-dlp: ${response.status} for ${name}`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const sums = await get("SHA2-256SUMS");
    const line = new TextDecoder()
      .decode(sums)
      .split("\n")
      .find((row) => row.trim().endsWith(` ${ASSET}`));
    const expected = line?.trim().split(/\s+/)[0];
    if (expected === undefined) throw new Error("yt-dlp's release has no checksum for its macOS build");
    // Current already: only noted as checked.
    if (fs.existsSync(to) && new Bun.CryptoHasher("sha256").update(fs.readFileSync(to)).digest("hex") === expected) {
      const now = new Date();
      fs.utimesSync(to, now, now);
      return to;
    }
    const binary = await get(ASSET);
    const actual = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
    if (expected !== actual) throw new Error("the yt-dlp download didn't match its checksum");
    fs.mkdirSync(parent(to)!, { recursive: true });
    const part = `${to}.part-${process.pid}`;
    fs.writeFileSync(part, binary, { mode: 0o755 });
    fs.renameSync(part, to);
    diag.info("youtube", `yt-dlp updated to the newest release`);
    return to;
  });
}

/**
 * Where yt-dlp finds FFmpeg (it merges the picture and the sound): a path,
 * never a bare name, which yt-dlp takes for a missing FFmpeg and then leaves
 * the streams unmerged without a word under --no-warnings.
 */
function ffmpegArgs(): string[] {
  const tool = tools.ffmpeg();
  const path = tool.includes("/") ? tool : Bun.which(tool);
  return path === null ? [] : ["--ffmpeg-location", path];
}

/**
 * yt-dlp's JavaScript runtime for YouTube's challenges, named explicitly
 * with its path (`--js-runtimes <name>:<path>`): without one YouTube hands
 * back only storyboard images and no video, and yt-dlp enables only deno by
 * default. The qjs bundled with Edit (`tools.qjs`, QuickJS-ng) first, so a
 * packaged Edit always has one; then a runtime installed on this Mac (deno,
 * node, bun, quickjs); then, in a compiled build with none of those, the
 * `edit` binary itself, which is Bun under BUN_BE_BUN=1 (see `runtimeEnv`).
 * Nobody using Edit installs a runtime for this.
 */
function jsRuntime(): [name: string, path: string] | null {
  const bundled = tools.qjs();
  if (bundled !== null) return ["quickjs", bundled];
  for (const [name, program] of [
    ["deno", "deno"],
    ["node", "node"],
    ["bun", "bun"],
    ["quickjs", "qjs"],
    ["quickjs", "quickjs"],
  ] as const) {
    const path = Bun.which(program);
    if (path !== null) return [name, path];
  }
  if (compiled()) return ["bun", process.execPath];
  return null;
}

export function runtimeArgs(): string[] {
  const runtime = jsRuntime();
  return runtime === null ? [] : ["--js-runtimes", `${runtime[0]}:${runtime[1]}`];
}

/** yt-dlp's environment: BUN_BE_BUN=1 when it runs `edit` as its Bun. */
export function runtimeEnv(args: string[]): Record<string, string | undefined> | undefined {
  return args.some((arg) => arg.startsWith("bun:")) ? { ...process.env, BUN_BE_BUN: "1" } : undefined;
}

// H.264 (the hardware decodes it everywhere; YouTube's AV1 doesn't on an M1)
// over plain HTTPS, up to 1080p, with the original sound: yt-dlp ranks the
// original track above YouTube's dubs. A progressive MP4 when there's no DASH.
// The last resort still asks for a video: a route YouTube is withholding
// formats from offers only storyboards, and a bare `b` would take one and
// call it a download.
const FORMAT = "bv*[vcodec^=avc1][height<=1080][protocol=https]+ba[ext=m4a][protocol=https]/b[vcodec^=avc1][ext=mp4]/bv*[height<=1080]+ba/b[vcodec!=none]";
/** Through the paid proxy ($1/GB): at most 720p, about half the bytes of 1080p (the audit, Oct 23). */
const PROXY_FORMAT = "bv*[vcodec^=avc1][height<=720][protocol=https]+ba[ext=m4a][protocol=https]/b[vcodec^=avc1][ext=mp4][height<=720]/bv*[height<=720]+ba/b[height<=720][vcodec!=none]";

/** Whether yt-dlp's words say YouTube refused this Mac (worth the proxy). */
function refused(stderr: string): boolean {
  return /not a bot|HTTP Error 403|HTTP Error 429|Sign in to confirm|page needs to be reloaded/i.test(stderr);
}

/**
 * Whether this route gave no video (formats withheld, only storyboard images
 * offered, or no JavaScript runtime to answer YouTube's challenge): another
 * route — a fresh proxy exit, this Mac again — may still get one, so it is
 * retried like a refusal, never the final word on its own. Read on the ERROR
 * line, not the whole output: a WARNING naming the missing runtime beside a
 * real error (a private video) must not make that error retryable.
 */
function noVideo(stderr: string): boolean {
  return /requested format is not available|only images are available|did not produce a video|javascript runtime|stood still/i.test(errorLine(stderr));
}

/** yt-dlp's error line, without anything credential-like. */
function errorLine(stderr: string): string {
  const lines = stderr.split("\n").filter((line) => line.trim() !== "");
  // Say the ERROR, not a WARNING that happened to come first in its output.
  const error = [...lines].reverse().find((line) => line.toUpperCase().includes("ERROR")) ?? lines[lines.length - 1] ?? "yt-dlp failed";
  return diag.scrub(error.replace(/^ERROR:\s*/, "").replace(/https?:\/\/[^\s@]*@[^\s]*/g, "<proxy>"));
}

export interface Downloaded {
  path: string;
  name: string;
  size: number;
}

const running = new Map<string, Promise<Downloaded>>();

/** The wait before asking YouTube again, and how long yt-dlp may say nothing before it's stopped (tests make them short). */
export const timing = { pause: (ms: number): Promise<void> => Bun.sleep(ms), quiet: 10 * 60_000 };

/** What a run stopped for saying nothing reads as (retried like a refusal). */
const STOOD_STILL = "ERROR: The download stood still";

/**
 * Downloads YouTube video `id` whole into `dir` (one download per video at a
 * time; a finished one is reused, a stopped one resumes), calling
 * `progress(bytes, total, name)` as it goes.
 */
export function download(
  home: string,
  id: string,
  dir: string,
  progress: (bytes: number, total: number | null, name: string) => void,
): Promise<Downloaded> {
  const key = join(dir, id);
  const already = running.get(key);
  if (already !== undefined) return already;
  const work = downloadNow(home, id, dir, progress).finally(() => running.delete(key));
  running.set(key, work);
  return work;
}

async function downloadNow(
  home: string,
  id: string,
  dir: string,
  progress: (bytes: number, total: number | null, name: string) => void,
): Promise<Downloaded> {
  fs.mkdirSync(dir, { recursive: true });
  const done = join(dir, ".done");
  try {
    const name = fs.readFileSync(done, "utf8").trim();
    const path = join(dir, name);
    if (name !== "" && fs.existsSync(path)) {
      const size = fs.statSync(path).size;
      progress(size, size, name);
      return { path, name, size };
    }
  } catch {
    // Not downloaded yet.
  }
  let binary = await ytdlp(home);
  const url = `https://www.youtube.com/watch?v=${id}`;
  const proxy = process.env.PROXY_URL?.trim() ?? "";
  const routes = routesFor(proxy, 2);
  let failure = "";
  let updated = false;
  for (const [attempt, route] of routes.entries()) {
    const result = await diag.timeOnAsync("youtube", "youtube: download", `${id}${said(route)}`, () =>
      runYtdlp(binary, url, dir, route, progress),
    );
    if (result.path !== null) {
      const name = result.path.slice(dir.length + 1);
      fs.writeFileSync(done, name);
      const size = fs.statSync(result.path).size;
      progress(size, size, name);
      return { path: result.path, name, size };
    }
    failure = errorLine(result.stderr);
    // YouTube changed and this yt-dlp doesn't know yet: the newest one, and this route again.
    if (!updated && outdated(result.stderr) && binary === join(home, "bin", "yt-dlp")) {
      updated = true;
      try {
        binary = await freshen(binary, true);
        diag.warn("youtube", `${id}: ${failure}; trying again with the newest yt-dlp`);
        routes.splice(attempt + 1, 0, route);
        continue;
      } catch (error) {
        diag.warn("youtube", `updating yt-dlp: ${diag.messageOf(error)}`);
      }
    }
    const last = attempt === routes.length - 1;
    if (last || !worthAnother(result.stderr, routes[attempt + 1]!)) break;
    diag.warn("youtube", `${id}: ${failure}; trying again${said(routes[attempt + 1]!)}`);
    await timing.pause(attempt === 0 ? 3000 : 1000);
  }
  throw new Error(`YouTube video ${id} couldn't be downloaded: ${failure}`);
}

/** One way of asking YouTube: straight from this Mac, with the editor's sign-in from Chrome, or through the paid proxy (never with the sign-in). */
interface Route {
  proxy: string | null;
  signIn: string[];
}

/**
 * The ways to ask, in order: straight (it costs nothing), with the editor's
 * YouTube sign-in from Chrome when there is one (else straight again: YouTube's
 * refusals come and go), then through the proxy when there is one. `straight`
 * is how many tries go before the proxy.
 */
function routesFor(proxy: string, straight: number): Route[] {
  const signIn = cookieArgs();
  const routes: Route[] = [{ proxy: null, signIn: [] }];
  if (straight > 1) routes.push({ proxy: null, signIn });
  else if (signIn.length > 0) routes.push({ proxy: null, signIn });
  if (proxy !== "") routes.push({ proxy, signIn: [] });
  return routes;
}

function said(route: Route): string {
  return route.proxy !== null ? " (proxy)" : route.signIn.length > 0 ? " (with the YouTube sign-in from Chrome)" : "";
}

/** Whether a video needs a signed-in YouTube (age, members, private): only the sign-in can help. */
function needsSignIn(stderr: string): boolean {
  return /confirm your age|age.restricted|members.only|Join this channel|Private video|This video is private/i.test(errorLine(stderr));
}

/** Whether the next route may get what this one didn't. */
function worthAnother(stderr: string, next: Route): boolean {
  if (needsSignIn(stderr)) return next.signIn.length > 0;
  return refused(stderr) || noVideo(stderr);
}

async function runYtdlp(
  binary: string,
  url: string,
  dir: string,
  route: Route,
  progress: (bytes: number, total: number | null, name: string) => void,
  range: [number, number] | null = null,
): Promise<{ path: string | null; stderr: string }> {
  const proxy = route.proxy;
  const runtime = runtimeArgs();
  const command = [
    binary,
    "--no-playlist",
    "--no-warnings",
    "--newline",
    // --print below makes it quiet; the progress lines still come.
    "--progress",
    "--no-mtime",
    // Through the paid proxy a retry can pay for the same bytes again (the audit, Oct 23): once there.
    "--retries",
    proxy === null ? "5" : "1",
    "--fragment-retries",
    proxy === null ? "5" : "1",
    "--socket-timeout",
    "30",
    "--continue",
    "-f",
    proxy === null ? FORMAT : PROXY_FORMAT,
    "--merge-output-format",
    "mp4",
    ...(range === null ? [] : ["--download-sections", `*${range[0]}-${range[1]}`, "--force-keyframes-at-cuts"]),
    ...ffmpegArgs(),
    ...runtime,
    "-P",
    dir,
    "-o",
    "%(title).120B [%(id)s].%(ext)s",
    "--progress-template",
    "download:EDIT %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(info.title).120B",
    "--print",
    "after_move:EDIT-FILE %(filepath)s",
    ...(proxy === null ? [] : ["--proxy", proxy]),
    ...(proxy === null ? route.signIn : []),
    url,
  ];
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: runtimeEnv(runtime) });
  } catch (error) {
    return { path: null, stderr: `ERROR: yt-dlp couldn't start: ${diag.messageOf(error)}` };
  }
  // Two streams (video, then sound) are downloaded one after the other: the
  // bytes before the current one are carried.
  let earlier = 0;
  let current = 0;
  let path: string | null = null;
  // Nothing said for this long (no progress, no merge finishing): stopped, and
  // the try counts as a failed one, never a download frozen for good.
  let heard = Date.now();
  let quiet = false;
  const watch = setInterval(() => {
    if (Date.now() - heard < timing.quiet) return;
    quiet = true;
    child.kill();
  }, Math.min(timing.quiet, 5000));
  const lines = async () => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of child.stdout) {
      heard = Date.now();
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
        if (line.startsWith("EDIT-FILE ")) {
          path = line.slice("EDIT-FILE ".length);
        } else if (line.startsWith("EDIT ")) {
          const [bytes, total, estimate, ...title] = line.slice("EDIT ".length).split(" ");
          const done = Number(bytes);
          if (!Number.isFinite(done)) continue;
          if (done < current) earlier += current;
          current = done;
          const size = Number(total);
          const guess = Number(estimate);
          const whole = Number.isFinite(size) ? size : Number.isFinite(guess) ? guess : null;
          progress(earlier + done, whole === null ? null : earlier + whole, title.join(" "));
        }
      }
    }
  };
  const timer = range === null ? null : setTimeout(() => child.kill(), 12 * 60_000);
  let stderr: string;
  let code: number;
  try { [, stderr, code] = await Promise.all([lines(), new Response(child.stderr).text(), child.exited]); }
  finally { if (timer !== null) clearTimeout(timer); clearInterval(watch); }
  if (quiet) return { path: null, stderr: `${stderr}\n${STOOD_STILL} (nothing for ${Math.round(timing.quiet / 60_000)} minutes).` };
  if (code !== 0) return { path: null, stderr };
  // yt-dlp said yes and made nothing (a route withholding formats can hand
  // back only storyboards): say so in words the retry above reads.
  if (path === null) return { path: null, stderr: `${stderr}\nERROR: The download did not produce a video.` };
  if (!fs.existsSync(path)) return { path: null, stderr: `${stderr}\nERROR: The download did not produce a video (yt-dlp finished without the file it named).` };
  return { path, stderr };
}

/** Download only a selected stretch, with exact cuts. Never fall back to a
 * whole stream: visual sourcing must not materialize hours for a few seconds. */
export async function downloadRange(home: string, id: string, range: [number, number], dir: string, progress: (bytes: number, total: number | null, name: string) => void = () => {}): Promise<Downloaded> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id) || !range.every(Number.isFinite) || range[0] < 0 || range[1] <= range[0] || range[1] - range[0] > 600) throw new Error("YouTube excerpt needs a valid video and a source range of at most 10 minutes");
  fs.mkdirSync(dir, { recursive: true });
  const binary = await ytdlp(home); const proxy = process.env.PROXY_URL?.trim() ?? "";
  const routes = routesFor(proxy, 1);
  let failure = "";
  for (const [attempt, route] of routes.entries()) {
    const result = await runYtdlp(binary, `https://www.youtube.com/watch?v=${id}`, dir, route, progress, range);
    if (result.path !== null) return { path: result.path, name: result.path.slice(dir.length + 1), size: fs.statSync(result.path).size };
    failure = errorLine(result.stderr);
    const next = routes[attempt + 1];
    if (next === undefined || !worthAnother(result.stderr, next)) break;
  }
  throw new Error(`YouTube excerpt ${id} ${range[0]}–${range[1]} couldn't be downloaded: ${failure}`);
}
