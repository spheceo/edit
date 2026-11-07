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

import { Effect, Fiber, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as diag from "./diag.ts";
import { inArea, runPromise } from "./effect/runtime.ts";
import * as relay from "./relay.ts";
import * as tools from "./tools.ts";
import { compiled } from "./update.ts";
import { cookieArgs, supported as signInSupported } from "./youtube_signin.ts";
import { join, parent } from "./paths.ts";
import { THIS_MACHINE } from "./machine.ts";

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
/** yt-dlp's build for this machine (Nov 7: Linux was handed the macOS one, and every YouTube import failed). */
const ASSET = process.platform === "darwin" ? "yt-dlp_macos" : process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
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
    if (expected === undefined) throw new Error(`yt-dlp's release has no checksum for ${ASSET}`);
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

// ── Why a try failed (in Effect since Nov 1: docs/plans/2026-11-01-effect.md, part 4) ──
//
// The routes were fixed seven times in eight days (cac57fd0, 94e49c77,
// db3f473d, 3b3cb78d, 88b0d2ce, 8c25e077, 597f55ae), each one for a way
// yt-dlp failed that the list of retryable words didn't know yet, which
// stopped the whole download at its first try (Oct 31, Kroger: "yt-dlp
// stopped part-way (exit 1)", the proxy and the sign-in never tried). Now a
// try's output is read once into the reason it failed (`reasonOf`), and what
// each reason does is one table (`afterFailure`): only a video that's gone,
// or one only a signed-in YouTube can have, stops the routes. Anything else,
// a wording nobody has seen yet included, goes on to the next route.

/** The video itself can't be had (taken down, private, blocked): no route helps. */
export class VideoGone extends Schema.TaggedError<VideoGone>()("VideoGone", { line: Schema.String }) {}
/** Only a signed-in YouTube can have it (age, members, private): the sign-in route, or nothing. */
export class NeedsSignIn extends Schema.TaggedError<NeedsSignIn>()("NeedsSignIn", { line: Schema.String }) {}
/** YouTube changed and this yt-dlp doesn't know yet: the newest one, and the same route again. */
export class YtdlpOutdated extends Schema.TaggedError<YtdlpOutdated>()("YtdlpOutdated", { line: Schema.String }) {}
/** YouTube refused this route (a bot check, 403s, 429s): the next one. */
export class RouteRefused extends Schema.TaggedError<RouteRefused>()("RouteRefused", { line: Schema.String }) {}
/** The route gave no video (formats withheld, only storyboards, no JavaScript runtime): the next one. */
export class NoVideoHere extends Schema.TaggedError<NoVideoHere>()("NoVideoHere", { line: Schema.String }) {}
/** The download stopped part-way (a dropped connection, a refused fragment): the next route, carrying on from the bytes here. */
export class StoppedPartWay extends Schema.TaggedError<StoppedPartWay>()("StoppedPartWay", { line: Schema.String }) {}
/** yt-dlp said nothing for too long and was stopped: the next route. */
export class StoodStill extends Schema.TaggedError<StoodStill>()("StoodStill", { line: Schema.String }) {}
/** A failure none of the above knows: the next route, never the last word. */
export class Unrecognised extends Schema.TaggedError<Unrecognised>()("Unrecognised", { line: Schema.String }) {}

export type TryFailure = VideoGone | NeedsSignIn | YtdlpOutdated | RouteRefused | NoVideoHere | StoppedPartWay | StoodStill | Unrecognised;

/** Every route was tried, or none could help: the reason the last one failed. */
export class DownloadFailed extends Schema.TaggedError<DownloadFailed>()("DownloadFailed", { reason: Schema.String, message: Schema.String }) {}

/** Whether yt-dlp's words say YouTube refused this Mac (worth the proxy). */
function refused(stderr: string): boolean {
  return /not a bot|HTTP Error 403|HTTP Error 429|Sign in to confirm|page needs to be reloaded/i.test(stderr);
}

/**
 * Whether this route gave no video (formats withheld, only storyboard images
 * offered, or no JavaScript runtime to answer YouTube's challenge). Read on
 * the ERROR line, not the whole output: a WARNING naming the missing runtime
 * beside a real error (a private video) must not make that error retryable.
 */
function noVideo(stderr: string): boolean {
  return /requested format is not available|only images are available|did not produce a video|javascript runtime/i.test(errorLine(stderr));
}

/** Whether a download stopped part-way (a connection dropped or timed out, a fragment refused mid-video, yt-dlp giving up after its own retries). */
function partWay(stderr: string): boolean {
  return /stopped part-way|nothing came down|connection reset|timed out|IncompleteRead|urlopen error|Remote end closed|did not get any data|giving up after|Got error|fragment/i.test(errorLine(stderr));
}

/** Whether the video itself can't be had (taken down, private, blocked): no route helps. */
function gone(stderr: string): boolean {
  return /Video unavailable|has been removed|no longer available|copyright|Private video|This video is private|does not exist|terminated/i.test(stderr);
}

/** Whether a video needs a signed-in YouTube (age, members, private): only the sign-in can help. */
function needsSignIn(stderr: string): boolean {
  return /confirm your age|age.restricted|members.only|Join this channel|Private video|This video is private/i.test(errorLine(stderr));
}

/** yt-dlp's error line, without anything credential-like. */
function errorLine(stderr: string): string {
  const lines = stderr.split("\n").filter((line) => line.trim() !== "");
  // Say the ERROR, not a WARNING that happened to come first in its output.
  const error = [...lines].reverse().find((line) => line.toUpperCase().includes("ERROR")) ?? lines[lines.length - 1] ?? "yt-dlp failed";
  return diag.scrub(error.replace(/^ERROR:\s*/, "").replace(/https?:\/\/[^\s@]*@[^\s]*/g, "<proxy>"));
}

/** Why a try failed, read once from what yt-dlp said, in this order: the sign-in, gone, outdated, then what another route can help. */
export function reasonOf(stderr: string): TryFailure {
  const line = errorLine(stderr);
  if (needsSignIn(stderr)) return new NeedsSignIn({ line });
  if (gone(stderr)) return new VideoGone({ line });
  if (outdated(stderr)) return new YtdlpOutdated({ line });
  if (stderr.includes(STOOD_STILL)) return new StoodStill({ line });
  if (refused(stderr)) return new RouteRefused({ line });
  if (noVideo(stderr)) return new NoVideoHere({ line });
  if (partWay(stderr)) return new StoppedPartWay({ line });
  return new Unrecognised({ line });
}

/** What a failed try leads to: the next route, the sign-in route, the same route with the newest yt-dlp, or the end. */
type Next = { readonly to: "next" } | { readonly to: "sign-in" } | { readonly to: "update" } | { readonly to: "stop" };

export function afterFailure(reason: TryFailure): Next {
  switch (reason._tag) {
    case "VideoGone":
      return { to: "stop" };
    case "NeedsSignIn":
      return { to: "sign-in" };
    case "YtdlpOutdated":
      return { to: "update" };
    case "RouteRefused":
    case "NoVideoHere":
    case "StoppedPartWay":
    case "StoodStill":
    case "Unrecognised":
      return { to: "next" };
  }
}

export interface Downloaded {
  path: string;
  name: string;
  size: number;
}

const running = new Map<string, Promise<Downloaded>>();

/** The wait before asking YouTube again, and how long yt-dlp may say nothing before it's stopped (tests make them short). */
export const timing = { pause: (ms: number): Promise<void> => Bun.sleep(ms), quiet: 10 * 60_000 };

/** What a run stopped for saying nothing reads as. */
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
  const work = runPromise(downloadWhole(home, id, dir, progress).pipe(inArea("youtube"))).finally(() => running.delete(key));
  running.set(key, work);
  return work;
}

