// Research on this machine: web and image searches through the
// local Chrome, headless, in a throwaway profile (not signed in, no cookies,
// nothing kept), so nothing lands in anyone's search history; they leave from
// this machine's own connection. Articles come from DuckDuckGo, images from
// Bing (Google blocks headless browsers).
//
// Found images are collected per project in `<home>/research/<project>/` for
// the user to review; the ones they keep go into the media bin.
//
// Plain fetches (article pages, image downloads) go through Bun's fetch; the
// browser stays a child process (`hooks.dump`,
// which tests replace).

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { ioMessage, writeAtomic } from "./files.ts";
import { crashed, isBug } from "./guard.ts";
import { importPaths } from "./import.ts";
import { join } from "./paths.ts";
import { byteLength, debugStrings, parseHex, serdeParse, splitWhitespace, takeChars, trim } from "./rust.ts";
import * as seams from "./seams.ts";
import type { Article, ResearchItem as Item, WebResult as Found } from "./seams.ts";
import { compareKeys } from "./stable.ts";
import * as tools from "./tools.ts";
import type { RawImage } from "./native/index.ts";

export type { Article, ResearchItem as Item, WebResult as Found } from "./seams.ts";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
/** Smaller than this on its short side isn't worth a look (thumbnails, icons). */
const MIN_SIDE = 360;
const MAX_BYTES = 25_000_000;
/** Bing's pages of image results. */
const PAGE = 35;

/** The ways out that tests replace: the headless browser. */
export const hooks = {
  /** A page as the browser renders it (scripts run), from a fresh profile that's deleted afterwards. */
  dump: (url: string, waitMs?: number): Promise<string> => chromeDump(url, waitMs),
};

/** Collections in progress (by project). */
const COLLECTING = new Set<string>();

export function dir(home: string, project: string): string {
  return join(home, "research", project);
}

export function collecting(project: string): boolean {
  return COLLECTING.has(project);
}

export function items(home: string, project: string): Item[] {
  return readIndex(home, project);
}

function readIndex(home: string, project: string): Item[] {
  try {
    const value = serdeParse(fs.readFileSync(join(dir(home, project), "index.json"), "utf8")) as unknown;
    return Array.isArray(value) && value.every(isItem) ? value.map(shownItem) : [];
  } catch {
    return [];
  }
}

function isItem(value: unknown): value is Item {
  const item = value as Record<string, unknown> | null;
  if (typeof item !== "object" || item === null) return false;
  const strings = ["id", "file", "title", "page", "image", "query", "status"];
  const sides = ["width", "height"];
  return (
    strings.every((key) => typeof item[key] === "string") &&
    sides.every((key) => typeof item[key] === "number" && Number.isInteger(item[key]) && (item[key] as number) >= 0) &&
    (item.media === undefined || item.media === null || typeof item.media === "string")
  );
}

/** An item as it's always been written: fields in order, `media` only once there is one. */
function shownItem(item: Item): Item {
  const out: Item = {
    id: item.id,
    file: item.file,
    width: item.width,
    height: item.height,
    title: item.title,
    page: item.page,
    image: item.image,
    query: item.query,
    status: item.status,
  };
  if (item.media !== undefined && item.media !== null) out.media = item.media;
  return out;
}

function writeIndex(home: string, project: string, found: Item[]): void {
  try {
    writeAtomic(join(dir(home, project), "index.json"), JSON.stringify(found.map(shownItem), null, 2));
  } catch (error) {
    throw new Error(ioMessage(error));
  }
}

/** Changes one item (its status, the media it became). */
export function update(home: string, project: string, id: string, change: (item: Item) => void): Item {
  const index = readIndex(home, project);
  const item = index.find((own) => own.id === id);
  if (item === undefined) throw new Error(`no found image ${id}`);
  change(item);
  const changed = shownItem(item);
  writeIndex(home, project, index);
  return changed;
}

