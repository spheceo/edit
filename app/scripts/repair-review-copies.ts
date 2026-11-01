/**
 * Review copies whose video runs longer than their edit, found and made again
 * (Nov 1: Kroger's 82.5-minute edit was shared as a 17 h 11 min review copy:
 * from 68458d2b, Oct 31, Modal's exports carry chapters, its review pieces
 * copied them, Debian's ffmpeg counted them in each piece's length and the
 * join held each piece's last frame until the export's end; fixed in b3448030).
 *
 * Every Edit review's versions are read from mamagi; each video.mp4's own
 * index (its moov, a few MB read from R2) says how long it plays, against the
 * edit's length the version keeps (meta.durationMs). A faulty one, asked to:
 * its export (meta.fullKey, the very file shared) is fetched, the review copy
 * made from it again as Edit makes one on a Mac (reviews.ts reviewCopy) and
 * put over the same key, as a share's "replace" does (link, number and notes
 * stay), its size recorded, and its time notes moved to the moments they meant
 * (reviews:retime): inside a piece's own frames the same frame, inside a held
 * frame's tail that frame.
 *
 *   infisical run --projectId=979fe56c-c4d0-4809-b64f-5ebc75eeaf05 --env=prod --path=/edit-relay --silent -- \
 *     bun scripts/repair-review-copies.ts                  report only
 *   … bun scripts/repair-review-copies.ts --repair <project id>   make that one's faulty versions again
 *   … bun scripts/repair-review-copies.ts --repair-all            every faulty one
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { S3Client } from "bun";

import { fixedMs, stretched, videoMs, videoTiming, type VideoTiming } from "../apps/server/src/review_repair.ts";
import { reviewCopy } from "../apps/server/src/reviews.ts";

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} isn't set (run under infisical run)`);
  return value;
};
const s3 = new S3Client({ accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY"), bucket: env("R2_BUCKET"), endpoint: `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com` });
const [convexUrl, convexToken] = [env("CONVEX_URL").replace(/\/+$/u, ""), env("CONVEX_SERVICE_TOKEN")];
async function convex(kind: "query" | "mutation", path: string, args: Record<string, unknown>): Promise<unknown> {
  const answer = (await (await fetch(`${convexUrl}/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, args: { token: convexToken, ...args }, format: "json" }) })).json()) as { status: string; value?: unknown; errorMessage?: string };
  if (answer.status !== "success") throw new Error(`${path}: ${answer.errorMessage ?? "failed"}`);
  return answer.value;
}

const args = process.argv.slice(2);
const only = args.includes("--repair") ? args[args.indexOf("--repair") + 1] : null;
const all = args.includes("--repair-all");

type Version = { n: number; key: string; deletedAt?: number | null; meta?: { durationMs?: number; fullKey?: string; timeline?: string } | null };
type Note = { noteId: string; version: number; anchor?: { kind?: string; ms?: number; endMs?: number } | null };
type Review = { sourceId: string; title: string; token: string; url: string; versions: Version[]; notes: Note[] };

/** The bytes of `key` in [from, from + length). */
const range = async (key: string, from: number, length: number) => new Uint8Array(await s3.file(key).slice(from, from + length).arrayBuffer());

/** A video's timing from its moov, read from R2 a box at a time (never the whole file). */
async function timingOf(key: string): Promise<VideoTiming | null> {
  const size = (await s3.file(key).stat()).size;
  let at = 0;
  while (at + 16 <= size) {
    const head = await range(key, at, 16);
    const view = new DataView(head.buffer);
    let length = view.getUint32(0);
    if (length === 1) length = Number(view.getBigUint64(8));
    else if (length === 0) length = size - at;
    if (String.fromCharCode(...head.subarray(4, 8)) === "moov") return videoTiming(await range(key, at, length));
    if (length < 8) return null;
    at += length;
  }
  return null;
}

const minutes = (ms: number) => `${Math.floor(ms / 3_600_000)} h ${Math.round((ms % 3_600_000) / 60_000)} min`;