const downloadWhole = Effect.fn("youtube.download")(function* (home: string, id: string, dir: string, progress: Progress) {
  fs.mkdirSync(dir, { recursive: true });
  const done = join(dir, ".done");
  const kept = (() => {
    try {
      const name = fs.readFileSync(done, "utf8").trim();
      const path = join(dir, name);
      return name !== "" && fs.existsSync(path) ? { path, name, size: fs.statSync(path).size } : null;
    } catch {
      // Not downloaded yet.
      return null;
    }
  })();
  if (kept !== null) {
    progress(kept.size, kept.size, kept.name);
    return kept;
  }
  const path = yield* overRoutes(home, id, dir, 2, null, null, progress, `YouTube video ${id} couldn't be downloaded`);
  const name = path.slice(dir.length + 1);
  fs.writeFileSync(done, name);
  const size = fs.statSync(path).size;
  progress(size, size, name);
  return { path, name, size };
});

type Progress = (bytes: number, total: number | null, name: string) => void;

/**
 * Tries the routes in order until one gives the file, as `afterFailure`
 * says; when none does, fails with `DownloadFailed` saying the last reason.
 */
const overRoutes = Effect.fn("youtube.overRoutes")(function* (
  home: string,
  id: string,
  dir: string,
  straight: number,
  range: [number, number] | null,
  format: string | null,
  progress: Progress,
  saying: string,
) {
  let binary = yield* Effect.promise(() => ytdlp(home));
  const url = `https://www.youtube.com/watch?v=${id}`;
  const routes = routesFor(yield* Effect.promise(() => proxyUrl()), straight);
  let updated = false;
  let last: TryFailure = new Unrecognised({ line: "yt-dlp failed" });
  for (let attempt = 0; attempt < routes.length; ) {
    const route = routes[attempt]!;
    const began = Date.now();
    const tried = yield* tryRoute(binary, url, dir, route, progress, range, format);
    diag.record("youtube", "youtube: download", Date.now() - began, tried.path === null ? `${id}${said(route)}: ${errorLine(tried.stderr)}` : null);
    if (tried.path !== null) return tried.path;
    last = reasonOf(tried.stderr);
    const next = afterFailure(last);
    if (next.to === "update" && !updated && binary === join(home, "bin", "yt-dlp")) {
      updated = true;
      const fresh = yield* Effect.tryPromise(() => freshen(binary, true)).pipe(
        Effect.tapError((error) => Effect.logWarning(`updating yt-dlp: ${diag.messageOf(error.cause)}`)),
        Effect.option,
      );
      if (Option.isSome(fresh)) {
        binary = fresh.value;
        yield* Effect.logWarning(`${id}: ${last.line}; trying again with the newest yt-dlp`);
        routes.splice(attempt + 1, 0, route);
        attempt += 1;
        continue;
      }
    }
    const to =
      next.to === "stop"
        ? null
        : next.to === "sign-in"
          ? (() => {
              const at = routes.findIndex((one, index) => index > attempt && one.signIn);
              return at < 0 ? null : at;
            })()
          : attempt + 1 < routes.length
            ? attempt + 1
            : null;
    if (to === null) break;
    yield* Effect.logWarning(`${id}: ${last.line}${last._tag === "Unrecognised" ? " (not a failure Edit knows: the next route may still get it)" : ""}; trying again${said(routes[to]!)}`);
    yield* Effect.promise(() => timing.pause(attempt === 0 ? 3000 : 1000));
    attempt = to;
  }
  return yield* new DownloadFailed({ reason: last._tag, message: `${saying}: ${last.line}` });
});