/** Pages fetched in the last ten minutes: read_page then add_article on the same story fetched it twice. */
const PAGES: [url: string, at: number, page: string][] = [];
const FRESH_MS = 600_000;

/**
 * An article page: kept for a few minutes, fetched plainly first (most news
 * pages are rendered on the server, and a plain fetch takes a second where a
 * fresh headless Chrome takes ten or twenty), the browser only when the plain
 * page is a shell, a block or too thin to be the story.
 */
async function articlePage(url: string): Promise<string> {
  const now = performance.now();
  const kept = PAGES.find(([own, at]) => own === url && now - at < FRESH_MS);
  if (kept !== undefined) return kept[2];
  const page = (await plain(url)) ?? (await hooks.dump(url));
  for (let index = PAGES.length - 1; index >= 0; index--) {
    const [own, at] = PAGES[index]!;
    if (own === url || performance.now() - at >= FRESH_MS) PAGES.splice(index, 1);
  }
  if (PAGES.length >= 24) PAGES.shift();
  PAGES.push([url, performance.now(), page]);
  return page;
}

/** Forgets the pages kept (tests). */
export function forgetPages(): void {
  PAGES.length = 0;
}

/**
 * The page as the server sends it, when that's already the story: a 200 with
 * a couple of thousand characters of readable text and no sign of a bot check.
 */
async function plain(url: string): Promise<string | null> {
  let code: number;
  let page: string;
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, "accept-language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(15_000),
    });
    code = response.status;
    page = new TextDecoder().decode(await response.arrayBuffer());
  } catch {
    return null;
  }
  if (code !== 200) {
    // A Cloudflare challenge: headless Chrome doesn't get past it either (it
    // waited the full timeout on one), so say so at once.
    if ((code === 403 || code === 503) && (page.includes("cf_chl") || page.includes("challenge-platform"))) {
      throw new Error("the site blocks readers with a bot check; use another source");
    }
    return null;
  }
  // Judged on the readable text: a <noscript> "enable JavaScript" note on a
  // server-rendered story isn't a block.
  const text = readable(page);
  const lower = asciiLower(text);
  if (botCheck(lower) || lower.includes("please enable javascript")) return null;
  if (byteLength(text) >= 2000) return page;
  // Pages rendered by script often carry the whole story as JSON-LD
  // (`articleBody`, for search engines): read that rather than start a
  // browser (a second instead of ten to forty).
  const body = articleBody(page);
  return body !== null && byteLength(body) >= 800 ? `${page}\n<div>${body}</div>` : null;
}

/** `to_ascii_lowercase`. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Whether a page's readable text (lower case) is a bot check, not the story. */
function botCheck(lower: string): boolean {
  return [
    "captcha",
    "verify you are human",
    "human verification",
    "access denied",
    "just a moment...",
    "enable javascript and cookies to continue",
  ].some((sign) => lower.includes(sign));
}

/** The `articleBody` of the page's JSON-LD (schema.org NewsArticle), if any. */
export function articleBody(page: string): string | null {
  const out: string[] = [];
  const bodies = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) bodies(item);
    } else if (typeof value === "object" && value !== null) {
      // serde_json's maps are sorted: the bodies come in key order.
      const map = value as Record<string, unknown>;
      for (const key of Object.keys(map).sort(compareKeys)) {
        const inner = map[key];
        if (key === "articleBody" && typeof inner === "string") out.push(inner);
        else bodies(inner);
      }
    }
  };
  for (const block of page.split("application/ld+json").slice(1)) {
    const close = block.indexOf(">");
    if (close < 0) continue;
    const json = block.slice(close + 1).split("</script>")[0] ?? "";
    try {
      bodies(JSON.parse(trim(json)));
    } catch {
      // Not JSON.
    }
  }
  const unique = out.filter((body, index) => index === 0 || body !== out[index - 1]);
  const body = unique.join("\n\n");
  return trim(body) === "" ? null : body;
}

