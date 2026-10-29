// A commentary's footage: the stretch of every YouTube clip the script plays,
// downloaded at 480p into the script's folder once its clips are known (after
// a build, a revision or a clip search, and when it's opened), so Split plays
// the footage itself instead of showing a card. Kept by video and stretch in
// `footage.json`: a clip that stays put isn't fetched again. Each Mac
// downloads its own (the files aren't synced). A shared script's review page
// gets the stretches too, under `writer/reviews/<id>/clips/`, with a manifest.

import * as fs from "node:fs";

import type { Cite, Draft, Script } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { writeAtomic } from "../files.ts";
import { isFile, join } from "../paths.ts";
import { ffmpeg } from "../tools.ts";
import { downloadRange, PREVIEW_FORMAT, videoId } from "../youtube.ts";
import * as cloud from "./cloud.ts";
import { named } from "./jobs.ts";
import { cites } from "./paragraphs.ts";
import { run } from "./proc.ts";
import * as store from "./store.ts";

/** Seconds either side of a clip, so a clip trimmed a little still plays from the file. */
const PAD_MS = 3_000;
/** A clip longer than this is fetched only this long (a whole stream is never one clip). */
const MAX_MS = 3 * 60_000;

/** One downloaded stretch of a video. */
export interface Piece {
  video: string;
  /** Where the file starts and ends in the video, ms. */
  fromMs: number;
  toMs: number;
  /** The file, inside the script's `footage/` folder. */
  file: string;
  /** Its index (moov) is at the front, so a browser seeks in it at once. */
  fast?: boolean;
}

/** What the view needs: the pieces there are, and how many are still coming. */
export interface Footage {
  pieces: Piece[];
  dir: string;
  pending: number;
  failed: number;
}

interface Kept {
  pieces: Piece[];
  /** Stretches that wouldn't download ("<video>@<from>-<to>"), not tried again this run. */
  failed: string[];
  /** Files put under the script's review, for its review page. */
  uploaded: string[];
  /** The manifest as last written, so an earlier version's clips stay listed. */
  published: Record<string, unknown>[];
}

const folder = (dir: string) => join(dir, "footage");

function read(dir: string): Kept {
  try {
    const kept = JSON.parse(fs.readFileSync(join(folder(dir), "footage.json"), "utf8")) as Partial<Kept>;
    return { pieces: kept.pieces ?? [], failed: kept.failed ?? [], uploaded: kept.uploaded ?? [], published: kept.published ?? [] };
  } catch {
    return { pieces: [], failed: [], uploaded: [], published: [] };
  }
}

function write(dir: string, kept: Kept): void {
  fs.mkdirSync(folder(dir), { recursive: true });
  writeAtomic(join(folder(dir), "footage.json"), JSON.stringify(kept, null, 2));
}

/** The YouTube video a clip plays: from its link, else its source's. */
const videoOf = (cite: Cite, origins: Map<string, string>): string | null => (cite.link ? videoId(cite.link) : null) ?? (origins.has(cite.source) ? videoId(origins.get(cite.source)!) : null);

/** Every stretch the draft plays, by video: what's needed, padded; overlapping or touching stretches of one video are one download. */
export function wanted(draft: Draft, origins: Map<string, string>): [string, number, number][] {
  const out: [string, number, number][] = [];
  for (const cite of cites(draft)) {
    const video = videoOf(cite, origins);
    if (video === null) continue;
    const from = Math.max(cite.startMs - PAD_MS, 0);
    const to = Math.min(cite.endMs + PAD_MS, from + MAX_MS);
    if (to <= from) continue;
    const near = out.find(([other, a, b]) => other === video && from <= b + PAD_MS && to + PAD_MS >= a && Math.max(to, b) - Math.min(from, a) <= MAX_MS);
    if (near) {
      near[1] = Math.min(near[1], from);
      near[2] = Math.max(near[2], to);
    } else out.push([video, from, to]);
  }
  return out;
}

const covered = (pieces: Piece[], video: string, from: number, to: number, dir: string): boolean => pieces.some((piece) => piece.video === video && piece.fromMs <= from + PAD_MS && piece.toMs + PAD_MS >= to && isFile(join(folder(dir), piece.file)));