/** The relay's proxy, asked for once in a while (it's the same for everyone). */
let fromRelay: { url: string; at: number } | null = null;

/**
 * The YouTube proxy: this machine's own (`PROXY_URL`, the dev server's), else
 * the relay's, which gives it to signed-in people only (installed Edits carry
 * no keys: until Oct 30 a teammate's download YouTube refused had no proxy).
 * Only used when YouTube refuses a download straight; never logged.
 */
export async function proxyUrl(): Promise<string> {
  const own = process.env.PROXY_URL?.trim() ?? "";
  if (own !== "") return own;
  if (fromRelay !== null && Date.now() - fromRelay.at < 10 * 60_000) return fromRelay.url;
  try {
    const answer = await relay.json<{ proxyUrl?: string | null }>("GET", "/v1/proxy", null, "the YouTube proxy", 20);
    fromRelay = { url: typeof answer.proxyUrl === "string" ? answer.proxyUrl.trim() : "", at: Date.now() };
  } catch (error) {
    diag.warn("youtube", `asking the relay for the YouTube proxy: ${diag.messageOf(error)}`);
    return "";
  }
  return fromRelay.url;
}

/** One way of asking YouTube: straight from this Mac, with the editor's sign-in from Chrome, or through the paid proxy (never with the sign-in). */
interface Route {
  proxy: string | null;
  /** The editor's YouTube sign-in from Chrome, read only when this route is tried. */
  signIn: boolean;
}

