// Recovery is separate from import/re-cut: the current edit is the source of
// truth. No layout, alignment, reset or stage is repeated by this tool.
import * as fs from "node:fs";
import type { App } from "./app.ts";
import { parseTranscript, transcriptOf } from "./captions_core.ts";
import * as diag from "./diag.ts";
import { clipMedia, clipOf, duration, reusedMedia } from "./project.ts";
import * as seams from "./seams.ts";
import type { Transcript } from "./transcribe.ts";
import { generate, narrationRecovery } from "./voiceover.ts";

export async function recover(app: App, id: string, prepare: boolean): Promise<unknown> {
  const live = app.store.get(id);
  if (!live) throw new Error("no such project");
  const project = live.project;
  const reused = reusedMedia(project);
  const used = new Set(seams.subtitles.footageSound(project, 0, duration(project)).map(clipMedia));
  const footage = project.media.filter((media) => used.has(media.id) && media.has_audio && !reused.has(media.id));
  const transcripts = new Map<string, Transcript>();
  const failures: { media?: string; step: string; error: string }[] = [];
  for (const media of footage) {
    try { transcripts.set(media.id, parseTranscript(fs.readFileSync(app.media.paths(media.path).transcript, "utf8"))); }
    catch {
      if (!prepare) continue;
      try { transcripts.set(media.id, await transcriptOf(app, media, project)); }
      catch (error) { failures.push({ media: media.id, step: "transcript", error: diag.messageOf(error) }); }
    }
  }
  if (prepare && project.script) {
    try { await generate(app, id, true); }
    catch (error) { failures.push({ step: "voice-over", error: diag.messageOf(error) }); }
  }
  const now = app.store.get(id);
  if (!now) throw new Error("project vanished");
  const blocks = now.project.script?.blocks ?? [];
  return {
    rev: now.rev,
    prepared: prepare,
    narration: narrationRecovery(now.project),
    transcripts: footage.map((media) => ({ media: media.id, name: media.name, state: transcripts.has(media.id) ? "ready" : "missing", model: transcripts.get(media.id)?.model })),
    subtitle_coverage: seams.editReview.subtitleCoverage(now.project, transcripts),
    unresolved_blocks: blocks.flatMap((block, index) => block.clip && !clipOf(now.project, block.clip)
      ? [{ block: index + 1, state: "removed_or_covered", why: "Previously placed: do not restore automatically." }]
      : !block.clip ? [{ block: index + 1, state: "unplaced", why: "Inspect current edit before inserting; do not re-cut or append blindly." }] : []),
    failures,
    next: "Load resume-edit, then continue only unfinished stages from the current timeline. Watch footage for speaker verification (cached); caption turns are not verified people. Use add_subtitles missing_only:true on confirmed unfinished spans. Preserve deliberate deletions, labels, completed graphics, music, trims and finished-video reuse. Stage completion needs context and judgement; subtitle counts alone do not prove the edit is finished.",
  };
}
