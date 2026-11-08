// Real page pixels from a private, throwaway Chrome. No agent-browser and
// no fabricated HTML reconstruction of an article, channel or social post.
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "./paths.ts";
import * as seams from "./seams.ts";

export interface Capture { url: string; title: string; width: number; height: number; path: string; }
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
  // in the shadow, never in the page's innerText.
  for (const el of [...document.querySelectorAll('body *')]) {
    if (!el.shadowRoot) continue;
    // Its words, not its stylesheet (LAist's shadow is 6,000 characters of CSS around a few lines).
    const said = [...el.shadowRoot.querySelectorAll('style, script')].reduce((text, sheet) => text.replace(sheet.textContent || '', ''), el.shadowRoot.textContent || '');
    const position = getComputedStyle(el).position;
    if (walls.test(said) && said.length < 2000 && (position === 'absolute' || position === 'fixed' || position === 'sticky')) { el.remove(); removed++; }
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
 * archived YouTube page draws nothing (the archive can't replay its app).
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

export async function capture(url: string, path: string, phrase = "", selector = "", fullPage = false): Promise<Capture> {
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
    const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
      // A whole page (4200 px of an old archived site) takes Chrome longer than 20 s to draw.
      const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome ${method} timed out`)); }, method === "Page.captureScreenshot" ? 90_000 : 20_000);
      pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params }));
    });
    await call("Page.enable");
    // Chrome's own user agent, without "Headless": X answers a HeadlessChrome one with a 403, so a linked post never
    // came through (Nov 6, the study the horror script linked as a comment).
    const version = await call("Browser.getVersion");
    if (typeof version.userAgent === "string") await call("Network.setUserAgentOverride", { userAgent: version.userAgent.replace("HeadlessChrome", "Chrome") });
    await call("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1400, deviceScaleFactor: 1, mobile: false });
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    const ready = new Promise<void>((resolve) => { pageLoaded = resolve; readyTimer = setTimeout(resolve, 15_000); });
    const navigation = await call("Page.navigate", { url });
    if (navigation.errorText) throw new Error(`the source page did not load: ${String(navigation.errorText)}`);
    await ready; if (readyTimer !== null) clearTimeout(readyTimer);
    await Bun.sleep(1500);
    await call("Runtime.evaluate", { expression: UNWALL, returnByValue: true });
    await Bun.sleep(300);
    const result = await call("Runtime.evaluate", { awaitPromise: true, expression: `(async () => {
      const phrase = ${JSON.stringify(phrase)}; const selector = ${JSON.stringify(selector)};
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
      // A page that drew nothing (an archived YouTube page: the Wayback Machine can't replay YouTube's app, Nov 8):
      // no words but the archive's own bar, no picture or video of any size. Said, never captured as a white card.
      const own = ${DRAWN};
      if (own.length < 20) return {error: 'The page drew nothing to capture' + (location.hostname === 'web.archive.org' ? ' (the Wayback Machine cannot replay this page, as with archived YouTube pages): use a screenshot of it the script gives, or another source, and say so' : '')};
      if (/^(Just a moment|Access denied|Sign in to X|Sign in to confirm)/i.test(body.trim())) return {error:'The site showed a login or bot check'};
      const r = element?.getBoundingClientRect();
      // The crop in the page's own coordinates (what captureScreenshot's clip takes): the element's place in the
      // window plus how far the page is scrolled. Without the scroll, a phrase scrolled to the middle of a long
      // article was cropped from a part of the page never drawn: a white picture (LAist, Nov 8).
      return {title:document.title,url:location.href,selection:element?.innerText?.slice(0,500),rect:r?{x:Math.max(0,r.x-12)+scrollX,y:Math.max(0,r.y-12)+scrollY,width:Math.min(innerWidth-Math.max(0,r.x-12),r.width+24),height:Math.min(innerHeight-Math.max(0,r.y-12),r.height+24)}:null};
    })()`, returnByValue: true });
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
    const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: whole !== null, ...(whole ? { clip: { ...whole, scale: 1 } } : rect ? { clip: { ...rect, scale: 1 } } : {}) });
    if (typeof shot.data !== "string") throw new Error("Chrome returned no screenshot");
    fs.writeFileSync(path, Buffer.from(shot.data, "base64"));
    return { path, url: typeof data.url === "string" ? data.url : url, title: typeof data.title === "string" ? data.title : "", width: whole?.width ?? rect?.width ?? 1920, height: whole?.height ?? rect?.height ?? 1400 };
  } finally {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("capture closed")); }
    socket?.close(); child.kill();
    const kill = setTimeout(() => child.kill(9), 3000);
    try { await child.exited; } finally { clearTimeout(kill); }
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
