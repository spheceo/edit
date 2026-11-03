// What an export is doing before the encoder reports a frame, and how that
// fills the bar. Cutting cloud excerpts and copying their sound took minutes
// on a share while the card sat at 0% (Republican Chairman, Nov 3): the
// percent only moved once frames were encoding. Prep now fills the first
// slice; the encode fills the rest and still ends at 100%.

/** One kind of prep, counted as it finishes. */
export interface Count {
  done: number;
  total: number;
}

/** How much of the bar prep may fill. The encode takes whatever is left. */
export const PREP = 0.2;

/**
 * The line for footage prep, and how far it is (0–1). The line names the part
 * with the most left, so 222 excerpts still to cut read as the wait rather
 * than the sound copies that already finished. Null when nothing is prepared.
 */
export function prepLine(excerpts: Count | null, sounds: Count | null): { phase: string; ratio: number } | null {
  const parts = [
    excerpts !== null && excerpts.total > 0 ? { phase: "cutting the footage", ...excerpts } : null,
    sounds !== null && sounds.total > 0 ? { phase: "copying the sound", ...sounds } : null,
  ].filter((part): part is { phase: string; done: number; total: number } => part !== null);
  if (parts.length === 0) return null;
  const done = parts.reduce((sum, part) => sum + Math.min(part.done, part.total), 0);
  const total = parts.reduce((sum, part) => sum + part.total, 0);
  const waiting = [...parts].sort((a, b) => b.total - b.done - (a.total - a.done))[0]!;
  return { phase: `${waiting.phase}, ${Math.min(waiting.done, waiting.total)} of ${waiting.total}`, ratio: done / total };
}

function clamp(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

/**
 * Prep (`ratio` 0–1, or null when this export has none) fills {@link PREP}.
 * Once the encode reports (`encode` 0–1) it fills the rest. Pass prep as 1
 * when prep is over, so the encode starts at {@link PREP} and still ends at
 * 1; a leftover 0.85 would end the bar at 97%. No prep: the encode is the
 * whole bar, as before.
 */
export function shownProgress(prep: number | null, encode: number | null): number {
  const head = prep === null ? 0 : clamp(prep) * PREP;
  if (encode === null) return head;
  if (prep === null) return clamp(encode);
  return head + (1 - PREP) * clamp(encode);
}

/**
 * What a share's row says from an export event. Null leaves the stage as it
 * is: a cancel, or an event that isn't the export waiting or running.
 */
export function shareLine(current: string, event: { state?: unknown; waiting?: unknown; phase?: unknown; progress?: unknown }): string | null {
  if (current === "cancelling") return null;
  if (event.state === "queued") return typeof event.waiting === "string" && event.waiting !== "" ? event.waiting : "queued for export";
  if (event.state === "running") {
    if (typeof event.phase === "string" && event.phase !== "") return event.phase;
    const progress = typeof event.progress === "number" && Number.isFinite(event.progress) ? event.progress : 0;
    return `exporting ${Math.round(progress * 100)}%`;
  }
  return null;
}
