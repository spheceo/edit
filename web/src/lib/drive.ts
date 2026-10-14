// An edit's export on the team's Drive (subtitled videos in Subtitles, the rest in Render) (crates/edit/src/drive.rs):
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

/** Whether an export goes to Drive too: all of the edit, as MP4 or MOV (as drive::wanted). */
export function uploadsToDrive(_project: Project, format: Format, range: [number, number], duration: number) {
  return (format === "h264" || format === "hevc" || format === "prores") && range[0] === 0 && range[1] >= duration && duration > 0;
}

/** The Drive folder a project's exports go to (as drive::folder). */
export const driveFolder = (project: Project) => (isSubtitled(project) ? "Subtitles" : "Render");

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
