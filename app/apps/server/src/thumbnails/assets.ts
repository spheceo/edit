// The overlays and pictures a thumbnail can put on: Edit's own (shipped in the
// binary, assets/thumbnails/) and the team's (uploaded from the page, on R2
// under edit/thumbnails/assets/, listed in mamagi). Sphe, Nov 2: "here are some
// of the overlays we put on top after… we tend to lean towards the rec most";
// "we should also be able to upload assets ourselves and the agent be able to
// use vision to see where to place the item".

import * as fs from "node:fs";

import type { Asset } from "@edit/types/thumbnails";

import recOverlay from "../../../../assets/thumbnails/overlays/bodycam-rec-axon.png" with { type: "file" };
import montserrat from "../../../../assets/thumbnails/fonts/Montserrat.ttf" with { type: "file" };

import { join } from "../paths.ts";
import * as cloud from "./cloud.ts";

/** Edit's own, each with where its bytes are. */
export const BUILT_IN: (Asset & { file: string })[] = [
  {
    id: "bodycam-rec",
    name: "Bodycam REC",
    note: "The team's usual overlay (most thumbnails have it): a body camera's viewfinder over the whole picture: corner brackets, a red REC dot top left, “AXON 1” top right, a battery bottom left, “cam 01” bottom right. Put it over the whole canvas (0, 0, 1280×720, stretch), above the picture and below any caption.",
    kind: "overlay",
    width: 1832,
    height: 1015,
    builtIn: true,
    file: recOverlay as unknown as string,
  },
];

export const FONT_FILES: Record<string, string> = { "Montserrat.ttf": montserrat as unknown as string };

let team: { at: number; list: Asset[] } | null = null;

/** Every asset: Edit's, then the team's (read again a minute after). */
export async function all(fresh = false): Promise<Asset[]> {
  if (fresh || team === null || Date.now() - team.at > 60_000) team = { at: Date.now(), list: await cloud.teamAssets() };
  return [...BUILT_IN.map(builtIn), ...team.list];
}

/** A built-in asset as the list shows it (without where its bytes are). */
function builtIn(asset: Asset & { file: string }): Asset {
  const shown: Asset & { file?: string } = { ...asset };
  delete shown.file;
  return shown;
}

export function forget(): void {
  team = null;
}

/** A picture's bytes from R2, kept on this Mac (`<cache>/thumbnails/`) after the first time. */
export async function cached(cacheDir: string, key: string): Promise<Uint8Array> {
  const path = join(cacheDir, "thumbnails", key.replace(/^edit\/thumbnails\//, "").replace(/[^\w.-]+/g, "_"));
  if (fs.existsSync(path)) return new Uint8Array(fs.readFileSync(path));
  const bytes = await cloud.bytesOf(key);
  fs.mkdirSync(join(cacheDir, "thumbnails"), { recursive: true });
  fs.writeFileSync(`${path}.part`, bytes);
  fs.renameSync(`${path}.part`, path);
  return bytes;
}

/** Where a picture is on this Mac (fetched once), for Claude to read. */
export async function localPath(cacheDir: string, key: string): Promise<string> {
  await cached(cacheDir, key);
  return join(cacheDir, "thumbnails", key.replace(/^edit\/thumbnails\//, "").replace(/[^\w.-]+/g, "_"));
}

/** An asset's bytes and type. */
export async function bytesOf(cacheDir: string, id: string): Promise<{ bytes: Uint8Array; type: string }> {
  const own = BUILT_IN.find((one) => one.id === id);
  if (own !== undefined) return { bytes: new Uint8Array(await Bun.file(own.file).arrayBuffer()), type: "image/png" };
  const found = (await all()).find((one) => one.id === id) ?? (await all(true)).find((one) => one.id === id);
  if (found?.key === undefined) throw new cloud.Missing(`There's no asset ${id}.`);
  return { bytes: await cached(cacheDir, found.key), type: found.key.endsWith(".png") ? "image/png" : found.key.endsWith(".webp") ? "image/webp" : "image/jpeg" };
}

export const typeOf = (key: string): string => (key.endsWith(".png") ? "image/png" : key.endsWith(".webp") ? "image/webp" : "image/jpeg");
