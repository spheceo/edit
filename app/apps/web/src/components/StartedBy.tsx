// Who started a project (`Project::created_by`, the cloud’s `createdBy`), as the
// spheceo kit draws a person (design/kit/components.css .sp-avatar): their
// initials in their own hue, covered by their Google photo once it loads
// (through the server, `/api/avatar`, which keeps it). Nothing for projects from before.

import { useState } from "react";

import type { Creator } from "../lib/types";
import { cx } from "./ui";

/** The kit’s eight initials hues (`--avatar-1…8`). */
const HUES = ["#8fbaf0", "#b4bcf0", "#f3a48e", "#d0aaf3", "#a9e091", "#86d3d6", "#f0a3c4", "#9fd3b5"];

/** "Siphesihle Mbuyisa" → "SM"; one word (or an email) → its first letter. */
export function initials(name: string): string {
  const words = (name.includes("@") && !name.includes(" ") ? name.split("@")[0]! : name).trim().split(/\s+/u).filter(Boolean);
  const first = (word: string | undefined) => (word === undefined ? "" : [...word][0]!.toUpperCase());
  return words.length > 1 ? first(words[0]) + first(words.at(-1)) : first(words[0]);
}

/** A person’s hue: the kit’s hash of the name (design/tools/page.mjs), so they’re the same colour in every app. */
export function hueOf(name: string): string {
  return HUES[[...name].reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length]!;
}

/** "Oct 21": when a project was started, from its id (`p<ms>-<n>`); null when the id doesn’t say. */
export function startedOn(id: string): string | null {
  const ms = Number(/^p(\d{12,})-/u.exec(id)?.[1] ?? NaN);
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
}

export function StartedBy({
  by,
  size = 20,
  projectId,
  title: given,
  className,
}: {
  by: Creator | null | undefined;
  size?: 20 | 24 | 32;
  projectId?: string;
  /** Its tooltip; "Started by <name> · <date>" by default, null for none (the account menu’s own row). */
  title?: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!by || by.name === "") return null;
  const on = projectId === undefined ? null : startedOn(projectId);
  const title = given === null ? undefined : (given ?? `Started by ${by.name}${on === null ? "" : ` · ${on}`}`);
  const hue = hueOf(by.name);
  const picture = by.picture ?? null;
  return (
    <span
      title={title}
      className={cx("relative inline-grid shrink-0 place-items-center rounded-full leading-none font-semibold select-none", className)}
      style={{
        width: size,
        height: size,
        fontSize: size === 20 ? 8.5 : size === 24 ? 9.5 : Math.round(size * 0.4),
        color: hue,
        background: `linear-gradient(color-mix(in srgb, ${hue} 15%, transparent), color-mix(in srgb, ${hue} 15%, transparent)), var(--color-panel)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${hue} 25%, transparent)`,
      }}
    >
      {initials(by.name)}
      {picture !== null && failed !== picture && (
        <img
          src={`/api/avatar?url=${encodeURIComponent(picture)}`}
          alt=""
          loading="lazy"
          className="absolute inset-0 size-full rounded-full object-cover"
          onError={() => setFailed(picture)}
        />
      )}
    </span>
  );
}
