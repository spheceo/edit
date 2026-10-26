// Edit Script's runtime: the functions an agent's TypeScript calls. Each call
// queues one apply_edit_plan operation (frames, the model's units); nothing
// is saved here. `run_edit` runs the script in its own process (`edit
// script-eval`), then applies the operations as one atomic plan, so a script
// that throws, or a plan that doesn't validate, saves nothing.
//
// The read side (`read_edit`) prints the timeline in these same calls, each
// with its clip's id: an edited line run again updates that clip, a line
// without an id adds one.

export type Time = number | string;

export interface ScriptClip {
  id: string;
  type: string;
  name: string;
  track: string;
  from: number;
  to: number;
  media?: string;
  source_in?: number;
  speed?: number;
  text?: string;
  link?: string;
}
export interface ScriptShot { id: string; from: number; to: number; facts?: Record<string, unknown> }
export interface ScriptWord { text: string; at: number }
export interface ScriptContext {
  project: { id: string; title: string; fps: number; width: number; height: number; rev: number; span: [number, number]; duration: number };
  clips: ScriptClip[];
  shots: ScriptShot[];
  words: ScriptWord[];
  media: { id: string; name: string; kind: string; duration: number; width: number; height: number; cuts?: number[] }[];
}
export type Op = Record<string, unknown>;

/** "1:23.4", "83.4" or 83.4 → seconds. */
export function seconds(t: Time): number {
  if (typeof t === "number" && Number.isFinite(t)) return t;
  if (typeof t === "string") {
    const parts = t.trim().split(":").map(Number);
    if (parts.length >= 1 && parts.length <= 3 && parts.every((v) => Number.isFinite(v))) return parts.reduce((total, v) => total * 60 + v, 0);
  }
  throw new Error(`not a time: ${JSON.stringify(t)} (seconds, or "m:ss.s")`);
}

