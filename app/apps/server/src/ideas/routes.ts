// Ideas' HTTP API, under /api/ideas, for someone with an `ideas.*`
// capability (or an admin): Home's Ideas section, a new idea from links, the idea
// page (its titles, guide, pictures, the chat with Claude), sending it to the
// board and making the changes reviewers ask for there. Claude's tools are
// served at /mcp/ideas/<token> (run.ts), for the runs on this Mac only.

import { footageIn, footageKind, footageLine, WORKSPACE_NAMES, WORKSPACES, type IdeaFootage, type Workspace } from "@edit/types/ideas";
import type { ChangeCard, Idea, IdeaImage, IdeaPlace, IdeaRow, IdeaSource, IdeasHome, IdeaTitle } from "@edit/types/ideas";

import { creator } from "../accounts.ts";
import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import * as imports from "../writer/imports.ts";
import { ApiError, bad, empty, json, notFound } from "../http/errors.ts";
import { readBytes, readJson, type RouteContext, type Router } from "../http/router.ts";
import * as kinds from "../kinds.ts";
import * as relay from "../relay.ts";
import * as cloudStorage from "../cloud.ts";
import * as board from "./board.ts";
import * as cloud from "./cloud.ts";
import { cleanGuide, cleanTitle, guideProblem, lengthStyle, titleProblem } from "./policy.ts";
import * as run from "./run.ts";
import * as sources from "./sources.ts";

type Context = RouteContext<App>;

/** Whether the signed-in person works on ideas (kinds.ts's rule: an admin, or nobody signed in, has everything). */
export function mayIdeas(given: Set<string> | null = kinds.granted()): boolean {
  return given === null || [...given].some((perm) => perm.startsWith("ideas."));
}

/** Whether they work on one workspace's ideas (`ideas.<workspace>`). */
export function mayWorkspace(workspace: Workspace, given: Set<string> | null = kinds.granted()): boolean {
  return given === null || given.has(`ideas.${workspace}`);
}

/** The workspaces they work on. */
export function workspacesOf(given: Set<string> | null = kinds.granted()): Workspace[] {
  return WORKSPACES.filter((one) => mayWorkspace(one, given));
}

const NO_IDEAS = "Your account can't work on ideas yet: an admin can give you Interrogation or bodycam ideas at accounts.spheceo.com.";

function guard(): void {
  if (!mayIdeas()) throw new ApiError(403, NO_IDEAS);
}

function guardWorkspace(workspace: Workspace): void {
  if (!mayWorkspace(workspace)) throw new ApiError(403, `Your account can't work on ${WORKSPACE_NAMES[workspace]} ideas: an admin can give you them at accounts.spheceo.com.`);
}

/** Refuses an idea of a workspace they don't work on (an idea that's gone is the route's to say). */
async function guardId(id: string): Promise<void> {
  const found = await cloud.get(id).catch(() => null);
  if (found !== null) guardWorkspace(found.idea.workspace);
}

/** The workspace a request names: interrogation when it names none. */
function workspaceIn(given: unknown): Workspace {
  if (given === undefined || given === null || given === "") return "interrogation";
  if (typeof given !== "string" || !(WORKSPACES as readonly string[]).includes(given)) throw bad(`There are no ${typeof given === "string" ? given : "such"} ideas.`);
  return given as Workspace;
}

const by = (): string => creator()?.name || "Edit";

export const holderOf = (app: App): string => (process.env.EDIT_CLOUD_HOLDER ?? "").trim() || app.machine;

const contextOf = (app: App): run.Context => ({ home: app.store.home, port: app.port, holder: holderOf(app), by: by() });

/** A failure as the page says it: the cloud's refusals plainly, the relay's reason as it gave it. */
function failed(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof cloud.Missing) throw notFound(error.message);
  if (error instanceof cloud.Conflict) throw new ApiError(409, "Someone else changed this idea at the same moment: try again.");
  throw new ApiError(502, diag.messageOf(error));
}

