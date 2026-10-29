// The case's names for the transcriber (Scribe's keyterms), listed by Edit's
// names.ts from what was saved for this script: its articles and case files
// (the research), then its narration and notes once written. Kept in the
// script's `names.json`, so they're asked again only when the sources change.

import type { Script } from "@edit/types/writer";

import { namesFor, type Source } from "../names.ts";
import { join } from "../paths.ts";
import { withDocuments } from "./casefiles.ts";
import * as research from "./research.ts";

/** What was saved for this case to read names from. */
export function sources(dir: string, script: Script): Source[] {
  const found = withDocuments(dir, research.load(dir) ?? { articles: [], queries: [], at: 0 });
  const out: Source[] = found.articles
    .map((article) => ({ title: article.title, text: `${article.summary}\n${article.facts.join("\n")}` }))
    .filter((source) => source.text.trim() !== "");
  const narration = script.clips.flatMap((clip) => [...(clip.narration === undefined ? [] : [clip.narration]), ...(clip.notes ?? []).map((note) => note.text)]).join("\n");
  if ([...narration.trim()].length >= 40) out.push({ title: "The script", text: narration.trim() });
  return out;
}

/** The case's names (at most 100); a failure keeps the names listed before. */
export function caseNames(dir: string, script: Script): Promise<string[]> {
  return namesFor(script.id, script.title, sources(dir, script), join(dir, "names.json"));
}
