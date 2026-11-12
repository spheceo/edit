// The small frames the progress bar shows as the pointer moves over it, as a
// video site makes them (Sphe, Nov 12: "try to really work on the precision
// of the images that show up when we hover"): sheets of 100 cut from the
// smooth render's keyframes, one every 2 s, in a single pass (a 34-minute
// edit's 1,096 in 8 s on mandalorian, 4 MB), made the first time the bar asks
// for this render and kept beside it until the next one. Before, the bar had
// a frame every 30 s drawn by the engine (0.1–2 s each), so a hover could show
// one 15 s away. The exact frame under a resting pointer still comes from the
// frame route (web lib/storyboard.ts).

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { json, notFound } from "./http/errors.ts";
import { serveFile } from "./http/files.ts";
import type { Router } from "./http/router.ts";
import { readState, writeAtomic } from "./files.ts";
import { fileName, isFile, join, parent } from "./paths.ts";
import * as playback from "./playback_render.ts";
import * as tools from "./tools.ts";

/** A sheet's frames across and down. */
export const COLUMNS = 10;
export const ROWS = 10;
/** A frame's size on a sheet (px): sharp at the bar's 176 px preview on a 2× screen's half. */
export const WIDTH = 192;

export interface Board {
  /** The render it was cut from. */
  stamp: string;
  columns: number;
  rows: number;
  width: number;
  height: number;
  /** Each frame's time in the edit (seconds), in sheet order. */
  times: number[];
}

/** Renders whose sheets are being cut now. */
const making = new Set<string>();

function folder(path: string, stamp: string): string {
  return `${path.replace(/\.mp4$/u, "")}.storyboard-${stamp}`;
}

/** Cuts the sheets of `path` into its folder: the keyframes' times, then the frames, then the index that says it's done. */
async function make(id: string, path: string, stamp: string, width: number, height: number): Promise<void> {
  const into = folder(path, stamp);
  fs.mkdirSync(into, { recursive: true });
  const listed = new TextDecoder().decode(await tools.run([tools.ffprobe(), "-v", "error", "-select_streams", "v", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", path]));
  const times = listed.split("\n").filter((line) => line.split(",")[1]?.startsWith("K")).map((line) => Number(line.split(",")[0])).filter(Number.isFinite).sort((a, b) => a - b);
  await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-skip_frame", "nokey", "-i", path, "-an", "-vf", `scale=${width}:${height},tile=${COLUMNS}x${ROWS}`, "-fps_mode", "passthrough", "-q:v", "5", join(into, "sheet-%03d.jpg")], { timeoutMs: 15 * 60_000 });
  const board: Board = { stamp, columns: COLUMNS, rows: ROWS, width, height, times };
  writeAtomic(join(into, "board.json"), JSON.stringify(board));
  // The renders before this one: their sheets go.
  const home = parent(path) ?? ".";
  const prefix = `${fileName(path)?.replace(/\.mp4$/u, "")}.storyboard-`;
  for (const name of fs.readdirSync(home)) if (name.startsWith(prefix) && name !== fileName(into)) fs.rmSync(join(home, name), { recursive: true, force: true });
  diag.info("playback", `${id}: the progress bar's ${times.length} frames cut from the smooth render`);
}

/** The board for `id`'s render `stamp`: ready, being cut (started now if it wasn't), or none (no such render here). */
export function board(app: App, id: string, stamp: string): Board | "making" | null {
  const ready = playback.readyFile(app, id);
  if (ready === null || ready.stamp !== stamp) return null;
  const saved = readState(join(folder(ready.path, stamp), "board.json")) as Board | null | undefined;
  if (saved !== null && saved !== undefined && Array.isArray(saved.times)) return saved;
  if (!making.has(ready.path)) {
    making.add(ready.path);
    const project = app.store.get(id)?.project;
    const width = WIDTH;
    const height = project === undefined ? 108 : Math.max(2, Math.round((WIDTH * project.settings.height) / project.settings.width / 2) * 2);
    make(id, ready.path, stamp, width, height)
      .catch((error: unknown) => diag.warn("playback", `${id}: the progress bar's frames weren't cut: ${diag.messageOf(error)}`))
      .finally(() => making.delete(ready.path));
  }
  return "making";
}

export function routes(router: Router<App>): void {
  router
    .get("/api/projects/{id}/storyboard", ({ app, params, url }) => {
      const found = board(app, params.id ?? "", url.searchParams.get("v") ?? "");
      if (found === null) throw notFound("no smooth render to cut frames from");
      return json(found === "making" ? { state: "making" } : { state: "ready", ...found });
    })
    .get("/api/projects/{id}/storyboard/{n}", ({ app, params, request, url }) => {
      const ready = playback.readyFile(app, params.id ?? "");
      const stamp = url.searchParams.get("v") ?? "";
      const n = Number(/^(\d+)\.jpg$/u.exec(params.n ?? "")?.[1] ?? Number.NaN);
      if (ready === null || ready.stamp !== stamp || !Number.isInteger(n)) throw notFound("no such sheet");
      const path = join(folder(ready.path, stamp), `sheet-${String(n + 1).padStart(3, "0")}.jpg`);
      if (!isFile(path)) throw notFound("no such sheet");
      const response = serveFile(request, path);
      response.headers.set("cache-control", "private, max-age=86400");
      return response;
    });
}
