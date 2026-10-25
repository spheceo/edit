import type { Clip, Project } from "./model.ts";
import { clipEnd, mediaOf, trackOf } from "./project.ts";

export function outline(p: Project): Record<string, unknown>[] {
  const groups = new Map<string, { heading: string; start: number; end: number; cut_ins: number[]; source_clips: number }>();
  let count = 0;
  for (const b of p.script?.blocks ?? []) {
    if (b.kind === "narration") count++;
    const heading = (b.notes ?? []).find((n) => n.startsWith("Chapter: "))?.slice(9) ?? "Story";
    const id = b.kind === "narration" ? b.voiceover ?? b.clip : b.clip;
    const c = p.clips.find((c) => c.id === id); if (!c) continue;
    const group = groups.get(heading) ?? { heading, start: c.start, end: clipEnd(c), cut_ins: [], source_clips: 0 };
    group.start = Math.min(group.start, c.start); group.end = Math.max(group.end, clipEnd(c));
    if (b.kind === "narration") group.cut_ins.push(count); else group.source_clips++;
    groups.set(heading, group);
  }
  return [...groups.values()].map((g) => ({ ...g, start_seconds: g.start / p.settings.fps, end_seconds: g.end / p.settings.fps }));
}

/** Rules specific to a narrated essay. A mechanical check never certifies
 * relevance: visual observations and the review remain separate evidence. */
export function issues(p: Project): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visible = (c: Clip) => !trackOf(p, c.track)?.hidden;
  const live = p.clips.filter(visible);
  const voices = new Set((p.script?.blocks ?? []).flatMap((b) => b.kind === "narration" && b.voiceover ? [b.voiceover] : []));
  const voiceMedia = new Set(live.flatMap((c) => c.type === "audio" && voices.has(c.id) ? [c.media] : []));
  const narration = live.filter((c) => c.type === "audio" && voiceMedia.has(c.media));
  const source = live.filter((c) => c.type === "audio" && !trackOf(p, c.track)?.muted && !voiceMedia.has(c.media) && mediaOf(p, c.media)?.kind === "video");
  const music = live.filter((c) => c.type === "audio" && !trackOf(p, c.track)?.muted && (mediaOf(p, c.media)?.library === "music" || /music|bed/iu.test(c.name ?? mediaOf(p, c.media)?.name ?? "")));
  for (const bed of music) {
    const clashes = source.filter((c) => c.start < clipEnd(bed) && clipEnd(c) > bed.start);
    if (clashes.length) out.push({ kind: "commentary_music_over_source", clip: bed.id, source_clips: clashes.map((c) => c.id), start: bed.start, end: clipEnd(bed), fix: "split the music at every source excerpt; music only under narration" });
  }
  const pictures = live.filter((c) => (c.type === "video") || (c.type === "solid" && (c.name ?? "").startsWith("Janitor · chapter")));
  for (const voice of narration) {
    const spans = pictures.filter((c) => c.start < clipEnd(voice) && clipEnd(c) > voice.start).map((c) => [Math.max(c.start, voice.start), Math.min(clipEnd(c), clipEnd(voice))] as const).sort((a, b) => a[0] - b[0]);
    let until = voice.start; const gaps: number[][] = [];
    for (const [a, b] of spans) { if (a > until + 2) gaps.push([until, a]); until = Math.max(until, b); }
    if (until < clipEnd(voice) - 2) gaps.push([until, clipEnd(voice)]);
    if (gaps.length) out.push({ kind: "commentary_uncovered_narration", clip: voice.id, start: voice.start, end: clipEnd(voice), gaps, fix: "cover the narration with inspected, relevant footage/evidence; a black placeholder card is unfinished" });
  }
  for (const c of live) {
    if (c.type === "text" && /^Cut-in \d+$/u.test(c.name ?? "")) out.push({ kind: "commentary_placeholder", clip: c.id, start: c.start, fix: "replace the import's full narration placeholder with visual coverage and selective editorial text" });
    if (c.type === "video" && c.link && c.duration > 20 * p.settings.fps && !Object.keys(c.keyframes ?? {}).length) out.push({ kind: "commentary_static_source", clip: c.id, start: c.start, end: clipEnd(c), fix: "motivate a punch-in/out or slow camera move within this long source excerpt" });
  }
  // Exact repeated portions of a moving source, not a person's recurring portrait.
  const uses = live.filter((c): c is Extract<Clip, { type: "video" }> => c.type === "video" && mediaOf(p, c.media)?.kind === "video" && !/backdrop/u.test(c.name ?? ""));
  const flagged = new Set<string>();
  for (let i = 0; i < uses.length; i++) for (let j = i + 1; j < uses.length; j++) {
    const a = uses[i]!; const b = uses[j]!;
    if (a.media !== b.media || Math.abs(a.start - b.start) < 10 * p.settings.fps) continue;
    const overlap = Math.min(a.source_in + a.duration / p.settings.fps * a.speed, b.source_in + b.duration / p.settings.fps * b.speed) - Math.max(a.source_in, b.source_in);
    if (overlap < 2.5 || flagged.has(b.id)) continue;
    flagged.add(b.id); out.push({ kind: "commentary_repeated_range", clip: b.id, earlier: a.id, start: b.start, seconds: Math.round(overlap * 10) / 10, fix: "choose a distinct scene matching this beat, unless this is a deliberate short callback" });
  }
  return out;
}
