// One `[hearing]` line in the log for every hearing, so it says plainly which
// model heard what (Sphe, Nov 11: "make things a lot more explicit in our
// logs so that we don't get confused by what model did what"): the model by
// name and id, whether it was paid, the file by a name a person can read,
// how much of it, and what came back. `grep '\[hearing\]'` is every word
// Edit got, in both modes.

import * as diag from "./diag.ts";

/** The log's area for every hearing. */
export const AREA = "hearing";

/** A model said plainly: "Scribe v3 (scribe_v3, paid)". */
export function said(model: string | undefined | null): string {
  if (model === undefined || model === null || model === "") return "an unknown model";
  if (model.startsWith("scribe_")) return `Scribe ${model.slice("scribe_".length)} (${model}, paid)`;
  if (model === "apple-speech") return "Apple's on-device recogniser (apple-speech, free)";
  if (model === "youtube-captions") return "YouTube's captions (youtube-captions, free)";
  if (model.startsWith("pyannote")) return `pyannote (${model}, paid)`;
  return model;
}

/**
 * A file as a person reads it: a cloud proxy by its source's place
 * (`youtube/vGj1b3p6mQk/384384-957495.mp4`), the stretches heard together
 * as such, else the file's name.
 */
export function labelOf(path: string): string {
  const key = /[?&]key=([^&]+)/u.exec(path)?.[1];
  if (key !== undefined) {
    const decoded = decodeURIComponent(key);
    return decoded.replace(/^edit\/(proxies|originals|excerpts)\//u, "");
  }
  if (/\/joined-[0-9a-f]+\/joined\.wav$/u.test(path)) return "the kept stretches, joined into one recording";
  return path.split("/").pop() || path;
}

/** Seconds as a clock: "21:38", "1:02:03". */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A count with thousands marked: "4,208". */
export const count = (n: number): string => n.toLocaleString("en-US");

/** A duration of work: "8 s", "2 min 35 s". */
export function took(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** Writes one hearing line. */
export function line(text: string): void {
  diag.info(AREA, text);
}
