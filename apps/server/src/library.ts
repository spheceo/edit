// The team's sound library (library.rs): a Google Drive folder ("Music & SFX
// Library", a folder per category under "Music" and "Sound effects") is the
// source of truth. Edit lists it through the Drive API and downloads a sound
// the first time it's used, into `<home>/library/<music|sfx>/<checksum>/`.
// Nothing is bundled with Edit.
//
// The folder is private, so Edit needs a Google sign-in that can read it: the
// relay hands out a short-lived one to Edits with the cloud token (Settings →
// Cloud), and a machine with GOOGLE_DRIVE_CLIENT_ID,
// GOOGLE_DRIVE_CLIENT_SECRET and GOOGLE_DOCS_REFRESH_TOKEN set signs in
// itself (`just dev` reads Repack's from Infisical).
//
// Beside the sounds sit an index (a .txt with a note per file, "first ~20
// seconds, low volume") and a usage guide (a Doc on what each category is
// for); both are read with the listing.
//
// Every Google call goes through curl with the sign-in on stdin (never in a
// process's arguments), as the Rust server did: the same retries and stall
// limits on downloads, and drive.ts shares `curl`.
//
// The loudness half (`loudness`, `levels`, `gainTo`, `footageLoudness`) is
// arithmetic over the addon's analysis of each file (`loudnessSpans`).

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { google, googleProto } from "./endpoints.ts";
import { catchBugsAsync } from "./guard.ts";
import { importPaths } from "./import.ts";
import { Semaphore } from "./media.ts";
import * as relay from "./relay.ts";
import type { AudioClip, Clip, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { join } from "./paths.ts";
import { fps as fpsOf, isSoundEffect, mediaOf } from "./project.ts";
import { debugStrings, lines, serdeParse, trim } from "./rust.ts";
import * as seams from "./seams.ts";
import type { Sound } from "./seams.ts";
import { compareKeys } from "./stable.ts";

export type { Sound } from "./seams.ts";

/** "Music & SFX Library" in the team's Drive. */
const DEFAULT_FOLDER = "1GngDWLQUNOYEnI068QsEkoAfHPAuZAyM";
const API = "https://www.googleapis.com/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const DOC = "application/vnd.google-apps.document";
/** Drive is read again after this, so a sound added there shows up without a restart. */
const FRESH_MS = 120_000;
const AUDIO = ["wav", "mp3", "m4a", "aif", "aiff", "flac", "ogg", "aac"];
/** Longer sound effects are beds (drones, heartbeats): no hit to line up. */
const HIT_SECONDS = 15.0;

/** A sound as listed, with what the listing keeps to itself (its file name and checksum). */
export interface Found extends Sound {
  file: string;
  md5: string;
}

/** What the library holds (library.rs Listing), as the UI gets it. */
export interface Listing {
  sounds: Found[];
  /** The usage guide, as plain text. */
  guide: string;
}

/** A sound as serde writes it (`file` and `md5` are skipped, `note` when there is none), fields in its order. */
export function shown(sound: Found): Sound {
  const out = { id: sound.id, name: sound.name, kind: sound.kind, category: sound.category } as Sound;
  if (sound.note !== undefined) out.note = sound.note;
  out.bytes = sound.bytes;
  return out;
}

/** The listing as `GET /api/library` answers it. */
export function listingJson(listing: Listing): { sounds: Sound[]; guide: string } {
  return { sounds: listing.sounds.map(shown), guide: listing.guide };
}

function find(listing: Listing, id: string): Found | undefined {
  return listing.sounds.find((sound) => sound.id === id);
}

export class Library implements seams.Library {
  private token: [string, number] | null = null;
  private listing: [number, Listing] | null = null;
  private refreshing = false;
  /** One download per file at a time. */
  private downloads = new Map<string, Semaphore>();
  /** How time passes (tests move it). */
  now: () => number = () => performance.now();

  /**
   * What's in the library. Once read, it answers at once; when the listing
   * is a couple of minutes old, Drive is read again behind the answer.
   */
  async list(refresh: boolean): Promise<Listing> {
    if (!refresh && this.listing !== null) {
      const [at, listing] = this.listing;
      if (this.now() - at >= FRESH_MS && !this.refreshing) {
        this.refreshing = true;
        void catchBugsAsync("rereading the library", () => this.reread())
          .catch(() => {})
          .finally(() => {
            this.refreshing = false;
          });
      }
      return listing;
    }
    return this.reread();
  }

  private async reread(): Promise<Listing> {
    const listing = await this.read();
    this.listing = [this.now(), listing];
    return listing;
  }

  private async read(): Promise<Listing> {
    const given = process.env.EDIT_LIBRARY_FOLDER;
    const root = given !== undefined ? given : DEFAULT_FOLDER;
    const sounds: Found[] = [];
    let index = "";
    let guide = "";
    let level: [string, string[]][] = [[root, []]];
    while (level.length > 0) {
      // Each folder is a request: read a level of them at once.
      const read = await Promise.allSettled(level.map(([folder]) => this.children(folder)));
      const next: [string, string[]][] = [];
      for (let at = 0; at < level.length; at++) {
        const [, path] = level[at]!;
        const result = read[at]!;
        if (result.status === "rejected") throw result.reason;
        for (const entry of result.value) {
          const id = typeof entry.id === "string" ? entry.id : "";
          const name = typeof entry.name === "string" ? entry.name : "";
          const mime = typeof entry.mimeType === "string" ? entry.mimeType : "";
          if (mime === FOLDER) {
            next.push([id, [...path, name]]);
          } else if (path.length === 0 && mime === DOC) {
            guide = await this.text(`${API}/files/${id}/export?mimeType=text/plain`);
          } else if (path.length === 0 && name.endsWith(".txt")) {
            index = await this.text(`${API}/files/${id}?alt=media`);
          } else {
            const dot = name.lastIndexOf(".");
            if (dot < 0 || path.length === 0) continue;
            const stem = name.slice(0, dot);
            const ext = name.slice(dot + 1);
            if (!AUDIO.includes(ext.toLowerCase())) continue;
            const [top, ...rest] = path as [string, ...string[]];
            const size = typeof entry.size === "string" && /^\+?\d+$/.test(entry.size) ? Number(entry.size.replace("+", "")) : 0;
            sounds.push({
              id,
              // Every Epidemic download ends in its name; it says nothing.
              name: trimEndMatches(stem, " - Epidemic Sound"),
              kind: top.replace(/[A-Z]/g, (c) => c.toLowerCase()) === "music" ? "music" : "sfx",
              category: rest.join(" / "),
              bytes: size,
              md5: typeof entry.md5Checksum === "string" ? entry.md5Checksum : id,
              file: name,
            });
          }
        }
      }
      level = next;
    }
    const found = notes(index);
    for (const sound of sounds) {
      const note = found.get(sound.id) ?? found.get(sound.file);
      if (note !== undefined) sound.note = note;
      else delete sound.note;
    }
    const order = (a: Found, b: Found) =>
      compareKeys(a.kind, b.kind) || compareKeys(a.category, b.category) || compareKeys(a.name, b.name);
    sounds.sort(order);
    return { sounds: sounds.map(ordered), guide: trim(trimStartMatches(guide, "\u{feff}")) };
  }

  private async children(folder: string): Promise<Record<string, unknown>[]> {
    const files: Record<string, unknown>[] = [];
    let page = "";
    for (;;) {
      const query = `'${folder}' in parents and trashed = false`;
      let url = `${API}/files?q=${encode(query)}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=nextPageToken,files(id,name,mimeType,size,md5Checksum)`;
      if (page !== "") url += `&pageToken=${encode(page)}`;
      let value: unknown;
      try {
        value = serdeParse(await this.text(url));
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error(error.message);
        throw error;
      }
      const listed = (value as { files?: unknown } | null)?.files;
      if (Array.isArray(listed)) files.push(...(listed as Record<string, unknown>[]));
      const next = (value as { nextPageToken?: unknown } | null)?.nextPageToken;
      if (typeof next === "string") page = next;
      else return files;
    }
  }

  /** A Drive API answer as text. */
  private async text(url: string): Promise<string> {
    const config = `header = ${quote(`Authorization: Bearer ${await this.accessToken()}`)}\n`;
    const [code, body] = await curl(config, ["--max-time", "60", url]);
    const text = new TextDecoder().decode(body);
    if (code !== 200) throw new Error(driveError(code, text));
    return text;
  }

  /**
   * An access token for the team's Google Drive sign-in (scope: all of
   * Drive), cached until shortly before it expires. Never log it.
   */
  async accessToken(): Promise<string> {
    if (this.token !== null && this.now() < this.token[1]) return this.token[0];
    const [id, secret, refresh] = ["GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET", "GOOGLE_DOCS_REFRESH_TOKEN"].map(
      (name) => {
        const value = process.env[name];
        return value !== undefined && value !== "" ? value : null;
      },
    );
    if (id === null || secret === null || refresh === null || id === undefined || secret === undefined || refresh === undefined) {
      if (relay.token() === null) {
        throw new Error(
          "The sound library and Google Drive need the team's sign-in: paste the cloud token in Settings → Cloud (or start Edit with GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET and GOOGLE_DOCS_REFRESH_TOKEN set).",
        );
      }
      // The relay keeps the sign-in and hands out an access token for an hour.
      const given = await relay.json<{ access_token?: unknown; expires_in?: unknown }>("POST", "/v1/cloud/google/token", {}, "Google sign-in", 30);
      if (typeof given.access_token !== "string") throw new Error("the relay's Google sign-in came back without a token");
      const lasts = typeof given.expires_in === "number" && given.expires_in > 0 ? given.expires_in : 3600;
      this.token = [given.access_token, this.now() + Math.max(lasts - 120, 0) * 1000];
      return given.access_token;
    }
    const config = (
      [
        ["client_id", id],
        ["client_secret", secret],
        ["refresh_token", refresh],
        ["grant_type", "refresh_token"],
      ] as const
    )
      .map(([name, value]) => `data-urlencode = ${quote(`${name}=${value}`)}\n`)
      .join("");
    const [code, body] = await curl(config, ["--max-time", "30", "https://oauth2.googleapis.com/token"]);
    let value: unknown = null;
    try {
      value = serdeParse(new TextDecoder().decode(body));
    } catch {
      value = null;
    }
    const token = (value as { access_token?: unknown } | null)?.access_token;
    if (typeof token !== "string" || code !== 200) throw new Error(`Google refused the Drive sign-in (${code}).`);
    const expires = (value as { expires_in?: unknown }).expires_in;
    const lasts = Math.max((typeof expires === "number" && Number.isInteger(expires) && expires >= 0 ? expires : 3600) - 120, 0);
    this.token = [token, this.now() + lasts * 1000];
    return token;
  }

  /** Forgets the cached sign-in (tests). */
  forgetToken(): void {
    this.token = null;
  }

  /**
   * The sound's file on disk, downloaded if missing. The folder is named
   * after the file's checksum, so a sound replaced in Drive is a new file
   * and projects using the old one keep it.
   */
  async file(home: string, sound: Found): Promise<string> {
    const dir = join(home, "library", sound.kind, sound.md5.length >= 12 ? sound.md5.slice(0, 12) : sound.md5);
    const path = join(dir, safeName(sound.file));
    if (isFile(path)) return path;
    // One download per file at a time (two sounds in Drive can be the same
    // file): a second ask for it waits, then finds it there. Other sounds
    // download meanwhile.
    let lock = this.downloads.get(path);
    if (lock === undefined) {
      lock = new Semaphore(1);
      this.downloads.set(path, lock);
    }
    return lock.with(async () => {
      if (isFile(path)) return path;
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (error) {
        throw new Error(diag.messageOf(error));
      }
      const part = join(dir, `.${safeName(sound.file)}.download`);
      const config = `header = ${quote(`Authorization: Bearer ${await this.accessToken()}`)}\n`;
      const url = `${API}/files/${sound.id}?alt=media&supportsAllDrives=true`;
      const started = performance.now();
      let code: number;
      try {
        [code] = await curl(config, [
          "--retry",
          "3",
          "--connect-timeout",
          "20",
          // A stalled download gives up (and is retried) rather than holding
          // the sound forever.
          "--speed-limit",
          "1024",
          "--speed-time",
          "20",
          "--max-time",
          "600",
          "-o",
          part,
          url,
        ]);
      } catch (error) {
        fs.rmSync(part, { force: true });
        throw error;
      }
      diag.record("library", "library: download", performance.now() - started, code !== 200 ? "refused" : null);
      if (code !== 200) {
        let body = "";
        try {
          body = fs.readFileSync(part, "utf8");
        } catch {
          body = "";
        }
        fs.rmSync(part, { force: true });
        throw new Error(driveError(code, body));
      }
      try {
        fs.renameSync(part, path);
      } catch (error) {
        throw new Error(diag.messageOf(error));
      }
      return path;
    });
  }
}

/** A sound's fields in serde's order (id, name, kind, category, note, bytes, then the skipped ones). */
function ordered(sound: Found): Found {
  const out = { id: sound.id, name: sound.name, kind: sound.kind, category: sound.category } as Found;
  if (sound.note !== undefined) out.note = sound.note;
  out.bytes = sound.bytes;
  out.file = sound.file;
  out.md5 = sound.md5;
  return out;
}

/** `str::trim_end_matches`: every trailing `suffix` off. */
function trimEndMatches(text: string, suffix: string): string {
  let out = text;
  while (suffix !== "" && out.endsWith(suffix)) out = out.slice(0, out.length - suffix.length);
  return out;
}

function trimStartMatches(text: string, prefix: string): string {
  let out = text;
  while (prefix !== "" && out.startsWith(prefix)) out = out.slice(prefix.length);
  return out;
}

/**
 * Downloads a library sound and adds it to the project's media (once). A
 * short sound effect comes with a "hit" marker on its loudest moment, for
 * lining it up on a cut.
 */
export async function importSound(app: App, project: string, soundId: string, origin: string): Promise<[string, Sound]> {
  const library = app.library as Library;
  const listing = await library.list(false);
  let sound = find(listing, soundId);
  if (sound === undefined) {
    // Just added in Drive.
    sound = find(await library.list(true), soundId);
    if (sound === undefined) throw new Error(`no sound ${soundId} in the library; list_library shows what's there`);
  }
  const path = await library.file(app.store.home, sound);
  const [, added, errors] = await importPaths(app, project, [path], false, origin);
  const mediaId = added[0];
  if (mediaId === undefined) throw new Error(`couldn't import ${sound.name}: ${debugStrings(errors)}`);
  const live = app.store.get(project);
  const media = live === null ? undefined : mediaOf(live.project, mediaId);
  if (media !== undefined && (media.markers ?? []).length === 0 && sound.kind === "sfx" && media.duration <= HIT_SECONDS) {
    const hit = await loudest(path);
    await app.store.update(project, origin, (edited) => {
      const target = edited.media.find((item) => item.id === mediaId);
      if (target !== undefined && (target.markers ?? []).length === 0) {
        target.markers = [{ time: hit, name: seams.sfx.HIT, note: "" }];
      }
    });
  }
  return [mediaId, shown(sound)];
}

export { importSound as import };

/**
 * How loud `seconds` of a sound from `from` are, in LUFS: integrated over
 * the stretch when it's longer than 3 s, else its loudest 400 ms (a hit is
 * heard at its peak). Padded with silence so a click shorter than the
 * window still measures.
 */
export async function loudness(path: string, from: number, seconds: number): Promise<number> {
  return (await levels(path, from, seconds))[0];
}

/**
 * The loudness as `loudness` measures it, and the sample peak (dBFS). Read
 * off the file's loudness analysis (made once per file, in the addon), so a
 * measurement costs microseconds once the file has been analysed.
 */
export async function levels(path: string, from: number, seconds: number): Promise<[number, number]> {
  const length = Math.max(seconds, 0.05);
  const [span] = await native().loudnessSpans(path, [{ from: Math.max(from, 0), seconds: length }]);
  if (span === undefined) throw new Error("that stretch of the sound is silent");
  return spanLevels(span, length);
}

/** library.rs `span_levels`, from the span the analysis measured. */
export function spanLevels(span: { integrated: number; loudest: number; peak: number }, seconds: number): [number, number] {
  if (seconds > 3.0 && span.integrated > -70.0) return [span.integrated, span.peak];
  if (span.loudest > -70.0) return [span.loudest, span.peak];
  throw new Error("that stretch of the sound is silent");
}

/**
 * The gain (dB) that brings an audio clip to `target` LUFS as heard, kept
 * so its peaks stay at or under -1 dBFS.
 */
export async function gainTo(project: Project, clip: Clip, target: number): Promise<number> {
  if (clip.type !== "audio") throw new Error(`${clip.id} isn't audio`);
  const media = mediaOf(project, clip.media);
  if (media === undefined) throw new Error("missing media");
  const seconds = (clip.duration / fpsOf(project)) * clip.speed;
  const [lufs, peak] = await levels(media.path, clip.source_in, seconds);
  return Math.min(Math.max(Math.min(target - lufs, -1.0 - peak), -40.0), 36.0);
}

const answers = new Map<string, number>();

/**
 * How loud the footage's own sound is across the timeline, in LUFS: its
 * clips (sound from video, not effects or voice-overs) averaged by energy
 * over their length, each as heard. An edit with no footage sound (all
 * narration) answers with its voice-overs instead: they're its speech. The
 * files are analysed side by side the first time; after that it's
 * arithmetic, and the answer for the same clips is remembered.
 */
export async function footageLoudness(project: Project): Promise<number> {
  const fps = fpsOf(project);
  // (file, from, seconds of source, seconds on the timeline, gain)
  type Span = [string, number, number, number, number];
  let spans: Span[] = [];
  const voiceovers: Span[] = [];
  for (const clip of project.clips) {
    if (clip.type !== "audio") continue;
    const media = mediaOf(project, clip.media);
    if (media === undefined) continue;
    const length = clip.duration / fps;
    if (isSoundEffect(media) || length < 1.0) continue;
    // The clip's gain as edit-core holds it (an f32).
    const span: Span = [media.path, clip.source_in, length * clip.speed, length, Math.fround((clip as AudioClip).volume_db)];
    if (media.kind === "video") spans.push(span);
    else if (seams.voiceover.isVoiceover(project, clip)) voiceovers.push(span);
  }
  if (spans.length === 0) spans = voiceovers;
  const key = JSON.stringify(spans.map(([path, ...rest]) => [native().mediaKey(path), ...rest]));
  const known = answers.get(key);
  if (known !== undefined) return known;
  await native().loudnessPrepare(spans.map((span) => span[0]));
  let energy = 0.0;
  let seconds = 0.0;
  for (const [path, from, sourceSeconds, length, gain] of spans) {
    let lufs: number;
    try {
      [lufs] = await levels(path, from, sourceSeconds);
    } catch (error) {
      if (error instanceof Error && !(error instanceof TypeError)) continue;
      throw error;
    }
    energy += length * 10 ** ((lufs + gain) / 10.0);
    seconds += length;
  }
  if (seconds === 0.0) throw new Error("no footage sound or voice-over on the timeline to match");
  const lufs = 10.0 * Math.log10(energy / seconds);
  if (answers.size >= 256) answers.clear();
  answers.set(key, lufs);
  return lufs;
}

/** Forgets the remembered footage loudness (tests). */
export function forgetAnswers(): void {
  answers.clear();
}

/** Seconds into the sound of its loudest 10 ms. */
function loudest(path: string): Promise<number> {
  return native().loudestMoment(path);
}

/**
 * The index's note for each file, by Drive id and by file name. An entry:
 *
 *     [Music / Investigative]
 *     Out There - Out To The World.wav
 *     Source note: First ~20 seconds: Epidemic Sound
 *     Source: https://www.epidemicsound.com/…
 *     Drive file: https://drive.google.com/file/d/<id>/view?usp=drivesdk
 */
export function notes(index: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of index.replaceAll("\r\n", "\n").split("\n\n")) {
    const entryLines = lines(entry).map(trim);
    if (!(entryLines[0]?.startsWith("[") ?? false)) continue;
    let note: string | null = null;
    for (const line of entryLines) {
      if (line.startsWith("Source note:")) {
        note = cleanNote(line.slice("Source note:".length));
        break;
      }
    }
    if (note === null) continue;
    const file = entryLines[1];
    if (file !== undefined) out.set(file, note);
    let id: string | null = null;
    for (const line of entryLines) {
      if (line.startsWith("Drive file:")) {
        const rest = line.slice("Drive file:".length).split("/d/")[1];
        id = rest === undefined ? null : rest.split("/")[0]!;
        break;
      }
    }
    if (id !== null) out.set(id, note);
  }
  return out;
}

