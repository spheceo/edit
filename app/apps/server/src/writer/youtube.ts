// YouTube for Script mode: which links it takes, what a video is before it
// downloads, and the download itself, through Edit's own (youtube.ts: its
// yt-dlp, format, proxy and the editor's sign-in from Chrome). A video comes
// down once into Edit's media folder, where Edit mode finds it too, and the
// script plays that same file.

import * as fs from "node:fs";

import type { App } from "../app.ts";
import { join } from "../paths.ts";
import * as edit from "../youtube.ts";
import { run } from "./proc.ts";

/** A single YouTube watch or short link. Other hosts are refused so yt-dlp is not pointed at an arbitrary site. */
export function checkUrl(raw: string): void {
  const url = raw.trim();
  if (url === "" || /[\p{Cc}\s]/u.test(url)) throw new Error("Paste one YouTube link.");
  if (!url.startsWith("https://")) throw new Error("Use an https YouTube link.");
  const rest = url.slice(8);
  const slash = rest.indexOf("/");
  const host = (slash < 0 ? rest : rest.slice(0, slash)).split(":")[0];
  const path = (slash < 0 ? "" : rest.slice(slash + 1)).split("?")[0]!;
  const ok = ["www.youtube.com", "youtube.com", "m.youtube.com"].includes(host ?? "") ? path.startsWith("watch") || path.startsWith("shorts/") : host === "youtu.be" && path !== "" && !path.includes("/");
  if (!ok) throw new Error("That is not a YouTube video link.");
}

export const isYoutube = (url: string): boolean => {
  try {
    checkUrl(url);
    return true;
  } catch {
    return false;
  }
};

/** What a video is, checked before anything downloads, as Repack checks its videos: its title, channel and length, or why it can't be imported. */
export interface Probe {
  title: string;
  channel: string;
  durationMs?: number | null;
  problem?: string | null;
  /** Something that couldn't be checked but may still import (through the proxy). */
  warning?: string | null;
}

/** Titles the New script check just read, by link, so the import that follows doesn't ask YouTube again. */
const checked = new Map<string, [string, number]>();

async function ytdlp(app: App, args: string[], timeoutMs: number): Promise<string> {
  const binary = await edit.ytdlp(app.store.home);
  const runtime = edit.runtimeArgs();
  return run(binary, [...runtime, ...args], { timeoutMs, env: edit.runtimeEnv(runtime) ?? process.env });
}

export async function title(app: App, url: string): Promise<string> {
  const known = checked.get(url);
  if (known !== undefined && Date.now() - known[1] < 3_600_000) return known[0];
  try {
    const text = await ytdlp(app, ["--no-playlist", "--skip-download", "--print", "%(title)s", url], 60_000);
    const line = text.split("\n").find((one) => one.trim() !== "")?.trim().replace(/[\r\n]/g, " ");
    return line ? [...line].slice(0, 180).join("") : "YouTube video";
  } catch {
    return "YouTube video";
  }
}

export async function probe(app: App, url: string): Promise<Probe> {
  let said: string;
  try {
    said = await ytdlp(app, ["--no-playlist", "--skip-download", "--dump-single-json", "--no-warnings", url], 90_000);
  } catch (error) {
    const [why, blocking] = probeTrouble(error instanceof Error ? error.message : String(error));
    return blocking ? { title: "", channel: "", problem: why } : { title: "", channel: "", warning: why };
  }
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(said.trim()) as Record<string, unknown>;
  } catch {
    return { title: "", channel: "", problem: "YouTube didn't say what this video is." };
  }
  const name = [...(typeof info.title === "string" ? info.title : "YouTube video")].slice(0, 180).join("");
  if (typeof info.title === "string") checked.set(url, [name, Date.now()]);
  const channel = typeof info.channel === "string" ? info.channel : typeof info.uploader === "string" ? info.uploader : "";
  const seconds = typeof info.duration === "number" && info.duration > 0 ? info.duration : null;
  const durationMs = seconds === null ? null : Math.floor(seconds * 1000);
  const live = typeof info.live_status === "string" ? info.live_status : "";
  const problem =
    info.is_live === true || live === "is_live"
      ? "It's live now; import it once the stream has ended."
      : live === "is_upcoming"
        ? "It hasn't premiered yet."
        : Number(info.age_limit ?? 0) >= 18
          ? "It's age-restricted, so it can't be downloaded."
          : durationMs === null
            ? "YouTube doesn't give its length."
            : durationMs > 10 * 3_600_000
              ? "It runs over 10 hours."
              : null;
  return { title: name, channel, durationMs, problem, warning: null };
}

/** yt-dlp's failure as a reason a person can act on, and whether it stops the import (a sign-in or connection trouble may not). */
function probeTrouble(error: string): [string, boolean] {
  const lower = error.toLowerCase();
  if (lower.includes("private video")) return ["It's private.", true];
  if (lower.includes("confirm your age") || lower.includes("age-restricted") || lower.includes("inappropriate")) return ["It's age-restricted, so it can't be downloaded.", true];
  if (lower.includes("not a bot") || lower.includes("sign in")) return ["YouTube asked this Mac to sign in, so it couldn't be checked. It should still import through the proxy.", false];
  if (["unavailable", "removed", "does not exist", "terminated"].some((word) => lower.includes(word))) return ["It's no longer available.", true];
  if (lower.includes("premiere") || lower.includes("live event")) return ["It hasn't premiered yet.", true];
  return ["YouTube couldn't be asked about it, so it wasn't checked. Check the link opens.", false];
}

/**
 * Brings video `url` down once into Edit's media folder (where Edit mode
 * finds it too) and answers its path; `onPercent` hears how far it is.
 */
export async function fetch(app: App, url: string, onPercent: (percent: number) => void = () => {}): Promise<string> {
  const id = edit.videoId(url);
  if (id === null) throw new Error("That is not a YouTube video link.");
  const dir = join(app.store.driveDir(), "youtube", id);
  const got = await edit.download(app.store.home, id, dir, (bytes, total) => onPercent(total ? Math.min(100, Math.floor((bytes * 100) / total)) : 0));
  return got.path;
}

/**
 * Puts the shared download at `dest` in a script's folder: the same file,
 * hard-linked, when they're on one disk; else the script keeps pointing at
 * the shared one (answered).
 */
export function place(shared: string, dest: string): string {
  try {
    if (fs.existsSync(dest)) fs.rmSync(dest);
    fs.linkSync(shared, dest);
    return dest;
  } catch {
    return shared;
  }
}
