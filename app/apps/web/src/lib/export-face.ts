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
