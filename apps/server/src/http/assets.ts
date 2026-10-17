// The web UI (apps/web/dist). A release embeds it in the binary (WP2's
// embed step registers those files with `useAssets`); a dev run serves the
// folder on disk. Every path that isn't a file is the SPA's shell.

import * as fs from "node:fs";
import * as nodePath from "node:path";

import { text } from "./errors.ts";

/** Where the UI's files come from. */
export interface Assets {
  /** The file at `path` (relative, no leading slash), or null. */
  get(path: string): Blob | Uint8Array | null;
}

/** The UI built on disk (`EDIT_WEB_DIST`, else apps/web/dist in this checkout). */
export function diskAssets(dir = process.env.EDIT_WEB_DIST ?? nodePath.join(import.meta.dir, "../../../web/dist")): Assets {
  const root = nodePath.resolve(dir);
  return {
    get(path) {
      const full = nodePath.resolve(root, path);
      if (full !== root && !full.startsWith(`${root}${nodePath.sep}`)) return null;
      try {
        if (!fs.statSync(full).isFile()) return null;
      } catch {
        return null;
      }
      return Bun.file(full);
    },
  };
}

/** Files given up front (the release binary's embedded UI): path → its bytes or file. */
export function mapAssets(files: Map<string, Blob | Uint8Array>): Assets {
  return { get: (path) => files.get(path) ?? null };
}

let current: Assets | null = null;

export function useAssets(assets: Assets): void {
  current = assets;
}

export function assets(): Assets {
  current ??= diskAssets();
  return current;
}

const TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  map: "application/json",
  wasm: "application/wasm",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  avif: "image/avif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain",
  webmanifest: "application/manifest+json",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

/** A file's content type by its extension (mime_guess's first guess, for the kinds the UI ships). */
export function mimeOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  return TYPES[ext] ?? "application/octet-stream";
}

/** The UI file a path names, else the shell (SPA routes); 503 when the UI isn't built. */
export function staticAsset(pathname: string, from: Assets = assets()): Response {
  const path = pathname.replace(/^\/+/, "");
  let file = path === "" ? null : from.get(path);
  let served = path;
  if (file === null) {
    file = from.get("index.html");
    served = "index.html";
  }
  if (file === null) {
    return text(
      "Edit's web UI is not built. Run `just web` (or `bun run --cwd apps/web build`) and restart.",
      503,
    );
  }
  const cache = served.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  return new Response(file, { headers: { "content-type": mimeOf(served), "cache-control": cache } });
}
