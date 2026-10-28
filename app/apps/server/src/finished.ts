// A finished video of ours, brought in by its review link
// (feedback.spheceo.com/r/<code>): the version the team approved, else the
// newest one still there, played untouched like any reused finished video.
// Every version Edit shares keeps the export as it was, full quality, beside
// the review copy (reviews.ts `fullKey`); the link is looked up among the
// app's reviews (Repack's reviews:open), then that project's versions
// (reviews:get). A script names it `review:<project id>/<version>`, so the
// same video comes back the same on every Mac, whatever is shared after.

import * as cloud from "./cloud.ts";

/** The link's code when `url` is a review link, else null. */
export function reviewCode(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^feedback\.spheceo\.com$|^feedback\.[\w.-]+$/.test(parsed.hostname.toLowerCase())) return null;
  return /^\/r\/([\w-]{16,64})\/?$/.exec(parsed.pathname)?.[1] ?? null;
}

/** The script file a review link becomes before it's looked up. */
export const LINK_PREFIX = "feedback:";
/** A finished video's script file once looked up: `review:<project id>/<version>`. */
export const PREFIX = "review:";

/** The project and version of a looked-up finished video, else null. */
export function reviewOf(file: string): { project: string; version: number } | null {
  const found = /^review:(p\d+-\d+)\/(\d+)$/.exec(file);
  return found === null ? null : { project: found[1]!, version: Number(found[2]) };
}

interface Row {
  sourceId?: string;
  url?: string;
  title?: string;
  approved?: { version?: number } | null;
}

interface Version {
  n: number;
  deleted?: boolean;
  meta?: { fullKey?: unknown } | null;
}

/**
 * Looks a review link up: the script file for its finished video
 * (`review:<project>/<version>`) and what to call it. Says what's wrong in
 * words a person can act on.
 */
export async function lookUp(url: string): Promise<{ file: string; title: string; version: number }> {
  const code = reviewCode(url);
  if (code === null) throw new Error("That isn't a review link (feedback.spheceo.com/r/…).");
  const rows = (await cloud.query("reviews:open", {})) as Row[];
  const row = rows.find((one) => typeof one.url === "string" && reviewCode(one.url) === code);
  if (row === undefined || typeof row.sourceId !== "string") {
    throw new Error("That review link isn't one of Edit's videos: only a video shared for review from Edit can be put in whole.");
  }
  const review = (await cloud.query("reviews:get", { sourceId: row.sourceId })) as { versions?: Version[] } | null;
  const versions = (review?.versions ?? []).filter((one) => !one.deleted && typeof one.meta?.fullKey === "string");
  const approved = row.approved?.version;
  const chosen = versions.find((one) => one.n === approved) ?? [...versions].sort((a, b) => b.n - a.n)[0];
  if (chosen === undefined) {
    throw new Error(`“${row.title ?? "That video"}” has no full-quality file to put in: share it for review again from its project in Edit.`);
  }
  return { file: `${PREFIX}${row.sourceId}/${chosen.n}`, title: row.title ?? "Finished video", version: chosen.n };
}

/** The full-quality file in the cloud of a looked-up finished video. */
export async function fullFile(file: string): Promise<{ key: string; title: string }> {
  const at = reviewOf(file);
  if (at === null) throw new Error(`${file} isn't a finished video's review`);
  const review = (await cloud.query("reviews:get", { sourceId: at.project })) as { title?: string; versions?: Version[] } | null;
  const version = review?.versions?.find((one) => one.n === at.version);
  const key = version?.meta?.fullKey;
  if (version === undefined || version.deleted || typeof key !== "string" || !cloud.validKey(key)) {
    throw new Error(`Version ${at.version} of that finished video is gone (another version was approved since): put its review link in again.`);
  }
  return { key, title: review?.title ?? "Finished video" };
}