/** The API a script sees, over `ctx`; `ops` collects what it asks for. */
export function runtime(ctx: ScriptContext, run: string, lineOf: () => number | null = () => null): { api: Record<string, unknown>; ops: Op[]; notes: string[]; lines: (number | null)[] } {
  // Each operation remembers the script line that queued it, so a plan's
  // "operation 3: …" comes back as that line.
  const lines: (number | null)[] = [];
  const ops = new Proxy([] as Op[], { get(target, key, receiver) {
    if (key === "push") return (...items: Op[]) => { for (const _ of items) lines.push(lineOf()); return target.push(...items); };
    return Reflect.get(target, key, receiver);
  } });
  const notes: string[] = [];
  const fps = ctx.project.fps;
  const f = (t: Time) => Math.round(seconds(t) * fps);
  const byId = new Map(ctx.clips.map((c) => [c.id, c]));
  let n = 0;
  const fresh = () => `x${run}${(n++).toString(36)}`;
  const span = (o: { from?: Time; to?: Time }, what: string): [number, number] => {
    if (o.from === undefined || o.to === undefined) throw new Error(`${what} needs from and to (timeline seconds)`);
    const [a, b] = [f(o.from), f(o.to)];
    if (b <= a) throw new Error(`${what}: to (${seconds(o.to)}) must be after from (${seconds(o.from)})`);
    return [a, b];
  };
  const mediaOf = (id: string) => {
    const m = ctx.media.find((one) => one.id === id || one.name === id);
    if (m === undefined) throw new Error(`no media ${id}: media lists them (id or exact name)`);
    return m;
  };
  /** An existing clip given by id, or a new one: an update keeps what isn't given. */
  const place = (kind: string, fields: Op, id: unknown): string => {
    if (typeof id === "string" && byId.has(id)) {
      ops.push({ op: "update", select: { ids: [id] }, patch: fields });
      return id;
    }
    const made = typeof id === "string" ? id : fresh();
    ops.push({ op: "add", clip: { id: made, ...fields } });
    void kind;
    return made;
  };
  // A composition (a card, a YouTube reference…) given ids is rebuilt: its old layers go first.
  const rebuild = (o: { ids?: unknown }) => {
    if (Array.isArray(o.ids) && o.ids.length > 0) ops.push({ op: "delete", select: { ids: o.ids.map(String) }, unlinked: true });
  };
  const graphic = (op: string, o: Op & { from?: Time; to?: Time; ids?: unknown }, extra: Op = {}) => {
    const [start, end] = span(o, op);
    rebuild(o);
    const { from: _f, to: _t, ids: _i, ...rest } = o;
    ops.push({ op, ...rest, ...extra, start, end });
  };
  const api: Record<string, unknown> = {
    project: ctx.project,
    clips: ctx.clips,
    shots: ctx.shots,
    words: ctx.words,
    media: ctx.media,
    sec: seconds,
    note: (message: string) => { notes.push(String(message)); },
    /** Where the narration says `word` (its first word at or after `after`). */
    said(word: string, after: Time = ctx.project.span[0]): number {
      const want = word.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, "").trim().split(/\s+/u);
      const from = seconds(after);
      const list = ctx.words;
      for (let i = 0; i < list.length; i++) {
        if (list[i]!.at < from - 0.01) continue;
        if (want.every((w, k) => (list[i + k]?.text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "") ?? "") === w)) return list[i]!.at;
      }
      throw new Error(`the narration doesn't say "${word}" after ${from.toFixed(1)}s in this span (words lists what it says)`);
    },
    /** A picture-only shot of `media` (B-roll): from/to on the timeline, source_in in the media's seconds. */
    shot(mediaId: string, o: { id?: string; from: Time; to: Time; source_in?: number; speed?: number; name?: string; track?: string; scale?: number; x?: number; y?: number; fill?: boolean }) {
      const m = mediaOf(mediaId);
      const [start, end] = span(o, "shot");
      // fill: as large as covers the frame (scale 1 only fits it: a photo of another shape would sit in black).
      if (o.fill === true && o.scale === undefined) {
        const fit = Math.min(ctx.project.width / Math.max(m.width, 1), ctx.project.height / Math.max(m.height, 1));
        o = { ...o, scale: Math.max(ctx.project.width / (m.width * fit), ctx.project.height / (m.height * fit)) * 1.004 };
      }
      if (m.kind === "video" && o.source_in !== undefined && m.duration > 0 && o.source_in + ((end - start) / fps) * (o.speed ?? 1) > m.duration + 0.05) {
        throw new Error(`shot: ${m.name} is ${m.duration.toFixed(2)} s long; from ${o.source_in} it runs out ${(o.source_in + ((end - start) / fps) * (o.speed ?? 1) - m.duration).toFixed(2)} s early (shorter, slower, or an earlier source_in)`);
      }
      const fields: Op = { type: "video", media: m.id, start, duration: end - start, source_in: o.source_in ?? 0, speed: o.speed ?? 1,
        ...(o.name ? { name: o.name } : {}), ...(o.track ? { track: o.track } : {}),
        ...(o.scale !== undefined || o.x !== undefined || o.y !== undefined ? { transform: { x: o.x ?? 0, y: o.y ?? 0, scale: o.scale ?? 1.004, rotation: 0 } } : {}) };
      if (!(typeof o.id === "string" && byId.has(o.id)) && fields.name === undefined) fields.name = `B-roll: ${m.name.replace(/\.[^.]+$/u, "").slice(0, 60)}`;
      return place("shot", fields, o.id);
    },
    /** Moves a clip's edges; its source follows, so the picture stays where it was. */
    trim(id: string, o: { from?: Time; to?: Time }) {
      const c = byId.get(id); if (c === undefined) throw new Error(`no clip ${id} in this span`);
      const start = o.from === undefined ? Math.round(c.from * fps) : f(o.from);
      const end = o.to === undefined ? Math.round(c.to * fps) : f(o.to);
      if (end <= start) throw new Error(`trim ${id}: nothing left`);
      const patch: Op = { start, duration: end - start };
      if (c.source_in !== undefined) {
        const sourceIn = c.source_in + ((start - Math.round(c.from * fps)) / fps) * (c.speed ?? 1);
        if (sourceIn < -0.001) throw new Error(`trim ${id}: its footage starts ${(-sourceIn).toFixed(2)} s too late to begin at ${(start / fps).toFixed(2)} (earliest ${(c.from - c.source_in / (c.speed ?? 1)).toFixed(2)})`);
        patch.source_in = Math.max(0, sourceIn);
      }
      ops.push({ op: "update", select: { ids: [id] }, patch });
    },
    remove(...ids: string[]) {
      const flat = ids.flat().map(String);
      for (const id of flat) if (!byId.has(id)) throw new Error(`no clip ${id} in this span`);
      if (flat.length) ops.push({ op: "delete", select: { ids: flat } });
    },
    update(id: string, patch: Op) {
      if (!byId.has(id)) throw new Error(`no clip ${id} in this span`);
      ops.push({ op: "update", select: { ids: [id] }, patch });
    },
    text(words: string, o: Op & { id?: string; from: Time; to: Time }) {
      if (typeof o.id === "string" && byId.has(o.id)) {
        const [start, end] = span(o, "text");
        ops.push({ op: "update", select: { ids: [o.id] }, patch: { text: words, start, duration: end - start } });
        return o.id;
      }
      graphic("commentary_text", { ...o, text: words });
      return null;
    },
    card: (mediaId: string, o: Op & { from: Time; to: Time }) => graphic("commentary_card", { ...o, media: mediaOf(mediaId).id }),
    youtube: (o: Op & { from: Time; to: Time }) => graphic("commentary_youtube", o),
    youtubeList: (o: Op & { from: Time; to: Time }) => graphic("commentary_youtube_list", o),
    label: (words: string, o: Op & { from: Time; to: Time }) => graphic("commentary_label", { ...o, text: words }),
    bumper: (o: Op & { from: Time; to: Time }) => graphic("commentary_bumper", o),
    chapter: (title: string, o: Op & { from: Time; to: Time; number?: number }) => graphic("commentary_chapter", { ...o, text: title }),
    profile: (o: Op & { from: Time; to: Time }) => graphic("commentary_profile", o),
    look: (o: { from: Time; to: Time }) => graphic("commentary_look", o),
    /** Our own X post; runs after the plan saves (it draws its highlight bars first). */
    tweet(o: Op & { from: Time; to: Time; ids?: unknown }) {
      const [start, end] = span(o, "tweet");
      rebuild(o);
      const { from: _f, to: _t, ids: _i, ...rest } = o;
      ops.push({ op: "@tool", tool: "commentary_tweet", args: { ...rest, start, end } });
    },
    /** Hard punch-ins on a clip at the words that earn them, into `on` ([x, y] project px from centre, or "centre"). */
    punch(id: string, o: { at: Time[]; on: [number, number] | "centre"; scales?: number[] }) {
      const at = o.at.map(f);
      ops.push({ op: "commentary_punch", clip: id, at, ...(o.on === "centre" ? { focus: "centre" } : { x: o.on[0], y: o.on[1] }), ...(o.scales ? { scales: o.scales } : {}) });
    },
    leak: (at: Time, mediaId: string) => { ops.push({ op: "commentary_leak", at: f(at), media: mediaOf(mediaId).id }); },
    dissolve: (at: Time, frames?: number) => { ops.push({ op: "transition", kind: "dissolve", at: f(at), ...(frames ? { frames } : {}) }); },
    flash: (at: Time) => { ops.push({ op: "transition", kind: "flash", at: f(at) }); },
    /** Any apply_edit_plan operation as written there (frames). */
    op: (raw: Op) => { ops.push(raw); },
  };
  return { api, ops, notes, lines };
}

