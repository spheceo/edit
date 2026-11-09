import type { Kind } from "./types";

/** What several videos pasted into New project make: one case filmed as several videos, or a compilation, a case each. */
export type Shape = "case" | "compilation";

/**
 * Several videos in New project used to be a compilation every time, so a
 * Courtroom case that came as its angles and its parts was written as a case
 * per video (Marc, Nov 9: "the bot sometimes thinks it's compilation when it's
 * not, just because there is multiple POVs"). The count can't tell the two
 * apart, so the person says which, where the videos could be either; where
 * they can only be one thing, that is set for them and the other choice is
 * shown greyed, with why: a reused case belongs to a compilation; only
 * Courtroom joins videos into one case (the server's rule: a bodycam or
 * interrogation case's recordings come in as one Drive folder); and someone
 * who may write only one of the two gets that one. Until the person picks,
 * Courtroom videos are one case, unless the title starts with "When", which
 * is how Repack names a standard compilation.
 */
export function shapeOf({ kind, reused, title, picked, may }: { kind: Kind | undefined; reused: boolean; title: string; picked: Shape | null; may: { single: boolean; compilation: boolean } }): { shape: Shape; fixed: string | null } {
  if (reused) return { shape: "compilation", fixed: "A case the channel already covered belongs in a compilation." };
  if (kind !== "courtroom") return { shape: "compilation", fixed: "Separate videos of bodycam or interrogation footage are a compilation. One case's recordings go in as one Drive folder." };
  if (!may.compilation && may.single) return { shape: "case", fixed: "Your account writes Courtroom cases, not compilations." };
  if (!may.single && may.compilation) return { shape: "compilation", fixed: "Your account writes Courtroom compilations, not single cases." };
  if (picked !== null) return { shape: picked, fixed: null };
  return { shape: /^\s*["“'‘]?when\b/i.test(title) ? "compilation" : "case", fixed: null };
}

/** The two shapes as New project offers them: the value, the chip's words, and what it makes (the chip's tooltip). */
export const SHAPES: readonly [Shape, string, string][] = [
  ["case", "One case, several videos", "One hearing filmed as several videos (its angles, its parts), joined in order and written as one case"],
  ["compilation", "A compilation, a case each", "Each video its own case, written and divided as a compilation"],
];
