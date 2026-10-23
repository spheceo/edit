// Who started a project (`Project::created_by`, the cloud's `createdBy`): their
// Google photo, through the server (`/api/avatar`, which keeps it), or their
// initials when there's no photo or it won't load. Nothing for projects from before.

import { useState } from "react";

import type { Creator } from "../lib/types";
import { cx } from "./ui";

/** "Siphesihle Mbuyisa" → "SM"; one name → its first letter. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const first = (word: string | undefined) => (word === undefined ? "" : [...word][0]!.toUpperCase());
  return words.length > 1 ? first(words[0]) + first(words.at(-1)) : first(words[0]);
}

export function StartedBy({ by, size = 20, className }: { by: Creator | null | undefined; size?: number; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!by || by.name === "") return null;
  const title = `Started by ${by.name}`;
  const picture = by.picture ?? null;
  if (picture !== null && failed !== picture) {
    return (
      <img
        src={`/api/avatar?url=${encodeURIComponent(picture)}`}
        alt=""
        title={title}
        width={size}
        height={size}
        loading="lazy"
        className={cx("shrink-0 rounded-full bg-active object-cover", className)}
        style={{ width: size, height: size }}
        onError={() => setFailed(picture)}
      />
    );
  }
  return (
    <span
      title={title}
      className={cx("flex shrink-0 items-center justify-center rounded-full bg-[#4a4a4a] font-semibold leading-none text-white", className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {initials(by.name)}
    </span>
  );
}