/** Chrome on this machine, headless: the page once it's rendered. */
async function chromeDump(url: string, waitMs = 6000): Promise<string> {
  const browser = seams.broll.chrome();
  if (browser === null) throw new Error("research needs Google Chrome (or Chromium) installed");
  const profile = join(os.tmpdir(), `edit-research-${process.pid}-${process.hrtime.bigint()}`);
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    child = Bun.spawn(
      [
        browser,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--mute-audio",
        "--disable-extensions",
        `--virtual-time-budget=${waitMs}`,
        `--user-agent=${USER_AGENT}`,
        `--user-data-dir=${profile}`,
        "--dump-dom",
        url,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
  } catch (error) {
    throw new Error(`chrome: ${diag.messageOf(error)}`);
  }
  // Headless Chrome prints the page and then may not exit: stop it once the page is out.
  const reading = (async () => {
    const chunks: Uint8Array[] = [];
    let tail = "";
    for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
      tail = (tail + Buffer.from(chunk).toString("latin1")).slice(-64);
      if (tail.includes("</html>")) break;
    }
    return Buffer.concat(chunks);
  })();
  const timeout = Bun.sleep(Math.max(30_000, waitMs + 20_000)).then(() => null);
  const bytes = await Promise.race([reading, timeout]);
  child.kill();
  await child.exited;
  fs.rmSync(profile, { recursive: true, force: true });
  if (bytes === null) throw new Error("the page took too long to load");
  const page = new TextDecoder().decode(bytes);
  // A bot check (Cloudflare's "Just a moment...") isn't the story: say so
  // rather than hand it over as the page.
  const text = readable(page);
  if (byteLength(text) < 2000 && botCheck(asciiLower(text))) {
    throw new Error("the site blocked the reader with a bot check; use another source");
  }
  return page;
}

/** Web results for `query` (DuckDuckGo). */
export async function searchWeb(query: string): Promise<Found[]> {
  const page = await hooks.dump(`https://html.duckduckgo.com/html/?q=${seams.library.encode(query)}`);
  const found: Found[] = [];
  for (const block of page.split('class="result__a"').slice(1)) {
    const href = attribute(block, "href") ?? "";
    const redirect = href.split("uddg=")[1];
    const url = redirect === undefined ? href : decode(redirect.split("&")[0]!);
    const close = block.indexOf(">");
    const title = textOf((close < 0 ? "" : block.slice(close + 1)).split("</a>")[0] ?? "");
    const after = block.split('class="result__snippet"')[1];
    let snippet = "";
    if (after !== undefined) {
      const open = after.indexOf(">");
      if (open >= 0) snippet = textOf(after.slice(open + 1).split("</a>")[0] ?? "");
    }
    if (url.startsWith("http") && title !== "") found.push({ title, url, snippet });
  }
  if (found.length === 0 && page.toLowerCase().includes("anomaly")) {
    throw new Error("DuckDuckGo wants a check that a person is searching; try again in a few minutes");
  }
  return found;
}

/** A page's readable text (scripts, styles and tags dropped), cut at `limit` characters. */
export async function readPage(url: string, limit: number): Promise<string> {
  if (!url.startsWith("http://") && !url.startsWith("https://")) throw new Error("give a web address (http or https)");
  return takeChars(readable(await articlePage(url)), limit);
}

/** A page's readable text: scripts, styles and tags dropped. */
export function readable(page: string): string {
  let text = page;
  // Drop what's never read: scripts, styles, svg and the like.
  for (const tag of ["script", "style", "noscript", "svg", "template"]) {
    const open = `<${tag}`;
    const close = `</${tag}>`;
    let kept = "";
    let rest = text;
    for (;;) {
      const at = rest.indexOf(open);
      if (at < 0) break;
      kept += rest.slice(0, at);
      const from = rest.slice(at + open.length);
      const end = from.indexOf(close);
      rest = end < 0 ? "" : from.slice(end + close.length);
    }
    text = kept + rest;
  }
  return textOf(text);
}

