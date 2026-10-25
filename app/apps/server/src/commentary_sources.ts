// Commentary's visual research: batched YouTube discovery, captions without
// video downloads, bounded excerpts through the shared cloud media registry.
// Keep the beat and source clock together so subsequent edits can reuse them.
import * as fs from "node:fs";
import type { App } from "./app.ts";
import { writeAtomic } from "./files.ts";
import { importMade, importPaths } from "./import.ts";
import wallpaper from "../../../assets/commentary/background.png" with { type: "file" };
import { registerTool, text } from "./mcp/registry.ts";
import { join, parent } from "./paths.ts";
import * as cloud from "./cloud.ts";
import * as seams from "./seams.ts";
import * as youtube from "./youtube.ts";
import { stableStringify } from "./stable.ts";
import { capture } from "./evidence_capture.ts";

type Args = Record<string, unknown>;

registerTool("capture_evidence", async ({ app, args, projectId }) => {
  if (typeof args.url !== "string") throw new Error("url is required");
  const dir = join(app.store.home, "research", projectId, "captures"); fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, `source-${Date.now()}.png`);
  const result = await capture(args.url, path, typeof args.phrase === "string" ? args.phrase : "", typeof args.selector === "string" ? args.selector : "");
  const [, ids, errors] = await importPaths(app, projectId, [path], false, "agent");
  const media = ids[0]; if (media === undefined) throw new Error(errors.join("; "));
  keep(app, projectId, `capture:${media}`, { ...result, media, captured: Date.now() });
  return text(stableStringify({ media, url: result.url, title: result.title, note: "Real page capture, not reconstructed content. Inspect it before use: a site may show a consent/login page or irrelevant UI. Add a commentary_card, then highlight_evidence on its returned photo clip." }));
});
export interface BrollRange { url: string; start: number; end: number; purpose: string; }
export function rangeOf(value: unknown): BrollRange {
  const one = value as Partial<BrollRange> | null;
  if (one == null || typeof one.url !== "string" || youtube.videoId(one.url) === null ||
      typeof one.start !== "number" || !Number.isFinite(one.start) || one.start < 0 ||
      typeof one.end !== "number" || !Number.isFinite(one.end) || one.end <= one.start || one.end - one.start > 240 ||
      typeof one.purpose !== "string" || one.purpose.trim() === "") {
    throw new Error("each B-roll range needs a YouTube url, start/end in source seconds (at most 240 s), and its narration purpose");
  }
  return { url: one.url, start: one.start, end: one.end, purpose: one.purpose.trim() };
}

/** Bounded subprocess; never put proxy credentials in an error. */
async function run(home: string, args: string[], ms = 100_000): Promise<string> {
  const binary = await youtube.ytdlp(home);
  const child = Bun.spawn([binary, "--no-warnings", "--socket-timeout", "20", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), ms);
  try {
    const [out, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error("YouTube research failed or timed out; try another query or use an already supplied source");
    return out;
  } finally { clearTimeout(timer); }
}

function keep(app: App, project: string, key: string, value: unknown): void {
  const path = join(app.store.home, "research", project, "broll.json");
  fs.mkdirSync(parent(path)!, { recursive: true });
  let saved: Args = {};
  try { saved = JSON.parse(fs.readFileSync(path, "utf8")) as Args; } catch { /* first search */ }
  saved[key] = value;
  writeAtomic(path, JSON.stringify(saved, null, 2));
}

registerTool("search_broll", async ({ app, args, projectId }) => {
  if (!Array.isArray(args.queries) || args.queries.length > 8 || args.queries.some((q) => typeof q !== "string" || q.trim() === "")) {
    throw new Error("queries must contain 0–8 specific visual searches (empty lists saved sources and observations)");
  }
  if (args.queries.length === 0) {
    let inventory: unknown = {};
    try { inventory = JSON.parse(fs.readFileSync(join(app.store.home, "research", projectId, "broll.json"), "utf8")); } catch { /* no sources yet */ }
    const [, ids, errors] = await importPaths(app, projectId, [wallpaper], false, "agent");
    return text(stableStringify({ inventory, brand_background: ids[0] ?? null, errors }));
  }
  const limit = Math.max(1, Math.min(8, Number(args.per_query) || 5));
  const results: unknown[] = [];
  // Two searches at a time, not one browser/model round trip for each beat.
  for (let i = 0; i < args.queries.length; i += 2) {
    results.push(...await Promise.all(args.queries.slice(i, i + 2).map(async (query) => {
      try {
        const data = JSON.parse(await run(app.store.home, ["--flat-playlist", "--dump-single-json", `ytsearch${limit}:${String(query)}`])) as { entries?: Args[] };
        const videos = (data.entries ?? []).filter((e) => typeof e.id === "string" && !["is_live", "is_upcoming"].includes(String(e.live_status))).map((e) => ({
          id: e.id, url: `https://www.youtube.com/watch?v=${String(e.id)}`, title: e.title, channel: e.channel ?? e.uploader,
          duration: e.duration, views: e.view_count, thumbnail: `https://i.ytimg.com/vi/${String(e.id)}/hqdefault.jpg`,
        }));
        keep(app, projectId, `query:${String(query)}`, { at: Date.now(), videos });
        return { query, videos };
      } catch (error) { return { query, error: error instanceof Error ? error.message : String(error) }; }
    })));
  }
  return text(stableStringify({ results, next: "Titles are leads, not visual verification. Read likely sources, import chosen ranges, then inspect their frames before placing. Prefer primary uploads and distinct scenes matching the narration." }));
});

registerTool("read_broll_source", async ({ app, args, projectId }) => {
  const id = typeof args.url === "string" ? youtube.videoId(args.url) : null;
  if (id === null) throw new Error("url must be a YouTube video");
  const dir = join(app.store.home, "research", projectId, "youtube", id);
  fs.mkdirSync(dir, { recursive: true });
  const cached = join(dir, "source.json");
  let source: Args;
  try { source = JSON.parse(fs.readFileSync(cached, "utf8")) as Args; }
  catch {
    const answer = await run(app.store.home, ["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", "en,en-orig", "--sub-format", "json3", "--dump-single-json", "-o", join(dir, "captions.%(ext)s"), `https://www.youtube.com/watch?v=${id}`]);
    const info = JSON.parse(answer) as Args;
    const file = fs.readdirSync(dir).find((name) => name.endsWith(".json3"));
    const data = file === undefined ? { events: [] } : JSON.parse(fs.readFileSync(join(dir, file), "utf8")) as { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] };
    const lines = (data.events ?? []).flatMap((e) => {
      const said = (e.segs ?? []).map((s) => s.utf8 ?? "").join("").trim();
      return said === "" ? [] : [{ at: (e.tStartMs ?? 0) / 1000, text: said }];
    });
    source = { url: `https://www.youtube.com/watch?v=${id}`, title: info.title, channel: info.channel ?? info.uploader, date: info.upload_date, duration: info.duration, lines };
    writeAtomic(cached, JSON.stringify(source));
    keep(app, projectId, `source:${id}`, { url: source.url, title: source.title, channel: source.channel, date: source.date });
  }
  const from = typeof args.start === "number" ? args.start : 0;
  const until = typeof args.end === "number" ? args.end : Infinity;
  const query = typeof args.phrase === "string" ? args.phrase.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const lines = ((source.lines ?? []) as { at: number; text: string }[]).filter((line) => line.at >= from && line.at <= until && (query.length === 0 || query.some((q) => line.text.toLowerCase().includes(q))));
  return text(stableStringify({ ...source, lines: lines.slice(0, 140), omitted: Math.max(0, lines.length - 140), note: "Automatic captions guide the search; they do not prove what is visible. Narrow by phrase/start/end, then inspect an imported range." }));
});