/**
 * The ways to ask, in order: straight (it costs nothing; `straight` times,
 * YouTube's refusals come and go), through the proxy when there is one, and
 * last the editor's YouTube sign-in from Chrome when there is one (the user,
 * Oct 28: "a sort of last resort … other than that, we should just have
 * things work").
 */
function routesFor(proxy: string, straight: number): Route[] {
  const routes: Route[] = Array.from({ length: straight }, () => ({ proxy: null, signIn: false }));
  if (proxy !== "") routes.push({ proxy, signIn: false });
  // Chrome's folder is looked in only when it comes to this: macOS warns the
  // person whenever Edit reads another app's data (Oct 30: "Data Access Blocked").
  if (signInSupported && process.env.EDIT_YOUTUBE_SIGNIN !== "0") routes.push({ proxy: null, signIn: true });
  return routes;
}

function said(route: Route): string {
  return route.proxy !== null ? " (proxy)" : route.signIn ? " (with the YouTube sign-in from Chrome)" : "";
}

/** An excerpt's try is stopped after this. */
const EXCERPT_MS = 12 * 60_000;

/**
 * One yt-dlp run on `route`: the file it made, or what it said (never a
 * failure of its own: `reasonOf` reads the words). yt-dlp and the FFmpeg it
 * merges with are one process group, ended together when the try is stopped
 * (saying nothing for `timing.quiet`, an excerpt past `EXCERPT_MS`) or the
 * download is.
 */