export function articles(home: string, project: string): Article[] {
  try {
    const value = serdeParse(fs.readFileSync(join(dir(home, project), "articles.json"), "utf8")) as unknown;
    return Array.isArray(value) && value.every(isArticle) ? value.map(shownArticle) : [];
  } catch {
    return [];
  }
}

function isArticle(value: unknown): value is Article {
  const article = value as Record<string, unknown> | null;
  if (typeof article !== "object" || article === null) return false;
  return (
    ["id", "url", "title", "outlet", "summary", "text"].every((key) => typeof article[key] === "string") &&
    (article.published === undefined || article.published === null || typeof article.published === "string")
  );
}

function shownArticle(article: Article): Article {
  const out: Record<string, unknown> = { id: article.id, url: article.url, title: article.title, outlet: article.outlet };
  if (article.published !== undefined && article.published !== null) out.published = article.published;
  out.summary = article.summary;
  out.text = article.text;
  return out as unknown as Article;
}

function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Saves an article to the project (its text, title, outlet and date read from
 * the page), and puts the photos it carries into the review: they're of this
 * case, unlike most image search results. Returns the article and how many
 * photos were added.
 */
export async function addArticle(home: string, project: string, url: string, summary: string): Promise<[Article, number]> {
  if (!url.startsWith("http://") && !url.startsWith("https://")) throw new Error("give a web address (http or https)");
  const page = await articlePage(url);
  const found = metas(page);
  const meta = (names: string[]): string | null => {
    for (const name of names) {
      const hit = found.find(([key]) => key === name);
      if (hit !== undefined) return hit[1];
    }
    return null;
  };
  let title = meta(["og:title", "twitter:title"]);
  if (title === null) {
    const after = page.split("<title")[1];
    const close = after === undefined ? -1 : after.indexOf(">");
    title = after === undefined || close < 0 ? "" : textOf(after.slice(close + 1).split("</title>")[0] ?? "");
  }
  const outlet = meta(["og:site_name", "application-name"]) ?? site(url);
  const published = meta(["article:published_time", "datePublished", "pubdate"]);
  const article: Article = {
    id: sha256Hex(url).slice(0, 16),
    url,
    title,
    outlet,
    ...(published !== null ? { published } : {}),
    summary,
    text: takeChars(readable(page), 60_000),
  };
  try {
    fs.mkdirSync(dir(home, project), { recursive: true });
    const all = articles(home, project).filter((known) => known.url !== article.url);
    all.push(article);
    writeAtomic(join(dir(home, project), "articles.json"), JSON.stringify(all.map(shownArticle), null, 2));
  } catch (error) {
    throw new Error(ioMessage(error));
  }
  // Its photos: the lead image and the ones in the story itself.
  const inside = page.split("<article")[1];
  const body = inside === undefined ? page : (inside.split("</article>")[0] ?? inside);
  const images: string[] = [];
  const lead = meta(["og:image", "twitter:image"]);
  if (lead !== null) images.push(lead);
  for (const tag of body.split("<img").slice(1)) {
    const source = attribute(` ${tag}`, "src") ?? attribute(` ${tag}`, "data-src") ?? "";
    const lower = source.toLowerCase();
    const decoration = ["logo", "icon", "avatar", "sprite", "pixel", "badge", ".svg", ".gif"].some((word) => lower.includes(word));
    if (source.startsWith("http") && !decoration && !images.includes(source)) images.push(source);
  }
  const hits: Hit[] = images.slice(0, 12).map((image) => [image, url, title]);
  const [added] = await storeHits(home, project, `article: ${outlet}`, hits);
  return [shownArticle(article), added];
}

