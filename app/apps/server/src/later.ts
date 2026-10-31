// Home's Later (Oct 31 2026): what someone set aside, the team's, in mamagi
// (`edit:listLater`, `setLater`, `clearLater`, through the relay, which names
// who did it from their token). An edit, a script, an idea or a board card,
// by its key. On its day it's back: in its list and in Needs you, marked Back
// until someone opens it (which clears it), or when someone brings it back
// sooner. The user, Oct 31: "we also need to be able to have ways to put
// projects aside, say we want to come back to a project later"; then, "does
// it sort of get snoozed and comes back clearly formatted showing like this
// was awoken".
//
//   GET  /api/later                     {entries}: what's set aside, and what's back and not opened yet
//   POST /api/later {key, until?}       set aside until then (none: until brought back)
//   POST /api/later {key, back: true}   brought back, or opened once back, or moved back from Done
//   POST /api/later {key, done: true}   marked done (in Done until moved back)

import type { LaterEntry, LaterKey } from "@edit/types/later";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { ApiError, bad, json } from "./http/errors.ts";
import { readJson, type RouteContext, type Router } from "./http/router.ts";

const KEY = /^(edit|script|idea|card):[A-Za-z0-9_-]{1,120}$/;

export const isKey = (key: unknown): key is LaterKey => typeof key === "string" && KEY.test(key);

/** A Back mark nobody opened in this long goes. */
const BACK_FOR_MS = 14 * 86_400_000;

/** What's set aside, and what's back (its time passed) and not opened yet; a Back mark two weeks old is left out. */
export async function list(now = Date.now()): Promise<LaterEntry[]> {
  if (!cloud.enabled()) return [];
  const rows = await cloud.query("edit:listLater", {});
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: unknown): LaterEntry[] => {
    if (typeof row !== "object" || row === null) return [];
    const { key, until, at, by, done } = row as Record<string, unknown>;
    if (!isKey(key) || typeof at !== "number") return [];
    const back = typeof until === "number" ? until : null;
    if (back !== null && back <= now - BACK_FOR_MS) return [];
    const who = typeof by === "object" && by !== null ? (by as Record<string, unknown>) : null;
    return [{ key, until: back, ...(done === true ? { done: true } : {}), at, by: who && typeof who.name === "string" ? { sub: String(who.sub ?? ""), name: who.name, picture: typeof who.picture === "string" ? who.picture : null } : null }];
  });
}

/** Sets `key` aside until `until` (null: until someone brings it back). */
export async function setAside(key: LaterKey, until: number | null): Promise<void> {
  await cloud.mutation("edit:setLater", until === null ? { key } : { key, until });
}

/** Marks `key` done: in Done until someone moves it back. */
export async function markDone(key: LaterKey): Promise<void> {
  await cloud.mutation("edit:setLater", { key, done: true });
}

/** Brings `key` back. */
export async function bringBack(key: LaterKey): Promise<void> {
  await cloud.mutation("edit:clearLater", { key });
}

function needsCloud(): void {
  if (!cloud.enabled()) throw new ApiError(409, "Sign in to set things aside: Later is the team's, kept in the cloud.");
}

export function routes(router: Router<App>): void {
  router
    .get("/api/later", async () => {
      try {
        return json({ entries: await list() });
      } catch (error) {
        diag.warn("later", `later: list: ${error instanceof Error ? error.message : String(error)}`);
        throw new ApiError(502, `Later didn't load: ${error instanceof Error ? error.message : String(error)}`);
      }
    })
    .post("/api/later", async (context: RouteContext<App>) => {
      needsCloud();
      const body = await readJson<{ key?: unknown; until?: unknown; back?: unknown; done?: unknown }>(context);
      if (!isKey(body.key)) throw bad("key is edit:, script:, idea: or card: and an id.");
      const until = body.back === true || body.done === true || body.until === undefined || body.until === null ? null : Number(body.until);
      if (until !== null && (!Number.isFinite(until) || until <= Date.now())) throw bad("until must be a time in the future.");
      try {
        if (body.back === true) await bringBack(body.key);
        else if (body.done === true) await markDone(body.key);
        else await setAside(body.key, until);
      } catch (error) {
        diag.warn("later", `later: ${body.back === true ? "bring back" : body.done === true ? "mark done" : "set aside"} ${body.key}: ${error instanceof Error ? error.message : String(error)}`);
        throw new ApiError(502, `Later didn't take it: ${error instanceof Error ? error.message : String(error)}`);
      }
      return json(body.back === true ? { key: body.key, back: true } : body.done === true ? { key: body.key, done: true } : { key: body.key, until });
    });
}