registerTool("import_broll", async ({ app, args, projectId }) => {
  if (!Array.isArray(args.ranges) || args.ranges.length === 0 || args.ranges.length > 12) throw new Error("ranges must contain 1–12 source ranges");
  const ranges = args.ranges.map(rangeOf); // validate the entire batch before downloads
  const results: unknown[] = [];
  // Reuse one original for all ranges from that video; no persistent preview download.
  for (const id of new Set(ranges.map((r) => youtube.videoId(r.url)!))) {
    const picks = ranges.filter((r) => youtube.videoId(r.url) === id);
    try {
      if (!cloud.enabled()) throw new Error("B-roll sourcing needs cloud storage; sign in to Edit");
      const cut = await seams.cloudMedia.youtubeExcerpts(app.store.home, app.store.cacheDir(), `youtube:${id}`, picks.map((p) => [p.start, p.end]));
      const [, ids, errors] = await importMade(app, projectId, cut.flatMap((e) => e.cloud === null ? [] : [e.cloud]), false, "agent");
      if (errors.length > 0) throw new Error(errors.join("; "));
      for (const pick of picks) {
        const index = cut.findIndex((e) => e.from <= pick.start && e.to >= pick.end - 0.05);
        const excerpt = cut[index]; const media = ids[index];
        if (excerpt === undefined || media === undefined) throw new Error("the imported excerpt did not cover its requested source range");
        const found = { ...pick, media, source_in: pick.start - excerpt.from, source_offset: excerpt.from, duration: pick.end - pick.start, verified: false };
        keep(app, projectId, `range:${id}:${pick.start}:${pick.end}`, found);
        results.push(found);
      }
    } catch (error) { results.push({ url: `https://www.youtube.com/watch?v=${id}`, error: error instanceof Error ? error.message : String(error) }); }
  }
  return text(stableStringify({ results, next: "Inspect each selected scene with look_at_media, then place its returned media/source_in. Source audio stays off under narration. Save actual frame observations with record_broll_observations." }));
});

registerTool("record_broll_observations", ({ app, args, projectId }) => {
  if (!Array.isArray(args.observations)) throw new Error("observations must be a list");
  const project = app.store.get(projectId)?.project;
  for (const value of args.observations) {
    const one = value as Args;
    if (typeof one.media !== "string" || !project?.media.some((m) => m.id === one.media) || typeof one.seen !== "string" || one.seen.trim() === "" || typeof one.purpose !== "string") throw new Error("each observation needs a project media id, what its inspected frames show, and the narration purpose");
    keep(app, projectId, `observation:${one.media}`, { ...one, at: Date.now() });
  }
  return text("Saved frame observations and their narration purposes. These are the editor's observations, not an automatic claim of verification.");
});