/** `<meta>` tags: (property or name, content). */
function metas(page: string): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of page.split("<meta").slice(1)) {
    const tag = ` ${raw}`;
    const key = attribute(tag, "property") ?? attribute(tag, "name") ?? attribute(tag, "itemprop");
    if (key === null) continue;
    const content = attribute(tag, "content");
    if (content === null) continue;
    out.push([key, content]);
  }
  return out;
}

function site(url: string): string {
  const rest = url.split("://")[1];
  if (rest === undefined) return "";
  const host = rest.split("/")[0]!;
  let out = host;
  while (out.startsWith("www.")) out = out.slice(4);
  return out;
}

/** Removes the found images with a status (new: unreviewed, rejected) and their files. */
export function clear(home: string, project: string, status: string): number {
  if (status === "kept") throw new Error("kept images stay (they're in the media bin)");
  const index = readIndex(home, project);
  const gone = index.filter((item) => item.status === status);
  const kept = index.filter((item) => item.status !== status);
  for (const item of gone) fs.rmSync(item.file, { force: true });
  writeIndex(home, project, kept);
  return gone.length;
}

/** Rejects found images (the agent's own pass before the user looks). */
export function reject(home: string, project: string, ids: string[]): number {
  const index = readIndex(home, project);
  let count = 0;
  for (const item of index) {
    if (ids.includes(item.id) && item.status === "new") {
      item.status = "rejected";
      count += 1;
    }
  }
  writeIndex(home, project, index);
  return count;
}

