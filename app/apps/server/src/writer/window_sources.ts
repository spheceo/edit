// What Edit.app's window player reads a script's recordings from
// (docs/plans/2026-11-10-script-player.md; the edit's is native_preview.ts).
// The script page plays its cut on the window's own player, the one the
// editor uses, when every recording the cut plays is a file on this Mac: the
// player reads files with the Mac's video decoder, and a stream only through
// FFmpeg, which opens it again at every jump (seconds a frame). So the page
// names the addresses its cut plays from (the same ones its own player
// reads), and each is answered with the file behind it and what's in it, or
// left out when it isn't here; the page's own player plays those from the
// cloud as before.
//
// A script's preview that's only in the cloud (made on another Mac, or left
// to the cloud when room was short) comes down whole behind the ask when the
// scripts' footage and Edit's cache have room for it (storage.overBudget, the
// same budget that later decides what leaves), and the page asks again until
// it's here. With no room it stays in the cloud and plays as it did.

import type { CutSource } from "@edit/types/script_cut";

import * as fs from "node:fs";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { native } from "../native/index.ts";
import { isFile, join } from "../paths.ts";
import * as cloud from "./cloud.ts";
import * as footage from "./footage.ts";
import * as storage from "./storage.ts";
import * as store from "./store.ts";

/** What the page is told: each address's file, the ones coming down, and Edit's media cache. */
export interface WindowSources {
  cache: string;
  sources: Record<string, CutSource>;
  /** Addresses whose file is on its way here: asked again shortly. */
  coming: string[];
}

/** A preview that didn't come down, or had no room, isn't tried again for this long. */
const RETRY_MS = 10 * 60_000;
const bringing = new Set<string>();
const notNow = new Map<string, number>();
/** What's in each file, by its path, size and time. */
const probed = new Map<string, { stamp: string; source: CutSource }>();

/** Seams for tests. */
export const hooks = {
  fetchPreview: (data: string, id: string): Promise<string> => cloud.fetchPreview(data, id),
  overBudget: (data: string, cache: string): number => storage.overBudget(data, cache),
};

/** The script and the file an address of the script page's player stands for (the routes that serve them), or null for any other. */
function fileOf(data: string, src: string): { id: string; path: string; preview: boolean } | null {
  let path: string;
  try {
    path = decodeURIComponent(new URL(src, "http://edit").pathname);
  } catch {
    return null;
  }
  const found = /^\/api\/writer\/scripts\/([^/]+)\/(proxy|files\/[^/]+|footage\/[^/]+)$/u.exec(path);
  if (found === null || !store.idOk(found[1]!)) return null;
  const [id, rest] = [found[1]!, found[2]!];
  const dir = store.scriptDir(data, id);
  if (rest === "proxy") return { id, path: store.proxyPath(dir), preview: true };
  const name = rest.slice(rest.indexOf("/") + 1);
  if (rest.startsWith("footage/")) {
    const clip = footage.file(dir, name);
    return clip === null ? null : { id, path: clip, preview: false };
  }
  return /^[\w .()-]+$/u.test(name) && !name.startsWith(".") ? { id, path: join(dir, name), preview: false } : null;
}

async function describe(path: string): Promise<CutSource> {
  const meta = fs.statSync(path);
  const stamp = `${meta.size}-${meta.mtimeMs}`;
  const known = probed.get(path);
  if (known !== undefined && known.stamp === stamp) return known.source;
  const found = await native().probe(path);
  const source: CutSource = {
    path,
    width: found.kind === "audio" ? 0 : found.width,
    height: found.kind === "audio" ? 0 : found.height,
    durationMs: Math.round(found.duration * 1000),
    fps: found.fps,
    sound: found.has_audio || found.kind === "audio",
  };
  probed.set(path, { stamp, source });
  return source;
}

/** Brings a script's preview down from the cloud behind the ask, when there's room for it; whether it's on its way. */
function bring(data: string, cache: string, id: string): boolean {
  if (bringing.has(id)) return true;
  if (Date.now() - (notNow.get(id) ?? 0) < RETRY_MS) return false;
  const kept = cloud.fileKey(data, id, "proxy.mp4");
  if (kept === null || kept.key === "") return false;
  if (hooks.overBudget(data, cache) + kept.size > 0) {
    notNow.set(id, Date.now());
    diag.info("writer", `${id.slice(0, 8)}: its preview (${(kept.size / 1e9).toFixed(1)} GB) stays in the cloud: no room for it here, so the page plays it`);
    return false;
  }
  bringing.add(id);
  const started = performance.now();
  void hooks
    .fetchPreview(data, id)
    .then(() => diag.info("writer", `${id.slice(0, 8)}: its preview is here for the window's player in ${diag.human(performance.now() - started)}`))
    .catch((error: unknown) => {
      notNow.set(id, Date.now());
      diag.warn("writer", `${id.slice(0, 8)}: its preview didn't come down for the window's player: ${diag.messageOf(error)}`);
    })
    .finally(() => bringing.delete(id));
  return true;
}

/**
 * Each of `srcs` (the addresses the script page's player reads) as the file
 * the window's player reads instead, for the scripts `readable` lets this
 * person see; a preview only in the cloud is brought down behind it.
 */
export async function windowSources(app: App, srcs: string[], readable: (id: string) => boolean): Promise<WindowSources> {
  const data = store.dataDir(app.store.home);
  const cache = app.store.cacheDir();
  const sources: Record<string, CutSource> = {};
  const coming: string[] = [];
  for (const src of new Set(srcs)) {
    const file = fileOf(data, src);
    if (file === null || !readable(file.id)) continue;
    if (isFile(file.path)) {
      try {
        sources[src] = await describe(file.path);
      } catch (error) {
        diag.warn("writer", `${file.id.slice(0, 8)}: ${file.path} can't be read for the window's player: ${diag.messageOf(error)}`);
      }
    } else if (file.preview && bring(data, cache, file.id)) coming.push(src);
  }
  return { cache, sources, coming };
}

/** For tests. */
export function reset(): void {
  bringing.clear();
  notNow.clear();
  probed.clear();
}
