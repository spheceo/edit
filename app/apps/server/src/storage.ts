// Storage readout (cloud-first plan, Phase 0): how much Edit keeps on this
// disk, where, and whether the cloud already holds it. Nothing here deletes:
// it only measures, so later phases can gate every deletion on proof.

import * as fs from "node:fs";

import * as cloud from "./cloud.ts";
import { join } from "./paths.ts";

/**
 * The smallest local cache, and what it was until Nov 2. Sized for a Mac that
 * did its heavy work on Modal; once Edit moved back onto the Macs (Sphe,
 * Nov 2), 400 MB meant the previews a project plays and the footage its
 * exports read were evicted and fetched from R2 again all day.
 */
export const DEFAULT_LOCAL_BUDGET_BYTES = 400_000_000;
/** The disk's free space Edit never takes the cache below. */
export const FREE_FLOOR_BYTES = 1_000_000_000;
/** The share of the room (free space plus the cache itself) the cache may hold. */
const SHARE = 0.25;
/** However big the disk, no more than this. */
const MOST = 50_000_000_000;

/**
 * The local-data budget: `EDIT_CACHE_BUDGET_MB` (decimal MB) when set; else,
 * with the disk known, a quarter of the room it has (its free space and what
 * the cache already holds, so the budget doesn't shrink as the cache fills),
 * between 400 MB and 50 GB and always leaving FREE_FLOOR_BYTES free: an M1
 * with 15 GB free and a 6.7 GB cache, 5.4 GB. Unknown, the old 400 MB.
 */
export function localBudgetBytes(disk?: { freeBytes: number; cacheBytes: number }): number {
  const mb = Number(process.env.EDIT_CACHE_BUDGET_MB ?? "");
  if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1_000_000);
  if (disk === undefined || !Number.isFinite(disk.freeBytes)) return DEFAULT_LOCAL_BUDGET_BYTES;
  const room = Math.max(disk.freeBytes, 0) + Math.max(disk.cacheBytes, 0);
  return Math.floor(Math.max(DEFAULT_LOCAL_BUDGET_BYTES, Math.min(room * SHARE, room - FREE_FLOOR_BYTES, MOST)));
}

export interface SectionBytes { name: string; bytes: number; files: number }

export interface ExportConfirmation {
  path: string;
  bytes: number | null;
  missing: boolean;
  cloudKey: string | null;
  /** "confirmed": a cloud copy verified by size; "local-only": no verified copy; "missing": no local file. */
  status: "confirmed" | "local-only" | "missing";
}

export interface StorageReport {
  /** One offline state for the whole app: false means show "offline". */
  online: boolean;
  home: string;
  totalBytes: number;
  budgetBytes: number;
  overBudgetBytes: number;
  diskFreeBytes: number | null;
  sections: SectionBytes[];
  exports: ExportConfirmation[];
}

/** Bytes and file count under `path` (0 when absent), each hard-linked inode once. */
function walk(path: string, seen = new Set<string>()): { bytes: number; files: number } {
  try {
    const stat = fs.statSync(path);
    if (!stat.isDirectory()) {
      const inode = `${stat.dev}:${stat.ino}`;
      if (seen.has(inode)) return { bytes: 0, files: 0 };
      seen.add(inode);
      return { bytes: stat.size, files: 1 };
    }
    let bytes = 0, files = 0;
    for (const name of fs.readdirSync(path)) {
      const sub = walk(join(path, name), seen);
      bytes += sub.bytes; files += sub.files;
    }
    return { bytes, files };
  } catch { return { bytes: 0, files: 0 }; }
}

interface RawRecord { path?: unknown; bytes?: unknown; cloudKey?: unknown }

function readExportRecords(home: string): RawRecord[] {
  try {
    const value = JSON.parse(fs.readFileSync(join(home, "exports.json"), "utf8")) as Record<string, RawRecord[]>;
    return Object.values(value).flat().filter((r) => typeof r?.path === "string");
  } catch { return []; }
}

/** Local-only view: an export counts as confirmed only when it names a cloud key. */
export function exportConfirmations(home: string): ExportConfirmation[] {
  return readExportRecords(home).map((record) => {
    const path = record.path as string;
    let bytes: number | null = null;
    try { bytes = fs.statSync(path).size; } catch { bytes = null; }
    const cloudKey = typeof record.cloudKey === "string" && record.cloudKey !== "" ? record.cloudKey : null;
    return { path, bytes, missing: bytes === null, cloudKey, status: bytes === null ? "missing" : cloudKey !== null ? "confirmed" : "local-only" };
  });
}