/** A found image shrunk into a 320×240 cell (letterboxed), for contact sheets. */
export async function thumbnail(path: string): Promise<RawImage | null> {
  const width = 320;
  const height = 240;
  try {
    const child = Bun.spawn(
      [
        tools.ffmpeg(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        path,
        "-frames:v",
        "1",
        "-vf",
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const [pixels] = await Promise.all([new Response(child.stdout).bytes(), child.exited]);
    return pixels.length === width * height * 4 ? { width, height, pixels: Buffer.from(pixels) } : null;
  } catch {
    return null;
  }
}

/**
 * Searches images for each query (Bing), downloads them, and adds the new ones
 * (big enough, not seen before) to the project's review. Returns (added,
 * already had, failed).
 */
export async function collect(home: string, project: string, queries: string[], perQuery: number): Promise<[number, number, number]> {
  if (COLLECTING.has(project)) throw new Error("already collecting images for this project; wait for it to finish");
  COLLECTING.add(project);
  // Released even if it crashes, or the project could never collect again.
  try {
    return await collectInner(home, project, queries, perQuery);
  } catch (error) {
    if (isBug(error)) throw new Error(crashed("collecting images", error));
    throw error;
  } finally {
    COLLECTING.delete(project);
  }
}

/** One Bing image result: (image, page, title). */
type Hit = [image: string, page: string, title: string];

/**
 * Stock libraries' pictures: never this case, and watermarked (the comp's
 * round-2 edit used a dreamstime photo four times; the house never uses
 * stock). Left out of what a search collects.
 */
const STOCK = /(^|\.)(dreamstime|shutterstock|alamy|gettyimages|istockphoto|depositphotos|123rf|stock\.adobe|adobestock|pond5|bigstockphoto|canstockphoto|vectorstock|freepik|pexels|unsplash|pixabay)\./iu;

/** Whether a hit (its image or page) comes from a stock library. */
export function isStock([image, page]: Hit): boolean {
  const host = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  };
  return STOCK.test(`${host(image)}.`) || STOCK.test(`${host(page)}.`);
}

async function collectInner(home: string, project: string, queries: string[], perQuery: number): Promise<[number, number, number]> {
  const seen = new Set(items(home, project).flatMap((item) => [item.id, item.image]));
  // Queries three at a time: each is a browser search and its downloads, and
  // one after another they made a research step wait minutes.
  const one = async (query: string): Promise<[number, number, number]> => {
    let had = 0;
    const hits: Hit[] = [];
    let first = 1;
    while (hits.length < perQuery) {
      const encoded = seams.library.encode(query);
      const url =
        first === 1
          ? `https://www.bing.com/images/search?q=${encoded}&first=1`
          : `https://www.bing.com/images/async?q=${encoded}&first=${first}&count=${PAGE}&mmasync=1`;
      const page = await hooks.dump(url);
      const before = hits.length;
      hits.push(...imageHits(page));
      if (hits.length === before) break;
      first += PAGE;
    }
    const fresh = hits.filter((hit) => !isStock(hit)).slice(0, perQuery).filter(([image]) => {
      const isNew = !seen.has(image);
      if (!isNew) had += 1;
      return isNew;
    });
    const [added, already, broken] = await storeHits(home, project, query, fresh);
    return [added, had + already, broken];
  };
  let added = 0;
  let had = 0;
  let failed = 0;
  for (let at = 0; at < queries.length; at += 3) {
    const results = await Promise.allSettled(queries.slice(at, at + 3).map(one));
    for (const result of results) {
      if (result.status === "rejected") {
        const error = result.reason as unknown;
        if (isBug(error)) throw new Error("a search crashed");
        throw error;
      }
      const [n, a, b] = result.value;
      added += n;
      had += a;
      failed += b;
    }
  }
  return [added, had, failed];
}

/** Downloads hits (a few at a time) into the review: (added, already there, failed). */
async function storeHits(home: string, project: string, query: string, hits: Hit[]): Promise<[number, number, number]> {
  const folder = dir(home, project);
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (error) {
    throw new Error(ioMessage(error));
  }
  let added = 0;
  let had = 0;
  let failed = 0;
  for (let at = 0; at < hits.length; at += 8) {
    const results = await Promise.all(
      hits.slice(at, at + 8).map((hit) =>
        download(folder, hit, query).catch((error: unknown) => {
          if (isBug(error)) diag.warn("research", `downloading ${hit[0]} crashed: ${diag.messageOf(error)}`);
          return null;
        }),
      ),
    );
    const index = readIndex(home, project);
    for (const item of results) {
      if (item === null) failed += 1;
      else if (index.some((known) => known.id === item.id || known.image === item.image)) had += 1;
      else {
        index.push(item);
        added += 1;
      }
    }
    writeIndex(home, project, index);
  }
  return [added, had, failed];
}

/** The image results on a Bing images page: their `m` attributes. */
export function imageHits(page: string): Hit[] {
  const out: Hit[] = [];
  for (const block of page.split('class="iusc"').slice(1)) {
    const raw = attribute(block, "m");
    if (raw === null) continue;
    let meta: unknown;
    try {
      meta = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) continue;
    const field = (name: string) => {
      const value = (meta as Record<string, unknown>)[name];
      return typeof value === "string" ? value : null;
    };
    const image = field("murl");
    if (image === null || !image.startsWith("http")) continue;
    out.push([image, field("purl") ?? "", field("t") ?? ""]);
  }
  return out;
}

/** Downloads one found image, if it's a real image big enough to use. */
async function download(folder: string, [image, page, title]: Hit, query: string): Promise<Item | null> {
  let bytes: Uint8Array;
  try {
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    if (page !== "") headers.referer = page;
    const response = await fetch(image, { headers, signal: AbortSignal.timeout(25_000) });
    const declared = Number(response.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      void response.body?.cancel();
      return null;
    }
    bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status !== 200 || bytes.length > MAX_BYTES) return null;
  } catch {
    return null;
  }
  const head = bytes.subarray(0, 12);
  if (head.length < 12) return null;
  let extension: string;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) extension = "jpg";
  else if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) extension = "png";
  else if (
    new TextDecoder().decode(head.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(head.subarray(8, 12)) === "WEBP"
  ) {
    extension = "webp";
  } else return null;
  const id = sha256Hex(bytes).slice(0, 16);
  const path = join(folder, `${id}.${extension}`);
  if (!fs.existsSync(path)) {
    try {
      fs.writeFileSync(path, bytes);
    } catch {
      return null;
    }
  }
  const size = await dimensions(path);
  if (size === null) return null;
  const [width, height] = size;
  if (Math.min(width, height) < MIN_SIDE) {
    fs.rmSync(path, { force: true });
    return null;
  }
  return { id, file: path, width, height, title, page, image, query, status: "new" };
}

