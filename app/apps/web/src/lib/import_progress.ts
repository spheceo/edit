import { explain } from "@edit/types/problems";
import type { ScriptJob } from "./types";

/** A script import as one line and one fraction (0–1), for the viewer, the tab and the panel. */
export function importProgress(job: ScriptJob): { fraction: number; line: string } {
  const files = job.files;
  const done = files.filter((file) => file.state === "done").length;
  // Each file: its download is most of it, then its excerpts.
  const part = (file: ScriptJob["files"][number]) =>
    file.state === "done"
      ? 1
      : file.state === "cutting"
        ? 0.6 + 0.4 * (file.cut && file.cut.total > 0 ? file.cut.done / file.cut.total : 0)
        : file.state === "downloading" && file.total
          ? 0.6 * (file.bytes / file.total)
          : file.state === "waiting" && file.total
            ? 0.6 * Math.min(file.bytes / file.total, 1)
            : 0;
  const footage = files.length === 0 ? 1 : files.reduce((sum, file) => sum + part(file), 0) / files.length;
  if (job.state === "transcribing") return { fraction: 0.88, line: "Transcribing to find exact cuts…" };
  if (job.state === "placing") return { fraction: 0.94, line: "Laying out the edit…" };
  if (job.state === "voicing") return { fraction: 0.97, line: "Making the voice-over…" };
  if (job.state === "failed") return { fraction: footage * 0.85, line: explain(job.error ?? "The import stopped", "finish the import").title };
  if (job.state === "waiting") {
    const missing = job.files.filter((file) => file.state === "failed").length;
    // Waiting by itself (the transcription plan's credit, the encoder): said as the server says it, nothing to press.
    if (missing === 0) return { fraction: footage * 0.85, line: job.error ?? "Waiting to carry on" };
    return { fraction: footage * 0.85, line: `Waiting for you: ${missing === 1 ? "one file" : `${missing} files`} couldn’t be downloaded` };
  }
  if (job.state === "done") return { fraction: 1, line: "Ready" };
  const cutting = files.find((file) => file.state === "cutting" && file.cut);
  const line = cutting?.cut
    ? `Cutting excerpts · ${cutting.cut.done} of ${cutting.cut.total}`
    : files.some((file) => file.state === "downloading")
      ? "Downloading footage"
      : "Getting the footage ready";
  return { fraction: footage * 0.85, line: files.length > 1 ? `${line} · file ${Math.min(done + 1, files.length)} of ${files.length}` : line };
}

/** What follows the layout, a line each (the voice-over, the recording, the research, the words), for the Downloads tab. */
export function afterLines(job: ScriptJob): { step: string; state: string; line: string }[] {
  const names: Record<string, string> = { voiceover: "Voice-over", recording: "The team’s recording", research: "Research", words: "Words" };
  return (job.after ?? []).map((one) => ({
    step: one.step,
    state: one.state,
    line: one.note ?? `${names[one.step] ?? one.step}: ${one.state === "running" ? "working…" : one.state === "done" ? "done" : one.state === "waiting" ? "waiting" : "didn’t work"}`,
  }));
}

/** Whether a finished import still has something to say (a follow-on that failed or waits), so its tab stays. */
export function afterNeedsSaying(job: ScriptJob | null): boolean {
  return job !== null && job.state === "done" && (job.after ?? []).some((one) => one.state === "failed" || one.state === "waiting");
}
