// YouTube with the editor's own sign-in, from Chrome: an age-restricted or
// members-only video (or a bot check) needs a signed-in YouTube, and the
// team signs in to YouTube in Chrome anyway. yt-dlp reads Chrome's cookies
// itself (`--cookies-from-browser chrome:<profile>`); Edit only works out
// which profile is signed in and says how it stands.
//
// macOS guards Chrome's cookies with a Keychain item ("Chrome Safe Storage").
// The first time, a Mac dialog asks: '"security" wants to use your
// confidential information stored in "Chrome Safe Storage"'; typing the Mac's
// password and choosing Always Allow is the whole set-up. `check` brings that
// dialog up while the editor is looking at Settings, not mid-import.
//
// Only cookie names are read here, never their values; the cookie file a
// check writes is deleted at once. The sign-in never goes through the paid
// proxy (youtube.ts): only straight from this Mac.

import * as fs from "node:fs";
import * as os from "node:os";
import { Database } from "bun:sqlite";

import * as diag from "./diag.ts";
import { join } from "./paths.ts";
import * as youtube from "./youtube.ts";

/** Where Chrome keeps its profiles (tests point it elsewhere). */
export const where = { chrome: join(os.homedir(), "Library", "Application Support", "Google", "Chrome") };

/** The cookies that say a YouTube account is signed in. */
const SIGNED_IN = ["LOGIN_INFO", "SAPISID", "__Secure-3PAPISID"];

export interface Profile {
  /** Its folder ("Default", "Profile 2"). */
  dir: string;
  /** Its name in Chrome ("Work"). */
  name: string;
  signedIn: boolean;
}

export interface SignIn {
  /** Chrome is on this Mac. */
  chrome: boolean;
  /** The profile Edit uses: the one used last that's signed in to YouTube, else the first signed in. */
  profile: Profile | null;
  profiles: Profile[];
  /** The last check: whether the Keychain let yt-dlp read the sign-in (null: never checked). */
  allowed: boolean | null;
  /** What the last check found wrong, in words for a person. */
  problem: string | null;
}

let lastCheck: { allowed: boolean; problem: string | null } | null = null;

/** Whether a profile's cookies hold a YouTube sign-in (names only: a copy is read, Chrome may hold the file). */
function signedIn(folder: string): boolean {
  for (const file of [join(folder, "Network", "Cookies"), join(folder, "Cookies")]) {
    if (!fs.existsSync(file)) continue;
    const copy = join(os.tmpdir(), `edit-chrome-cookies-${process.pid}-${Date.now()}`);
    try {
      fs.copyFileSync(file, copy);
      const db = new Database(copy, { readonly: true });
      try {
        const marks = SIGNED_IN.map(() => "?").join(",");
        const row = db
          .query(`SELECT COUNT(*) AS n FROM cookies WHERE host_key IN ('.youtube.com', 'youtube.com', 'www.youtube.com') AND name IN (${marks})`)
          .get(...SIGNED_IN) as { n: number } | null;
        return (row?.n ?? 0) > 0;
      } finally {
        db.close();
      }
    } catch (error) {
      diag.warn("youtube", `reading Chrome's cookie names in ${folder}: ${diag.messageOf(error)}`);
      return false;
    } finally {
      fs.rmSync(copy, { force: true });
    }
  }
  return false;
}

