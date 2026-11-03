// What export retention (apps/server/src/export_retention.ts) would do with a
// data folder's exports, read straight from its files (no server, nothing
// else touched): `bun scripts/export-retention.ts [home] [--delete]`, the
// home ~/.edit by default. Without --delete it only reports.
import * as fs from "node:fs";
import * as os from "node:os";

import { apply, decide, type Kept } from "../apps/server/src/export_retention.ts";
import { defaultExportsDir } from "../apps/server/src/paths.ts";

const args = process.argv.slice(2);
const home = args.find((arg) => !arg.startsWith("--")) ?? `${os.homedir()}/.edit`;
const remove = args.includes("--delete");
const read = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
};
const records = read<Record<string, Kept[]>>(`${home}/exports.json`, {});
const shared = read<{ shared?: Record<string, { versions: { n: number; path: string }[] }> }>(`${home}/reviews.json`, {}).shared ?? {};
const roots = [defaultExportsDir(), `${home}/exports`];
const free = (() => {
  try {
    const stat = fs.statfsSync(home);
    return stat.bavail * stat.bsize;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
})();
const decisions = decide(records, {
  now: Date.now(),
  roots,
  reviewed: (id, path) => shared[id]?.versions.find((version) => version.path === path)?.n ?? null,
  onDrive: (id) => read<{ drive?: { uploaded_ms?: number } }>(`${home}/projects/${id}.json`, {}).drive?.uploaded_ms ?? null,
  // A running server's exports and shares aren't known here: run it with Edit closed, or with nothing exporting or sharing.
  busy: () => false,
  short: Number.isFinite(free) ? 1e9 - free : 0,
});
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;
console.log(`${home}: ${Object.keys(records).length} projects, free ${gb(free)}; looked in ${roots.join(", ")}`);
for (const one of decisions) console.log(`${one.remove ? (remove ? "DELETE" : "would delete") : "keep"}  ${one.project} v${one.version}  ${gb(one.bytes)}  ${one.name}: ${one.why}`);
const done = apply(home, decisions, !remove);
console.log(`${remove ? "deleted" : "would delete"} ${done.files} files, ${gb(done.bytes)}`);
