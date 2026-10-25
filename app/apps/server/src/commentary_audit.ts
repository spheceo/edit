import type { Clip, Project } from "./model.ts";
import { clipEnd, mediaOf, trackOf } from "./project.ts";

/** Most of the narration a blurred text backdrop may cover: emphasis is selective. */
export const TEXT_BACKDROP_SHARE = 0.25;

type Span = [number, number];

function union(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function overlap(a: Span[], b: Span[]): number {
  let total = 0;
  for (const [s, e] of a) for (const [t, u] of b) total += Math.max(0, Math.min(e, u) - Math.max(s, t));
  return total;
}

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
    if ((c.type === "text" || c.type === "solid") && /^Cut-in \d+$/u.test(c.name ?? "")) out.push({ kind: "commentary_placeholder", clip: c.id, start: c.start, fix: "remove the import's linked narration placeholder card/text as you replace it with visual coverage and selective editorial text" });
    if (c.type === "video" && c.link && c.duration > 20 * p.settings.fps && !Object.keys(c.keyframes ?? {}).length) out.push({ kind: "commentary_static_source", clip: c.id, start: c.start, end: clipEnd(c), fix: "motivate a punch-in/out or slow camera move within this long source excerpt" });
  }
  // Selective text: a blurred text backdrop over most of the narration hides its pictures.
  const said = union(narration.map((c): Span => [c.start, clipEnd(c)]));
  const dimmed = union(live.filter((c) => c.name === "Janitor · text backdrop").map((c): Span => [c.start, clipEnd(c)]));
  const total = said.reduce((sum, [a, b]) => sum + b - a, 0);
  const under = overlap(said, dimmed);
  if (total > 0 && under / total > TEXT_BACKDROP_SHARE) out.push({ kind: "commentary_text_heavy", start: dimmed[0]?.[0] ?? 0, share: Math.round((under / total) * 100) / 100, backdrops: live.filter((c) => c.name === "Janitor · text backdrop").length,
    fix: `blurred text backdrops cover ${Math.round((under / total) * 100)}% of the narration: keep only each chapter's key phrases (a quarter at most), delete the rest's backdrop and text so the B-roll is seen` });
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