const tryRoute = Effect.fn("youtube.tryRoute")(function* (
  binary: string,
  url: string,
  dir: string,
  route: Route,
  progress: Progress,
  range: [number, number] | null,
  format: string | null,
) {
  const proxy = route.proxy;
  const signIn = route.signIn ? cookieArgs() : [];
  if (route.signIn && signIn.length === 0) return { path: null, stderr: `ERROR: no YouTube sign-in in Chrome on ${THIS_MACHINE}` };
  const runtime = runtimeArgs();
  const args = [
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
    format ?? (proxy === null ? FORMAT : PROXY_FORMAT),
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
    "download:EDIT %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(info.filesize_approx)s %(info.title).120B",
    "--print",
    "after_move:EDIT-FILE %(filepath)s",
    ...(proxy === null ? [] : ["--proxy", proxy]),
    ...(proxy === null ? signIn : []),
    url,
  ];
  const env = runtimeEnv(runtime);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Two streams (video, then sound) are downloaded one after the other: the
  // bytes before the current one are carried. The total is the whole video's
  // (both streams, yt-dlp's estimate) from the start and never shrinks: it
  // was the picture's alone, and the bar went back (89% to 85%) as the sound began.
  let earlier = 0;
  let current = 0;
  let largest = 0;
  let path: string | null = null;
  let heard = Date.now();
  const line = (text: string) => {
    heard = Date.now();
    const said = text.trim();
    if (said.startsWith("EDIT-FILE ")) {
      path = said.slice("EDIT-FILE ".length);
    } else if (said.startsWith("EDIT ")) {
      const [bytes, total, estimate, approx, ...title] = said.slice("EDIT ".length).split(" ");
      const done = Number(bytes);
      if (!Number.isFinite(done)) return;
      if (done < current) earlier += current;
      current = done;
      const size = Number(total);
      const guess = Number(estimate);
      const whole = Number.isFinite(size) ? size : Number.isFinite(guess) ? guess : null;
      const both = Number(approx);
      largest = Math.max(largest, whole === null ? 0 : earlier + whole, Number.isFinite(both) ? both : 0, earlier + done);
      progress(earlier + done, largest > 0 ? largest : null, title.join(" "));
    }
  };
  const run = Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(binary, args, { stdin: "ignore", stdout: "pipe", stderr: "pipe", forceKillAfter: "5 seconds", ...(env ? { env, extendEnv: false } : {}) }),
    );
    const errors = yield* Stream.mkString(Stream.decodeText(handle.stderr)).pipe(Effect.orElseSucceed(() => ""), Effect.forkScoped);
    let pending = "";
    yield* Stream.runForEach(Stream.decodeText(handle.stdout), (text) =>
      Effect.sync(() => {
        heard = Date.now();
        pending += text;
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          line(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
      }),
    ).pipe(Effect.ignore);
    const code = Number(yield* handle.exitCode.pipe(Effect.orElseSucceed(() => -1)));
    return { code, stderr: yield* Fiber.join(errors) };
  }).pipe(
    Effect.scoped,
    Effect.catch((error) => Effect.succeed({ code: -1, stderr: `ERROR: yt-dlp couldn't start: ${error.message}` })),
  );
  // Nothing said for this long (no progress, no merge finishing): stopped, and
  // the try counts as a failed one, never a download frozen for good.
  const quiet = Effect.gen(function* () {
    for (;;) {
      yield* Effect.sleep(Math.min(timing.quiet, 5000));
      if (Date.now() - heard >= timing.quiet) return { code: -1, stderr: `${STOOD_STILL} (nothing for ${Math.round(timing.quiet / 60_000)} minutes).` };
    }
  });
  const watched = Effect.raceFirst(run, quiet);
  const ran = yield* range === null
    ? watched
    : watched.pipe(Effect.timeoutOrElse({ duration: EXCERPT_MS, orElse: () => Effect.succeed({ code: -1, stderr: "ERROR: The excerpt took more than 12 minutes and was stopped." }) }));
  if (ran.code !== 0) return { path: null, stderr: ran.stderr };
  // yt-dlp said yes and made nothing (a route withholding formats can hand
  // back only storyboards): say so in words `reasonOf` reads.
  // Set by `line` as the output came: the type checker can't see into it.
  const made = path as string | null;
  if (made === null) return { path: null, stderr: `${ran.stderr}\nERROR: The download did not produce a video.` };
  if (!fs.existsSync(made)) return { path: null, stderr: `${ran.stderr}\nERROR: The download did not produce a video (yt-dlp finished without the file it named).` };
  return { path: made, stderr: ran.stderr };
});

/** Download only a selected stretch, with exact cuts. Never fall back to a
 * whole stream: visual sourcing must not materialize hours for a few seconds. */
/** A preview's picture: H.264 in an mp4, 480p at most (Script mode's review clips). */
export const PREVIEW_FORMAT = "b[vcodec^=avc1][height<=480][ext=mp4]/bv*[vcodec^=avc1][height<=480]+ba[ext=m4a]/b[height<=480][ext=mp4]/bv*[height<=480]+ba/b";

export async function downloadRange(home: string, id: string, range: [number, number], dir: string, progress: (bytes: number, total: number | null, name: string) => void = () => {}, format: string | null = null): Promise<Downloaded> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id) || !range.every(Number.isFinite) || range[0] < 0 || range[1] <= range[0] || range[1] - range[0] > 600) throw new Error("YouTube excerpt needs a valid video and a source range of at most 10 minutes");
  fs.mkdirSync(dir, { recursive: true });
  const path = await runPromise(overRoutes(home, id, dir, 1, range, format, progress, `YouTube excerpt ${id} ${range[0]}–${range[1]} couldn't be downloaded`).pipe(inArea("youtube")));
  return { path, name: path.slice(dir.length + 1), size: fs.statSync(path).size };
}
