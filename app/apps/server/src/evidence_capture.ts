// Real page pixels from a private, throwaway Chrome. No agent-browser and
// no fabricated HTML reconstruction of an article, channel or social post.
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "./paths.ts";
import * as seams from "./seams.ts";

export interface Rect { x: number; y: number; width: number; height: number; }
/** A capture; `lines`: each line of the phrase's words, in the picture's pixels (what highlight_evidence takes). */
export interface Capture { url: string; title: string; width: number; height: number; path: string; lines?: Rect[]; }

/**
 * The page around a phrase (horror's highlights, Nov 9): a page "shown whole
 * and close", never a line cut out of it (22 of the horror run's captures were
 * such strips, which its audit refuses). At least 1,000 px wide round the
 * text's column and 1,000 tall, the phrase's lines in the middle, inside the
 * page.
 */
export function aroundCrop(lines: Rect[], page: { width: number; height: number }, column: { left: number; right: number }): Rect {
  const width = Math.min(page.width, Math.max(1000, column.right - column.left + 80));
  const height = Math.min(page.height, 1000);
  const middleX = (column.left + column.right) / 2;
  const top = Math.min(...lines.map((line) => line.y)); const bottom = Math.max(...lines.map((line) => line.y + line.height));
  const x = Math.min(Math.max(0, middleX - width / 2), page.width - width);
  const y = Math.min(Math.max(0, (top + bottom) / 2 - height / 2), page.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** Lines in the page's pixels as they sit in a crop of it. */
export function linesIn(lines: Rect[], crop: Rect): Rect[] {
  return lines
    .map((line) => ({ x: Math.round(line.x - crop.x), y: Math.round(line.y - crop.y), width: Math.round(line.width), height: Math.round(line.height) }))
    .filter((line) => line.x + line.width > 0 && line.y + line.height > 0 && line.x < crop.width && line.y < crop.height);
}
/**
 * Takes a sign-in or cookie wall off the page as loaded (a dialog, or a fixed
 * panel over most of it, saying "Log in", "Sign up", "See photos…") and lets
 * it scroll again. What's under it is the real page: Instagram shows a
 * profile's bio, counts and grid, and a post with its caption, under its
 * "See photos, videos and more" dialog (v2, Nov 6: every profile capture was
 * that dialog, so the edit showed b-roll where "we should show his instagram
 * profile").
 */
export const UNWALL = `(() => {
  const walls = /log in|sign up|see photos|see more from|continue with|sign in|accept all|allow all|cookies|create new account/i;
  const area = innerWidth * innerHeight;
  const covering = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height > area * 0.15; };
  let removed = 0;
  // A wall drawn in a shadow root over the article (LAist's "Want to read more? … log in", Nov 8): its words are
  // in the shadow, never in the page's innerText. A shadow of a few words of sign-in is a gate, never the page.
  for (const el of [...document.querySelectorAll('body *')]) {
    if (!el.shadowRoot) continue;
    // Its words, not its stylesheet (LAist's shadow is 6,000 characters of CSS around a few lines).
    const said = [...el.shadowRoot.querySelectorAll('style, script')].reduce((text, sheet) => text.replace(sheet.textContent || '', ''), el.shadowRoot.textContent || '');
    // Wherever its host sits: in the article on Nov 9, a 0-pixel static host (allegro-content-gate) whose form drew over it.
    if (walls.test(said) && said.trim().length < 2000) { el.remove(); removed++; }
  }
  for (const el of [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]) {
    const said = el.innerText || '';
    if (!walls.test(said) || said.length > 400) continue;
    let top = el;
    while (top.parentElement && top.parentElement !== document.body && getComputedStyle(top.parentElement).position === 'fixed') top = top.parentElement;
    top.remove(); removed++;
  }
  for (const el of [...document.querySelectorAll('body *')]) {
    const style = getComputedStyle(el);
    if (style.position !== 'fixed' && style.position !== 'sticky') continue;
    const text = el.innerText || '';
    const r = el.getBoundingClientRect();
    // The page itself pinned in place while a wall is up (Instagram's profile, its top bar saying "Log In"): let go, never removed.
    if (text.length > 400) { el.style.setProperty('position', 'relative', 'important'); continue; }
    // A wall (a few words), or the dimmed backdrop behind one (most of the screen, next to no words of its own).
    if ((covering(el) && walls.test(text)) || (r.width * r.height > area * 0.6 && text.trim().length < 40)) { el.remove(); removed++; }
  }
  // What a gate leaves on the words under it once it's gone (LAist blurs the article): no blur, no fade.
  if (removed > 0) for (const el of [...document.querySelectorAll('body *')]) {
    const style = getComputedStyle(el);
    if (/blur/.test(style.filter)) el.style.setProperty('filter', 'none', 'important');
    if (style.maskImage && style.maskImage !== 'none') el.style.setProperty('mask-image', 'none', 'important');
    if (style.webkitMaskImage && style.webkitMaskImage !== 'none') el.style.setProperty('-webkit-mask-image', 'none', 'important');
  }
  for (const el of [document.documentElement, document.body]) { el.style.setProperty('overflow', 'auto', 'important'); el.style.setProperty('position', 'static', 'important'); }
  return removed;
})()`;

/**
 * The words a page actually draws, up to 40 characters, or "picture" when it
 * shows one of any size: text with a box on the page, outside the Wayback
 * Machine's bar (a hidden shell's text and its scripts don't count). An
 * archived page the archive was too slow to serve drew only its bar (Nov 8).
 */
export const DRAWN = `(() => {
  if ([...document.querySelectorAll('img, video, canvas, svg')].some(e => { const b = e.getBoundingClientRect(); return b.width > 200 && b.height > 150 && !e.closest('[id^="wm-"]'); })) return 'picture'.repeat(4);
  let own = '';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && own.length < 40; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !node.textContent.trim() || parent.closest('script, style, noscript, [id^="wm-"]')) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && getComputedStyle(parent).visibility !== 'hidden') own += node.textContent.trim() + ' ';
  }
  return own.trim();
})()`;

/** The page a Wayback link leaves open (web/ then a star for the date, or 2015 and a star, then the page), else null. */
export function waybackOpen(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "web.archive.org") return null;
  const found = /^\/web\/(\d*\*)\/(.+)$/u.exec(parsed.pathname + parsed.search);
  return found === null ? null : found[2]!;
}

/**
 * The capture a Wayback link that leaves the date open stands for: the newest
 * good one (200) at least half the size of the largest, so a parked domain's
 * last captures (beginmodeling.com's 541 bytes in 2025, the site gone) never
 * stand for the site. The horror Doc of Nov 8 linked four such ("scroll
 * through the channel page here slowly: web.archive.org/web/*\/youtube.com/@Ryu-Kuriyama"),
 * and Chrome opened the archive's calendar of them.
 */
export function pickCapture(rows: string[][]): string | null {
  const captures = rows.filter((row) => row.length >= 3 && /^\d{14}$/u.test(row[0]!)).map(([timestamp, original, length]) => ({ timestamp: timestamp!, original: original!, length: Number(length) || 0 }));
  if (captures.length === 0) return null;
  const largest = Math.max(...captures.map((one) => one.length));
  const chosen = [...captures].reverse().find((one) => one.length >= largest / 2) ?? captures.at(-1)!;
  return `https://web.archive.org/web/${chosen.timestamp}/${chosen.original}`;
}

async function waybackCapture(page: string): Promise<string> {
  const index = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(page.replace(/^https?:\/\//u, ""))}&filter=statuscode:200&collapse=digest&fl=timestamp,original,length&output=json`;
  let rows: string[][];
  try {
    const answer = await fetch(index, { signal: AbortSignal.timeout(60_000) });
    rows = answer.ok ? ((await answer.json()) as string[][]) : [];
  } catch {
    rows = [];
  }
  const chosen = pickCapture(rows);
  if (chosen === null) throw new Error(`the Wayback Machine has no capture of ${page}: give a dated archive link or the live page`);
  return chosen;
}

/** pdf.js, pinned, for a PDF's pages in the capture Chrome (it shows a PDF to no one headless). */
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build";

/** Whether a link is a PDF by its name (court papers, agreements, verdicts). */
export function isPdfLink(url: string): boolean {
  try {
    return /\.pdf$/iu.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * In-page script: a PDF (base64) drawn with pdf.js on a canvas at 1600 px wide, on its page `page` (else the first
 * page holding the phrase), with the crop around the phrase's lines (three lines of room each side, the text's
 * margins across), or the whole page without one. Returns {page, width, height, rect} or {error}.
 */
export function pdfScript(base64: string, phrase: string, page: number | null): string {
  return `(async () => {
  const lib = await import(${JSON.stringify(`${PDFJS}/pdf.min.mjs`)});
  globalThis.pdfjsWorker = await import(${JSON.stringify(`${PDFJS}/pdf.worker.min.mjs`)});
  const raw = atob(${JSON.stringify(base64)}); const bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const doc = await lib.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const norm = (s) => s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();
  const needle = norm(${JSON.stringify(phrase)});
  const asked = ${page === null ? "null" : String(page)};
  if (asked !== null && (asked < 1 || asked > doc.numPages)) return { error: 'The PDF has ' + doc.numPages + ' pages, not ' + asked };
  const pages = asked !== null ? [asked] : Array.from({ length: doc.numPages }, (_, i) => i + 1);
  for (const n of pages) {
    const one = await doc.getPage(n);
    const scale = 1600 / one.getViewport({ scale: 1 }).width;
    const vp = one.getViewport({ scale });
    const content = await one.getTextContent();
    let text = ''; const spans = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const said = norm(item.str); if (!said) continue;
      if (text) text += ' ';
      spans.push([text.length, text.length + said.length, item]); text += said;
    }
    const at = needle ? text.indexOf(needle) : 0;
    if (needle && at < 0) continue;
    const canvas = document.createElement('canvas'); canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    document.body.style.margin = '0'; document.body.innerHTML = ''; document.body.appendChild(canvas);
    await one.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const box = (item) => { const t = lib.Util.transform(vp.transform, item.transform); const h = Math.hypot(t[2], t[3]); return { x: t[4], y: t[5] - h, w: item.width * scale, h }; };
    let rect = null; const lines = []; let column = null;
    if (needle) {
      const hit = spans.filter(([from, to]) => to > at && from < at + needle.length).map(([, , item]) => box(item));
      const all = spans.map(([, , item]) => box(item));
      const left = Math.max(0, Math.min(...all.map((b) => b.x)) - 24), right = Math.min(canvas.width, Math.max(...all.map((b) => b.x + b.w)) + 24);
      // One whole line above and below the phrase's lines (court papers are double-spaced: room counted in font
      // heights cut through the next line), with a little air.
      const hitTop = Math.min(...hit.map((b) => b.y)), hitBottom = Math.max(...hit.map((b) => b.y + b.h));
      const above = all.filter((b) => b.y + b.h < hitTop - 2), below = all.filter((b) => b.y > hitBottom + 2);
      const lineAbove = above.length ? Math.max(...above.map((b) => b.y + b.h)) : null, lineBelow = below.length ? Math.min(...below.map((b) => b.y)) : null;
      const topOf = lineAbove === null ? hitTop : Math.min(...above.filter((b) => b.y + b.h >= lineAbove - 2).map((b) => b.y));
      const bottomOf = lineBelow === null ? hitBottom : Math.max(...below.filter((b) => b.y <= lineBelow + 2).map((b) => b.y + b.h));
      const air = Math.max(...hit.map((b) => b.h)) * 0.6;
      const top = Math.max(0, topOf - air), bottom = Math.min(canvas.height, bottomOf + air);
      rect = { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
      // The phrase's own lines: each text run it touches, cut to the share of its letters the phrase takes, joined by line.
      const runs = spans.filter(([from, to]) => to > at && from < at + needle.length).map(([from, to, item]) => {
        const b = box(item); const n = Math.max(1, to - from);
        const a = Math.max(0, at - from) / n, z = Math.min(n, at + needle.length - from) / n;
        return { x: b.x + b.w * a, y: b.y, width: b.w * (z - a), height: b.h };
      });
      for (const run of runs) {
        const same = lines.find((line) => Math.abs(line.y - run.y) < run.height * 0.5);
        if (same) { const r = Math.max(same.x + same.width, run.x + run.width); same.x = Math.min(same.x, run.x); same.width = r - same.x; same.height = Math.max(same.height, run.height); }
        else lines.push({ ...run });
      }
      column = { left, right };
    }
    return { page: n, width: canvas.width, height: canvas.height, rect, lines, column };
  }
  return { error: needle ? 'The phrase is not in the PDF' + (asked !== null ? ' on page ' + asked : '') + '; do not fabricate it (a phrase split by a line break or a hyphen: give a shorter part of it)' : 'The PDF has no pages' };
})()`;
}

export async function capture(url: string, path: string, phrase = "", selector = "", fullPage = false, page: number | null = null, around = false): Promise<Capture> {
  const open = waybackOpen(url);
  if (open !== null) url = await waybackCapture(open);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("capture needs a public https source URL");
  const browser = seams.broll.chrome(); if (browser === null) throw new Error("evidence capture needs Chrome installed");
  const profile = fs.mkdtempSync(join(os.tmpdir(), "edit-evidence-"));
  const child = Bun.spawn([browser, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio", "--hide-scrollbars", "--window-size=1920,1400", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  let socket: WebSocket | null = null;
  let next = 0;
  let pageLoaded: (() => void) | null = null;
  const pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  try {
    const until = Date.now() + 15_000;
    const portFile = join(profile, "DevToolsActivePort");
    while (!fs.existsSync(portFile) && Date.now() < until) await Bun.sleep(100);
    const port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
    if (!Number.isInteger(port) || port <= 0) throw new Error("Chrome did not start its capture endpoint");
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json() as { type: string; webSocketDebuggerUrl: string }[];
    const target = tabs.find((t) => t.type === "page"); if (target === undefined) throw new Error("Chrome has no capture page");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome capture connection timed out")), 5000);
      socket!.onopen = () => { clearTimeout(timer); resolve(); };
      socket!.onerror = () => { clearTimeout(timer); reject(new Error("Chrome capture connection failed")); };
    });
    socket.onmessage = (event) => {
      // One malformed frame must not throw out of the handler and strand its request.
      let message: { id?: number; method?: string; result?: Record<string, unknown>; error?: { message?: string } };
      try {
        message = JSON.parse(String(event.data)) as typeof message;
      } catch {
        return;
      }
      if (message.method === "Page.loadEventFired") pageLoaded?.();
      if (message.id === undefined) return;
      const own = pending.get(message.id); if (own === undefined) return;
      pending.delete(message.id); clearTimeout(own.timer);
      if (message.error) own.reject(new Error(message.error.message ?? "Chrome capture failed")); else own.resolve(message.result ?? {});
    };
    const call = (method: string, params: Record<string, unknown> = {}, wait?: number): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
      // A whole page (4200 px of an old archived site) takes Chrome longer than 20 s to draw.
      const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome ${method} timed out`)); }, wait ?? (method === "Page.captureScreenshot" ? 90_000 : 20_000));
      pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params }));
    });
    await call("Page.enable");
    // Chrome's own user agent, without "Headless": X answers a HeadlessChrome one with a 403, so a linked post never
    // came through (Nov 6, the study the horror script linked as a comment).
    const version = await call("Browser.getVersion");
    if (typeof version.userAgent === "string") await call("Network.setUserAgentOverride", { userAgent: version.userAgent.replace("HeadlessChrome", "Chrome") });
    await call("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1400, deviceScaleFactor: 1, mobile: false });
    // A PDF: its page drawn by pdf.js in this Chrome (a headless Chrome shows a PDF to no one, so the phrase was
    // never found: the horror Doc of Nov 8 asks for eight highlights on pages of a court's Statement of Decision).
    if (isPdfLink(url)) {
      let bytes: Uint8Array;
      try {
        const answer = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { "user-agent": String(version.userAgent ?? "").replace("HeadlessChrome", "Chrome") } });
        if (!answer.ok) throw new Error(`the PDF answered ${answer.status}`);
        bytes = new Uint8Array(await answer.arrayBuffer());
      } catch (error) {
        throw new Error(`the PDF did not download: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (bytes.length > 80_000_000) throw new Error("the PDF is over 80 MB: give the page as a screenshot instead");
      const drawn = await call("Runtime.evaluate", { expression: pdfScript(Buffer.from(bytes).toString("base64"), phrase, page), awaitPromise: true, returnByValue: true }, 180_000);
      const pdf = (drawn.result as { value?: { error?: string; page?: number; width?: number; height?: number; rect?: Rect | null; lines?: Rect[]; column?: { left: number; right: number } | null } } | undefined)?.value;
      if (pdf === undefined) throw new Error(`the PDF could not be drawn${drawn.exceptionDetails ? `: ${JSON.stringify(drawn.exceptionDetails).slice(0, 200)}` : ""}`);
      if (pdf.error !== undefined) throw new Error(pdf.error);
      const found = pdf.lines ?? [];
      const clip = around && found.length > 0 && pdf.column
        ? aroundCrop(found, { width: pdf.width!, height: pdf.height! }, pdf.column)
        : (pdf.rect ?? { x: 0, y: 0, width: pdf.width!, height: pdf.height! });
      const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...clip, scale: 1 } });
      if (typeof shot.data !== "string") throw new Error("Chrome returned no screenshot");
      fs.writeFileSync(path, Buffer.from(shot.data, "base64"));
      return { path, url, title: `${parsed.pathname.split("/").pop() ?? "PDF"}, page ${pdf.page}`, width: clip.width, height: clip.height, ...(found.length > 0 ? { lines: linesIn(found, clip) } : {}) };
    }
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    // The Wayback Machine serves an old page slowly, its scripts and pictures one by one through the archive (the
    // 2007 Sankei article, Nov 8: still loading after a minute, captured at 15 s with no article on it).
    const archived = parsed.hostname === "web.archive.org";
    const ready = new Promise<void>((resolve) => { pageLoaded = resolve; readyTimer = setTimeout(resolve, archived ? 90_000 : 15_000); });
    const navigation = await call("Page.navigate", { url });
    if (navigation.errorText) throw new Error(`the source page did not load: ${String(navigation.errorText)}`);
    await ready; if (readyTimer !== null) clearTimeout(readyTimer);
    await Bun.sleep(1500);
    await call("Runtime.evaluate", { expression: UNWALL, returnByValue: true });
    await Bun.sleep(300);
    const result = await call("Runtime.evaluate", { awaitPromise: true, expression: `(async () => {
      const phrase = ${JSON.stringify(phrase)}; const selector = ${JSON.stringify(selector)};
      // Chrome's own error page (the site refused or dropped the connection) is never the source.
      if (location.protocol === 'chrome-error:') return {error: 'The page did not load (the site refused the connection): try again in a few minutes'};
      for (let waited = 0; document.readyState === 'loading' && waited < ${archived ? 60_000 : 10_000}; waited += 500) await new Promise(resolve => setTimeout(resolve, 500));
      let element = null;
      for(let attempt=0;attempt<10;attempt++) {
        element = selector ? document.querySelector(selector) : null;
        if (!element && phrase) {
        const needle = phrase.toLowerCase().replace(/\\s+/g, ' ').trim();
        element = [...document.querySelectorAll('p, h1, h2, h3, blockquote, article, [data-testid="tweetText"], ytd-rich-item-renderer')]
          .filter(e => e.textContent.toLowerCase().replace(/\\s+/g, ' ').includes(needle))
          .sort((a,b) => a.textContent.length-b.textContent.length)[0];
        }
        if (element || (!phrase && !selector)) break;
        await new Promise(resolve=>setTimeout(resolve,750));
      }
      if ((phrase || selector) && !element) return {error: 'The requested text/element is not on the loaded page; do not fabricate it.'};
      if (element) {
        element.scrollIntoView({block:'center',behavior:'instant'});
        // A wall that comes in as the page is scrolled (LAist's, Nov 8) is taken off too, and the place measured after.
        await new Promise(resolve=>setTimeout(resolve,1500));
        ${UNWALL};
        await new Promise(resolve=>setTimeout(resolve,300));
        element.scrollIntoView({block:'center',behavior:'instant'});
      }
      const body = document.body.innerText;
      // A page that drew nothing (an archived page the Wayback Machine served too slowly or refused, Nov 8):
      // no words but the archive's own bar, no picture or video of any size. Said, never captured as a white card.
      const own = ${DRAWN};
      if (own.length < 20) return {error: 'The page drew nothing to capture' + (location.hostname === 'web.archive.org' ? ' (the Wayback Machine is slow or refusing just now): try again in a few minutes, or use a screenshot of it the script gives' : '')};
      if (/^(Just a moment|Access denied|Sign in to X|Sign in to confirm)/i.test(body.trim())) return {error:'The site showed a login or bot check'};
      const r = element?.getBoundingClientRect();
      // The phrase's own lines, in the page's pixels: its words' range in the element, one box per line.
      const lines = [];
      if (element && phrase) {
        const needle = phrase.toLowerCase().replace(/\s+/g, ' ').trim();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); const map = []; let flat = '';
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const said = node.textContent.toLowerCase();
          for (let i = 0; i < said.length; i++) {
            const space = /\s/.test(said[i]);
            if (space && (flat.endsWith(' ') || flat === '')) continue;
            flat += space ? ' ' : said[i]; map.push([node, i]);
          }
        }
        const at = flat.indexOf(needle);
        if (at >= 0) {
          const range = document.createRange();
          range.setStart(map[at][0], map[at][1]); const last = map[at + needle.length - 1]; range.setEnd(last[0], last[1] + 1);
          for (const box of range.getClientRects()) {
            if (box.width < 2 || box.height < 2) continue;
            const same = lines.find((line) => Math.abs(line.y - (box.y + scrollY)) < box.height * 0.5);
            if (same) { const right = Math.max(same.x + same.width, box.x + scrollX + box.width); same.x = Math.min(same.x, box.x + scrollX); same.width = right - same.x; same.height = Math.max(same.height, box.height); }
            else lines.push({ x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height });
          }
        }
      }
      const column = r ? { left: r.x + scrollX, right: r.x + scrollX + r.width } : null;
      const pageHeight = Math.max(document.documentElement.scrollHeight, innerHeight);
      // The crop in the page's own coordinates (what captureScreenshot's clip takes): the element's place in the
      // window plus how far the page is scrolled. Without the scroll, a phrase scrolled to the middle of a long
      // article was cropped from a part of the page never drawn: a white picture (LAist, Nov 8).
      return {lines,column,pageHeight,title:document.title,url:location.href,selection:element?.innerText?.slice(0,500),rect:r?{x:Math.max(0,r.x-12)+scrollX,y:Math.max(0,r.y-12)+scrollY,width:Math.min(innerWidth-Math.max(0,r.x-12),r.width+24),height:Math.min(innerHeight-Math.max(0,r.y-12),r.height+24)}:null};
    })()`, returnByValue: true }, 120_000);
    const data = (result.result as { value?: Record<string, unknown> } | undefined)?.value;
    if (data === undefined || data.error) throw new Error(String(data?.error ?? "the source page could not be read"));
    await Bun.sleep(500);
    const rect = data.rect as { x: number; y: number; width: number; height: number } | null;
    if (rect && (rect.width < 20 || rect.height < 20)) throw new Error("the source element is outside the capture viewport");
    // The whole page (a profile to scroll through), down to 4200 px: its later walls taken off as they load.
    let whole: { x: number; y: number; width: number; height: number } | null = null;
    if (fullPage && rect === null) {
      await call("Runtime.evaluate", { awaitPromise: true, expression: `(async () => { for (let y = 0; y < 4200; y += 700) { scrollTo(0, y); await new Promise(r => setTimeout(r, 350)); } scrollTo(0, 0); await new Promise(r => setTimeout(r, 500)); })()` });
      await call("Runtime.evaluate", { expression: UNWALL, returnByValue: true });
      const size = await call("Runtime.evaluate", { expression: "Math.min(document.documentElement.scrollHeight, 4200)", returnByValue: true });
      const height = Number((size.result as { value?: number } | undefined)?.value ?? 1400);
      whole = { x: 0, y: 0, width: 1920, height: Math.max(1400, Math.round(height)) };
    }
    const found = Array.isArray(data.lines) ? (data.lines as Rect[]) : [];
    const column = data.column as { left: number; right: number } | null;
    // In a horror project, the page round the phrase, not its paragraph alone.
    const pageCrop = around && found.length > 0 && column !== null ? aroundCrop(found, { width: 1920, height: Number(data.pageHeight) || 1400 }, column) : null;
    const clip = whole ?? pageCrop ?? rect;
    const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: whole !== null || pageCrop !== null, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    if (typeof shot.data !== "string") throw new Error("Chrome returned no screenshot");
    fs.writeFileSync(path, Buffer.from(shot.data, "base64"));
    return { path, url: typeof data.url === "string" ? data.url : url, title: typeof data.title === "string" ? data.title : "", width: clip?.width ?? 1920, height: clip?.height ?? 1400,
      ...(found.length > 0 && clip ? { lines: linesIn(found, clip) } : {}) };
  } finally {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("capture closed")); }
    socket?.close(); child.kill();
    const kill = setTimeout(() => child.kill(9), 3000);
    try { await child.exited; } finally { clearTimeout(kill); }
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