/** The reference an agent writes against (the language's declarations). */
export const REFERENCE = `// Edit Script: the timeline as TypeScript. Times are timeline seconds (12.5) or "m:ss.s".
// Reading: project {title, fps, width, height, rev, span:[from,to], duration}; clips (every clip in the span: id, type, name, track, from, to, media, source_in, speed, text); media's cuts are the source seconds its scene changes (where known);
// shots (what's on screen cut to cut: id, from, to, facts? {sees, text, people, empty, fits, why} from describe_shots); words (the narration: {text, at}); media ({id, name, kind, duration, width, height}).
// said(word | "two words", after?) → seconds the narration says it. sec("1:02.5") → 62.5. note(msg) shows in the result.
// Writing (queued; the whole script saves as one plan, or nothing if it throws or doesn't validate):
// shot(media, {id?, from, to, source_in?, speed?, name?, scale?, x?, y?, fill?})  picture-only shot (B-roll); fill: true covers the frame (a photo of another shape); with an existing id it updates that clip; refuses a source that runs out
// trim(id, {from?, to?})  move a clip's edges, its source following; remove(...ids); update(id, patch)
// text(words, {id?, from, to, motion?, size?, x?, y?, blur?, box?, align?})  centred emphasis (commentary_text)
// card(media, {from, to, ...commentary_card}); youtube({from, to, media, title, channel, meta?, duration?, avatar?}); youtubeList({from, to, items})
// tweet({from, to, name, handle?, time?, text, avatar?, media?, highlight?: string[]}); label(words, {from, to}); bumper({from, to, avatar, subscribe?, line?})
// chapter(title, {from, to, number?}); profile({from, to, media, name?, lines}); look({from, to})
// Any of those given ids: [...] (a composition's layers as read_edit lists them) rebuilds it.
// punch(id, {at: [times], on: [x, y] | "centre", scales?}); leak(at, brandLightLeakMedia); dissolve(at, frames?); flash(at)
// op(raw)  any apply_edit_plan operation (frames), e.g. op({op: "blur_marks", clips: [id], leave: ["RIP N3ON"]}) to keep a mark that's the point unblurred. Library functions saved with save_graphic are in scope by name.
// Plain TypeScript otherwise: loops, helpers, const. No imports, no I/O.`;
