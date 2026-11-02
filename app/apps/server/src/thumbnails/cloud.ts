// Thumbnails live in mamagi (the `thumbnails` module), reached through the
// relay's /v1/ideas/convex as ideas are: the team's, so nothing of one is kept
// only on one Mac. Every change reads it, makes the change and commits it
// naming the rev it began from; overtaken, it's made again on top. Pictures go
// to R2 under `edit/thumbnails/<id>/`, the team's overlays under
// `edit/thumbnails/assets/`.

import { summarize, type Asset, type Thumbnail, type ThumbRow } from "@edit/types/thumbnails";

import * as cloudStorage from "../cloud.ts";
import * as diag from "../diag.ts";
import * as relay from "../relay.ts";

type Answer = { status: "success"; value: unknown } | { status: "error"; errorMessage?: string; errorData?: { code?: string; message?: string } | string };

export class Conflict extends Error {}
export class Missing extends Error {}

async function call(kind: "query" | "mutation", path: string, args: Record<string, unknown>): Promise<unknown> {
  const answer = await relay.json<Answer>("POST", "/v1/ideas/convex", { kind, path, args }, "thumbnails", 60);
  if (answer.status === "success") return answer.value;
  const data = typeof answer.errorData === "object" && answer.errorData !== null ? answer.errorData : null;
  const said = data?.message ?? answer.errorMessage ?? "the cloud refused";
  if (data?.code === "conflict") throw new Conflict(said);
  if (data?.code === "missing") throw new Missing(said);
  throw new Error(said);
}

type Listed = Omit<ThumbRow, "id"> & { thumbId: string };

export async function list(): Promise<ThumbRow[]> {
  const rows = (await call("query", "thumbnails:list", {})) as Listed[];
  return rows.map(({ thumbId, ...row }) => ({ id: thumbId, ...row }));
}

export async function get(id: string): Promise<{ thumb: Thumbnail; rev: number } | null> {
  const found = (await call("query", "thumbnails:get", { thumbId: id })) as { body: Thumbnail; rev: number } | null;
  return found === null ? null : { thumb: found.body, rev: found.rev };
}

export async function commit(thumb: Thumbnail, baseRev: number, by: string): Promise<number> {
  const body = { ...thumb, updatedAt: Date.now() };
  const answer = (await call("mutation", "thumbnails:commit", { thumbId: thumb.id, baseRev, body, summary: summarize(body), by })) as { rev: number };
  return answer.rev;
}

export async function remove(id: string, by: string): Promise<void> {
  await call("mutation", "thumbnails:remove", { thumbId: id, by });
}

/** Changes a thumbnail on its newest copy (`change` may answer false: nothing to change); overtaken, made again on top. */
export async function change(id: string, by: string, change: (thumb: Thumbnail) => boolean | void): Promise<{ thumb: Thumbnail; rev: number }> {
  for (let attempt = 0; ; attempt++) {
    const found = await get(id);
    if (found === null) throw new Missing("This thumbnail was deleted.");
    const thumb = structuredClone(found.thumb);
    if (change(thumb) === false) return found;
    try {
      const rev = await commit(thumb, found.rev, by);
      return { thumb: { ...thumb, updatedAt: Date.now() }, rev };
    } catch (error) {
      if (!(error instanceof Conflict) || attempt >= 6) throw error;
      diag.info("thumbnails", `${id}: changed elsewhere meanwhile; making the change again on top`);
    }
  }
}

/** Bytes put on R2 under `folder` (named by their hash): the key. */
export async function put(folder: string, bytes: Uint8Array, type: string, extension: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 24);
  const key = `edit/thumbnails/${folder}/${hash}.${extension}`;
  const url = await cloudStorage.presign(key, "PUT");
  const answer = await fetch(url, { method: "PUT", body: bytes, headers: { "content-type": type } });
  if (!answer.ok) throw new Error(`the cloud refused the picture (${answer.status})`);
  return key;
}

/** A picture's bytes from R2. */
export async function bytesOf(key: string): Promise<Uint8Array> {
  const answer = await fetch(await cloudStorage.presign(key, "GET"));
  if (!answer.ok) throw new Missing("That picture isn't in the cloud.");
  return new Uint8Array(await answer.arrayBuffer());
}

/** The team's own overlays and pictures. */
export async function teamAssets(): Promise<Asset[]> {
  const rows = (await call("query", "thumbnails:listAssets", {})) as { assetId: string; body: Asset }[];
  return rows.map((row) => ({ ...row.body, id: row.assetId, builtIn: false }));
}

export async function putAsset(asset: Asset, by: string): Promise<void> {
  await call("mutation", "thumbnails:putAsset", { assetId: asset.id, body: asset, by });
}

export async function removeAsset(id: string, by: string): Promise<void> {
  await call("mutation", "thumbnails:removeAsset", { assetId: id, by });
}
