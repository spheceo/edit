// A cloud project's cover in the cloud (`edit/covers/<id>.jpg`), so a Mac that
// hasn't downloaded the project shows a frame of it on Home, not a blank
// tile. The Mac that has it uploads each version's card cover as it makes it;
// the others fetch it once per version.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import { cloudOf } from "./cloud_projects.ts";
import * as diag from "./diag.ts";
import type { Router } from "./http/router.ts";
import { isFile, join } from "./paths.ts";

/** Covers at least this wide go to the cloud (the card's is 720). */
const SHARED_WIDTH = 720;
/** A cover that isn't in the cloud isn't asked for again for this long. */
const MISS_MS = 10 * 60_000;

export function key(id: string): string {
  return `edit/covers/${id}.jpg`;
}

/** The version of each project's cover sent this run. */
const sent = new Map<string, string>();

/** Sends a cover just made here for a cloud project (in the background, once per version). */
export function share(app: App, id: string, version: string, width: number, file: string): void {
  if (width < SHARED_WIDTH || sent.get(id) === version || !cloud.enabled()) return;
  if (cloudOf(app)?.status(id).cloud !== true) return;
  sent.set(id, version);
  void cloud.uploadFile(file, key(id)).catch((error: unknown) => {
    sent.delete(id);
    diag.warn("cloud", `the cover of ${id}: ${diag.messageOf(error)}`);
  });
}

const missed = new Map<string, number>();

export function routes(router: Router<App>): void {
  // `v` is the cloud project's update time: a new version is fetched again.
  router.get("/api/cloud/projects/{id}/cover.jpg", async ({ app, params, query }) => {
    const id = (params.id ?? "").replace(/[^0-9a-z_-]/gi, "");
    const version = (query.get("v") ?? "").replace(/[^0-9a-z]/gi, "").slice(0, 20);
    const dir = join(app.store.cacheDir(), "cloud-covers");
    const out = join(dir, `${id}-${version}.jpg`);
    const headers = { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" };
    if (isFile(out)) return new Response(Bun.file(out), { headers });
    if (id === "" || !cloud.enabled() || Date.now() - (missed.get(id) ?? 0) < MISS_MS) return new Response(null, { status: 404 });
    try {
      await cloud.download(key(id), out);
    } catch {
      missed.set(id, Date.now());
      return new Response(null, { status: 404 });
    }
    // Only the newest version is kept.
    for (const name of fs.readdirSync(dir)) if (name.startsWith(`${id}-`) && name !== `${id}-${version}.jpg`) fs.rmSync(join(dir, name), { force: true });
    return new Response(Bun.file(out), { headers });
  });
}
