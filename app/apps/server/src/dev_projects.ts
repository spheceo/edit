// Dev projects (Oct 31 2026): a project started on a dev build (`just dev`,
// the dev server, the trial server on :7710) is marked `origin: "dev"` when
// it's made (`Store.marksDev`), so Home can badge it, hide it, and clear them
// all at once (Sphe, Oct 31: "the project list gets huge"). One that became
// real work is promoted: the mark goes and it's an ordinary project.
// Projects from before stay unmarked.
//
//   POST /api/projects/{id}/promote   {ok}: the dev mark cleared
//   POST /api/dev-projects/delete     {count} → {deleted, failed}: every dev
//     project on this Mac deleted (as Home's Delete does, the cloud's copy
//     too), only when `count` is how many there are; never one without the mark

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { ApiError, bad, json } from "./http/errors.ts";
import { readJson, type RouteContext, type Router } from "./http/router.ts";
import * as seams from "./seams.ts";

/** The ids of this Mac's dev projects, as their files say. */
export function devIds(app: App): string[] {
  return app.store
    .list()
    .filter((summary) => summary.dev === true && summary.problem === undefined)
    .map((summary) => summary.id);
}

/** Clears `id`'s dev mark: it's a real project now. */
export async function promote(app: App, id: string): Promise<void> {
  if (app.store.get(id) === null) throw new ApiError(404, "no such project");
  await app.store.update(id, "promote", (project) => {
    delete project.origin;
  });
}

/** Deletes one project as Home's Delete does: the cloud's copy first, then this Mac's (kept in projects/deleted). */
async function deleteOne(app: App, id: string): Promise<void> {
  // Read again from its file just before: only a project still marked dev goes.
  if (app.store.get(id)?.project.origin !== "dev") throw new Error("not a dev project");
  const why = app.store.unavailable(id);
  if (why !== null) throw new Error(why);
  if (app.store.cloud() !== null) await seams.cloudProjects.delete(app, id);
  if (!app.store.delete(id)) throw new Error("its file couldn't be moved aside");
}

/** Deletes every dev project here, when `expected` is how many there are (what the confirm said). */
export async function deleteAll(app: App, expected: number): Promise<{ deleted: string[]; failed: { id: string; error: string }[] }> {
  const ids = devIds(app);
  if (ids.length !== expected) throw new ApiError(409, `There are ${ids.length} dev projects now, not ${expected}: look again before deleting.`);
  const deleted: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of ids) {
    try {
      await deleteOne(app, id);
      deleted.push(id);
    } catch (error) {
      failed.push({ id, error: diag.messageOf(error) });
    }
  }
  diag.info("dev-projects", `deleted ${deleted.length} dev projects${failed.length > 0 ? `, ${failed.length} not` : ""}`);
  return { deleted, failed };
}

export function routes(router: Router<App>): void {
  router
    .post("/api/projects/{id}/promote", async ({ app, params }: RouteContext<App>) => {
      try {
        await promote(app, params.id!);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(409, diag.messageOf(error));
      }
      return json({ ok: true });
    })
    .post("/api/dev-projects/delete", async (context: RouteContext<App>) => {
      const given = await readJson<{ count?: unknown }>(context);
      if (typeof given.count !== "number" || !Number.isInteger(given.count) || given.count < 1) throw bad("count: how many dev projects the confirm showed.");
      return json(await deleteAll(context.app, given.count));
    });
}
