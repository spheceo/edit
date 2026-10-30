// Ideas (Oct 31 2026): a case repackaged into titles and a thumbnail guide,
// then sent to the Interrogation board — Sphe Research's repackaging and
// Repack's threads, brought into Edit. Everything here needs a person with
// an `ideas.*` capability (or an admin), as index.ts checks first:
//
//   POST /v1/ideas/convex             {kind, path: "ideas:list|get|commit|remove", args}
//   GET  /v1/ideas/lanes              the board and the lists ideas go to
//   GET  /v1/ideas/youtube?id=        a video's details (the YouTube Data API, this relay's key)
//   POST /v1/ideas/trello/duplicates  {ids}: the cards anywhere on the board that already have these videos
//   GET  /v1/ideas/trello/approved    the titles the team approved (every list from Approved on)
//   POST /v1/ideas/trello/where       {cards}: where each sent card is now
//   GET  /v1/ideas/trello/changes     cards in the lanes waiting on changes, with their comments
//   GET  /v1/ideas/trello/card?card=  one card of the board's, whole
//   GET  /v1/ideas/trello/image?url=  a card's attachment (Trello's need the key)
//   POST /v1/ideas/trello/send        {lane, cardId?, name, desc, images}: the card in a lane
//   POST /v1/ideas/trello/update      {cardId, name, desc, images}: a card's changes made
//
// Trello is written only on the lanes below (and on a card waiting on
// changes), each list checked to still have its name first, as Sphe
// Research did. The Trello key and token (Repack's root TRELLO_*: Sphe
// Research's own token) and the YouTube key never leave the relay.

import type { Caller } from "./auth";
import { actorOf, convexPaused, isObject, r2Config, r2Fetch, Upstream, type CloudEnv } from "./cloud";

export interface IdeasEnv extends CloudEnv {
  TRELLO_API_KEY?: string;
  TRELLO_TOKEN?: string;
  /** The YouTube Data API v3 key (Repack's root YOUTUBE_API_KEY). */
  YOUTUBE_API_KEY?: string;
}

/** The Interrogation board, as Sphe Research's registry and the board itself name it (read Oct 31). */
export const BOARD = {
  id: "CJiVnylO",
  name: "Interrogation",
  /** Where ideas go: each repackager's lane, and the drafts waiting for a check. */
  lanes: [
    { key: "sphe", id: "6a5fc25fb30edc6fbad29c57", name: "Repackaging (Sphe)" },
    { key: "jj", id: "6a5fc27820a2496d6cea41f0", name: "Repackaging (JJ)" },
    { key: "check", id: "6abb7fa7e40c540d6373f9f6", name: "Sphe - Draft Ideas Ready For Check" },
  ],
  approved: { id: "6a5fc2861af44c1aab895a32", name: "Approved (Sent to B+E)" },
  // Matched by id: the board has "Changes Made" and "Changes made", "Changes required" and "Sphe changes required".
  changesRequired: ["6a5fbafa83dcd7639929dd76", "6a8c143486ac75520a5260a9"],
  changesMade: ["6a5fbafa83dcd7639929dd7a", "6a8c143486ac75520a5260aa"],
  /** The label a card gets once its changes are made. */
  madeLabel: "6a5fbafa83dcd7639929dd7a",
} as const;

/** Whether someone may work on ideas: an `ideas.*` capability, or an admin. */
export function mayIdeas(found: Caller): boolean {
  return found.kind === "person" && (found.admin || found.perms.some((perm) => perm.startsWith("ideas.")));
}

export const NO_IDEAS = "Your account can't work on ideas yet: an admin can give you Interrogation ideas at accounts.spheceo.com.";

/** The ideas functions Edit calls, each as its kind. */
const IDEA_FUNCTIONS = new Map([
  ["ideas:list", "query"],
  ["ideas:get", "query"],
  ["ideas:commit", "mutation"],
  ["ideas:remove", "mutation"],
]);