const originsOf = (script: Script): Map<string, string> => new Map((script.commentary?.sources ?? []).map((source) => [source.id, source.origin]));

/** The script's footage now; downloads what's missing in the background. */
export function now(app: App, data: string, id: string): Footage {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  if (!script.commentary) return { pieces: [], dir: folder(dir), pending: 0, failed: 0 };
  const kept = read(dir);
  const draft = script.commentary.draft;
  const missing = (draft ? wanted(draft, originsOf(script)) : []).filter(([video, from, to]) => !covered(kept.pieces, video, from, to, dir) && !kept.failed.includes(`${video}@${from}-${to}`));
  // A shared script's review still lacking a piece, or its manifest, gets them put up too.
  const unpublished = script.review !== undefined && (kept.published.length === 0 || kept.pieces.some((piece) => !kept.uploaded.includes(piece.file)));
  if (missing.length > 0 || unpublished) soon(app, data, id);
  return { pieces: kept.pieces.filter((piece) => isFile(join(folder(dir), piece.file))), dir: folder(dir), pending: missing.length, failed: kept.failed.length };
}

const running = new Set<string>();

/** Downloads a script's missing footage in the background, once at a time per script. */
export function soon(app: App, data: string, id: string): void {
  if (running.has(id)) return;
  running.add(id);
  void fetchAll(app, data, id)
    .catch((error: unknown) => diag.warn("writer", `script ${id.slice(0, 8)}: its footage: ${diag.messageOf(error)}`))
    .finally(() => running.delete(id));
}

async function fetchAll(app: App, data: string, id: string): Promise<void> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  const draft = script.commentary?.draft;
  if (!draft) return;
  // A shared script's review page gets what's here first, and a manifest saying what's still coming.
  const shared = () => script.review !== undefined || store.read(dir).review !== undefined;
  if (shared()) await publish(data, id).catch((error: unknown) => diag.warn("writer", `${named(id, script.title)}: the review's clips couldn't be put up: ${diag.messageOf(error)}`));
  const began = Date.now();
  let [got, lost] = [0, 0];
  for (const [video, from, to] of wanted(draft, originsOf(script))) {
    const kept = read(dir);
    const tag = `${video}@${from}-${to}`;
    if (covered(kept.pieces, video, from, to, dir) || kept.failed.includes(tag)) continue;
    try {
      const piece = await fetchPiece(app, dir, video, from, to);
      kept.pieces = [...kept.pieces.filter((other) => !(other.video === piece.video && other.fromMs >= piece.fromMs && other.toMs <= piece.toMs)), piece];
      got++;
      write(dir, kept);
      if (shared()) await publish(data, id).catch((error: unknown) => diag.warn("writer", `${named(id, script.title)}: a clip couldn't be put up for the review: ${diag.messageOf(error)}`));
    } catch (error) {
      diag.warn("writer", `${named(id, script.title)}: ${video} ${from}–${to} ms didn't download: ${diag.messageOf(error)}`);
      kept.failed.push(tag);
      lost++;
      write(dir, kept);
    }
  }
  if (got + lost > 0) diag.info("writer", `${named(id, script.title)}: ${got} clip stretches downloaded${lost > 0 ? `, ${lost} couldn't be` : ""} in ${Math.round((Date.now() - began) / 1000)} s`);
}