const newId = () => `i${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const shortId = () => Math.random().toString(36).slice(2, 10);

/** The links in what was pasted: YouTube videos and web pages, each once, in order. */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'\])]+/g)) {
    const link = match[0].replace(/[.,;:!?]+$/, "");
    const id = sources.videoIdOf(link);
    const key = id === null ? link : `https://www.youtube.com/watch?v=${id}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** A link as an idea's source: a video's details from YouTube's API, or an article read now. */
async function sourceOf(link: string): Promise<IdeaSource> {
  const id = sources.videoIdOf(link);
  if (id !== null) {
    const { description: _, ...video } = await sources.video(id);
    return video;
  }
  if (/trello\.com\/c\//.test(link)) throw new Error("That's a Trello card: open cards waiting on changes from Home's Needs you.");
  return (await sources.article(link)).source;
}

/** Where every sent card is, each workspace's board read a minute at a time; nothing when it can't be read. */
async function places(rows: Omit<IdeaRow, "place">[], workspace: Workspace): Promise<[Record<string, IdeaPlace>, string | null]> {
  const ids = rows.flatMap((row) => (row.workspace === workspace && row.summary.card !== null ? [row.summary.card.cardId] : []));
  try {
    return [await board.where(ids, workspace), null];
  } catch (error) {
    return [{}, diag.messageOf(error)];
  }
}

async function home(): Promise<IdeasHome> {
  const mine = workspacesOf();
  const rows = (await cloud.list()).filter((row) => mine.includes(row.workspace));
  const linked = new Set(rows.flatMap((row) => (row.summary.card !== null ? [row.summary.card.cardId] : [])));
  const boards = await Promise.all(
    mine.map(async (workspace) => {
      const [where, boardError] = await places(rows, workspace);
      let changes: ChangeCard[] = [];
      let error = boardError;
      try {
        changes = (await board.changes(workspace)).filter((one) => !linked.has(one.id)).map(({ id, name, url, list, comments, cover }) => ({ id, workspace, name, url, list, comments, cover }));
      } catch (failure) {
        error ??= diag.messageOf(failure);
      }
      const lanes = (await board.lanes(workspace).catch(() => [])).map((lane) => ({ ...lane, workspace }));
      return { where, changes, lanes, error };
    }),
  );
  const where = Object.assign({}, ...boards.map((one) => one.where)) as Record<string, IdeaPlace>;
  return {
    ideas: rows.map((row) => ({ ...row, place: row.summary.card !== null ? (where[row.summary.card.cardId] ?? null) : null })),
    changes: boards.flatMap((one) => one.changes),
    lanes: boards.flatMap((one) => one.lanes),
    workspaces: mine,
    boardError: boards.find((one) => one.error !== null)?.error ?? null,
  };
}

/** An idea for the page: its body, rev, where its card is, the run's live turn (on this Mac), and each title's problems. */
async function page(id: string) {
  const found = await cloud.get(id);
  if (found === null) throw notFound("This idea was deleted.");
  const { idea, rev } = found;
  guardWorkspace(idea.workspace);
  const live = run.liveOf(id);
  const shown: Idea = live !== null && idea.run !== null ? { ...idea, run: { ...idea.run, ...live } } : idea;
  const style = lengthStyle((await board.approved(idea.workspace).catch(() => [])).map((one) => one.title));
  const problems: Record<string, string> = {};
  for (const title of idea.titles) {
    const problem = titleProblem(title.text, style);
    if (problem !== null) problems[title.id] = problem;
  }
  const place = idea.card === null ? null : ((await board.where([idea.card.cardId], idea.workspace).catch(() => ({}) as Record<string, IdeaPlace>))[idea.card.cardId] ?? null);
  return { idea: shown, rev, place, problems, guideProblem: idea.thumbnailGuide.trim() === "" ? null : guideProblem(idea.thumbnailGuide, idea.images.filter((one) => one.from === "frame").length), style };
}

type Patch = {
  titles?: { id?: string; text: string }[];
  main?: string | null;
  thumbnailGuide?: string;
  summary?: string;
  footage?: { id?: string; url: string; reuse?: boolean; title?: string }[];
  notes?: string;
  steer?: string;
  wantsSummary?: boolean;
  status?: "draft" | "ready";
  images?: string[];
  base?: null;
};

/** A person's change to an idea: their titles and guide are theirs (Claude's next fresh run keeps them). */
export function applyPatch(idea: Idea, patch: Patch, who: string): void {
  if (patch.titles !== undefined) {
    if (!Array.isArray(patch.titles) || patch.titles.length > 20) throw bad("titles must be at most 20.");
    const before = new Map(idea.titles.map((one) => [one.id, one]));
    // The main title followed by its id: rewording it keeps it the main one.
    const mainId = idea.titles.find((one) => one.text === idea.main)?.id;
    const next: IdeaTitle[] = [];
    for (const given of patch.titles) {
      const text = cleanTitle(typeof given?.text === "string" ? given.text : "");
      if (text === "") continue;
      if ([...text].length > 200) throw bad("A title is at most 200 characters.");
      const was = given.id === undefined ? undefined : before.get(given.id);
      next.push(was !== undefined && was.text === text ? was : { id: was?.id ?? shortId(), text, by: who, at: Date.now() });
    }
    idea.titles = next;
    const renamed = next.find((one) => one.id === mainId);
    if (renamed !== undefined) idea.main = renamed.text;
    if (idea.main !== null && !next.some((one) => one.text === idea.main)) idea.main = next[0]?.text ?? null;
    if (idea.main === null) idea.main = next[0]?.text ?? null;
  }
  if (patch.main !== undefined) {
    if (patch.main !== null && !idea.titles.some((one) => one.text === patch.main)) throw bad("The main title must be one of the idea's titles.");
    idea.main = patch.main;
  }
  if (patch.thumbnailGuide !== undefined) {
    if (typeof patch.thumbnailGuide !== "string" || patch.thumbnailGuide.length > 2000) throw bad("The guide is at most 2,000 characters.");
    idea.thumbnailGuide = patch.thumbnailGuide.trim() === "" ? "" : cleanGuide(patch.thumbnailGuide);
    idea.guideBy = who;
  }
  for (const [key, max] of [["summary", 600], ["notes", 8000], ["steer", 600]] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > max) throw bad(`${key} is at most ${max} characters.`);
    idea[key] = value.trim();
  }
  if (patch.footage !== undefined) {
    if (!Array.isArray(patch.footage) || patch.footage.length > 30) throw bad("footage is a list of at most 30 links.");
    const before = new Map(idea.footage.map((one) => [one.id, one]));
    const next: IdeaFootage[] = [];
    for (const given of patch.footage) {
      const url = typeof given?.url === "string" ? given.url.trim() : "";
      const kind = footageKind(url);
      if (kind === null || url.length > 2000) throw bad(`${url || "That"} isn't a YouTube or Google Drive link.`);
      if (next.some((one) => one.url === url)) continue;
      const was = given.id === undefined ? undefined : before.get(given.id);
      const title = typeof given.title === "string" && given.title.trim() !== "" ? given.title.trim().slice(0, 300) : was?.url === url ? was.title : undefined;
      const problem = was?.url === url ? was.problem : undefined;
      // A script's Doc is only ever a reuse (its case, as written).
      next.push({ id: was?.id ?? shortId(), url, kind, reuse: kind === "doc" || given.reuse === true, ...(title !== undefined ? { title } : {}), ...(problem !== undefined ? { problem } : {}) });
    }
    idea.footage = next;
  }
  if (patch.wantsSummary !== undefined) idea.wantsSummary = patch.wantsSummary === true;
  if (patch.images !== undefined) {
    if (!Array.isArray(patch.images)) throw bad("images must be the pictures' ids, in order.");
    const byId = new Map(idea.images.map((one) => [one.id, one]));
    idea.images = patch.images.flatMap((one) => (byId.has(one) ? [byId.get(one)!] : []));
    if (!idea.images.some((one) => one.from === "base")) idea.base = null;
  }
  if (patch.base === null) {
    idea.base = null;
    idea.images = idea.images.filter((one) => one.from !== "base");
  }
  if (patch.status !== undefined) {
    if (patch.status !== "draft" && patch.status !== "ready") throw bad("status is draft or ready.");
    if (idea.status === "sent") throw bad("This idea is on the board: change it there, or make its changes.");
    if (patch.status === "ready") {
      const missing = readiness(idea);
      if (missing.length > 0) throw bad(`Not ready: ${missing.join(", ")}.`);
    }
    idea.status = patch.status;
  }
}