const MAX_BODY = 1024 * 1024;
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function ideasRoute(request: Request, url: URL, env: IdeasEnv, found: Caller): Promise<Response> {
  const route = url.pathname.slice("/v1/ideas/".length);
  try {
    if (request.method === "GET") {
      if (route === "lanes") return json(200, { board: { id: BOARD.id, name: BOARD.name }, lanes: BOARD.lanes, approved: BOARD.approved });
      if (route === "youtube") return json(200, await youtubeVideo(url.searchParams.get("id") ?? "", env));
      if (route === "trello/approved") return json(200, await approvedTitles(env));
      if (route === "trello/changes") return json(200, await changesWaiting(env));
      if (route === "trello/card") return json(200, await oneCard(url.searchParams.get("card") ?? "", env));
      if (route === "trello/image") return await attachmentImage(url.searchParams.get("url") ?? "", env);
      return json(404, { error: "not found" });
    }
    if (request.method !== "POST") return json(405, { error: `GET or POST ${url.pathname}` });
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return json(413, { error: "Request too large." });
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (!isObject(parsed)) throw new Error("not an object");
      body = parsed;
    } catch {
      return json(400, { error: "Send a JSON object." });
    }
    if (route === "convex") return await convex(body, env, found);
    if (route === "trello/duplicates") return json(200, await duplicates(body.ids, env));
    if (route === "trello/where") return json(200, await where(body.cards, env));
    if (route === "trello/send") return json(200, await send(body, env));
    if (route === "trello/update") return json(200, await update(body, env));
    return json(404, { error: "not found" });
  } catch (error) {
    if (error instanceof Refused) return json(error.status, { error: error.message });
    if (error instanceof Upstream) return json(502, { error: error.message });
    throw error;
  }
}

// ---------------------------------------------------------------- Convex

