// Posts: an Instagram reel or carousel item, an X, TikTok, Reddit or Facebook
// video, as a script or the agent links it. A horror script is the story's
// own posts between its narration ("Take a look at this:" and the reel's
// link), so a post is footage like a Drive file or a YouTube video: its file
// in a script is `post:<the link, base64url>` (a file id stays one path-safe
// word, as edit-core's validate holds every script file), downloaded whole
// (posts are short) by yt-dlp, which reads these sites without a sign-in.

import * as fs from "node:fs";

import { join } from "./paths.ts";
import * as youtube from "./youtube.ts";
import { NeedsPerson } from "./import_steps.ts";

export const PREFIX = "post:";

/** The sites whose posts are footage; an article or any other page is evidence (capture_evidence), not footage. */
const SITES = ["instagram.com", "x.com", "twitter.com", "tiktok.com", "reddit.com", "v.redd.it", "facebook.com", "fb.watch", "streamable.com", "vimeo.com", "dailymotion.com", "rumble.com", "twitch.tv", "kick.com"];

function siteOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase().replace(/^(www|m|mobile|old|vm)\./u, "");
    return SITES.find((site) => host === site || host.endsWith(`.${site}`)) ?? null;
  } catch {
    return null;
  }
}

/** A post's link without its tracking, else null when it isn't a post. */
export function canonical(url: string): string | null {
  if (siteOf(url) === null) return null;
  const parsed = new URL(url);
  // Instagram's carousel item (img_index) picks the video; the rest (?s=20, igsh, utm) is tracking.
  const keep = parsed.searchParams.get("img_index");
  parsed.search = keep !== null && /^\d+$/u.test(keep) ? `?img_index=${keep}` : "";
  parsed.hash = "";
  return parsed.toString();
}

/** A post's script file (`post:<its canonical link, base64url>`), else null. */
export function fileOf(url: string): string | null {
  const link = canonical(url);
  return link === null ? null : `${PREFIX}${Buffer.from(link, "utf8").toString("base64url")}`;
}

/** The link of a post's script file, else null. */
export function urlOf(file: string): string | null {
  if (!file.startsWith(PREFIX)) return null;
  const encoded = file.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
  const link = Buffer.from(encoded, "base64url").toString("utf8");
  return siteOf(link) !== null ? link : null;
}

/** A name for a post's file: its site and its id ("instagram DU6q9WeEjRX"). */
export function nameOf(url: string): string {
  const site = siteOf(url)?.split(".")[0] ?? "post";
  const id = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "post";
  return `${site} ${id.replace(/[^A-Za-z0-9_-]/gu, "")}`;
}

/**
 * Downloads a post's video into `dir` once (a second call finds it): the
 * whole post, or its carousel item. A failure says yt-dlp's own last error
 * (an image-only post, a private account, a removed post).
 */
export async function download(home: string, url: string, dir: string, progress: (bytes: number, total: number | null, name: string) => void = () => {}): Promise<{ path: string; name: string; size: number }> {
  fs.mkdirSync(dir, { recursive: true });
  const key = Bun.hash(url).toString(16);
  const found = () => fs.readdirSync(dir).find((f) => f.startsWith(`${key}.`) && /\.(mp4|mov|webm|mkv)$/u.test(f));
  const name = `${nameOf(url)}.mp4`;
  const had = found();
  if (had !== undefined) {
    const size = fs.statSync(join(dir, had)).size;
    progress(size, size, name);
    return { path: join(dir, had), name, size };
  }
  const item = new URL(url).searchParams.get("img_index");
  const binary = await youtube.ytdlp(home);
  const child = Bun.spawn([binary, "--no-warnings", "--socket-timeout", "20", "-f", "bv*+ba/b", "--merge-output-format", "mp4", "--max-filesize", "800M",
    ...(item !== null && /^\d+$/u.test(item) ? ["--playlist-items", item] : ["--no-playlist"]), "-o", join(dir, `${key}.%(ext)s`), url], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 300_000);
  try {
    const [, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const got = found();
    if (code !== 0 || got === undefined) {
      const why = err.trim().split("\n").filter((line) => line.startsWith("ERROR")).pop()?.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/u, "").slice(0, 300) ?? "the download failed or timed out";
      // Said plainly, and never tried again by itself: neither changes on its own.
      if (/no video in this post|no video formats found/iu.test(why)) throw new NeedsPerson(`That post is pictures only, with no video to play. Go on without it (the edit can show it as a screenshot), or give another link.`);
      if (/empty media response|login required|log in|cookies/iu.test(why)) throw new NeedsPerson(`That post is only shown to someone signed in to ${siteOf(url)?.split(".")[0] ?? "the site"}. Go on without it, or give another link to the same video.`);
      throw new Error(`${nameOf(url)}: ${why}`);
    }
    const size = fs.statSync(join(dir, got)).size;
    progress(size, size, name);
    return { path: join(dir, got), name, size };
  } finally {
    clearTimeout(timer);
  }
}
