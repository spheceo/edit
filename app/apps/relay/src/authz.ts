/**
 * Who may do what in Edit's cloud. The audit (Oct 23): any signed-in account,
 * a subtitler's or a stolen hour-long token, could call any `edit:` function
 * (`deleteProject`, a forced `acquireLock`) and read, write, list or delete
 * any key under `edit/`. Now:
 *
 * - only the `edit:` functions Edit calls, each as its kind;
 * - a project outside the person's kinds of video is neither read nor
 *   changed (the same rule as Edit's own, apps/server/src/kinds.ts, so a
 *   token alone can't get round it), judged by the summary its commits keep;
 * - a project is deleted only by who started it, or an admin;
 * - keys are written only where Edit writes them, deleted and listed beyond
 *   the analysis only by an admin, and a project's own keys (its reviews and
 *   cover) follow the project's kind.
 *
 * Footage keys are named by their content (a Drive file, a hash), shared by
 * every project that uses them, so they can't be tied to one project.
 */
import type { Caller } from "./auth";

/** What the kinds rule needs of a project. */
export interface Shape {
  style: string;
  subtitles: boolean;
  footageOnly: boolean;
}

/** The capabilities a caller has; null for everything (an admin, or a token from before the kinds). */
export function grantedTo(found: Caller): Set<string> | null {
  if (found.kind !== "person" || found.admin) return null;
  if (!found.perms.some((perm) => perm.includes("."))) return null;
  return new Set(found.perms);
}

export const isAdmin = (found: Caller) => found.kind === "person" && found.admin;

/** A project's shape from its Convex summary (none: an edit in the default style), as Edit's `cloudShape`. */
export function shapeOf(summary: unknown): Shape {
  const field = (name: string) => (typeof summary === "object" && summary !== null ? (summary as Record<string, unknown>)[name] : undefined);
  const style = field("style");
  return {
    style: style === "interrogation" || style === "courtroom" ? style : "bodycam",
    subtitles: field("subtitles") === true,
    footageOnly: field("footageOnly") === true,
  };
}

/** Whether someone with `given` may see and change a project of this shape (kinds.ts `mayWork`). */
export function mayWork(shape: Shape, given: Set<string> | null): boolean {
  if (given === null) return true;
  if (!shape.subtitles && given.has(`edit.${shape.style}`)) return true;
  return given.has("video.subtitles") && (shape.subtitles || shape.footageOnly);
}

export const UNAVAILABLE = "This project isn't available to your account: an admin can give you its kind of video at accounts.spheceo.com.";

/** The `edit:` functions Edit calls, each as its kind. */
export const EDIT_CALLS = new Map<string, string>([
  ["edit:listProjects", "query"], ["edit:getProject", "query"], ["edit:uploadUrl", "mutation"], ["edit:commitProject", "mutation"],
  ["edit:deleteProject", "mutation"], ["edit:acquireLock", "mutation"], ["edit:renewLock", "mutation"], ["edit:releaseLock", "mutation"],
  ["edit:clearRestore", "mutation"], ["edit:getMedia", "query"], ["edit:listMedia", "query"], ["edit:putMedia", "mutation"],
]);

/** Calls that change a project (refused outside the caller's kinds). */
export const PROJECT_WRITES = new Set(["edit:commitProject", "edit:deleteProject", "edit:acquireLock", "edit:clearRestore"]);

/**
 * Problem reports sent from Edit's Report a problem (the error, the log, how
 * long things took): anyone signed in writes one, only an admin reads or
 * lists them (they hold another person's log).
 */
export const REPORTS = "edit/reports/";

/** Why `found` may not read `key` when it's a problem report (null: they may). */
export function reportRefused(found: Caller, key: string): string | null {
  return key.startsWith(REPORTS) && !isAdmin(found) ? "Only an admin reads problem reports." : null;
}

/** Where Edit writes in R2 (cloud_media.ts, covers.ts, reviews.ts, cloud_exports.ts, reports). */
export const WRITABLE = [
  "edit/originals/", "edit/proxies/", "edit/excerpts/", "edit/analysis/", "edit/sound/",
  "edit/covers/", "edit/reviews/", "edit/exports/assets/", "edit/exports/manifests/",
  REPORTS,
];

/** What a non-admin may list: the analysis beside a source (cloud_media's fetchAnalysisOf). */
export const LISTABLE = "edit/analysis/";

/** The project a key belongs to: a review's files, a cover. Null for shared keys. */
export function projectOfKey(key: string): string | null {
  return /^edit\/reviews\/([^/]+)\//.exec(key)?.[1] ?? /^edit\/covers\/([^/]+)\.jpg$/.exec(key)?.[1] ?? null;
}

const HOUR = 3600;
/** Presigned URLs last at most an hour; a GET of footage up to 6 h (FFmpeg reads an original through one URL for a whole excerpt or export). */
export const MAX_EXPIRES = HOUR;
export const MAX_FOOTAGE_GET = 6 * HOUR;
const FOOTAGE = /^edit\/(originals|proxies|excerpts|sound)\//;

export function maxExpires(method: string, key: string): number {
  return method === "GET" && FOOTAGE.test(key) ? MAX_FOOTAGE_GET : MAX_EXPIRES;
}