async function dimensions(path: string): Promise<[number, number] | null> {
  let text: string;
  try {
    const child = Bun.spawn(
      [tools.ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    [text] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  } catch {
    return null;
  }
  const line = trim(text);
  const comma = line.indexOf(",");
  if (comma < 0) return null;
  const width = parseU32(trim(line.slice(0, comma)));
  const height = parseU32(trim(line.slice(comma + 1)));
  return width === null || height === null ? null : [width, height];
}

/** `str::parse::<u32>`. */
function parseU32(text: string): number | null {
  if (!/^\+?\d+$/.test(text)) return null;
  const value = Number(text.replace("+", ""));
  return value <= 0xffff_ffff ? value : null;
}

/** An attribute's value in the tag that `block` starts inside, unescaped. */
function attribute(block: string, name: string): string | null {
  const tag = block.split(">")[0]!;
  const needle = ` ${name}="`;
  const at = tag.indexOf(needle);
  if (at < 0) return null;
  const rest = tag.slice(at + needle.length);
  const end = rest.indexOf('"');
  return end < 0 ? null : unescape(rest.slice(0, end));
}

/** Markup to plain text: tags dropped, entities read, spaces collapsed. */
export function textOf(markup: string): string {
  let text = "";
  let inTag = false;
  for (const c of markup) {
    if (c === "<") {
      inTag = true;
      text += " ";
    } else if (c === ">") {
      inTag = false;
    } else if (!inTag) {
      text += c;
    }
  }
  return splitWhitespace(unescape(text)).join(" ");
}

function unescape(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");
}

/** Percent-decoding (DuckDuckGo's redirect links). */
export function decode(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  const out: number[] = [];
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index]!;
    const high = bytes[index + 1];
    const low = bytes[index + 2];
    const escaped =
      byte === 0x25 && high !== undefined && low !== undefined && high < 0x80 && low < 0x80
        ? parseHex(String.fromCharCode(high, low), 0xff)
        : null;
    if (escaped !== null) {
      out.push(escaped);
      index += 3;
    } else if (byte === 0x2b) {
      out.push(0x20);
      index += 1;
    } else {
      out.push(byte);
      index += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(out));
}

/**
 * Sets a found image's status; kept the first time, it goes into the media
 * bin, named after its caption. Returns it (with its
 * media, once kept).
 */
export async function reviewFound(app: App, id: string, item: string, status: string, origin: string): Promise<Item> {
  const home = app.store.home;
  const found = items(home, id).find((own) => own.id === item);
  if (found === undefined) throw new Error("no such found image");
  let media = found.media ?? null;
  if (status === "kept" && media === null) {
    const [, added, errors] = await importPaths(app, id, [found.file], false, origin);
    const mediaId = added[0];
    if (mediaId === undefined) throw new Error(`couldn't add it to the media bin: ${debugStrings(errors)}`);
    const name = takeChars(found.title, 80);
    if (trim(name) !== "") {
      await app.store.update(id, origin, (project) => {
        const own = project.media.find((candidate) => candidate.id === mediaId);
        if (own !== undefined) own.name = name;
      });
    }
    media = mediaId;
  }
  return update(home, id, item, (own) => {
    own.status = status;
    if (media === null) delete own.media;
    else own.media = media;
  });
}

// Its routes live beside the package's other routes (script_tools.ts).
export { researchRoutes as routes } from "./script_tools.ts";
export { caseNames, known as knownNames } from "./names.ts";
