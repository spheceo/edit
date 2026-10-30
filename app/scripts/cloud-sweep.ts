/**
 * Footage in the cloud that no project or script uses any more (a deleted
 * project's: Convex deletes only its body), and temporary pieces left behind.
 * Report only unless `--delete`; then it deletes only what has been
 * unreferenced at every run for GRACE_DAYS (a teammate's Mac may hold a
 * project not pushed yet), noted in `edit/sweep/unreferenced.json`. The bucket
 * is shared with Repack: nothing outside `edit/` is read or touched.
 *
 *   infisical run --projectId=… --env=dev --path=/edit-relay --silent -- bun scripts/cloud-sweep.ts [--delete]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { S3Client } from "bun";

const GRACE_DAYS = 14;
/** Temporary pieces older than this go without a grace period (a review's, an old cloud export's result). */
const TEMP_DAYS = 2;
const FOOTAGE = ["edit/originals/", "edit/excerpts/", "edit/proxies/"];
const TEMP = ["edit/reviews/tmp/", "edit/proxies/jobs/", "edit/exports/results/"];
const NOTED = "edit/sweep/unreferenced.json";

const remove = process.argv.includes("--delete");
const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} isn't set (run under infisical run)`);
  return value;
};
const s3 = new S3Client({ accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY"), bucket: env("R2_BUCKET"), endpoint: `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com` });
const [convexUrl, convexToken] = [env("CONVEX_URL").replace(/\/+$/u, ""), env("CONVEX_SERVICE_TOKEN")];

async function convex(kind: "query" | "mutation", path: string, args: Record<string, unknown>): Promise<unknown> {
  const answer = await fetch(`${convexUrl}/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, args: { token: convexToken, ...args }, format: "json" }) });
  const body = (await answer.json()) as { status: string; value?: unknown; errorMessage?: string };
  if (body.status !== "success") throw new Error(`${path}: ${body.errorMessage}`);
  return body.value;
}

async function list(prefix: string): Promise<{ key: string; size: number; at: number }[]> {
  const out: { key: string; size: number; at: number }[] = [];
  let token: string | undefined;
  do {
    const page = await s3.list({ prefix, maxKeys: 1000, ...(token !== undefined ? { continuationToken: token } : {}) });
    for (const one of page.contents ?? []) out.push({ key: one.key, size: one.size ?? 0, at: Date.parse(String(one.lastModified ?? "")) || 0 });
    token = page.isTruncated === true ? page.nextContinuationToken : undefined;
  } while (token !== undefined);
  return out;
}

/** The source a footage key belongs to (`drive/<id>`, `sha256/<hex>`, `youtube/<id>`), as projects and scripts name it. */
function sourceOf(key: string): string | null {
  const parts = key.split("/");
  // Only footage's own sources: a review's proxy (`edit/proxies/review/…`) or a job's manifest isn't one.
  if (parts.length < 4 || !["drive", "sha256", "youtube"].includes(parts[2]!)) return null;
  return `${parts[2]}/${parts[3]!.replace(/\.mp4$/u, "")}`;
}

// Every source the team still uses: cloud projects, live scripts, and the projects on this Mac.
const used = new Set<string>();
const read = (raw: string) => {
  const text = `${raw}\n${raw.replace(/%2F/giu, "/").replace(/%3A/giu, ":")}`;
  for (const match of text.matchAll(/edit\/(?:originals|excerpts|proxies)\/[^"\\\s]+/gu)) {
    const source = sourceOf(match[0]);
    if (source !== null) used.add(source);
  }
  for (const match of text.matchAll(/"?(drive|youtube|sha256):([A-Za-z0-9_-]{6,64})/gu)) used.add(`${match[1]}/${match[2]}`);
  for (const match of text.matchAll(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/gu)) used.add(`youtube/${match[1]}`);
  for (const match of text.matchAll(/drive\.google\.com\/(?:file\/d\/|open\?id=)([A-Za-z0-9_-]{20,})/gu)) used.add(`drive/${match[1]}`);
};
const projects = (await convex("query", "edit:listProjects", {})) as { projectId?: string; id?: string }[];
for (const card of projects) {
  const got = (await convex("query", "edit:getProject", { projectId: card.projectId ?? card.id })) as { bodyUrl?: string } | null;
  if (got?.bodyUrl === undefined) continue;
  const answer = await fetch(got.bodyUrl);
  if (!answer.ok) throw new Error(`a project's body didn't load (${answer.status}): nothing is deleted when one can't be read`);
  read(await answer.text());
}
const scripts = (await convex("query", "writer:listScripts", {})) as { deletedAt?: number }[];
for (const row of scripts) if (row.deletedAt === undefined || row.deletedAt === null) read(JSON.stringify(row));
const here = join(os.homedir(), ".edit", "projects");
for (const name of fs.existsSync(here) ? fs.readdirSync(here) : []) if (name.endsWith(".json")) read(fs.readFileSync(join(here, name), "utf8"));

const now = Date.now();
let noted: Record<string, number> = {};
try {
  noted = (await s3.file(NOTED).json()) as Record<string, number>;
} catch {
  // The first run.
}
const next: Record<string, number> = {};
const unused = new Map<string, { keys: string[]; bytes: number }>();
for (const prefix of FOOTAGE) {
  for (const one of await list(prefix)) {
    const source = sourceOf(one.key);
    if (source === null || used.has(source)) continue;
    const entry = unused.get(source) ?? { keys: [], bytes: 0 };
    entry.keys.push(one.key);
    entry.bytes += one.size;
    unused.set(source, entry);
  }
}
const due: string[] = [];
let [unusedBytes, dueBytes] = [0, 0];
for (const [source, { keys, bytes }] of unused) {
  next[source] = noted[source] ?? now;
  unusedBytes += bytes;
  if (now - next[source]! >= GRACE_DAYS * 86_400_000) {
    due.push(...keys);
    dueBytes += bytes;
  }
}
for (const prefix of TEMP) {
  for (const one of await list(prefix)) {
    if (now - one.at < TEMP_DAYS * 86_400_000) continue;
    due.push(one.key);
    dueBytes += one.size;
  }
}
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
console.log(`${projects.length} cloud projects and ${scripts.length} scripts read; ${used.size} sources in use`);
console.log(`unused footage: ${unused.size} sources, ${gb(unusedBytes)}; due (unused ${GRACE_DAYS}+ days, and old temporary pieces): ${due.length} files, ${gb(dueBytes)}`);
await s3.write(NOTED, JSON.stringify(next));
if (!remove) {
  for (const key of due.slice(0, 40)) console.log(`  would delete ${key}`);
  console.log("report only: run with --delete to delete what's due");
} else {
  for (const key of due) await s3.delete(key);
  console.log(`deleted ${due.length} files, ${gb(dueBytes)}`);
}
