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
  out.push(...pacing(p, live));
  return out;
}

/** Shortest a card may be up: its slide takes most of a second, then it must be read. */
export const CARD_MIN_SECONDS = 2.5;
/** A picture showing for fewer frames than this between two others is a flash, not a shot. */
export const FLASH_FRAMES = 8;
/** One source's shots starting within this many seconds... */
export const OVERUSE_WINDOW = 60;
/** ...this many times is the same footage again and again. */
export const OVERUSE_USES = 3;

/** The source video a media was cut from: excerpts of one YouTube video are one source. */
function sourceOf(p: Project, media: string): string {
  const name = mediaOf(p, media)?.name ?? "";
  return /\[([\w-]{11})\]/u.exec(name)?.[1] ?? media;
}

/** The picture on top from cut to cut: each run is one shot as the viewer sees it (a card over footage is the card). */
export function shots(p: Project, live: Clip[] = p.clips.filter((c) => !trackOf(p, c.track)?.hidden)): { id: string; from: number; to: number }[] {
  const index = new Map(p.tracks.map((t, i) => [t.id, i]));
  // A composition is one shot: its backdrop stands for it while its layers arrive (a list's rows one after another).
  const pictures = live.filter((c) => (c.type === "video" && !/light leak|evidence marker|post highlight|Mark blur|^Dissolve|^Janitor · (YouTube|post|bumper|profile|source card|channel|icon)|^(Cut-in \d+ · )?Horror · (screenshot|picture|marker|icon)/u.test(c.name ?? "")) || c.type === "solid");
  const cuts = [...new Set(pictures.flatMap((c) => [c.start, clipEnd(c)]))].sort((a, b) => a - b);
  const runs: { id: string; from: number; to: number }[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [from, to] = [cuts[i]!, cuts[i + 1]!];
    const top = pictures.filter((c) => c.start <= from && clipEnd(c) >= to).sort((a, b) => (index.get(b.track) ?? 0) - (index.get(a.track) ?? 0))[0];
    if (top === undefined) continue;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.id === top.id && last.to === from) last.to = to;
    else runs.push({ id: top.id, from, to });
  }
  return runs;
}

/** Punch-ins on B-roll under the narration inside this window... */
export const PUNCH_WINDOW = 60;
/** ...beyond this many are too many ("when we're saying something, I don't think it makes too much sense… we're just overdoing it"). */
export const BROLL_PUNCHES = 2;
/** Two corner labels closer than this: the label is a rare comic beat, not the emphasis style. */
export const LABEL_GAP = 180;
/** Two light leaks closer than this. */
export const LEAK_GAP = 90;