/**
 * Verifies each export's cloud copy by size (`head` injectable for tests).
 * An export is "confirmed" only when R2 holds an object of exactly its size;
 * anything else stays "local-only" and must never be deleted.
 */
export async function verifyExports(
  home: string,
  head: (key: string) => Promise<{ size: number } | null> = (key) => cloud.head(key),
): Promise<ExportConfirmation[]> {
  const out: ExportConfirmation[] = [];
  for (const entry of exportConfirmations(home)) {
    if (entry.status === "missing" || entry.cloudKey === null) { out.push(entry); continue; }
    let status: ExportConfirmation["status"] = "local-only";
    try {
      const found = await head(entry.cloudKey);
      if (found !== null && entry.bytes !== null && found.size === entry.bytes) status = "confirmed";
    } catch { /* unreachable cloud: not confirmed */ }
    out.push({ ...entry, status });
  }
  return out;
}

export interface MigrationResult {
  checked: number;
  deletedBytes: number;
  deleted: string[];
  kept: { path: string; reason: string }[];
}

/**
 * Verified migration of Edit's media copies: a local file is deleted only
 * when `keyFor` names its cloud original and R2 holds an object of exactly
 * its size. Anything else is kept, with the reason. `keyFor` must only name
 * copies Edit made (registry-tracked downloads, cloud media) — never a
 * user's own file.
 */
export async function migrateMediaFiles(
  files: string[],
  keyFor: (path: string) => string | null,
  head: (key: string) => Promise<{ size: number } | null> = (key) => cloud.head(key),
  dryRun = false,
): Promise<MigrationResult> {
  const out: MigrationResult = { checked: 0, deletedBytes: 0, deleted: [], kept: [] };
  for (const path of files) {
    out.checked += 1;
    let size: number;
    try { size = fs.statSync(path).size; } catch { out.kept.push({ path, reason: "missing" }); continue; }
    const key = keyFor(path);
    if (key === null) { out.kept.push({ path, reason: "no cloud original known" }); continue; }
    let found: { size: number } | null = null;
    try { found = await head(key); } catch { found = null; }
    if (found === null) { out.kept.push({ path, reason: "not in the cloud" }); continue; }
    if (found.size !== size) { out.kept.push({ path, reason: `size differs (local ${size}, cloud ${found.size})` }); continue; }
    if (!dryRun) {
      try { fs.rmSync(path, { force: true }); } catch { out.kept.push({ path, reason: "could not delete" }); continue; }
      if (fs.existsSync(path)) { out.kept.push({ path, reason: "could not delete" }); continue; }
    }
    out.deleted.push(path);
    out.deletedBytes += size;
  }
  return out;
}

/** Every file under `dir`, recursively (empty when absent). */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walkDir = (path: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walkDir(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walkDir(dir);
  return out.sort();
}

/** The full readout for `home`: per-section bytes, the budget, and export confirmations. */
export function storageReport(home: string): StorageReport {
  const names = ["cache", "media", "uploads", "library", "projects", "exports", "jobs"];
  const seen = new Set<string>();
  const sections: SectionBytes[] = [];
  let totalBytes = 0;
  for (const name of names) {
    const part = walk(join(home, name), seen);
    if (part.files > 0) sections.push({ name, ...part });
    totalBytes += part.bytes;
  }
  // Everything else in the home (settings, logs, small state) as one section.
  let other = { bytes: 0, files: 0 };
  try {
    for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
      if (names.includes(entry.name)) continue;
      const part = walk(join(home, entry.name), seen);
      other = { bytes: other.bytes + part.bytes, files: other.files + part.files };
    }
  } catch { /* no home yet */ }
  if (other.files > 0) sections.push({ name: "other", ...other });
  totalBytes += other.bytes;
  sections.sort((a, b) => b.bytes - a.bytes);
  let diskFreeBytes: number | null = null;
  try { const s = fs.statfsSync(home); diskFreeBytes = s.bavail * s.bsize; } catch { diskFreeBytes = null; }
  const budgetBytes = localBudgetBytes(diskFreeBytes === null ? undefined : { freeBytes: diskFreeBytes, cacheBytes: sections.find((section) => section.name === "cache")?.bytes ?? 0 });
  return { online: cloud.enabled(), home, totalBytes, budgetBytes, overBudgetBytes: Math.max(totalBytes - budgetBytes, 0), diskFreeBytes, sections, exports: exportConfirmations(home) };
}
