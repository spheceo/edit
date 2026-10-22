// Writer's scripts into Edit (docs/plans/2026-10-22-share-review-handoff.md):
// Writer is where scripts are written, and its scripts sync to Repack's
// Convex with their files on R2 (`writer:listScripts` / `getScript`, read
// through Edit's relay, which never lets Edit write them). Importing one
// makes an Edit project with the script as a Doc would give it, and the
// script import does the rest: footage Writer put in the shared registry
// (`editMedia`, by Drive id or YouTube id) is found there, not downloaded.
//
// Writer's footage script is clips in play order on one clock: footage
// ranges of the source (`startMs`/`endMs`), and cut-ins holding a narration
// paragraph. A Drive folder's recordings are joined on that clock, `parts`
// saying where each one starts and its link; a footage clip across two
// recordings plays as one range of each. A clip's notes are the producer's
// for the editor, an "edit:" one an instruction the agent follows there.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { ApiError } from "./http/errors.ts";
import type { Router } from "./http/router.ts";
import type { ScriptBlock, Style } from "./model.ts";
import * as script from "./script.ts";
import type { Parsed } from "./seams.ts";
import { writeAtomic } from "./files.ts";
import { join } from "./paths.ts";
import { stableStringify } from "./stable.ts";

/** A Writer script as its `script.json` has it (the parts the handoff reads). */
export interface WriterScript {
  id: string;
  title: string;
  sourceKind?: string;
  sourceUrl?: string;
  kind?: string;
  clips?: { id: string; startMs: number; endMs: number; kind?: string; narration?: string; notes?: { text: string }[] }[];
  parts?: { title: string; startMs: number; durationMs: number; url?: string }[];
  commentary?: unknown;
}

/** The house style a Writer script's kind edits in. */
export function styleOf(kind: string | undefined): Style {
  return kind === "courtroom" ? "courtroom" : kind === "foia" ? "bodycam" : "interrogation";
}

const mmss = (seconds: number) => {
  const whole = Math.max(Math.round(seconds), 0);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
};

/**
 * A Writer script as Edit's script blocks, or why it can't come over: a
 * commentary script has no footage of its own, and footage only on the Mac
 * it was imported on (a disk file) has no link another machine can fetch.
 */
export function toParsed(given: WriterScript): Parsed {
  if (given.sourceKind === "commentary" || (given.commentary !== undefined && given.commentary !== null)) {
    throw new Error("a commentary script has no footage of its own to edit; export its Google Doc and import that");
  }
  const parts = (given.parts ?? []).filter((part) => part.durationMs > 0);
  // The recordings on the script's clock, each with its file.
  const files: { start: number; end: number; url: string; file: string }[] = [];
  if (parts.length === 0) {
    const url = given.sourceUrl ?? "";
    const file = script.footageFile(url);
    if (file === null) throw new Error(`its footage (${given.sourceKind ?? "a file"}) is only on the Mac that imported it: import it in Writer from Drive or YouTube to hand it over`);
    files.push({ start: 0, end: Number.MAX_SAFE_INTEGER, url, file });
  } else {
    for (const part of parts) {
      const file = part.url === undefined ? null : script.footageFile(part.url);
      if (file === null) throw new Error(`"${part.title}" has no Drive or YouTube link: import it in Writer from Drive or YouTube to hand it over`);
      files.push({ start: part.startMs, end: part.startMs + part.durationMs, url: part.url!, file });
    }
  }
  const blocks: ScriptBlock[] = [];
  for (const clip of given.clips ?? []) {
    const notes = (clip.notes ?? []).map((note) => note.text.trim()).filter((text) => text !== "");
    if (clip.kind === "cut-in") {
      const text = (clip.narration ?? "").trim();
      if (text !== "") blocks.push({ kind: "narration", text, ...(notes.length > 0 ? { notes } : {}) });
      continue;
    }
    // One range of each recording the clip plays over; its notes go with the first.
    let first = true;
    for (const one of files) {
      const from = Math.max(clip.startMs, one.start);
      const to = Math.min(clip.endMs, one.end);
      if (to - from < 100) continue;
      const [start, end] = [(from - one.start) / 1000, (to - one.start) / 1000];
      blocks.push({
        kind: "footage",
        url: one.url,
        file: one.file,
        start,
        end,
        label: `${mmss(start)} - ${mmss(end)}`,
        ...(first && notes.length > 0 ? { notes } : {}),
      });
      first = false;
    }
  }
  if (!blocks.some((block) => block.kind === "footage")) throw new Error("it has no footage ranges yet: build the script in Writer first");
  return { title: given.title, blocks };
}