/** What an idea still needs before it goes to the board (Sphe Research's Titles, Thumbnail Guide, Case). */
export function readiness(idea: Idea): string[] {
  const missing: string[] = [];
  if (idea.titles.length === 0) missing.push("a title");
  if (idea.thumbnailGuide.trim() === "") missing.push("a thumbnail guide");
  if (idea.sources.length === 0) missing.push("the case link");
  return missing;
}

const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

/** Ideas whose footage is being named now. */
const naming = new Set<string>();

/**
 * Footage not yet checked, named (the video's title, the Drive folder's name)
 * or marked with why it can't be imported. A YouTube video from the YouTube
 * Data API on the relay, as an idea's case is (about a second: yt-dlp through
 * the proxy took 14–22 s a video, and Sphe, Nov 2: "checking is taking too
 * long"); Drive and Docs as Script mode checks them. Done in the background,
 * so a page gone before it ends still gets the names.
 */
export function nameFootage(app: App, id: string, who: string, idea: Idea | null = null): Promise<void> {
  if (naming.has(id) || (idea !== null && !idea.footage.some(unchecked))) return Promise.resolve();
  naming.add(id);
  return (async () => {
    const found = idea ?? (await cloud.get(id))?.idea ?? null;
    const wanted = found?.footage.filter(unchecked) ?? [];
    if (wanted.length === 0) return;
    const youtube = wanted.filter((one) => one.kind === "youtube");
    const others = wanted.filter((one) => one.kind !== "youtube");
    const [videos, checked] = await Promise.all([
      Promise.all(
        youtube.map(async (one): Promise<[string, { title: string; problem: string | null }]> => {
          const video = sources.videoIdOf(one.url);
          if (video === null) return [one.url, { title: "", problem: "That isn't a YouTube video's link." }];
          return sources.video(video).then(
            (found): [string, { title: string; problem: string | null }] => [one.url, { title: found.title, problem: null }],
            (error: unknown): [string, { title: string; problem: string | null }] => [one.url, { title: "", problem: diag.messageOf(error) }],
          );
        }),
      ),
      others.length > 0 ? imports.checkVideos(app, others.map(footageLine)) : Promise.resolve([]),
    ]);
    const byUrl = new Map<string, { title: string; problem: string | null }>([...videos, ...checked.map((one): [string, { title: string; problem: string | null }] => [one.url, one])]);
    await cloud.change(id, who, (fresh) => {
      let changed = false;
      for (const one of fresh.footage) {
        const check = byUrl.get(one.url);
        if (check === undefined || !unchecked(one)) continue;
        if (check.title !== "") one.title = check.title.slice(0, 300);
        else if (check.problem !== null) one.problem = check.problem.slice(0, 300);
        else continue;
        changed = true;
      }
      return changed;
    });
  })()
    .catch((error: unknown) => diag.warn("ideas", `${id}: naming its footage: ${diag.messageOf(error)}`))
    .finally(() => naming.delete(id));
}

