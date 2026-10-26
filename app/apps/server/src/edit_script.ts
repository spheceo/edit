// Edit Script: the timeline read and written as TypeScript, checked like a
// program (the user, Oct 26: "a sort of 'compiler' that will tell the agents,
// 'Okay, this doesn't really make sense. You've used this graphic over this
// sort of text'").
//
// - read_edit prints a stretch of the timeline as calls (script_runtime.ts),
//   each with its clip's id and what the picture shows (its facts).
// - run_edit runs a script in its own process (`edit script-eval`), applies
//   what it queued as one atomic apply_edit_plan (or a dry run), then lints
//   the result: the plan's audit in that stretch, and the facts' verdicts.
// - describe_shots turns frames into facts: each shot's rendered frame, with
//   the words said over it and what's known of its source, goes to Sonnet 5.5
//   through the user's Claude Code, which says what's on screen and whether
//   it fits the words. People are named from context (titles, captions, the
//   editor's notes), never recognised from faces.
// - save_graphic keeps a function the agent wrote in a library every script
//   (every project) can call.

import * as fs from "node:fs";
import type { App } from "./app.ts";
import { parseTranscript } from "./captions_core.ts";
import * as commentaryAudit from "./commentary_audit.ts";
import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { handlerFor, registerTool, text, type Content } from "./mcp/registry.ts";
import type { Clip, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { join, parent } from "./paths.ts";
import { clipEnd, mediaOf, trackOf } from "./project.ts";
import { REFERENCE, type Op, type ScriptContext } from "./script_runtime.ts";
import { stableStringify } from "./stable.ts";

type Args = Record<string, unknown>;
const DESCRIBER = "claude-sonnet-5-5";
/** Longest stretch one read or description takes (a few minutes of an essay is a few hundred lines). */
const MAX_SPAN = 180;

// ---------------------------------------------------------------------------
// Facts: what each shot shows, kept per project.

export interface Facts { sees: string; text: string; people: string; empty: boolean; fits: "yes" | "no" | "unsure"; why: string }
const factsFile = (app: App, project: string) => join(app.store.home, "research", project, "facts.json");
/** A shot's facts hold while its clip, timing and source moment are the same. */
export function factKey(clip: Clip | undefined, shot: { id: string; from: number; to: number }): string {
  const source = clip !== undefined && clip.type === "video" ? `${clip.media}@${clip.source_in.toFixed(2)}x${clip.speed}` : "";
  return `${shot.id}:${shot.from}-${shot.to}:${source}`;
}
function readFacts(app: App, project: string): Record<string, Facts> {
  try { return JSON.parse(fs.readFileSync(factsFile(app, project), "utf8")) as Record<string, Facts>; } catch { return {}; }
}
function observations(app: App, project: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const saved = JSON.parse(fs.readFileSync(join(app.store.home, "research", project, "broll.json"), "utf8")) as Record<string, Args>;
    for (const [key, value] of Object.entries(saved)) if (key.startsWith("observation:") && typeof value.media === "string") out.set(value.media, `${String(value.seen ?? "")} (${String(value.purpose ?? "")})`);
  } catch { /* none saved */ }
  return out;
}

// ---------------------------------------------------------------------------
// The context a script reads.