/** How the YouTube sign-in from Chrome stands on this Mac. */
export function status(): SignIn {
  const root = where.chrome;
  const none: SignIn = { chrome: false, profile: null, profiles: [], allowed: lastCheck?.allowed ?? null, problem: lastCheck?.problem ?? null };
  if (!fs.existsSync(root)) return none;
  let names: Record<string, { name?: string }> = {};
  let lastUsed: string | null = null;
  try {
    const state = JSON.parse(fs.readFileSync(join(root, "Local State"), "utf8")) as { profile?: { info_cache?: Record<string, { name?: string }>; last_used?: string } };
    names = state.profile?.info_cache ?? {};
    lastUsed = state.profile?.last_used ?? null;
  } catch {
    // No Local State: the folders are enough.
  }
  const dirs = fs
    .readdirSync(root)
    .filter((dir) => dir === "Default" || /^Profile \d+$/.test(dir))
    .sort((a, b) => (a === "Default" ? -1 : b === "Default" ? 1 : a.localeCompare(b, undefined, { numeric: true })));
  const profiles = dirs.map((dir) => ({ dir, name: names[dir]?.name ?? dir, signedIn: signedIn(join(root, dir)) }));
  const profile = profiles.find((one) => one.signedIn && one.dir === lastUsed) ?? profiles.find((one) => one.signedIn) ?? null;
  return { ...none, chrome: true, profile, profiles };
}

/** yt-dlp's arguments for the sign-in, or none when Chrome has no YouTube sign-in. */
export function cookieArgs(): string[] {
  if (process.platform !== "darwin" || process.env.EDIT_YOUTUBE_SIGNIN === "0") return [];
  try {
    const profile = status().profile;
    return profile === null ? [] : ["--cookies-from-browser", `chrome:${join(where.chrome, profile.dir)}`];
  } catch (error) {
    diag.warn("youtube", `looking for Chrome's YouTube sign-in: ${diag.messageOf(error)}`);
    return [];
  }
}

/**
 * Asks yt-dlp to read the sign-in now (bringing up the Mac's Keychain dialog
 * the first time) and says whether it could. A public video is looked up, not
 * downloaded; the cookie file it writes is deleted at once.
 */
export async function check(home: string): Promise<SignIn> {
  const now = status();
  if (!now.chrome) {
    lastCheck = { allowed: false, problem: "Chrome isn't on this Mac." };
    return { ...now, ...lastCheck };
  }
  if (now.profile === null) {
    lastCheck = { allowed: false, problem: "None of Chrome's profiles is signed in to YouTube." };
    return { ...now, ...lastCheck };
  }
  const jar = join(os.tmpdir(), `edit-youtube-check-${process.pid}-${Date.now()}.txt`);
  try {
    const binary = await youtube.ytdlp(home);
    const runtime = youtube.runtimeArgs();
    const child = Bun.spawn(
      [binary, "--ignore-config", "--no-warnings", "--skip-download", "--simulate", "--no-playlist", ...runtime, ...cookieArgs(), "--cookies", jar, "https://www.youtube.com/watch?v=jNQXAC9IVRw"],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: youtube.runtimeEnv(runtime) },
    );
    // The Keychain dialog waits for the person: give them time to answer it.
    const timer = setTimeout(() => child.kill(), 3 * 60_000);
    const [stderr] = await Promise.all([new Response(child.stderr).text(), child.exited]).finally(() => clearTimeout(timer));
    let read = false;
    try {
      read = fs
        .readFileSync(jar, "utf8")
        .split("\n")
        .some((line) => {
          const cells = line.split("\t");
          return cells.length >= 7 && cells[0]!.endsWith("youtube.com") && SIGNED_IN.includes(cells[5]!) && cells[6]!.trim() !== "";
        });
    } catch {
      read = false;
    }
    if (read) lastCheck = { allowed: true, problem: null };
    else if (/keychain|Safe Storage|decrypt/i.test(stderr)) lastCheck = { allowed: false, problem: "The Mac didn't let Edit read Chrome's sign-in (the Keychain dialog was denied or closed)." };
    else lastCheck = { allowed: false, problem: "Edit couldn't read the YouTube sign-in from Chrome." };
    if (!read) diag.warn("youtube", `checking the YouTube sign-in: ${diag.scrub(stderr.trim().split("\n").slice(-2).join(" "))}`);
  } finally {
    fs.rmSync(jar, { force: true });
  }
  return { ...status(), ...lastCheck };
}
