import type { ImportProgress } from "./types";

/** An import's steps, in order, as imports.ts reports them (its stage, and the words of its detail). */
export const STEPS: { key: string; label: string; hint: string }[] = [
  { key: "download", label: "Download", hint: "The footage comes down from YouTube, Drive or this Mac." },
  { key: "preview", label: "Preview", hint: "Joined into one timeline and cut to a 480p preview the editors play." },
  { key: "research", label: "Research", hint: "The article and any case files are read for names and facts." },
  { key: "transcribe", label: "Transcribe", hint: "Every recording is heard and its words timed." },
  { key: "watch", label: "Check speakers", hint: "The footage is watched to check who says each line. Saved checks are reused after a restart." },
  { key: "speakers", label: "Name speakers", hint: "Each voice gets a name or a role." },
];

export function stepOf(item: Pick<ImportProgress, "stage" | "detail">): string {
  const said = `${item.stage} ${item.detail}`.toLowerCase();
  if (/who speaks|saved checks/.test(said)) return "watch";
  if (/naming the speakers|speaker/.test(said)) return "speakers";
  if (/transcrib|hearing|who speaks|heard/.test(said)) return "transcribe";
  if (/research|pdf|article|case file/.test(said)) return "research";
  if (/preview|joining|cutting|processing/.test(said)) return "preview";
  return "download";
}

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s` : `${seconds} s`;
}
