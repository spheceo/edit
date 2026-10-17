// A subtitled video's export on the team's Drive (Repack's Subtitles folder) (apps/server/src/drive.ts);
// a normal edit isn't uploaded: it's downloaded from the project's exports.
// the link a project keeps, checked against Drive when it's shown.

import { useEffect, useState } from "react";

import { api } from "./api";
import { copyText } from "./diagnostics";
import type { Format } from "./exporting";
import type { DriveFile, Project } from "./types";

/** A subtitled video: Repack-style subtitles over footage and nothing else (as subtitles::is_subtitled). */
export function isSubtitled(project: Project) {
  const subtitle = (clip: Project["clips"][number]) => clip.name?.startsWith("Subtitle · ") ?? false;
  const footage = (clip: Project["clips"][number]) =>
    (clip.type === "video" || clip.type === "audio") && project.media.find((media) => media.id === clip.media)?.kind === "video";
  return project.clips.some(subtitle) && project.clips.every((clip) => subtitle(clip) || footage(clip));
}

/** A subtitled video: only footage and subtitles, or Repack-style subtitles (no label) in it (as drive.ts subtitleVideo). */
export function subtitleVideo(project: Project) {
  return isSubtitled(project) || project.clips.some((clip) => clip.type === "text" && (clip.name ?? "").startsWith("Subtitle · ") && !clip.style.label);
}

/** Whether an export goes to Drive too: all of a subtitled video, as MP4 or MOV (as drive.ts wanted). */
export function uploadsToDrive(project: Project, format: Format, range: [number, number], duration: number) {
  return subtitleVideo(project) && (format === "h264" || format === "hevc" || format === "prores") && range[0] === 0 && range[1] >= duration && duration > 0;
}

/** The Drive folder a subtitled video's exports go to. */
export const driveFolder = (_project: Project) => "Subtitles";

/** Files asked about this session: the server checks Drive at most every few minutes anyway. */
const asked = new Set<string>();

/**
 * The project's Drive link, gone once the server finds the file deleted or
 * trashed (it then clears it from the project too).
 */
export function useDriveLink(projectId: string, drive: DriveFile | null | undefined): DriveFile | null {
  const [gone, setGone] = useState<string | null>(null);
  const fileId = drive?.file_id;
  useEffect(() => {
    if (!fileId || asked.has(fileId)) return;
    asked.add(fileId);
    let current = true;
    void api
      .driveLink(projectId)
      .then(({ drive }) => current && drive?.file_id !== fileId && setGone(fileId))
      .catch(() => asked.delete(fileId));
    return () => {
      current = false;
    };
  }, [projectId, fileId]);
  return drive && drive.file_id !== gone ? drive : null;
}

export function openDrive(url: string) {
  window.open(url, "_blank", "noreferrer");
}

export async function copyDriveLink(url: string, toast: (text: string, tone?: "info" | "error") => void) {
  if (await copyText(url)) toast("Copied the Drive link: anyone with it can watch");
  else toast("Couldn't copy to the clipboard", "error");
}
