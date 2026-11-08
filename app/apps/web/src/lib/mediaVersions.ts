// The picture each media streams, as the preview asks for it: the light
// preview once it's made (when wanted), else the preview, else the original,
// each with its files' stamps ("light~<light>~<preview>"), so a version's URL
// is only ever that version.

import type { MediaStatus } from "./types";

const versionOf = (status: MediaStatus, light: boolean) => {
  const preview = status.stamps?.preview ?? "";
  return light && status.light === "ready" ? `light~${status.stamps?.light ?? ""}~${preview}` : status.proxy === "ready" ? `preview~${preview}` : "source";
};

/**
 * A selector of every media's version that gives back the same object until
 * one of them changes: a status update that moves only progress (most of
 * them, hundreds at once while a project's media are processed) doesn't
 * re-render the viewer or send the project to the preview again (Nov 8 audit,
 * item G: a JSON key over every media was built on every render).
 */
export function mediaVersions(light: boolean): (state: { media: Record<string, MediaStatus> }) => Record<string, string> {
  let seen: Record<string, MediaStatus> | null = null;
  let versions: Record<string, string> = {};
  return ({ media }) => {
    if (media === seen) return versions;
    seen = media;
    const next: Record<string, string> = {};
    for (const [id, status] of Object.entries(media)) next[id] = versionOf(status, light);
    const keys = Object.keys(next);
    if (keys.length !== Object.keys(versions).length || keys.some((id) => versions[id] !== next[id])) versions = next;
    return versions;
  };
}
