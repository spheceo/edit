import { explain } from "@edit/types/problems";

/** What the card and the share chip read. A script share keeps its own stage. */
export interface FaceJob {
  name: string;
  kind?: string;
  state: string;
  progress: number;
  waiting?: string;
  phase?: string;
  stage?: string;
  error?: string;
}

export function capitalize(text: string): string {
  return text === "" ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** The one line under Exports, when a single edit is queued or still preparing. A script share, and an encode already reporting frames, keep the name. */
export function activityLine(job: FaceJob): string | null {
  if (job.kind === "script") return null;
  if (job.state === "queued") return job.waiting ?? "waiting for the renderer";
  if (job.state === "running" && typeof job.phase === "string" && job.phase !== "") return job.phase;
  return null;
}

function stageLine(stage: string | undefined): string {
  const text = stage?.trim() || "sharing";
  return `${capitalize(text)}…`;
}

/** The queue dialog's line. A running prep names itself; the bar already shows the percent. */
export function exportLabel(job: FaceJob): string {
  if (job.kind === "script") return stageLine(job.stage);
  if (job.state === "queued") return `Queued · ${job.waiting ?? "waiting for the renderer"}`;
  if (job.state === "running" && typeof job.phase === "string" && job.phase !== "") return capitalize(job.phase);
  if (job.state === "running") return `Exporting · ${Math.round(job.progress * 100)}%`;
  if (job.state === "done") return "Export ready";
  if (job.state === "cancelled") return "Cancelled";
  return job.error ? explain(job.error, "export it").title : "Export failed";
}

export interface CardFace {
  percent: number | null;
  /** Under "Exports". */
  subtitle: string;
  /** The hover: the edit's name plus the stage, when the stage took the subtitle. */
  title: string;
  attention: boolean;
}

/** The card's one number: the average of what's still going (a queued edit counts as 0). Done fills the card; a failure doesn't. */
export function cardFace(jobs: FaceJob[]): CardFace {
  const going = jobs.filter((job) => job.state === "queued" || job.state === "running");
  if (going.length > 0) {
    const ratio = going.reduce((sum, job) => sum + (job.state === "queued" ? 0 : job.progress), 0) / going.length;
    const rendering = going.filter((job) => job.state === "running").length;
    const queued = going.filter((job) => job.state === "queued").length;
    const line = going.length === 1 ? activityLine(going[0]!) : null;
    const subtitle =
      going.length === 1 ? (line ?? going[0]!.name) : [rendering ? `${rendering} exporting` : "", queued ? `${queued} queued` : ""].filter(Boolean).join(" · ");
    const title = going.length === 1 && line !== null ? `${going[0]!.name}: ${line}` : subtitle;
    return { percent: Math.round(ratio * 100), subtitle, title, attention: false };
  }
  if (jobs.some((job) => job.state === "failed")) return { percent: null, subtitle: "Needs attention", title: "Needs attention", attention: true };
  if (jobs.some((job) => job.state === "done")) return { percent: 100, subtitle: "Exports ready", title: "Exports ready", attention: false };
  if (jobs.some((job) => job.state === "cancelled")) return { percent: null, subtitle: "Cancelled", title: "Cancelled", attention: false };
  return { percent: null, subtitle: "Exports", title: "Exports", attention: false };
}

/** Settings → Exports. `shown` is the folder with home as `~`. */
export function folderDetail(chosen: boolean, shown: string): string {
  return chosen ? `Exports go to ${shown}.` : `Not chosen yet. Exports go to ${shown} until you pick a folder.`;
}

/** The row's chip. "exporting" with no count is still just Sharing; a named stage is said. */
export function shareChip(stage: string): string {
  if (stage === "exporting") return "Sharing";
  if (stage === "cancelling") return "Cancelling…";
  return capitalize(stage);
}

/** What the Share dialog says under its settings, from the export as the editor heard it and the server's share. */
export type ShareStatus =
  | { kind: "progress"; text: string }
  | { kind: "share-failed"; error: string }
  | { kind: "export-failed"; error: string | null }
  | { kind: "cancelled" }
  | { kind: "up" }
  /** An Export (this computer only) that's done: its file. */
  | { kind: "saved"; path: string }
  | { kind: "none" };

/**
 * The Share dialog's line: the export's progress while it runs, then the
 * share's (`sharing`, the server's line); how the last share stands after.
 * "Up on the link" only once the server says the version is published
 * (`share.state === "done"`): the export finishing is not the share (the
 * Nov 8 audit, 2c.1: it said "Up on the link" before the copy, the upload
 * and the publish, whose failures then came only by polling). `only`: the
 * export under way or just done was asked for by itself (Export), so its end
 * is the end, and what an earlier share left isn't said over it.
 */
export function shareStatus(given: {
  exportState: { state: string; progress: number; path?: string; waiting?: string; phase?: string; error?: string } | null;
  sharing: string | null;
  share: { state: "running" | "done" | "failed"; error?: string } | null;
  linked: boolean;
  stopped: boolean;
  only?: boolean;
}): ShareStatus {
  const { exportState, sharing, share } = given;
  if (exportState?.state === "queued") return { kind: "progress", text: exportState.waiting ? `Export queued · ${exportState.waiting}` : "Export queued · you can keep editing" };
  if (exportState?.state === "running") return { kind: "progress", text: exportState.phase ? capitalize(exportState.phase) : `Exporting… ${Math.round(exportState.progress * 100)}%` };
  if (sharing) return { kind: "progress", text: `${capitalize(sharing)}…` };
  if (given.only === true) {
    if (exportState?.state === "done" && exportState.path) return { kind: "saved", path: exportState.path };
    if (exportState?.state === "failed") return { kind: "export-failed", error: exportState.error ?? null };
    if (given.stopped || exportState?.state === "cancelled") return { kind: "cancelled" };
    return { kind: "none" };
  }
  if (share?.state === "failed") return { kind: "share-failed", error: share.error ?? "The share stopped" };
  if (exportState?.state === "failed") return { kind: "export-failed", error: exportState.error ?? null };
  if (given.stopped || exportState?.state === "cancelled") return { kind: "cancelled" };
  if (share?.state === "done" && given.linked) return { kind: "up" };
  return { kind: "none" };
}