const unchecked = (one: IdeaFootage) => one.title === undefined && one.problem === undefined;

/** A picture uploaded to the idea's folder on R2. */
async function upload(id: string, bytes: Uint8Array, type: string, name: string): Promise<IdeaImage> {
  const extension = IMAGE_TYPES[type];
  if (extension === undefined) throw bad("Add a JPEG, PNG, WebP or GIF picture.");
  if (bytes.length === 0 || bytes.length > 15 * 1024 * 1024) throw bad("A picture is at most 15 MB.");
  const key = await cloud.putPicture(id, bytes, type, extension);
  return { id: shortId(), name: name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[^\p{L}\p{N} _-]+/gu, " ").trim().slice(0, 80) || "picture", key, from: "upload" };
}

/** A picture's bytes for the page. */
async function picture(image: IdeaImage): Promise<Response> {
  if (image.key !== undefined) {
    const answer = await fetch(await cloudStorage.presign(image.key, "GET"));
    if (!answer.ok) throw notFound("That picture isn't in the cloud.");
    return new Response(answer.body, { headers: { "content-type": answer.headers.get("content-type") ?? "image/jpeg", "cache-control": "private, max-age=86400" } });
  }
  const url = image.url ?? "";
  if (/^https:\/\/i\.ytimg\.com\//.test(url)) return Response.redirect(url, 302);
  const answer = await relayImage(url);
  return new Response(answer.body, { headers: { "content-type": answer.headers.get("content-type") ?? "image/jpeg", "cache-control": "private, max-age=3600" } });
}

/** A Trello attachment's bytes, through the relay (it holds the key). */
async function relayImage(url: string): Promise<Response> {
  const response = await fetch(`${relay.url()}/v1/ideas/trello/image?url=${encodeURIComponent(url)}`, { headers: relay.authHeaders(), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new ApiError(502, `The board's picture: ${response.status}`);
  return response;
}

/** An existing card on the board as an idea: its titles, guide, links, footage and pictures, its comments when it waits on changes. */
async function fromCard(given: string, workspace: Workspace): Promise<string> {
  const card = await board.card(given, workspace);
  const rows = await cloud.list();
  const had = rows.find((row) => row.summary.card?.cardId === card.id);
  if (had !== undefined) return had.id;
  const parsed = board.parseCard(card.name, card.desc);
  const found: IdeaSource[] = [];
  for (const link of parsed.links.slice(0, 6)) {
    try {
      found.push(await sourceOf(link));
    } catch (error) {
      diag.warn("ideas", `card ${card.id}: its link ${link.split("?")[0]}: ${diag.messageOf(error)}`);
    }
  }
  const who = by();
  const lanes = await board.lanes(workspace).catch(() => []);
  const lane = lanes.find((one) => one.name === card.list)?.key ?? "";
  const pictures = card.attachments.filter((one) => one.image);
  const images: IdeaImage[] = (card.cover !== null ? [...pictures].sort((a, b) => Number(b.url === card.cover) - Number(a.url === card.cover)) : pictures).slice(0, 8).map((one) => ({ id: shortId(), name: one.name.replace(/\.[a-z0-9]{2,5}$/i, "").slice(0, 80) || "picture", url: one.url, from: "card" as const }));
  const idea = run.fresh(newId(), who, { workspace, sources: found, steer: "", wantsSummary: parsed.summary !== "", images, footage: footageIn(parsed.footage, shortId).footage });
  idea.titles = parsed.titles.map((text) => ({ id: shortId(), text, by: "the card", at: Date.now() }));
  idea.main = idea.titles[0]?.text ?? null;
  idea.thumbnailGuide = parsed.guide === "" ? "" : cleanGuide(parsed.guide);
  idea.guideBy = "the card";
  idea.summary = parsed.summary;
  idea.status = "sent";
  idea.card = { cardId: card.id, url: card.url, lane, list: card.list, sentAt: Date.now(), sentBy: who };
  idea.changes = card.changes ? { comments: board.commentsOf(card), at: Date.now() } : null;
  await cloud.commit(idea, 0, who);
  return idea.id;
}

export function routes(router: Router<App>): void {
  router
    .get("/api/ideas/workspaces", () => {
      guard();
      return json({ workspaces: workspacesOf() });
    })
    .get("/api/ideas", async () => {
      guard();
      try {
        return json(await home());
      } catch (error) {
        failed(error);
      }
    })
    .post("/api/ideas", async (context: Context) => {
      guard();
      const body = await readJson<{ links?: unknown; steer?: unknown; summary?: unknown; footage?: unknown; workspace?: unknown }>(context);
      const workspace = workspaceIn(body.workspace);
      guardWorkspace(workspace);
      const links = linksIn(typeof body.links === "string" ? body.links : "");
      if (links.length === 0) throw bad("Paste a YouTube video or an article's link.");
      if (links.length > 20) throw bad("Twenty links at most at once.");
      const steer = typeof body.steer === "string" ? body.steer.trim().slice(0, 600) : "";
      const pasted = footageIn(typeof body.footage === "string" ? body.footage : "", shortId);
      if (pasted.refused.length > 0) throw bad(`The footage is YouTube or Google Drive links: ${pasted.refused[0]} isn't one.`);
      const footage = pasted.footage;
      const who = by();
      const made: { id: string; link: string }[] = [];
      const refused: { link: string; why: string; id?: string }[] = [];
      // A case someone already has as an idea is theirs to open, not a second idea.
      const existing = await cloud.list().catch((error: unknown) => failed(error));
      const had = new Map(existing.flatMap((row) => (row.summary.keys ?? []).map((key) => [key, row] as const)));
      // One idea a link, each repackaged as it's made (three at a time on this Mac).
      await Promise.all(
        links.map(async (link) => {
          try {
            const video = sources.videoIdOf(link);
            const known = had.get(video !== null ? `youtube:${video}` : link);
            if (known !== undefined) {
              refused.push({ link, why: `It's already an idea: “${known.summary.title}”${known.createdBy ? `, started by ${known.createdBy.name}` : ""}.`, id: known.id });
              return;
            }
            const source = await sourceOf(link);
            const idea = run.fresh(newId(), who, { workspace, sources: [source], steer, wantsSummary: body.summary === true, footage: links.length === 1 ? footage : [] });
            await cloud.commit(idea, 0, who);
            made.push({ id: idea.id, link });
          } catch (error) {
            refused.push({ link, why: diag.messageOf(error) });
          }
        }),
      );
      const order = (link: string) => links.indexOf(link);
      made.sort((a, b) => order(a.link) - order(b.link));
      if (footage.length > 0) for (const one of made) void nameFootage(context.app, one.id, who);
      for (const one of made) await run.repackage(contextOf(context.app), one.id).catch((error: unknown) => diag.warn("ideas", `${one.id}: ${diag.messageOf(error)}`));
      return json({ ideas: made, refused });
    })
    .post("/api/ideas/from-card", async (context: Context) => {
      guard();
      const body = await readJson<{ card?: unknown; workspace?: unknown }>(context);
      if (typeof body.card !== "string" || body.card.trim() === "") throw bad("Name the card (its link or id).");
      const workspace = workspaceIn(body.workspace);
      guardWorkspace(workspace);
      try {
        return json({ id: await fromCard(body.card.trim(), workspace) });
      } catch (error) {
        failed(error);
      }
    })
    .get("/api/ideas/{id}", async ({ params, app }: Context) => {
      guard();
      await guardId(params.id!);
      try {
        const shown = await page(params.id!);
        // Footage nobody has checked (an idea from before Nov 2, a card's), named as it's opened.
        void nameFootage(app, shown.idea.id, by(), shown.idea);
        return json(shown);
      } catch (error) {
        failed(error);
      }
    })
    // A person's change to the idea (only the fields given).
    .put("/api/ideas/{id}", async (context: Context) => {
      guard();
      await guardId(context.params.id!);
      const patch = await readJson<Patch>(context);
      const who = by();
      try {
        const { idea, rev } = await cloud.change(context.params.id!, who, (idea) => applyPatch(idea, patch, who));
        // New footage named before the answer when it's quick (YouTube's are), so the page shows the names at once.
        if (patch.footage !== undefined && idea.footage.some(unchecked)) {
          const named = await Promise.race([nameFootage(context.app, idea.id, who, idea).then(() => true), Bun.sleep(8000).then(() => false)]);
          if (named) {
            const fresh = await cloud.get(idea.id);
            if (fresh !== null) return json(fresh);
          }
        }
        return json({ idea, rev });
      } catch (error) {
        failed(error);
      }
    })
    .delete("/api/ideas/{id}", async ({ params }: Context) => {
      guard();
      await guardId(params.id!);
      run.stop(params.id!);
      try {
        await cloud.remove(params.id!, by());
      } catch (error) {
        failed(error);
      }
      return empty(204);
    })
    .post("/api/ideas/{id}/repackage", async (context: Context) => {
      guard();
      await guardId(context.params.id!);
      const body = await readJson<{ improve?: unknown; changes?: unknown; steer?: unknown }>(context).catch(() => ({}) as Record<string, unknown>);
      const id = context.params.id!;
      try {
        if (typeof body.steer === "string") await cloud.change(id, by(), (idea) => void (idea.steer = (body.steer as string).trim().slice(0, 600)));
        if (body.changes === true) {
          // The reviewers' comments, read fresh from the card: they're the brief.
          const found = await cloud.get(id);
          if (found?.idea.card == null) throw bad("This idea isn't on the board.");
          const card = await board.card(found.idea.card.cardId, found.idea.workspace);
          await cloud.change(id, by(), (idea) => void (idea.changes = { comments: board.commentsOf(card), at: Date.now() }));
        }
        await run.repackage(contextOf(context.app), id, { improve: body.improve === true, changes: body.changes === true });
        return json({ ok: true });
      } catch (error) {
        failed(error);
      }
    })
    .post("/api/ideas/{id}/chat", async (context: Context) => {
      guard();
      await guardId(context.params.id!);
      const body = await readJson<{ text?: unknown }>(context);
      try {
        await run.chat(contextOf(context.app), context.params.id!, typeof body.text === "string" ? body.text : "");
        return json({ ok: true });
      } catch (error) {
        if (error instanceof Error && /^(Write what|Keep the message|Claude is)/.test(error.message)) throw bad(error.message);
        failed(error);
      }
    })
    .post("/api/ideas/{id}/stop", async ({ params }: Context) => {
      guard();
      await guardId(params.id!);
      return json({ stopped: run.stop(params.id!) });
    })
    .post("/api/ideas/{id}/comments", async ({ params }: Context) => {
      guard();
      await guardId(params.id!);
      try {
        const found = await cloud.get(params.id!);
        if (found === null) throw notFound("This idea was deleted.");
        if (found.idea.card === null) return json({ changes: null });
        const card = await board.card(found.idea.card.cardId, found.idea.workspace);
        const { idea } = await cloud.change(params.id!, by(), (idea) => {
          idea.changes = card.changes ? { comments: board.commentsOf(card), at: Date.now() } : null;
          if (idea.card !== null) idea.card.list = card.list;
        });
        return json({ changes: idea.changes });
      } catch (error) {
        failed(error);
      }
    })
    .post("/api/ideas/{id}/send", async (context: Context) => {
      guard();
      await guardId(context.params.id!);
      const body = await readJson<{ lane?: unknown; anyway?: unknown }>(context);
      if (typeof body.lane !== "string") throw bad("Choose the lane it goes to.");
      const who = by();
      try {
        const found = await cloud.get(context.params.id!);
        if (found === null) throw notFound("This idea was deleted.");
        const missing = readiness(found.idea);
        if (missing.length > 0) throw bad(`Not ready: ${missing.join(", ")}.`);
        if (found.idea.card !== null && found.idea.status === "sent") throw bad("This idea is already on the board: update its card instead.");
        if (run.isRunning(found.idea.id)) throw bad("Claude is still working on this idea.");
        // The board checked again first: someone may have put the video there since (it fails closed). A
        // second card for a video already there only when the person says so.
        if (found.idea.card === null && body.anyway !== true) {
          const ids = found.idea.sources.flatMap((one) => (one.kind === "youtube" ? [one.videoId] : []));
          const hit = Object.values(await board.duplicates(ids, found.idea.workspace))[0];
          if (hit !== undefined) {
            await cloud.change(found.idea.id, who, (idea) => void (idea.duplicate = { cardId: hit.cardId, name: hit.name, url: hit.url, list: hit.list }));
            throw new ApiError(409, `It's already on the board as “${hit.name}” (${hit.list || "archived"}). Nothing was sent.`);
          }
        }
        const card = await board.send(found.idea, body.lane, who);
        const { idea } = await cloud.change(found.idea.id, who, (idea) => {
          idea.card = card;
          idea.status = "sent";
        });
        diag.info("ideas", `${idea.id}: sent to ${card.list} (${card.url})`);
        return json({ idea });
      } catch (error) {
        failed(error);
      }
    })
    .post("/api/ideas/{id}/update-card", async ({ params }: Context) => {
      guard();
      await guardId(params.id!);
      const who = by();
      try {
        const found = await cloud.get(params.id!);
        if (found === null) throw notFound("This idea was deleted.");
        if (found.idea.card === null) throw bad("This idea isn't on the board yet: send it first.");
        const missing = readiness(found.idea);
        if (missing.length > 0) throw bad(`Not ready: ${missing.join(", ")}.`);
        if (run.isRunning(found.idea.id)) throw bad("Claude is still working on this idea.");
        const done = await board.update(found.idea);
        const { idea } = await cloud.change(found.idea.id, who, (idea) => {
          if (idea.card !== null) idea.card = { ...idea.card, url: done.url, updatedAt: Date.now() };
          idea.changes = null;
        });
        return json({ idea, labelled: done.labelled });
      } catch (error) {
        failed(error);
      }
    })
    .post(
      "/api/ideas/{id}/images",
      async (context: Context) => {
        guard();
        await guardId(context.params.id!);
        const type = (context.request.headers.get("content-type") ?? "").split(";")[0]!.trim();
        const bytes = await readBytes(context.request, 16 * 1024 * 1024);
        try {
          const image = await upload(context.params.id!, bytes, type, context.query.get("name") ?? "picture");
          const { idea } = await cloud.change(context.params.id!, by(), (idea) => {
            if (idea.images.length >= 8) throw bad("Eight pictures at most.");
            idea.images = [...idea.images, image];
          });
          return json({ idea });
        } catch (error) {
          failed(error);
        }
      },
      { bodyLimit: 16 * 1024 * 1024 },
    )
    .get("/api/ideas/{id}/images/{image}", async ({ params }: Context) => {
      guard();
      await guardId(params.id!);
      try {
        const found = await cloud.get(params.id!);
        const image = found?.idea.images.find((one) => one.id === params.image);
        if (image === undefined) throw notFound("That picture isn't with this idea.");
        return await picture(image);
      } catch (error) {
        failed(error);
      }
    })
    .post("/mcp/ideas/{token}", async (context: Context) => {
      const body = await readJson<unknown>(context);
      const answers = (await Promise.all((Array.isArray(body) ? body : [body]).map((message) => run.answerTo(context.params.token ?? "", message)))).filter((one) => one !== null);
      if (answers.length === 0) return empty(202);
      return json(Array.isArray(body) ? answers : answers[0]);
    });
}

