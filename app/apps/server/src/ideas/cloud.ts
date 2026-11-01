// Ideas live in mamagi (the `ideas` module), reached through the relay's
// /v1/ideas/convex: the team's, so nothing of an idea is kept only on one Mac
// (the user, Oct 29: "everything on the cloud!"). Every change reads the idea,
// makes the change and commits it naming the rev it began from; overtaken by
// another Mac's (or this Mac's own run), it reads again and makes the change
// on top, so neither is lost.

import type { Idea, IdeaRow, IdeaSummary } from "@edit/types/ideas";

import * as diag from "../diag.ts";
import * as relay from "../relay.ts";

type Answer = { status: "success"; value: unknown } | { status: "error"; errorMessage?: string; errorData?: { code?: string; message?: string } | string };

/** A commit another one overtook. */
export class Conflict extends Error {}

/** The idea isn't in the cloud (never was, or it was deleted). */
export class Missing extends Error {}

async function call(kind: "query" | "mutation", path: string, args: Record<string, unknown>): Promise<unknown> {
  const answer = await relay.json<Answer>("POST", "/v1/ideas/convex", { kind, path, args }, "ideas", 60);
  if (answer.status === "success") return answer.value;
  const data = typeof answer.errorData === "object" && answer.errorData !== null ? answer.errorData : null;
  const said = data?.message ?? answer.errorMessage ?? "the cloud refused";
  if (data?.code === "conflict") throw new Conflict(said);
  if (data?.code === "missing") throw new Missing(said);
  throw new Error(said);
}

type Listed = Omit<IdeaRow, "id" | "place"> & { ideaId: string };

/** Every idea, newest change first, without their bodies. */
export async function list(): Promise<Omit<IdeaRow, "place">[]> {
  const rows = (await call("query", "ideas:list", {})) as Listed[];
  return rows.map(({ ideaId, ...row }) => ({ id: ideaId, ...row, workspace: row.workspace ?? "interrogation" }));
}

/** One idea and the rev it's at, or null. */
export async function get(id: string): Promise<{ idea: Idea; rev: number } | null> {
  const found = (await call("query", "ideas:get", { ideaId: id })) as { body: Idea; rev: number } | null;
  return found === null ? null : { idea: { ...found.body, workspace: found.body.workspace ?? "interrogation" }, rev: found.rev };
}

/** Commits `idea` as the next rev after `baseRev`; the new rev. */
export async function commit(idea: Idea, baseRev: number, by: string): Promise<number> {
  const at = Date.now();
  const body = { ...idea, updatedAt: at };
  const answer = (await call("mutation", "ideas:commit", { ideaId: idea.id, workspace: idea.workspace, baseRev, body, summary: summarize(body), by })) as { rev: number };
  return answer.rev;
}

export async function remove(id: string, by: string): Promise<void> {
  await call("mutation", "ideas:remove", { ideaId: id, by });
}

/**
 * Changes an idea: `change` makes the change on the newest copy (and may
 * answer false: nothing to change). Overtaken, it's made again on the newer
 * one, up to five times.
 */
export async function change(id: string, by: string, change: (idea: Idea) => boolean | void): Promise<{ idea: Idea; rev: number }> {
  for (let attempt = 0; ; attempt++) {
    const found = await get(id);
    if (found === null) throw new Missing("This idea was deleted.");
    const idea = structuredClone(found.idea);
    if (change(idea) === false) return found;
    try {
      const rev = await commit(idea, found.rev, by);
      return { idea: { ...idea, updatedAt: Date.now() }, rev };
    } catch (error) {
      if (!(error instanceof Conflict) || attempt >= 4) throw error;
      diag.info("ideas", `${id}: changed elsewhere meanwhile; making the change again on top`);
    }
  }
}

/** A source's key: a video by its id, an article by its link. */
export const keyOf = (source: Idea["sources"][number]): string => (source.kind === "youtube" ? `youtube:${source.videoId}` : source.url);

/** An idea's row in a list. */
export function summarize(idea: Idea): IdeaSummary {
  const video = idea.sources.find((one) => one.kind === "youtube");
  const first = idea.sources[0];
  const title = idea.main ?? idea.titles[0]?.text ?? (first === undefined ? "New idea" : first.title || first.url);
  return {
    title,
    status: idea.status,
    run: idea.run?.state ?? null,
    step: idea.run?.state === "running" || idea.run?.state === "queued" ? (idea.run.step ?? null) : (idea.run?.error ?? null),
    sources: idea.sources.length,
    thumbnail: video?.kind === "youtube" ? video.thumbnail : null,
    views: video?.kind === "youtube" ? video.views : null,
    outlier: video?.kind === "youtube" ? video.outlier : null,
    card: idea.card === null ? null : { cardId: idea.card.cardId, url: idea.card.url, list: idea.card.list },
    changes: idea.changes?.comments.length ?? 0,
    skipped: idea.skipped,
    duplicate: idea.duplicate?.name ?? null,
    keys: idea.sources.map(keyOf),
    niche: idea.niche,
    source: first?.title ?? "",
  };
}