/**
 * "Whoosh 1, very low volume: Epidemic Sound" → "very low volume". Where it
 * came from and a bare label ("Hit 2") say nothing about the sound.
 */
export function cleanNote(given: string): string | null {
  let note = trim(given);
  const colon = note.lastIndexOf(": ");
  if (colon >= 0) note = note.slice(0, colon);
  const label = (part: string) => {
    const space = part.lastIndexOf(" ");
    if (space < 0) return false;
    const word = part.slice(0, space);
    const number = part.slice(space + 1);
    return word !== "" && /^[0-9]*$/.test(number);
  };
  let parts = note.split(", ");
  if (parts.length > 0 && label(parts[0]!)) parts = parts.slice(1);
  const joined = parts.join(", ");
  return joined === "" ? null : joined;
}

/**
 * Runs curl with `config` (headers, form fields) on stdin so the sign-in
 * never shows in process arguments. Returns the status and the body (empty
 * when `args` writes it to a file).
 */
export async function curl(config: string, args: string[]): Promise<[number, Uint8Array]> {
  // Google's addresses go wherever this run reaches Google (`endpoints`).
  const given = args.map((arg) => (arg.startsWith("https://") ? google(arg) : arg));
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn(["curl", "-sS", "-L", "--proto", googleProto(), "--config", "-", "-w", "\n%{http_code}", ...given], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new Error(`curl: ${diag.messageOf(error)}`);
  }
  let written = true;
  try {
    child.stdin.write(config);
    await child.stdin.end();
  } catch {
    written = false;
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (!written) throw new Error("curl stdin");
  if (code !== 0) throw new Error(`couldn't reach Google Drive: ${trim(stderr)}`);
  const split = stdout.lastIndexOf(0x0a);
  const at = split < 0 ? 0 : split;
  const status = Number.parseInt(trim(new TextDecoder().decode(stdout.subarray(at))), 10);
  return [Number.isFinite(status) && status >= 0 && status <= 0xffff ? status : 0, stdout.subarray(0, at)];
}

export function driveError(code: number, body: string): string {
  let message = "request failed";
  try {
    const value = JSON.parse(body) as { error?: { message?: unknown } } | null;
    if (typeof value?.error?.message === "string") message = value.error.message;
  } catch {
    message = "request failed";
  }
  switch (code) {
    case 401:
    case 403:
      return `Google Drive refused the sound library (${code}): ${message}`;
    case 404:
      return "Google Drive can't find the sound library folder (or that file).";
    default:
      return `Google Drive answered ${code}: ${message}`;
  }
}

const CONTROL = /\p{Cc}/u;

/** A value for curl's config file, quoted. */
export function quote(value: string): string {
  if (CONTROL.test(value)) throw new Error("a Google Drive setting contains a control character");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** URL-encodes a query value (every byte but unreserved ones as %XX). */
export function encode(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(char)) out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function safeName(name: string): string {
  const replaced = [...name].map((char) => (char === "/" || char === "\\" || char === ":" || char === "\0" ? "_" : char)).join("");
  const cleaned = trimStartMatches(trim(replaced), ".");
  return cleaned === "" ? "sound.wav" : cleaned;
}

function isFile(path: string): boolean {
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
}