/** Which Writer scripts were made into which Edit projects here (`<home>/writer-imports.json`). */
function imports(home: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(join(home, "writer-imports.json"), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Writer's scripts in the cloud, newest first (deleted ones left out), each with the Edit project made from it here. */
export async function list(
  app: App,
): Promise<{ id: string; title: string; rev: number; updatedAt: number; updatedBy: string | null; project: string | null; handoff: { at: number; by: string | null; changed: boolean } | null; clips: number; durationMs: number; built: boolean; style: Style | null }[]> {
  const made = imports(app.store.home);
  if (!cloud.enabled()) throw new Error("Writer's scripts need Edit's cloud (the relay token)");
  const rows = (await cloud.query("writer:listScripts", {})) as Record<string, unknown>[];
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row.deletedAt === undefined || row.deletedAt === null)
    .map((row) => ({
      id: String(row.scriptId ?? ""),
      title: String(row.title ?? "Untitled"),
      rev: Number(row.rev ?? 0),
      updatedAt: Number(row.updatedAt ?? 0),
      updatedBy: typeof row.updatedBy === "string" ? row.updatedBy : null,
      // From Writer's library row: a built script has its footage cut into clips (a source being researched is one whole clip, or none).
      ...(() => {
        const summary = (row.summary ?? {}) as { clipCount?: unknown; durationMs?: unknown; status?: unknown; kind?: unknown };
        const clips = typeof summary.clipCount === "number" ? summary.clipCount : 0;
        // Its kind of video, once Writer's row says it (as its script's `kind`).
        const style = typeof summary.kind === "string" && summary.kind !== "" ? styleOf(summary.kind) : null;
        return { clips, durationMs: typeof summary.durationMs === "number" ? summary.durationMs : 0, built: clips > 1, style };
      })(),
      // Sent to Edit from Writer ("Send to Edit"), and whether it changed since.
      handoff: (() => {
        const mark = row.handoff as { at?: number; by?: string; rev?: number } | null | undefined;
        if (mark === null || mark === undefined || typeof mark.at !== "number") return null;
        return { at: mark.at, by: typeof mark.by === "string" ? mark.by : null, changed: Number(row.rev ?? 0) > Number(mark.rev ?? 0) };
      })(),
      project: (() => {
        const id = made[String(row.scriptId ?? "")];
        return id !== undefined && app.store.get(id) !== null ? id : null;
      })(),
    }))
    .filter((row) => row.id !== "")
    // Those sent to Edit first, newest first.
    .sort((a, b) => Number(b.handoff !== null) - Number(a.handoff !== null) || (b.handoff?.at ?? b.updatedAt) - (a.handoff?.at ?? a.updatedAt));
}

/** A Writer script's body, read from R2 (the relay presigns it). */
export async function fetchScript(id: string): Promise<WriterScript> {
  const row = (await cloud.query("writer:getScript", { scriptId: id })) as Record<string, unknown> | null;
  if (row === null || typeof row.bodyKey !== "string") throw new Error("no such script in Writer's cloud");
  const url = await cloud.presign(row.bodyKey, "GET");
  const answer = await fetch(url);
  if (!answer.ok) throw new Error(`Writer's script didn't download (HTTP ${answer.status})`);
  return (await answer.json()) as WriterScript;
}

/** Makes an Edit project from a Writer script and starts its import (footage, transcripts, voice-over, layout). */
export async function importScript(app: App, id: string): Promise<{ project: string }> {
  const given = await fetchScript(id);
  const parsed = toParsed(given);
  const live = app.store.createAs(given.title, styleOf(given.kind), { width: 1920, height: 1080, fps: 30 });
  await app.store.update(live.project.id, "script", (project) => script.attach(project, `writer:${id}`, parsed));
  script.start(app, live.project.id, false);
  writeAtomic(join(app.store.home, "writer-imports.json"), JSON.stringify({ ...imports(app.store.home), [id]: live.project.id }));
  diag.info("script", `${given.title}: imported from Writer (${parsed.blocks.length} blocks)`);
  return { project: live.project.id };
}

function sorted(value: unknown, status = 200): Response {
  return new Response(stableStringify(value), { status, headers: { "content-type": "application/json" } });
}

export function routes(router: Router<App>): void {
  router.get("/api/writer/scripts", async ({ app }) => {
    try {
      return sorted({ scripts: await list(app) });
    } catch (error) {
      throw new ApiError(400, diag.messageOf(error));
    }
  });
  router.get("/api/writer/scripts/{id}", async ({ params }) => {
    try {
      const given = await fetchScript(params.id ?? "");
      return sorted({ ...script.summary(toParsed(given)), title: given.title, style: styleOf(given.kind) });
    } catch (error) {
      throw new ApiError(400, diag.messageOf(error));
    }
  });
  router.post("/api/writer/scripts/{id}/import", async ({ app, params }) => {
    try {
      return sorted(await importScript(app, params.id ?? ""));
    } catch (error) {
      throw new ApiError(400, diag.messageOf(error));
    }
  });
}