/** One stretch of one video, as an mp4 a browser plays from its start. */
async function fetchPiece(app: App, dir: string, video: string, from: number, to: number): Promise<Piece> {
  const file = `${video}-${Math.floor(from / 1000)}-${Math.ceil(to / 1000)}.mp4`;
  const scratch = join(folder(dir), `.${file}.coming`);
  fs.rmSync(scratch, { recursive: true, force: true });
  try {
    const got = await downloadRange(app.store.home, video, [from / 1000, to / 1000], scratch, () => {}, PREVIEW_FORMAT);
    fs.renameSync(got.path, join(folder(dir), file));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const fast = await faststart(join(folder(dir), file)).then(() => true, () => false);
  return { video, fromMs: from, toMs: to, file, fast };
}

/** The file's index moved to its front (no re-encode), so a browser seeks in it before it's all down. */
async function faststart(path: string): Promise<void> {
  const tmp = path.replace(/\.mp4$/, ".fast.mp4");
  await run(ffmpeg(), ["-v", "error", "-y", "-i", path, "-c", "copy", "-movflags", "+faststart", tmp], { timeoutMs: 120_000 });
  fs.renameSync(tmp, path);
}

const clipsKey = (id: string, file: string) => `writer/reviews/${id}/clips/${file}`;

/**
 * Puts a shared commentary's downloaded stretches under its review and
 * rewrites the manifest the review page reads: one entry per clip the script
 * plays, "ready" with the file that covers it, else "pending" or "failed".
 * Entries an earlier version listed stay, so its page still finds them. The
 * manifest is written after the files it names.
 */
export async function publish(data: string, id: string): Promise<number> {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  const draft = script.commentary?.draft;
  if (!draft || script.review === undefined) return 0;
  const origins = originsOf(script);
  const kept = read(dir);
  let sent = 0;
  for (const [index, piece] of kept.pieces.entries()) {
    const path = join(folder(dir), piece.file);
    if (kept.uploaded.includes(piece.file) || !isFile(path)) continue;
    if (!piece.fast && (await faststart(path).then(() => true, () => false))) kept.pieces[index]!.fast = true;
    await cloud.putFile(id, clipsKey(id, piece.file), path);
    kept.uploaded.push(piece.file);
    sent++;
    write(dir, kept);
    await manifest(id, draft, origins, kept);
    write(dir, kept);
  }
  await manifest(id, draft, origins, kept);
  write(dir, kept);
  if (sent > 0) diag.info("writer", `${named(id, script.title)}: ${sent} clip stretches put up for the review`);
  return sent;
}

async function manifest(id: string, draft: Draft, origins: Map<string, string>, kept: Kept): Promise<void> {
  const entries: Record<string, unknown>[] = [];
  const add = (block: string, cite: Cite) => {
    const video = videoOf(cite, origins);
    if (video === null) return;
    const ready = kept.pieces.find((piece) => piece.video === video && piece.fromMs <= cite.startMs && piece.toMs >= Math.min(cite.endMs, piece.fromMs + MAX_MS) && kept.uploaded.includes(piece.file));
    const failed = kept.failed.some((tag) => {
      const [failedVideo, range] = tag.split("@");
      const [a, b] = (range ?? "").split("-").map(Number);
      return failedVideo === video && a !== undefined && b !== undefined && a <= cite.startMs && b >= Math.min(cite.endMs, a + MAX_MS);
    });
    const entry: Record<string, unknown> = { blockId: block, label: cite.video.trim(), startMs: cite.startMs, endMs: cite.endMs };
    if (ready) Object.assign(entry, { status: "ready", file: ready.file, fromMs: ready.fromMs, toMs: ready.toMs });
    else entry.status = failed ? "failed" : "pending";
    entries.push(entry);
  };
  for (const cite of draft.open) add("open", cite);
  for (const paragraph of draft.sections.flatMap((section) => section.paragraphs)) for (const piece of paragraph.pieces) if (piece.kind === "clip") add(paragraph.id ?? "", piece);
  // An earlier version's ready clips stay listed, unless this draft lists the same clip.
  const same = (a: Record<string, unknown>, b: Record<string, unknown>) => String(a.label).toLowerCase() === String(b.label).toLowerCase() && a.startMs === b.startMs && a.endMs === b.endMs;
  for (const old of kept.published) {
    if (old.status === "ready" && !entries.some((entry) => same(entry, old)) && typeof old.file === "string" && kept.uploaded.includes(old.file)) entries.push(old);
  }
  const body = { updatedAt: Date.now(), clips: entries };
  await cloud.putBytes(clipsKey(id, "manifest.json"), JSON.stringify(body));
  kept.published = entries;
}

/** A file of the script's footage, by its name only. */
export function file(dir: string, name: string): string | null {
  const safe = name.endsWith(".mp4") && !/[/\\]/.test(name) && !name.startsWith(".") && /^[A-Za-z0-9._-]+$/.test(name);
  const path = join(folder(dir), name);
  return safe && isFile(path) ? path : null;
}