async function convex(body: Record<string, unknown>, env: IdeasEnv, found: Caller): Promise<Response> {
  const path = typeof body.path === "string" ? body.path : "";
  const kind = IDEA_FUNCTIONS.get(path);
  if (kind === undefined || body.kind !== kind) return json(403, { error: "Only the ideas functions Edit calls can be called here." });
  if (body.args !== undefined && !isObject(body.args)) return json(400, { error: "args must be an object." });
  if (!env.CONVEX_URL || !env.CONVEX_SERVICE_TOKEN) return json(503, { error: "Convex is not configured on the relay yet." });
  const paused = convexPaused(env);
  if (paused !== null) return paused;
  const { actor: _sent, ...args } = (body.args ?? {}) as Record<string, unknown>;
  // Who started an idea, and who changed it, come from the token, never the caller.
  if (path === "ideas:commit" || path === "ideas:remove") {
    const actor = actorOf(found);
    if (actor !== null && actor.name !== "") args.by = actor.name;
    if (path === "ideas:commit" && actor !== null) args.actor = actor;
  }
  let answer: Response;
  try {
    answer = await fetch(`${env.CONVEX_URL.replace(/\/+$/, "")}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args: { ...args, token: env.CONVEX_SERVICE_TOKEN }, format: "json" }),
    });
  } catch (error) {
    return json(502, { error: `Convex: ${error instanceof Error ? error.message : String(error)}` });
  }
  const text = await answer.text();
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed) && (parsed.status === "success" || parsed.status === "error")) return json(200, parsed);
  } catch {
    // Not Convex's own shape: said below.
  }
  return json(502, { error: `Convex answered ${answer.status}: ${text.slice(0, 300)}` });
}

// ---------------------------------------------------------------- YouTube

const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

async function youtube(path: string, params: Record<string, string>, env: IdeasEnv): Promise<Record<string, unknown>> {
  if (!env.YOUTUBE_API_KEY) throw new Refused(503, "The YouTube API is not configured on the relay yet.");
  const query = new URLSearchParams({ ...params, key: env.YOUTUBE_API_KEY });
  const answer = await fetch(`${YOUTUBE_API}/${path}?${query}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (answer === null) throw new Upstream("YouTube's API did not answer.");
  if (answer.status === 403) throw new Upstream("YouTube's API refused the relay's key (its daily quota may be spent).");
  if (!answer.ok) throw new Upstream(`YouTube's API answered ${answer.status}.`);
  return (await answer.json()) as Record<string, unknown>;
}

/** ISO 8601's PT1H2M3S, in seconds. */
export function isoSeconds(duration: unknown): number | null {
  const match = typeof duration === "string" ? /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration) : null;
  if (match === null) return null;
  const [, days, hours, minutes, seconds] = match.map((part) => Number(part ?? 0));
  return days! * 86_400 + hours! * 3600 + minutes! * 60 + seconds!;
}

/** How a video's views compare to its channel's usual long-form reach (Sphe Research's outlier score): views over the median of its recent uploads, "unknown" with fewer than five. */
export function outlier(views: number, recent: number[]): string {
  const counts = recent.filter((count) => count > 0).sort((a, b) => a - b);
  if (counts.length < 5 || !(views >= 0)) return "unknown";
  const median = counts[Math.floor(counts.length / 2)]!;
  return `${Math.round((views / median) * 10) / 10}x`;
}

type Item = { id?: string; snippet?: Record<string, unknown>; statistics?: Record<string, unknown>; contentDetails?: Record<string, unknown> };

async function youtubeVideo(id: string, env: IdeasEnv) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Refused(400, "That isn't a YouTube video id.");
  const found = (await youtube("videos", { part: "snippet,statistics,contentDetails", id }, env)).items as Item[] | undefined;
  const video = found?.[0];
  if (video === undefined) throw new Refused(404, "That video isn't on YouTube, or it's private.");
  const snippet = video.snippet ?? {};
  const views = Number(video.statistics?.viewCount ?? NaN);
  const thumbnails = (snippet.thumbnails ?? {}) as Record<string, { url?: string } | undefined>;
  const thumbnail = ["maxres", "standard", "high", "medium", "default"].map((size) => thumbnails[size]?.url).find((one) => typeof one === "string") ?? null;
  const channelId = typeof snippet.channelId === "string" ? snippet.channelId : "";
  let score = "unknown";
  if (channelId !== "" && Number.isFinite(views)) {
    try {
      // The channel's uploads, then their views; Shorts (three minutes or less) left out.
      const channel = ((await youtube("channels", { part: "contentDetails", id: channelId }, env)).items as Item[] | undefined)?.[0];
      const uploads = (channel?.contentDetails?.relatedPlaylists as { uploads?: string } | undefined)?.uploads;
      if (uploads) {
        const listed = ((await youtube("playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: "30" }, env)).items as Item[] | undefined) ?? [];
        const ids = listed.map((item) => item.contentDetails?.videoId).filter((one): one is string => typeof one === "string" && one !== id);
        if (ids.length > 0) {
          const recent = ((await youtube("videos", { part: "statistics,contentDetails", id: ids.join(",") }, env)).items as Item[] | undefined) ?? [];
          score = outlier(views, recent.filter((item) => (isoSeconds(item.contentDetails?.duration) ?? 0) > 180).slice(0, 24).map((item) => Number(item.statistics?.viewCount ?? 0)));
        }
      }
    } catch {
      // A bonus on top of the details, never their failure.
    }
  }
  return {
    videoId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: typeof snippet.title === "string" ? snippet.title : "",
    description: typeof snippet.description === "string" ? snippet.description.slice(0, 800) : "",
    channel: typeof snippet.channelTitle === "string" ? snippet.channelTitle : "",
    channelId,
    publishedAt: typeof snippet.publishedAt === "string" ? snippet.publishedAt : null,
    views: Number.isFinite(views) ? views : null,
    likes: Number.isFinite(Number(video.statistics?.likeCount)) ? Number(video.statistics?.likeCount) : null,
    comments: Number.isFinite(Number(video.statistics?.commentCount)) ? Number(video.statistics?.commentCount) : null,
    durationSeconds: isoSeconds(video.contentDetails?.duration),
    thumbnail,
    outlier: score,
  };
}

// ---------------------------------------------------------------- Trello

async function trello<T = unknown>(env: IdeasEnv, method: string, path: string, params: Record<string, string> = {}, form?: FormData): Promise<T> {
  if (!env.TRELLO_API_KEY || !env.TRELLO_TOKEN) throw new Refused(503, "Trello is not configured on the relay yet.");
  const query = new URLSearchParams({ ...params, key: env.TRELLO_API_KEY, token: env.TRELLO_TOKEN });
  const answer = await fetch(`https://api.trello.com/1/${path}?${query}`, { method, ...(form ? { body: form } : {}), signal: AbortSignal.timeout(30_000) }).catch(() => null);
  // The key and token are in the query: a failure names the method and path only.
  if (answer === null) throw new Upstream(`Trello did not answer ${method} ${path}.`);
  if (answer.status === 404) throw new Refused(404, "That card or list isn't on the Interrogation board any more.");
  if (!answer.ok) throw new Upstream(`Trello answered ${answer.status} for ${method} ${path}: ${(await answer.text()).slice(0, 200)}`);
  return (await answer.json()) as T;
}

type List = { id: string; name: string; closed: boolean; pos: number };
type Attachment = { id: string; name?: string; url?: string; mimeType?: string | null; isUpload?: boolean; previews?: { url?: string; width?: number }[] | null };
type Card = {
  id: string;
  name: string;
  desc?: string;
  url: string;
  shortUrl?: string;
  idList: string;
  idBoard?: string;
  idLabels?: string[];
  closed?: boolean;
  dateLastActivity?: string;
  idAttachmentCover?: string | null;
  attachments?: Attachment[];
};

/** A short while of the board's lists and cards: one repackaging run asks for the duplicates, the approved titles and a send. */
const kept = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ms: number, read: () => Promise<T>): Promise<T> {
  const hit = kept.get(key);
  if (hit !== undefined && Date.now() - hit.at < ms) return hit.value as T;
  const value = await read();
  kept.set(key, { at: Date.now(), value });
  return value;
}

/** Forgets what was read of the board (a send or an update changed it). */
function forget(): void {
  for (const key of [...kept.keys()]) if (key !== "lists") kept.delete(key);
}

export function resetForTests(): void {
  kept.clear();
}

const lists = (env: IdeasEnv) => cached("lists", 10 * 60_000, () => trello<List[]>(env, "GET", `boards/${BOARD.id}/lists`, { fields: "id,name,closed,pos", filter: "all" }));

/** Whether a list holds approved titles: everything from Approved on (script, edit, subtitles, upload, the archive), never an idea list. */
export function holdsApproved(name: string): boolean {
  return !/idea|repackag|channel interro|thumb/i.test(name);
}

/** The board's cards (archived ones too, for duplicates), a minute at a time. */
const allCards = (env: IdeasEnv) =>
  cached("cards:all", 60_000, () =>
    trello<Card[]>(env, "GET", `boards/${BOARD.id}/cards`, { filter: "all", fields: "id,name,desc,url,shortUrl,idList,idLabels,closed,dateLastActivity,idAttachmentCover", attachments: "true", attachment_fields: "id,name,url,mimeType,isUpload,previews" }),
  );

/** Every YouTube video id in a text (Trello's Markdown escapes underscores in links: `\_`). */
export function youtubeIds(text: string): string[] {
  const out = new Set<string>();
  const clean = text.replace(/\\_/g, "_");
  for (const match of clean.matchAll(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^\s"'<>()\]]*?&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/g)) out.add(match[1]!);
  return [...out];
}

const cardIds = (card: Card) => youtubeIds([card.name, card.desc ?? "", ...(card.attachments ?? []).flatMap((one) => [one.name ?? "", one.url ?? ""])].join("\n"));

async function duplicates(given: unknown, env: IdeasEnv) {
  if (!Array.isArray(given) || given.length === 0 || given.length > 50 || !given.every((one) => typeof one === "string" && /^[A-Za-z0-9_-]{11}$/.test(one))) throw new Refused(400, "ids must be 1 to 50 YouTube video ids.");
  const [cards, named] = await Promise.all([allCards(env), lists(env)]);
  const listName = new Map(named.map((list) => [list.id, list.name]));
  const wanted = new Set(given as string[]);
  const found: Record<string, { cardId: string; name: string; url: string; list: string; closed: boolean }> = {};
  for (const card of cards)
    for (const id of cardIds(card))
      if (wanted.has(id) && found[id] === undefined) found[id] = { cardId: card.id, name: card.name, url: card.shortUrl || card.url, list: listName.get(card.idList) ?? "", closed: card.closed === true };
  return { found };
}

/** A cover's image: its largest preview up to about 1280 px, else the file. */
function coverOf(card: Card): string | null {
  const cover = (card.attachments ?? []).find((one) => one.id === card.idAttachmentCover);
  if (cover === undefined) return null;
  const previews = (cover.previews ?? []).filter((one) => typeof one.url === "string").sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return previews.findLast((one) => (one.width ?? 0) <= 1280)?.url ?? cover.url ?? null;
}

/** A card's name as a title: without the board's case number ("745) …"). */
export function titleOf(name: string): string {
  return name.replace(/^\s*\d+\)\s*/, "").trim();
}

async function approvedTitles(env: IdeasEnv) {
  return cached("approved", 10 * 60_000, async () => {
    const [cards, named] = await Promise.all([allCards(env), lists(env)]);
    const approved = new Map(named.filter((list) => holdsApproved(list.name)).map((list) => [list.id, list.name]));
    const titles = cards
      .filter((card) => approved.has(card.idList) && /\p{L}/u.test(card.name) && !/^https?:\/\//.test(card.name.trim()) && !/\.(png|jpe?g|webp)$/i.test(card.name.trim()))
      .sort((a, b) => (b.dateLastActivity ?? "").localeCompare(a.dateLastActivity ?? ""))
      .slice(0, 400)
      .map((card) => ({ id: card.id, title: titleOf(card.name), list: approved.get(card.idList) ?? "", url: card.shortUrl || card.url, cover: coverOf(card) }));
    return { titles };
  });
}

const needsChanges = (card: Card) => {
  const labels = new Set(card.idLabels ?? []);
  return BOARD.changesRequired.some((id) => labels.has(id)) && !BOARD.changesMade.some((id) => labels.has(id));
};

async function where(given: unknown, env: IdeasEnv) {
  if (!Array.isArray(given) || given.length > 300 || !given.every((one) => typeof one === "string" && /^[a-f0-9]{24}$/.test(one))) throw new Refused(400, "cards must be at most 300 Trello card ids.");
  const [cards, named] = await Promise.all([allCards(env), lists(env)]);
  const listName = new Map(named.map((list) => [list.id, list.name]));
  const byId = new Map(cards.map((card) => [card.id, card]));
  const places: Record<string, { list: string; closed: boolean; approved: boolean; changes: boolean; missing: boolean }> = {};
  for (const id of given as string[]) {
    const card = byId.get(id);
    const list = card === undefined ? "" : (listName.get(card.idList) ?? "");
    places[id] = card === undefined ? { list: "", closed: false, approved: false, changes: false, missing: true } : { list, closed: card.closed === true, approved: holdsApproved(list) && list !== "", changes: needsChanges(card), missing: false };
  }
  return { places };
}

type Comment = { id: string; text: string; author: string; at: string };

async function commentsOf(env: IdeasEnv, cardId: string): Promise<Comment[]> {
  type Action = { id: string; date: string; data?: { text?: string }; memberCreator?: { fullName?: string; username?: string } };
  const actions = await trello<Action[]>(env, "GET", `cards/${cardId}/actions`, { filter: "commentCard", limit: "100", memberCreator_fields: "fullName,username" });
  return actions
    .map((one) => ({ id: one.id, text: one.data?.text ?? "", author: one.memberCreator?.fullName ?? one.memberCreator?.username ?? "", at: one.date }))
    .filter((one) => one.text.trim() !== "")
    .sort((a, b) => a.at.localeCompare(b.at));
}

const cardView = (card: Card, list: string, comments: Comment[]) => ({
  id: card.id,
  name: card.name,
  desc: card.desc ?? "",
  url: card.shortUrl || card.url,
  list,
  closed: card.closed === true,
  changes: needsChanges(card),
  cover: coverOf(card),
  attachments: (card.attachments ?? []).filter((one) => typeof one.url === "string").map((one) => ({ id: one.id, name: one.name ?? "", url: one.url!, mimeType: one.mimeType ?? null, image: (one.mimeType ?? "").startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(one.name ?? "") })),
  comments,
});

async function changesWaiting(env: IdeasEnv) {
  const lanes = new Map<string, string>(BOARD.lanes.map((lane) => [lane.id, lane.name]));
  const cards = (await allCards(env)).filter((card) => card.closed !== true && lanes.has(card.idList) && needsChanges(card)).slice(0, 30);
  return { cards: await Promise.all(cards.map(async (card) => cardView(card, lanes.get(card.idList) ?? "", await commentsOf(env, card.id)))) };
}

async function oneCard(id: string, env: IdeasEnv) {
  const short = /trello\.com\/c\/([A-Za-z0-9]{6,32})/.exec(id)?.[1] ?? id;
  if (!/^[A-Za-z0-9]{6,32}$/.test(short)) throw new Refused(400, "That isn't a Trello card.");
  const card = await trello<Card>(env, "GET", `cards/${short}`, { fields: "id,name,desc,url,shortUrl,idList,idBoard,idLabels,closed,dateLastActivity,idAttachmentCover", attachments: "true", attachment_fields: "id,name,url,mimeType,isUpload,previews" });
  const board = await boardId(env);
  if (card.idBoard !== board) throw new Refused(403, "That card isn't on the Interrogation board.");
  const list = (await lists(env)).find((one) => one.id === card.idList)?.name ?? "";
  return cardView(card, list, await commentsOf(env, card.id));
}

/** The board's own id (its short link resolves to it). */
const boardId = (env: IdeasEnv) => cached("board", 24 * 3600_000, async () => (await trello<{ id: string }>(env, "GET", `boards/${BOARD.id}`, { fields: "id" })).id);

const ATTACHMENT = /^https:\/\/trello\.com\/1\/cards\/[a-f0-9]{24}\/attachments\/[a-f0-9]{24}\/(?:download|previews)\//;

/** An attachment's bytes: Trello's files answer only with the key, sent as OAuth (never in the URL). */
async function trelloFile(url: string, env: IdeasEnv): Promise<Response> {
  if (!ATTACHMENT.test(url)) throw new Refused(400, "Only a Trello card's attachments can be fetched here.");
  if (!env.TRELLO_API_KEY || !env.TRELLO_TOKEN) throw new Refused(503, "Trello is not configured on the relay yet.");
  const answer = await fetch(url, { headers: { authorization: `OAuth oauth_consumer_key="${env.TRELLO_API_KEY}", oauth_token="${env.TRELLO_TOKEN}"` }, redirect: "follow", signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (answer === null || !answer.ok) throw new Upstream(`Trello's file answered ${answer?.status ?? "nothing"}.`);
  return answer;
}

async function attachmentImage(url: string, env: IdeasEnv): Promise<Response> {
  const answer = await trelloFile(url, env);
  const type = answer.headers.get("content-type") ?? "application/octet-stream";
  if (!type.startsWith("image/")) throw new Refused(415, "That attachment isn't a picture.");
  return new Response(answer.body, { status: 200, headers: { "content-type": type, "cache-control": "private, max-age=3600" } });
}

// ---------------------------------------------------------------- Sending

type Image = { name: string; key?: string; url?: string };

function imagesOf(given: unknown): Image[] {
  if (given === undefined) return [];
  if (!Array.isArray(given) || given.length > MAX_IMAGES) throw new Refused(400, `images must be at most ${MAX_IMAGES}.`);
  return given.map((one) => {
    if (!isObject(one) || typeof one.name !== "string" || one.name.trim() === "" || one.name.length > 200) throw new Refused(400, "Each image needs a name.");
    const key = typeof one.key === "string" ? one.key : undefined;
    const url = typeof one.url === "string" ? one.url : undefined;
    if ((key === undefined) === (url === undefined)) throw new Refused(400, "Each image needs a key or a url.");
    if (key !== undefined && (!/^edit\/ideas\/[A-Za-z0-9_-]{4,80}\/[A-Za-z0-9._-]{1,120}$/.test(key) || key.includes(".."))) throw new Refused(400, "An idea's image is under edit/ideas/<idea>/.");
    if (url !== undefined && !ATTACHMENT.test(url) && !/^https:\/\/i\.ytimg\.com\/vi\/[A-Za-z0-9_-]{11}\/[a-z0-9_]+\.(?:jpg|webp)$/.test(url)) throw new Refused(400, "An image's url must be a Trello attachment or a YouTube thumbnail.");
    return { name: one.name.trim(), ...(key ? { key } : {}), ...(url ? { url } : {}) };
  });
}

function text(given: unknown, what: string, max: number, min = 1): string {
  if (typeof given !== "string" || given.trim().length < min || given.length > max) throw new Refused(400, `${what} must be ${min} to ${max} characters.`);
  return given;
}

/**
 * A card's description with its pictures: each `[image]` line becomes the
 * next attachment's picture, and any left over go at the end (Sphe
 * Research's trelloDescription). The Titles / Thumbnail Guide / Case headings
 * get a blank line either side, as the board writes them.
 */
export function described(markdown: string, images: { name: string; url: string }[]): string {
  let next = 0;
  const picture = (image: { name: string; url: string }) => `![${image.name.replace(/[[\]]/g, "")}](${image.url})`;
  const lines = markdown.split("\n").flatMap((line) => {
    if (!/^\s*\[image\]\s*$/.test(line)) return [line];
    const image = images[next++];
    return image === undefined ? [] : [picture(image)];
  });
  for (const image of images.slice(next)) lines.push("", picture(image));
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*!\[[^\]]*\]\(https?:\/\/[^)]+\)\s*$/.test(line) || /^\s*(Titles|Thumbnail Guide|Case|Footage):\s*$/i.test(line)) {
      while (out.at(-1) === "") out.pop();
      if (out.length) out.push("");
      out.push(line.trim(), "");
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A lane's list, checked to be the open list of that name on the board before anything is written to it. */
async function laneList(key: unknown, env: IdeasEnv) {
  const lane = BOARD.lanes.find((one) => one.key === key);
  if (lane === undefined) throw new Refused(400, `Choose a lane: ${BOARD.lanes.map((one) => one.key).join(", ")}.`);
  const list = await trello<{ id: string; name: string; idBoard: string; closed: boolean }>(env, "GET", `lists/${lane.id}`, { fields: "id,name,idBoard,closed" });
  if (list.id !== lane.id || list.closed || list.name.trim() !== lane.name || list.idBoard !== (await boardId(env))) throw new Refused(409, `Ideas go only to the open ${lane.name} list on the ${BOARD.name} board, and it isn't that now.`);
  return lane;
}

/** The bytes of an image to attach: an idea's own (R2), a Trello attachment, or a YouTube thumbnail. */
async function imageBytes(image: Image, env: IdeasEnv): Promise<{ bytes: ArrayBuffer; type: string }> {
  let answer: Response;
  if (image.key !== undefined) {
    const r2 = r2Config(env);
    if (r2 === null) throw new Refused(503, "Cloud storage is not configured on the relay yet.");
    answer = await r2Fetch(r2, "GET", image.key, {});
  } else if (ATTACHMENT.test(image.url!)) answer = await trelloFile(image.url!, env);
  else {
    const got = await fetch(image.url!, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (got === null || !got.ok) throw new Upstream(`The picture ${image.name} couldn't be read.`);
    answer = got;
  }
  const bytes = await answer.arrayBuffer();
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Refused(413, `The picture ${image.name} is over 15 MB.`);
  const type = answer.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
  return { bytes, type: type.startsWith("image/") ? type : "image/jpeg" };
}

const extensionOf = (type: string) => ({ "image/png": "png", "image/webp": "webp", "image/gif": "gif" })[type] ?? "jpg";

/** The card's pictures: those it has by name kept, the rest uploaded (Trello keeps its own copy). */
async function attach(cardId: string, images: Image[], env: IdeasEnv): Promise<Attachment[]> {
  const existing = await trello<Attachment[]>(env, "GET", `cards/${cardId}/attachments`, { fields: "id,name,url,mimeType,isUpload,previews" });
  const out: Attachment[] = [];
  for (const image of images) {
    const had = existing.find((one) => one.url === image.url || (one.name ?? "").trim().toLowerCase() === image.name.toLowerCase());
    if (had !== undefined) {
      out.push(had);
      continue;
    }
    const { bytes, type } = await imageBytes(image, env);
    const form = new FormData();
    const named = /\.[a-z0-9]{2,5}$/i.test(image.name) ? image.name : `${image.name}.${extensionOf(type)}`;
    form.set("file", new Blob([bytes], { type }), named);
    form.set("name", image.name);
    form.set("mimeType", type);
    out.push(await trello<Attachment>(env, "POST", `cards/${cardId}/attachments`, {}, form));
  }
  return out;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** How long to wait for Trello to make a picture's previews (it refuses a cover without one). */
export const coverWaits = { ms: [300, 700, 1500, 2500] };

async function cover(cardId: string, attachment: Attachment | undefined, env: IdeasEnv): Promise<void> {
  if (attachment === undefined) return;
  for (const wait of [0, ...coverWaits.ms]) {
    if (wait > 0) await pause(wait);
    const fresh = wait === 0 ? attachment : await trello<Attachment>(env, "GET", `cards/${cardId}/attachments/${attachment.id}`, { fields: "id,previews" }).catch(() => attachment);
    if (Array.isArray(fresh.previews) && fresh.previews.length > 0) {
      await trello(env, "PUT", `cards/${cardId}`, { idAttachmentCover: attachment.id });
      return;
    }
  }
}

async function send(body: Record<string, unknown>, env: IdeasEnv) {
  const lane = await laneList(body.lane, env);
  const name = text(body.name, "name", 300).trim();
  const markdown = text(body.desc, "desc", 16_000, 0);
  const images = imagesOf(body.images);
  // A send tried again (Edit restarted, the connection dropped) finishes the card it began, never a second one.
  let card: Card | null = null;
  if (typeof body.cardId === "string" && /^[a-f0-9]{24}$/.test(body.cardId)) {
    const remembered = await trello<Card>(env, "GET", `cards/${body.cardId}`, { fields: "id,name,url,shortUrl,idList,idBoard,closed" }).catch(() => null);
    if (remembered !== null && remembered.idList === lane.id && remembered.closed !== true) card = remembered;
  }
  if (card === null) {
    const waiting = await trello<Card[]>(env, "GET", `lists/${lane.id}/cards`, { fields: "id,name,url,shortUrl,idList,idBoard,closed", filter: "open" });
    card = waiting.find((one) => one.name.trim().toLowerCase() === name.toLowerCase()) ?? null;
  }
  const created = card === null;
  if (card === null) card = await trello<Card>(env, "POST", "cards", { idList: lane.id, name, desc: described(markdown, []), pos: "top" });
  if (card.idList !== lane.id) throw new Refused(409, `Refused a card outside ${lane.name}.`);
  const attached = await attach(card.id, images, env);
  const desc = described(markdown, attached.map((one) => ({ name: one.name ?? "image", url: one.url ?? "" })).filter((one) => one.url !== ""));
  await trello(env, "PUT", `cards/${card.id}`, { name, desc });
  await cover(card.id, attached[0], env);
  forget();
  return { cardId: card.id, url: card.shortUrl || card.url, created, lane: lane.key, list: lane.name };
}

async function update(body: Record<string, unknown>, env: IdeasEnv) {
  if (typeof body.cardId !== "string" || !/^[a-f0-9]{24}$/.test(body.cardId)) throw new Refused(400, "cardId must be a Trello card id.");
  const name = text(body.name, "name", 300).trim();
  const markdown = text(body.desc, "desc", 16_000, 0);
  const images = imagesOf(body.images);
  const card = await trello<Card>(env, "GET", `cards/${body.cardId}`, { fields: "id,name,url,shortUrl,idList,idBoard,idLabels,closed" });
  if (card.idBoard !== (await boardId(env))) throw new Refused(403, "That card isn't on the Interrogation board.");
  // A card in a lane, or one waiting on changes anywhere on the board: never another of the board's cards.
  if (!BOARD.lanes.some((lane) => lane.id === card.idList) && !needsChanges(card)) throw new Refused(409, "That card isn't in a repackaging lane or waiting on changes, so Edit doesn't change it.");
  const attached = await attach(card.id, images, env);
  const desc = described(markdown, attached.map((one) => ({ name: one.name ?? "image", url: one.url ?? "" })).filter((one) => one.url !== ""));
  await trello(env, "PUT", `cards/${card.id}`, { name, desc });
  await cover(card.id, attached[0], env);
  // "Changes Made", added beside the card's other labels (never a PUT of them all: the board's workflow flags are labels too).
  const made = needsChanges(card) && !(card.idLabels ?? []).includes(BOARD.madeLabel);
  if (made) await trello(env, "POST", `cards/${card.id}/idLabels`, { value: BOARD.madeLabel });
  forget();
  return { cardId: card.id, url: card.shortUrl || card.url, labelled: made };
}
