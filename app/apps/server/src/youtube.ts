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
// use). YouTube is asked straight from this Mac; when it refuses (a bot check,
// 403s), and `PROXY_URL` is set (Repack's download proxy; `just dev` borrows
// it), once more through the proxy. The proxy URL is a credential: never in a
// log line or an error.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import * as tools from "./tools.ts";
import { compiled } from "./update.ts";
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
let fetching: Promise<string> | null = null;

/** The yt-dlp to run: `EDIT_YTDLP`, PATH, or Edit's own copy (fetched once). */
export async function ytdlp(home: string): Promise<string> {
  const set = process.env.EDIT_YTDLP;
  if (set !== undefined && set !== "") return set;
  const found = Bun.which("yt-dlp");
  if (found !== null) return found;
  const own = join(home, "bin", "yt-dlp");
  if (fs.existsSync(own)) return own;
  fetching ??= fetchYtdlp(own).finally(() => {
    fetching = null;
  });
  return fetching;
}

async function fetchYtdlp(to: string): Promise<string> {
  return diag.timeOnAsync("youtube", "youtube: fetch yt-dlp", to, async () => {
    const asset = "yt-dlp_macos";
    const get = async (name: string): Promise<Uint8Array> => {
      const response = await fetch(`${RELEASE}/${name}`, { redirect: "follow" });
      if (!response.ok) throw new Error(`fetching yt-dlp: ${response.status} for ${name}`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const [binary, sums] = await Promise.all([get(asset), get("SHA2-256SUMS")]);
    const line = new TextDecoder()
      .decode(sums)
      .split("\n")
      .find((row) => row.trim().endsWith(` ${asset}`));
    const expected = line?.trim().split(/\s+/)[0];
    const actual = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
    if (expected === undefined || expected !== actual) throw new Error("the yt-dlp download didn't match its checksum");
    fs.mkdirSync(parent(to)!, { recursive: true });
    const part = `${to}.part-${process.pid}`;
    fs.writeFileSync(part, binary, { mode: 0o755 });
    fs.renameSync(part, to);
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
 * yt-dlp's JavaScript runtime for YouTube's challenges: Deno by default; Node
 * or Bun when that's what this Mac has; else the compiled `edit` itself, which
 * is Bun under BUN_BE_BUN=1 (see `runtimeEnv`), so a Mac needs none installed.
 */
function runtimeArgs(): string[] {
  if (Bun.which("deno") !== null) return [];
  if (Bun.which("node") !== null) return ["--js-runtimes", "node"];
  if (Bun.which("bun") !== null) return ["--js-runtimes", "bun"];
  if (compiled()) return ["--js-runtimes", `bun:${process.execPath}`];
  return [];
}

/** yt-dlp's environment: BUN_BE_BUN=1 when it runs `edit` as its Bun. */
function runtimeEnv(args: string[]): Record<string, string | undefined> | undefined {
  return args.some((arg) => arg.startsWith("bun:")) ? { ...process.env, BUN_BE_BUN: "1" } : undefined;
}

// H.264 (the hardware decodes it everywhere; YouTube's AV1 doesn't on an M1)
// over plain HTTPS, up to 1080p, with the original sound: yt-dlp ranks the
// original track above YouTube's dubs. A progressive MP4 when there's no DASH.
const FORMAT = "bv*[vcodec^=avc1][height<=1080][protocol=https]+ba[ext=m4a][protocol=https]/b[vcodec^=avc1][ext=mp4]/bv*[height<=1080]+ba/b";
/** Through the paid proxy ($1/GB): at most 720p, about half the bytes of 1080p (the audit, Oct 23). */
const PROXY_FORMAT = "bv*[vcodec^=avc1][height<=720][protocol=https]+ba[ext=m4a][protocol=https]/b[vcodec^=avc1][ext=mp4][height<=720]/bv*[height<=720]+ba/b[height<=720]/b";

/** Whether yt-dlp's words say YouTube refused this Mac (worth the proxy). */
function refused(stderr: string): boolean {
  return /not a bot|HTTP Error 403|HTTP Error 429|Sign in to confirm|page needs to be reloaded/i.test(stderr);
}

/** yt-dlp's error line, without anything credential-like. */
function errorLine(stderr: string): string {
  const lines = stderr.split("\n").filter((line) => line.trim() !== "");
  const error = lines.reverse().find((line) => line.startsWith("ERROR:")) ?? lines[0] ?? "yt-dlp failed";
  return diag.scrub(error.replace(/^ERROR:\s*/, "").replace(/https?:\/\/[^\s@]*@[^\s]*/g, "<proxy>"));
}

export interface Downloaded {
  path: string;
  name: string;
  size: number;
}

const running = new Map<string, Promise<Downloaded>>();

/** The wait before asking YouTube again (tests make it instant). */
export const timing = { pause: (ms: number): Promise<void> => Bun.sleep(ms) };

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
  const binary = await ytdlp(home);
  const url = `https://www.youtube.com/watch?v=${id}`;
  const proxy = process.env.PROXY_URL?.trim() ?? "";
  // Straight first (it costs nothing), a second time straight (YouTube's
  // refusals come and go), then through the proxy when there is one.
  const routes: (string | null)[] = [null, null, ...(proxy !== "" ? [proxy] : [])];
  let failure = "";
  for (const [attempt, route] of routes.entries()) {
    const result = await diag.timeOnAsync("youtube", "youtube: download", `${id}${route === null ? "" : " (proxy)"}`, () =>
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
    const last = attempt === routes.length - 1;
    if (last || !refused(result.stderr)) break;
    diag.warn("youtube", `${id}: ${failure}; trying again${routes[attempt + 1] === null ? "" : " through the proxy"}`);
    await timing.pause(attempt === 0 ? 3000 : 1000);
  }
  throw new Error(`YouTube video ${id} couldn't be downloaded: ${failure}`);
}

async function runYtdlp(
  binary: string,
  url: string,
  dir: string,
  proxy: string | null,
  progress: (bytes: number, total: number | null, name: string) => void,
  range: [number, number] | null = null,
): Promise<{ path: string | null; stderr: string }> {
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
  const lines = async () => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of child.stdout) {
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
  finally { if (timer !== null) clearTimeout(timer); }
  if (code !== 0 || path === null) return { path: null, stderr };
  if (!fs.existsSync(path)) return { path: null, stderr: `${stderr}\nERROR: yt-dlp finished without the file it named` };
  return { path, stderr };
}

/** Download only a selected stretch, with exact cuts. Never fall back to a
 * whole stream: visual sourcing must not materialize hours for a few seconds. */
export async function downloadRange(home: string, id: string, range: [number, number], dir: string, progress: (bytes: number, total: number | null, name: string) => void = () => {}): Promise<Downloaded> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id) || !range.every(Number.isFinite) || range[0] < 0 || range[1] <= range[0] || range[1] - range[0] > 600) throw new Error("YouTube excerpt needs a valid video and a source range of at most 10 minutes");
  fs.mkdirSync(dir, { recursive: true });
  const binary = await ytdlp(home); const proxy = process.env.PROXY_URL?.trim() ?? "";
  const routes = [null, ...(proxy ? [proxy] : [])];
  let failure = "";
  for (const route of routes) {
    const result = await runYtdlp(binary, `https://www.youtube.com/watch?v=${id}`, dir, route, progress, range);
    if (result.path !== null) return { path: result.path, name: result.path.slice(dir.length + 1), size: fs.statSync(result.path).size };
    failure = errorLine(result.stderr);
    if (!refused(result.stderr)) break;
  }
  throw new Error(`YouTube excerpt ${id} ${range[0]}–${range[1]} couldn't be downloaded: ${failure}`);
}