const open = (await convex("query", "reviews:open", { app: "edit" })) as { sourceId: string }[];
const faulty: { review: Review; version: Version; timing: VideoTiming }[] = [];
for (const { sourceId } of open) {
  const review = (await convex("query", "reviews:get", { app: "edit", sourceId })) as Review | null;
  if (review === null) continue;
  for (const version of review.versions) {
    if (version.deletedAt || !version.key.endsWith(".mp4") || typeof version.meta?.durationMs !== "number") continue;
    let timing: VideoTiming | null;
    try {
      timing = await timingOf(version.key);
    } catch (error) {
      console.log(`  ${review.title} v${version.n}: couldn't read ${version.key}: ${(error as Error).message}`);
      continue;
    }
    if (timing === null) continue;
    const bad = stretched(timing, version.meta.durationMs);
    console.log(`${bad ? "FAULTY" : "ok    "} ${review.title} v${version.n}: plays ${minutes(videoMs(timing))}, the edit is ${minutes(version.meta.durationMs)} (${review.url})`);
    if (bad) faulty.push({ review, version, timing });
  }
}
console.log(`\n${open.length} reviews read, ${faulty.length} faulty version(s).`);

for (const { review, version, timing } of faulty) {
  if (!all && review.sourceId !== only) continue;
  const fullKey = version.meta?.fullKey;
  if (!fullKey) {
    console.log(`  ${review.title} v${version.n}: no export kept beside it (meta.fullKey); skipped`);
    continue;
  }
  const work = join(os.homedir(), "edit-repairs", review.sourceId, version.meta?.timeline ?? `v${version.n}`);
  fs.mkdirSync(work, { recursive: true });
  const full = join(work, "full.mp4");
  const copy = join(work, "video.mp4");
  const size = (await s3.file(fullKey).stat()).size;
  if (!fs.existsSync(full) || fs.statSync(full).size !== size) {
    console.log(`  ${review.title} v${version.n}: fetching its export (${(size / 1e9).toFixed(1)} GB)`);
    await Bun.write(full, s3.file(fullKey));
  }
  console.log(`  making its review copy again from the export`);
  fs.rmSync(copy, { force: true });
  await reviewCopy(full, copy);
  // Checked before anything's replaced: as long as the edit, give or take.
  const made = videoTiming(await (async () => {
    const bytes = new Uint8Array(fs.readFileSync(copy));
    const view = new DataView(bytes.buffer);
    let at = 0;
    while (at + 8 <= bytes.length && String.fromCharCode(...bytes.subarray(at + 4, at + 8)) !== "moov") at += view.getUint32(at);
    return bytes.subarray(at, at + view.getUint32(at));
  })());
  if (made === null || stretched(made, version.meta!.durationMs!) || Math.abs(videoMs(made) - version.meta!.durationMs!) > 2000) {
    console.log(`  the copy made again plays ${made === null ? "?" : minutes(videoMs(made))}: not put up`);
    continue;
  }
  console.log(`  putting it over ${version.key} (${(fs.statSync(copy).size / 1e9).toFixed(2)} GB)`);
  const writer = s3.file(version.key).writer({ type: "video/mp4", partSize: 64 * 1024 * 1024, queueSize: 4, retry: 3 });
  const stream = fs.createReadStream(copy, { highWaterMark: 8 * 1024 * 1024 });
  for await (const chunk of stream) writer.write(chunk as Buffer);
  await writer.end();
  if ((await s3.file(version.key).stat()).size !== fs.statSync(copy).size) throw new Error(`${version.key}: R2 holds a different size than the copy made`);
  await convex("mutation", "reviewPage:recordSize", { link: review.token, version: version.n, sizeBytes: fs.statSync(copy).size });
  // Its notes, moved to the moments they meant.
  const moves = review.notes
    .filter((note) => note.version === version.n && note.anchor?.kind === "time" && typeof note.anchor.ms === "number")
    .map((note) => ({ noteId: note.noteId, ms: fixedMs(timing, note.anchor!.ms!), ...(typeof note.anchor!.endMs === "number" ? { endMs: fixedMs(timing, note.anchor!.endMs) } : {}), was: note.anchor! }));
  const changed = moves.filter((move) => move.ms !== move.was.ms || ("endMs" in move && move.endMs !== move.was.endMs));
  for (const move of moves) console.log(`  note ${move.noteId}: ${move.was.ms} ms → ${move.ms} ms${"endMs" in move ? ` (to ${move.was.endMs} → ${move.endMs})` : ""}`);
  if (changed.length > 0) await convex("mutation", "reviews:retime", { app: "edit", sourceId: review.sourceId, version: version.n, moves: changed.map(({ was: _was, ...move }) => move) });
  console.log(`  repaired: ${review.title} v${version.n} plays ${minutes(videoMs(made))}; ${changed.length} of ${moves.length} time notes moved (${review.url})`);
  fs.rmSync(work, { recursive: true, force: true });
}