function liveProject(app: App, projectId: string): { project: Project; rev: number } {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  return { project: live.project, rev: live.rev };
}
function spanOf(p: Project, args: Args): [number, number] {
  const fps = p.settings.fps;
  const total = Math.max(0, ...p.clips.map(clipEnd)) / fps;
  const from = typeof args.start === "number" ? Math.max(0, args.start) : 0;
  const to = typeof args.end === "number" ? Math.min(args.end, total) : Math.min(total, from + 120);
  if (to <= from) throw new Error("end must be after start (timeline seconds)");
  if (to - from > MAX_SPAN) throw new Error(`at most ${MAX_SPAN} s at a time`);
  return [from, to];
}
/** The narration's words on the timeline, from the voice-overs' transcripts. */
function narration(app: App, p: Project, from: number, to: number): { text: string; at: number }[] {
  const fps = p.settings.fps;
  const voices = new Set((p.script?.blocks ?? []).flatMap((b) => (b.kind === "narration" && b.voiceover ? [b.voiceover] : [])));
  const out: { text: string; at: number }[] = [];
  for (const clip of p.clips) {
    if (clip.type !== "audio" || !(voices.has(clip.id) || (clip.name ?? "").startsWith("Voice-over"))) continue;
    if (clipEnd(clip) / fps < from || clip.start / fps > to) continue;
    const media = mediaOf(p, clip.media); if (media === undefined) continue;
    let words: { text: string; start: number; end: number }[] = [];
    try { words = parseTranscript(fs.readFileSync(app.media.paths(media.path).transcript, "utf8")).words; } catch { continue; }
    const out_ = clip.source_in + (clip.duration / fps) * clip.speed;
    for (const word of words) {
      if (word.end <= clip.source_in || word.start >= out_) continue;
      const at = (clip.start + ((word.start - clip.source_in) / clip.speed) * fps) / fps;
      if (at >= from && at < to) out.push({ text: word.text.trim(), at: Math.round(at * 100) / 100 });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
export function context(app: App, projectId: string, from: number, to: number): ScriptContext {
  const { project: p, rev } = liveProject(app, projectId);
  const fps = p.settings.fps;
  const r = (frames: number) => Math.round((frames / fps) * 100) / 100;
  const facts = readFacts(app, projectId);
  const inSpan = (c: Clip) => clipEnd(c) / fps > from && c.start / fps < to && trackOf(p, c.track)?.hidden !== true;
  const clips = p.clips.filter(inSpan).sort((a, b) => a.start - b.start).map((c) => ({
    id: c.id, type: c.type, name: c.name ?? "", track: c.track, from: r(c.start), to: r(clipEnd(c)),
    ...(c.type === "video" || c.type === "audio" ? { media: c.media, source_in: c.source_in, speed: c.speed } : {}),
    ...(c.type === "text" ? { text: c.text } : {}), ...(c.link ? { link: c.link } : {}),
  }));
  const shots = commentaryAudit.shots(p).filter((s) => s.to / fps > from && s.from / fps < to).map((s) => {
    const known = facts[factKey(p.clips.find((c) => c.id === s.id), s)];
    return { id: s.id, from: r(s.from), to: r(s.to), ...(known ? { facts: known as unknown as Record<string, unknown> } : {}) };
  });
  return {
    project: { id: p.id, title: p.name, fps, width: p.settings.width, height: p.settings.height, rev, span: [from, to], duration: r(Math.max(0, ...p.clips.map(clipEnd))) },
    clips, shots, words: narration(app, p, from, to),
    media: p.media.map((m) => ({ id: m.id, name: m.name, kind: m.kind, duration: Math.round(m.duration * 100) / 100, width: m.width, height: m.height })),
  };
}

// ---------------------------------------------------------------------------
// read_edit: the stretch as code.

const q = (v: unknown) => JSON.stringify(v);
const family = (name: string): string | null =>
  /^Janitor · YouTube list/u.test(name) ? "youtubeList" : /^Janitor · YouTube/u.test(name) ? "youtube" : /^Janitor · post/u.test(name) ? "tweet"
    : /^Janitor · bumper/u.test(name) ? "bumper" : /^Janitor · (source card|card backdrop|source credit)/u.test(name) ? "card"
    : /^Janitor · chapter/u.test(name) ? "chapter" : /^Janitor · profile/u.test(name) ? "profile" : null;

export function listing(ctx: ScriptContext, library: string[]): string {
  const lines: string[] = [];
  const { project } = ctx;
  const t = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
  lines.push(`// ${project.title} · ${t(project.span[0])}–${t(project.span[1])} of ${t(project.duration)} · rev ${project.rev} · ${project.fps} fps · ${project.width}×${project.height}`);
  if (library.length) lines.push(`// library: ${library.join(", ")}`);
  const mediaName = new Map(ctx.media.map((m) => [m.id, m.name]));
  const facts = new Map(ctx.shots.filter((s) => s.facts).map((s) => [s.id, s.facts as unknown as Facts]));
  const used = new Set<string>();
  const rows: [number, string][] = [];
  // Compositions: a backdrop and the layers of its family that arrive with it.
  for (const anchor of ctx.clips.filter((c) => /backdrop$/u.test(c.name) && family(c.name) !== null)) {
    if (used.has(anchor.id)) continue;
    const kind = family(anchor.name)!;
    // A list's rows are YouTube layers too.
    const mine = (c: { name: string }) => family(c.name) === kind || (kind === "youtubeList" && family(c.name) === "youtube");
    const layers = ctx.clips.filter((c) => mine(c) && c.from >= anchor.from - 0.01 && c.from < anchor.from + 1.2 && c.to <= anchor.to + 0.1 && !used.has(c.id));
    for (const c of layers) used.add(c.id);
    const textOf = (pattern: RegExp, among = layers) => among.filter((c) => pattern.test(c.name)).map((c) => (c.text ?? "").replace(/\s*\n\s*/gu, " ").trim()).filter((v) => v !== "").join(" ");
    const pic = layers.find((c) => /frame|source card|picture/u.test(c.name));
    const fields: Record<string, unknown> = { ids: layers.map((c) => c.id), from: anchor.from, to: anchor.to };
    if (kind === "youtube") Object.assign(fields, { media: pic?.media, source_in: pic?.source_in, title: textOf(/title/u), channel: textOf(/channel/u), meta: textOf(/views/u) || undefined, duration: textOf(/length/u) || undefined, avatar: layers.find((c) => /avatar/u.test(c.name))?.media });
    if (kind === "tweet") {
      const [handle, time] = textOf(/handle/u).split(" · ");
      Object.assign(fields, { name: textOf(/post name/u), handle: handle?.replace(/^@/u, ""), time, text: textOf(/post text/u), avatar: layers.find((c) => /avatar/u.test(c.name))?.media, media: pic?.media });
    }
    if (kind === "youtubeList") {
      // Each row: its frame, then the title and views that arrive with it.
      const frames = layers.filter((c) => /YouTube frame/u.test(c.name)).sort((a, b) => a.from - b.from);
      fields.items = frames.map((frame, i) => {
        const row = layers.filter((c) => c.from >= frame.from && c.from < (frames[i + 1]?.from ?? Infinity));
        return { media: frame.media, title: textOf(/title/u, row), meta: textOf(/views/u, row) || undefined, duration: textOf(/length/u, row) || undefined };
      });
    }
    if (kind === "card") Object.assign(fields, { media: pic?.media, label: textOf(/credit/u) || undefined });
    if (kind === "bumper" || kind === "chapter") Object.assign(fields, { text: textOf(/emphasis|title|name/u) });
    const seen = facts.get(anchor.id) ?? (pic ? facts.get(pic.id) : undefined);
    rows.push([anchor.from, `${kind}(${q(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== "")))})${pic?.media ? ` // ${mediaName.get(pic.media) ?? ""}` : ""}${seen ? ` · sees: ${seen.sees}${seen.fits === "no" ? ` · DOESN'T FIT: ${seen.why}` : ""}` : ""}`]);
  }
  for (const c of ctx.clips) {
    if (used.has(c.id)) continue;
    const seen = facts.get(c.id);
    const factsNote = seen ? ` · sees: ${seen.sees}${seen.text ? ` · text: ${seen.text}` : ""}${seen.empty ? " · EMPTY (no subject)" : ""}${seen.fits === "no" ? ` · DOESN'T FIT: ${seen.why}` : ""}` : "";
    if (c.type === "video") {
      const sound = c.link ? " · source excerpt with its own sound" : "";
      rows.push([c.from, `shot(${q(c.media)}, {id: ${q(c.id)}, from: ${c.from}, to: ${c.to}, source_in: ${Number((c.source_in ?? 0).toFixed(2))}, speed: ${c.speed}}) // ${c.name ? `${c.name} · ` : ""}${mediaName.get(c.media ?? "") ?? ""}${sound}${factsNote}`]);
    } else if (c.type === "text") {
      rows.push([c.from, `text(${q(c.text)}, {id: ${q(c.id)}, from: ${c.from}, to: ${c.to}}) // ${c.name}`]);
    } else if (c.type === "audio") {
      if (c.link) continue; // a source excerpt's sound is listed with its picture
      rows.push([c.from, `// sound ${c.id} ${t(c.from)}–${t(c.to)} ${q(c.name || mediaName.get(c.media ?? "") || "")}${/Voice-over|Cut-in/u.test(c.name) ? " (narration)" : ""}`]);
    } else {
      rows.push([c.from, `// ${c.type} ${c.id} ${t(c.from)}–${t(c.to)} ${q(c.name)}`]);
    }
  }
  rows.sort((a, b) => a[0] - b[0]);
  // The narration, a sentence-ish line at a time, between the clips it's said over.
  const said: [number, string][] = [];
  let line: { at: number; words: string[] } | null = null;
  for (const w of ctx.words) {
    if (line === null) line = { at: w.at, words: [] };
    line.words.push(w.text);
    if (/[.?!:]$/u.test(w.text) || line.words.length >= 18) { said.push([line.at, `// says @${line.at}: ${line.words.join(" ")}`]); line = null; }
  }
  if (line !== null) said.push([line.at, `// says @${line.at}: ${line.words.join(" ")}`]);
  const all = [...rows, ...said].sort((a, b) => a[0] - b[0] || (a[1].startsWith("// says") ? -1 : 1));
  lines.push(...all.map(([, l]) => l));
  const undescribed = ctx.shots.filter((s) => !s.facts).length;
  if (undescribed) lines.push(`// ${undescribed} of ${ctx.shots.length} shots not described yet: describe_shots over this stretch adds what each shows and whether it fits its words`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The library of graphics the agent writes.

const libraryDir = (app: App) => join(app.store.home, "graphics-lib");
function library(app: App): { name: string; code: string }[] {
  try {
    return fs.readdirSync(libraryDir(app)).filter((f) => f.endsWith(".ts")).sort().map((f) => ({ name: f.slice(0, -3), code: fs.readFileSync(join(libraryDir(app), f), "utf8") }));
  } catch { return []; }
}
function signatures(lib: { name: string; code: string }[]): string[] {
  return lib.flatMap((one) => [...one.code.matchAll(/export function (\w+)\(([^)]*)\)/gu)].map((m) => `${m[1]}(${m[2]!.replace(/\s+/gu, " ").slice(0, 80)})`));
}

// ---------------------------------------------------------------------------
// Running a script.

/** The evaluator: this same binary (or bun on main.ts in dev) as `script-eval`. */
function evaluator(): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:\\~BUN\\");
  return compiled ? [process.execPath, "script-eval"] : [process.execPath, Bun.main, "script-eval"];
}
export async function evaluate(code: string, ctx: ScriptContext, lib: { name: string; code: string }[], ms = 20_000): Promise<{ ops: Op[]; notes: string[]; lines?: (number | null)[]; error?: string }> {
  const child = Bun.spawn(evaluator(), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, EDIT_SCRIPT_EVAL: "1" } });
  child.stdin.write(JSON.stringify({ code, library: lib, context: ctx, run: Date.now().toString(36).slice(-4) }));
  child.stdin.end();
  let late = false;
  const timer = setTimeout(() => { late = true; child.kill(); }, ms);
  try {
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (late) return { ops: [], notes: [], error: `the script ran for more than ${ms / 1000} s (a loop that never ends?)` };
    if (exit !== 0) return { ops: [], notes: [], error: (err.trim().split("\n").slice(-3).join(" ") || `the script's process exited ${exit}`) };
    return JSON.parse(out) as { ops: Op[]; notes: string[]; error?: string };
  } finally { clearTimeout(timer); }
}

/** The compiler's own checks after a run: what describe_shots said doesn't fit, or shows nothing. */
export function lints(ctx: ScriptContext): string[] {
  const out: string[] = [];
  for (const s of ctx.shots) {
    const f = s.facts as unknown as Facts | undefined;
    if (f === undefined) continue;
    if (f.fits === "no") out.push(`error ${s.id} @${s.from}–${s.to}: the picture doesn't fit its words: ${f.why} (sees: ${f.sees})`);
    else if (f.empty) out.push(`error ${s.id} @${s.from}–${s.to}: shows no subject (sees: ${f.sees})`);
  }
  const undescribed = ctx.shots.filter((s) => !s.facts).length;
  if (undescribed) out.push(`info: ${undescribed} shot(s) here aren't described; describe_shots checks each picture against its words`);
  return out;
}

function firstText(content: Content[]): string {
  const block = content.find((c) => c.type === "text") as { text?: string } | undefined;
  return block?.text ?? "";
}

// ---------------------------------------------------------------------------
// describe_shots: frames into facts.

const SCHEMA = { type: "object", additionalProperties: false, required: ["shots"], properties: { shots: { type: "array", items: { type: "object", additionalProperties: false,
  required: ["n", "sees", "text", "people", "empty", "fits", "why"],
  properties: { n: { type: "integer" }, sees: { type: "string" }, text: { type: "string" }, people: { type: "string" }, empty: { type: "boolean" }, fits: { type: "string", enum: ["yes", "no", "unsure"] }, why: { type: "string" } } } } } };
const INSTRUCTIONS = `You check a video editor's shots. A source clip playing its own sound fits when it shows who is speaking or what they speak about. Each numbered image is one shot as the viewer sees it, with the narration said over it and what's known of its source. For each shot answer:
- sees: one plain sentence of what's on screen (setting, action, any graphic: a YouTube page, a post, a card, centred text).
- text: the words visible on screen, short, or "".
- people: who is shown, named ONLY from the given context (source title, the editor's notes) or visible text, e.g. "likely N3on (per source title)"; otherwise describe them ("a young man in glasses"). Never identify anyone from their face.
- empty: true when there's no person, action or thing the words could be about (an empty walkway, a blank screen).
- fits: does the picture show what the words say, or plausibly the person/event they name, given the context? "no" when it clearly doesn't (wrong person or event, an unrelated screenshot, a graphic whose words contradict the line, text naming something the narration doesn't), "unsure" when it can't be told.
- why: a short reason when fits isn't "yes", else "".`;

registerTool("read_edit", ({ app, args, projectId }) => {
  const { project: p } = liveProject(app, projectId);
  const [from, to] = spanOf(p, args);
  return text(listing(context(app, projectId, from, to), signatures(library(app))));
});

registerTool("run_edit", async ({ app, args, projectId }) => {
  if (typeof args.code !== "string" || args.code.trim() === "") throw new Error("code is the Edit Script (TypeScript)");
  const { project: p, rev } = liveProject(app, projectId);
  const [from, to] = spanOf(p, args);
  const ctx = context(app, projectId, from, to);
  const result = await diag.timeOnAsync("agent", "edit script: evaluate", projectId, () => evaluate(args.code as string, ctx, library(app)));
  if (result.error !== undefined) return text(stableStringify({ saved: false, error: result.error, queued_before_error: result.ops.length, notes: result.notes, hint: "nothing was saved; fix the script and run it again" }));
  const plan = result.ops.filter((op) => op.op !== "@tool");
  const tools = result.ops.filter((op) => op.op === "@tool");
  const dryRun = args.dry_run === true;
  let applied: Args = { saved: false, operations: 0 };
  if (plan.length > 0) {
    const apply = handlerFor("apply_edit_plan"); if (apply === undefined) throw new Error("apply_edit_plan isn't available");
    // The plan's operation n back to the script line that queued it.
    const planLines = result.ops.map((op, i) => [op, result.lines?.[i] ?? null] as const).filter(([op]) => op.op !== "@tool").map(([, line]) => line);
    try {
      const answer = await apply.handler({ app, args: { base_rev: rev, operations: plan, dry_run: dryRun }, projectId } as never);
      try { applied = JSON.parse(firstText(answer)) as Args; } catch { applied = { result: firstText(answer).slice(0, 4000) }; }
    } catch (error) {
      const message = diag.messageOf(error).replace(/operation (\d+)/u, (all, n: string) => { const line = planLines[Number(n) - 1]; return line ? `line ${line} (${all})` : all; });
      return text(stableStringify({ saved: false, error: message, notes: result.notes, hint: "nothing was saved; fix the script and run it again" }));
    }
  }
  const after: Args[] = [];
  if (!dryRun) for (const op of tools) {
    const tool = handlerFor(String(op.tool)); if (tool === undefined) { after.push({ tool: op.tool, error: "not available" }); continue; }
    try { after.push({ tool: op.tool, result: firstText(await tool.handler({ app, args: op.args as Args, projectId } as never)).slice(0, 600) }); }
    catch (error) { after.push({ tool: op.tool, error: diag.messageOf(error) }); }
  }
  // The plan's audit, only where this script worked.
  const fps = p.settings.fps;
  const audit = (applied.audit as Args | undefined) ?? {};
  const issues = Array.isArray(audit.issues) ? (audit.issues as Args[]).filter((i) => {
    const at = typeof i.start === "number" ? i.start : typeof i.at === "number" ? i.at : null;
    return at !== null && at / fps >= from - 1 && at / fps <= to + 1;
  }) : [];
  const now = context(app, projectId, from, to);
  return text(stableStringify({
    saved: !dryRun && plan.length + tools.length > 0, dry_run: dryRun, rev: applied.rev ?? rev, operations: plan.length, tools: after, notes: result.notes,
    results: applied.results, issues_here: issues, lints: lints(now),
  }));
});

registerTool("describe_shots", async ({ app, args, projectId }) => {
  const { project: p } = liveProject(app, projectId);
  const [from, to] = spanOf(p, args);
  const ctx = context(app, projectId, from, to);
  const fps = p.settings.fps;
  const facts = readFacts(app, projectId);
  const seen = observations(app, projectId);
  const todo = ctx.shots.filter((s) => (args.refresh === true || s.facts === undefined) && s.to - s.from >= 0.15).slice(0, 60);
  if (todo.length === 0) return text(`every shot in ${from}–${to}s is described; refresh: true to look again`);
  const frames = todo.map((s) => Math.floor(((s.from + s.to) / 2) * fps));
  const pictures = await native().renderFrames({ project: { json: JSON.stringify(p) }, frames, maxSide: 768, priority: "agent", encode: "agent" });
  const described: string[] = [];
  for (let i = 0; i < todo.length; i += 8) {
    const batch = todo.slice(i, i + 8);
    const input: Args[] = [];
    const lines = batch.map((s, k) => {
      const clip = p.clips.find((c) => c.id === s.id);
      const media = clip?.type === "video" ? mediaOf(p, clip.media) : undefined;
      const words = ctx.words.filter((w) => w.at >= s.from && w.at < s.to).map((w) => w.text).join(" ");
      const near = ctx.words.filter((w) => w.at >= s.from - 3 && w.at < s.to + 1).map((w) => w.text).join(" ");
      // A source excerpt speaks for itself: what's said in it is its line.
      let own = "";
      if (clip?.type === "video" && clip.link && media !== undefined) {
        try {
          const heard = parseTranscript(fs.readFileSync(app.media.paths(media.path).transcript, "utf8")).words;
          const out = clip.source_in + (clip.duration / fps) * clip.speed;
          own = heard.filter((w) => w.start >= clip.source_in - 0.1 && w.end <= out + 0.1).map((w) => w.text.trim()).join(" ");
        } catch { own = ""; }
      }
      return `#${k + 1} (${s.from}–${s.to}s) clip "${clip?.name ?? ""}"; source: "${media?.name ?? "a graphic"}"${media && seen.has(media.id) ? `; editor's note: ${seen.get(media.id)}` : ""}; ${own ? `a source clip playing its own sound, saying: "${own}"` : `said over it: "${words || "(nothing: a pause)"}"`}; around it: "${near}"`;
    });
    batch.forEach((_, k) => {
      const pic = pictures[i + k]; if (pic === undefined) return;
      input.push({ type: "image", data: Buffer.from(pic.data).toString("base64"), mime: pic.mime });
    });
    input.push({ type: "text", text: `Shots, in the images' order:\n${lines.join("\n")}` });
    const answer = await app.agents.ask(DESCRIBER, "low", INSTRUCTIONS, input as never, SCHEMA, 300_000);
    const parsed = (JSON.parse(answer) as { shots: (Facts & { n: number })[] }).shots;
    for (const one of parsed) {
      const s = batch[one.n - 1]; if (s === undefined) continue;
      const { n: _n, ...fact } = one;
      facts[factKey(p.clips.find((c) => c.id === s.id), { id: s.id, from: Math.round(s.from * fps), to: Math.round(s.to * fps) })] = fact;
      described.push(`${s.id} @${s.from}: ${fact.sees}${fact.fits !== "yes" ? ` [${fact.fits.toUpperCase()}: ${fact.why}]` : ""}${fact.empty ? " [EMPTY]" : ""}`);
    }
  }
  fs.mkdirSync(parent(factsFile(app, projectId))!, { recursive: true });
  writeAtomic(factsFile(app, projectId), JSON.stringify(facts));
  return text(`${described.length} shots described (${DESCRIBER}); read_edit and run_edit show them, run_edit's lints flag the ones that don't fit:\n${described.join("\n")}`);
});

registerTool("save_graphic", ({ app, args }) => {
  if (typeof args.name !== "string" || !/^[a-z][A-Za-z0-9]{1,40}$/u.test(args.name)) throw new Error("name is a function name, camelCase (youtubeCard)");
  if (typeof args.code !== "string" || !new RegExp(`export function ${args.name}\\(`, "u").test(args.code)) throw new Error(`code must contain export function ${args.name}(…), written with the Edit Script calls`);
  const dir = libraryDir(app); fs.mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, `${args.name}.ts`), args.code);
  return text(`saved ${args.name} to the graphics library: every run_edit script (any project) can call it`);
}, { noProject: true });

registerTool("edit_script_reference", () => [...text(REFERENCE)], { noProject: true });

export const forTests = { listing, lints };