/** The team's N3on v1 notes that a structural check can see: flashes, unreadable cards, recycled footage and recycled graphics. */
function pacing(p: Project, live: Clip[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const fps = p.settings.fps;
  // "a quick 1-second frame of neon, and then it goes over to Megan Fox… We cannot have mistakes like that."
  // A house flash or dip is a transition, not a picture flashing up.
  const runs = shots(p, live).filter((run) => !/^(Flash|Dip|Drop|Bridge flash|Light leak|Red flash)/u.test(live.find((c) => c.id === run.id)?.name ?? ""));
  for (let i = 1; i + 1 < runs.length; i++) {
    const run = runs[i]!;
    if (run.to - run.from >= FLASH_FRAMES || runs[i - 1]!.id === run.id || runs[i + 1]!.id === run.id) continue;
    out.push({ kind: "commentary_flash", clip: run.id, start: run.from, frames: run.to - run.from, between: [runs[i - 1]!.id, runs[i + 1]!.id],
      fix: "butt the pictures either side together (or hold one of them over the gap): a picture flashing up for a few frames reads as a mistake" });
  }
  const cards = live.filter((c) => (c.name === "Janitor · source card" || c.name === "Horror · screenshot" || c.name === "Horror · picture") && c.duration < CARD_MIN_SECONDS * fps);
  for (const c of cards) out.push({ kind: "commentary_short_card", clip: c.id, start: c.start, seconds: Math.round((c.duration / fps) * 10) / 10,
    fix: `a card needs ${CARD_MIN_SECONDS}s or more to arrive and be read: hold it longer, or show the moment as footage instead` });
  // "We're using all of the same clips."
  const broll = live.filter((c): c is Extract<Clip, { type: "video" }> => c.type === "video" && /B-roll/u.test(c.name ?? "") && mediaOf(p, c.media)?.kind === "video").sort((a, b) => a.start - b.start);
  const bySource = new Map<string, typeof broll>();
  for (const c of broll) bySource.set(sourceOf(p, c.media), [...(bySource.get(sourceOf(p, c.media)) ?? []), c]);
  for (const [source, uses] of bySource) {
    let until = -1;
    for (let i = 0; i + OVERUSE_USES - 1 < uses.length; i++) {
      const window = uses.slice(i, i + OVERUSE_USES);
      if (window[0]!.start < until || window[OVERUSE_USES - 1]!.start - window[0]!.start > OVERUSE_WINDOW * fps) continue;
      const within = uses.filter((c) => c.start >= window[0]!.start && c.start - window[0]!.start <= OVERUSE_WINDOW * fps);
      until = within[within.length - 1]!.start + 1;
      out.push({ kind: "commentary_source_overuse", source, start: window[0]!.start, clips: within.map((c) => c.id), name: mediaOf(p, window[0]!.media)?.name,
        fix: `${within.length} shots from one video inside ${OVERUSE_WINDOW}s: find other sources for these beats (the event itself, the people named, a different year or setting), keeping this one for the line that's about it` });
    }
  }
  // Punch-ins belong to a source clip where someone is talking; on B-roll under the narrator only now and then.
  const punchedBroll = live.filter((c) => c.type === "video" && /B-roll/u.test(c.name ?? "") && (c.keyframes?.scale ?? []).some((k) => k.ease === "hold")).sort((a, b) => a.start - b.start);
  for (let i = 0, until = -1; i + BROLL_PUNCHES < punchedBroll.length; i++) {
    const group = punchedBroll.filter((c) => c.start >= punchedBroll[i]!.start && c.start - punchedBroll[i]!.start <= PUNCH_WINDOW * fps);
    if (punchedBroll[i]!.start < until || group.length <= BROLL_PUNCHES) continue;
    until = group[group.length - 1]!.start + 1;
    out.push({ kind: "commentary_punch_overuse", start: group[0]!.start, clips: group.map((c) => c.id),
      fix: `${group.length} punched-in B-roll shots inside ${PUNCH_WINDOW}s: keep punch-ins for source clips where someone is talking and the narration's sharpest lines, remove the rest (their scale keys)` });
  }
  const labels = live.filter((c) => c.name === "Janitor · corner label").sort((a, b) => a.start - b.start);
  for (let i = 1; i < labels.length; i++) if (labels[i]!.start - labels[i - 1]!.start < LABEL_GAP * fps) out.push({ kind: "commentary_label_overuse", clip: labels[i]!.id, start: labels[i]!.start,
    fix: "a corner label is a rare comic beat stating the obvious; big emphasis is commentary_text in the middle (\"have the sort of drop-shadow big text be in the middle instead\")" });
  // "We are not going to have light leaks for most of the video": a few, on the biggest turns.
  const leaks = live.filter((c) => c.name === "Janitor · light leak" || c.name === "Light leak").sort((a, b) => a.start - b.start);
  for (let i = 1; i < leaks.length; i++) if (leaks[i]!.start - leaks[i - 1]!.start < LEAK_GAP * fps) out.push({ kind: "commentary_leak_overuse", clip: leaks[i]!.id, start: leaks[i]!.start,
    fix: "light leaks are rare, for a chapter's start or the story's biggest turn; cut here, or a clean dissolve (transition kind dissolve)" });
  // "if we're having camera shutter effects without any sort of flash on screen, that is weird."
  const flashes = live.filter((c) => c.type !== "audio" && /flash|leak|burn|card|photo|board|shutter|post|YouTube frame/iu.test(c.name ?? ""));
  for (const c of live) {
    if (c.type !== "audio" || trackOf(p, c.track)?.muted) continue;
    const m = mediaOf(p, c.media); if (!/shutter|camera/iu.test(`${m?.name ?? ""} ${c.name ?? ""}`)) continue;
    if (flashes.some((f) => Math.abs(f.start - c.start) <= 4 || (f.type === "adjustment" && f.start <= c.start + 4 && clipEnd(f) >= c.start - 4))) continue;
    out.push({ kind: "commentary_sound_without_picture", clip: c.id, start: c.start, fix: "a shutter needs a flash or a photo arriving on that frame: add a flash transition at it, or remove the sound" });
  }
  // "we use background blur, a box in the middle… the second one is just text in the middle, and that's it."
  const graphics = live.filter((c) => /^Janitor · (source card|emphasis|YouTube frame|corner label|bumper avatar|light leak|profile facts|post text|channel panel|icon|location)$/u.test(c.name ?? ""));
  const punches = live.filter((c) => c.type === "video" && (c.keyframes?.scale ?? []).some((k) => k.ease === "hold"));
  const plain = graphics.filter((c) => c.name === "Janitor · source card" || c.name === "Janitor · emphasis").length;
  if (graphics.length >= 10 && plain / graphics.length >= 0.85) out.push({ kind: "commentary_graphics_monotony", start: graphics[0]!.start, cards_and_text: plain, graphics: graphics.length, punch_ins: punches.length,
    fix: "nearly every graphic is a card or centred text: use the reference's other moves where they fit (commentary_youtube for a video talked about, highlight_evidence on a real post, commentary_punch on the words that land, commentary_label for a comic beat, commentary_leak on a turn), and show people in footage rather than cards" });
  // Horror: "Always use grain and vignette on all footage" (its guide's first rule): every picture under the look.
  if (p.style === "horror") {
    // A picture is graded only where a look sits on a higher track than it.
    const level = new Map(p.tracks.map((t, i) => [t.id, i]));
    const looks = live.filter((c) => c.name === "Horror · analog look");
    const bareSpans = union(live.filter((c) => c.type === "video" || c.type === "solid").flatMap((c): Span[] => {
      const over = union(looks.filter((l) => (level.get(l.track) ?? 0) > (level.get(c.track) ?? 0)).map((l): Span => [l.start, clipEnd(l)]));
      let spans: Span[] = [[c.start, clipEnd(c)]];
      for (const [s, e] of over) spans = spans.flatMap(([a, b]): Span[] => e <= a || s >= b ? [[a, b]] : [...(s > a ? [[a, s] as Span] : []), ...(e < b ? [[e, b] as Span] : [])]);
      return spans;
    }));
    // "The same clip never repeats in a video": any stretch of footage shown twice, however far apart.
    const fps = p.settings.fps;
    const footage = live.filter((c): c is Extract<Clip, { type: "video" }> => c.type === "video" && mediaOf(p, c.media)?.kind === "video" && !/backdrop|^Horror · |^Desktop · /u.test(c.name ?? ""));
    const repeated = new Set<string>();
    for (let i = 0; i < footage.length; i++) for (let j = i + 1; j < footage.length; j++) {
      const [a, b] = [footage[i]!, footage[j]!].sort((x, y) => x.start - y.start) as [typeof footage[number], typeof footage[number]];
      if (a.media !== b.media || repeated.has(b.id)) continue;
      const shared = Math.min(a.source_in + (a.duration / fps) * a.speed, b.source_in + (b.duration / fps) * b.speed) - Math.max(a.source_in, b.source_in);
      if (shared < 1) continue;
      repeated.add(b.id);
      out.push({ kind: "horror_repeated_clip", clip: b.id, earlier: a.id, start: b.start, seconds: Math.round(shared * 10) / 10, name: mediaOf(p, b.media)?.name,
        fix: "the guide: \"The same clip never repeats in a video\". Show another moment of the story here (another part of the post, the people named, the place, the news), or end the earlier shot sooner" });
    }
    // A page is shown whole and close; a single line cut out of it reads as a modern crop.
    for (const c of live) {
      if (c.type !== "video" || c.name !== "Horror · screenshot") continue;
      const m = mediaOf(p, c.media);
      if (m !== undefined && m.kind === "image" && m.height < 220) out.push({ kind: "horror_screenshot_strip", clip: c.id, start: c.start, size: `${m.width}x${m.height}`,
        fix: "capture the page, not a line of it: capture_evidence the article, post or thread without a tight crop, then commentary_card it (a page fills the frame, close on the words: focus [x, y]) and highlight_evidence the words" });
    }
    // "The news highlighter/marker effect is the one we use most": a screenshot shown with nothing highlighted on it.
    const marks = live.filter((c) => /Horror · marker$/u.test(c.name ?? ""));
    for (const c of live) {
      if (c.type !== "video" || !/Horror · screenshot$/u.test(c.name ?? "")) continue;
      if (marks.some((m) => m.start >= c.start && m.start < clipEnd(c))) continue;
      out.push({ kind: "horror_unhighlighted_screenshot", clip: c.id, start: c.start,
        fix: "the highlighter \"is the one we use most\": highlight_evidence on this screenshot over the exact words the narration reads (red, roughened edges). If it isn't a page with words (a photo, a still or a frame of footage), it's no screenshot: commentary_card it again with photo: true, or place the footage itself" });
    }
    // "Stock footage is the exception, not the rule": real footage of the story is 75–90% of the B-roll.
    const broll = live.filter((c): c is Extract<Clip, { type: "video" }> => c.type === "video" && /B-roll/u.test(c.name ?? "") && mediaOf(p, c.media)?.kind === "video");
    const stockish = broll.filter((c) => /stock|royalty|free 4k|b-?roll|pexels|pixabay|storyblocks|envato/iu.test(mediaOf(p, c.media)?.name ?? ""));
    const shown = broll.reduce((n, c) => n + c.duration, 0); const stockFrames = stockish.reduce((n, c) => n + c.duration, 0);
    if (shown > 0 && stockFrames / shown > 0.25) out.push({ kind: "horror_stock_heavy", start: stockish[0]!.start, share: Math.round((stockFrames / shown) * 100) / 100,
      sources: [...new Set(stockish.map((c) => mediaOf(p, c.media)?.name))].slice(0, 8),
      fix: `${Math.round((stockFrames / shown) * 100)}% of the B-roll is stock: the guide wants the story's own footage for 75–90% (the post itself, the account, the people, the place, the news); keep stock for wide establishing shots, matching the era (no modern phones in an older story)` });
    // The team's notes on v2 (Nov 6), as checks.
    const narr = live.filter((c) => c.type === "audio" && ((c.name ?? "").startsWith("Voice-over") || (p.script?.blocks ?? []).some((b) => b.kind === "narration" && b.voiceover === c.id)));
    const source = live.filter((c) => c.type === "audio" && !trackOf(p, c.track)?.muted && mediaOf(p, c.media)?.kind === "video");
    const speaking = (frame: number) => narr.some((c) => c.start <= frame && clipEnd(c) > frame);
    const sourceSound = (frame: number) => source.some((c) => c.start <= frame && clipEnd(c) > frame && (c as { volume_db?: number }).volume_db !== undefined && ((c as { volume_db: number }).volume_db > -30));
    const graphic = /^(Cut-in \d+ · )?Horror · (picture|screenshot|card backdrop|.* title|title line|profile lines|icon|icon word)$/u;
    const arriving = live.filter((c) => graphic.test(c.name ?? "") && c.name !== "Horror · title backdrop");
    // "Animation appears while b-roll is still playing, we haven't switched to our voice over yet."
    const early = new Set<number>();
    for (const c of arriving) {
      if (early.has(c.start) || speaking(c.start) || !sourceSound(c.start)) continue;
      const voiceAt = narr.filter((v) => v.start > c.start).sort((x, y) => x.start - y.start)[0]?.start;
      early.add(c.start);
      out.push({ kind: "horror_graphic_over_source", clip: c.id, start: c.start, ...(voiceAt === undefined ? {} : { narration_starts: voiceAt }),
        fix: "it arrives while a post still plays its own sound: start it with the narration that's about it (narration_starts), not before" });
    }
    // "We switch the background while our text is still visible, makes it look unpolished."
    const stack = new Map(p.tracks.map((t, i) => [t.id, i]));
    const shots = live.filter((c) => c.type === "video" && !/^(Cut-in \d+ · )?(Horror|Desktop|Janitor) · |backdrop/u.test(c.name ?? ""));
    const topAt = (frame: number) => shots.filter((c) => c.start <= frame && clipEnd(c) > frame).sort((x, y) => (stack.get(y.track) ?? 0) - (stack.get(x.track) ?? 0))[0]?.id ?? null;
    for (const c of live) {
      if (c.type !== "text" || !/Horror · .* title$/u.test(c.name ?? "") || c.duration < 12) continue;
      const first = topAt(c.start + 2);
      const cut = Array.from({ length: Math.floor((c.duration - 6) / 3) }, (_, i) => c.start + 4 + i * 3).find((f) => topAt(f) !== first);
      if (cut !== undefined) out.push({ kind: "horror_text_across_cut", clip: c.id, start: c.start, cut_near: cut, text: (c as { text?: string }).text,
        fix: "the picture under the words changes while they're up: end the words before the cut, or start them on the new shot" });
    }
    // "By now it's getting boring for viewers because they see the text for 20s+."
    for (const c of live) {
      const desk = /Desktop · wallpaper$/u.test(c.name ?? "");
      const words = c.type === "text" && /Horror · (.* title|profile lines)$/u.test(c.name ?? "");
      if ((desk && c.duration > 12 * fps) || (words && c.duration > 8 * fps)) out.push({ kind: "horror_text_long", clip: c.id, start: c.start, seconds: Math.round(c.duration / fps),
        fix: desk ? "a Notepad (or any window) held this long is just words: open a picture or a video beside it (the person's photo in a Paint window, the post itself), or end it sooner" : "words alone this long: give the line a picture (the post, the page, the person) and keep the words short" });
    }
    const bare = bareSpans.reduce((n, [a, b]) => n + b - a, 0);
    if (bare > p.settings.fps) {
      const at = bareSpans[0]?.[0] ?? 0;
      out.push({ kind: "horror_look_missing", start: at, seconds: Math.round(bare / p.settings.fps * 10) / 10,
        fix: "the analog look goes on all footage: apply_edit_plan with the operation commentary_look {start: 0, end: the last frame} once the pictures are placed, and again after adding more" });
    }
  }
  return out;
}
