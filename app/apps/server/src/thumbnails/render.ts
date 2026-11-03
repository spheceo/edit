// A thumbnail drawn on this Mac for Claude to look at (and for the list), by
// the same drawing the editor runs (`@edit/types/thumbnail_render`), in a
// headless Chrome kept open a few minutes between looks: what Claude sees is
// what the person sees, fonts and all. The page is this server's
// (`/api/thumbnails/renderer`); its pictures and fonts come from here too.

import * as fs from "node:fs";
import * as os from "node:os";

import { HEIGHT, WIDTH, type Design } from "@edit/types/thumbnails";
// @ts-expect-error: Bun gives the file's text (the import attribute), which TypeScript doesn't know.
import rendererSource from "@edit/types/thumbnail_render" with { type: "text" };

import * as diag from "../diag.ts";
import { join } from "../paths.ts";
import * as seams from "../seams.ts";

let transpiled: string | null = null;

/** The drawing as plain JavaScript for the page (its imports are types only). */
function rendererScript(): string {
  transpiled ??= new Bun.Transpiler({ loader: "ts" }).transformSync(rendererSource as unknown as string).replace(/^import .*$/gm, "");
  return transpiled;
}

/** The page Chrome draws on: the drawing, the fonts, and `render(design, id, grid)` answering a data URL. */
export function page(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Montserrat"; src: url("/api/thumbnails/fonts/Montserrat.ttf") format("truetype"); font-weight: 100 900; font-style: normal; }
@font-face { font-family: "Arabic-font-2013"; src: url("/api/thumbnails/fonts/Arabic-font-2013.ttf") format("truetype"); font-weight: 100 900; font-style: normal; }
@font-face { font-family: "ITC Avant Garde Gothic"; src: url("/api/thumbnails/fonts/ITCAvantGardeGothic-Bold.otf") format("opentype"); font-weight: 100 900; font-style: normal; }
html, body { margin: 0; background: #000; }
</style></head><body><script type="module">
${rendererScript()}
const pictures = new Map();
function picture(url) {
  if (!pictures.has(url)) pictures.set(url, new Promise((resolve) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); image.src = url; }));
  return pictures.get(url);
}
const sourceUrl = (id, source) => source.startsWith("asset:") ? "/api/thumbnails/assets/" + encodeURIComponent(source.slice(6)) + "/file" : "/api/thumbnails/" + encodeURIComponent(id) + "/images/" + encodeURIComponent(source);
window.render = async (design, id, grid, type) => {
  const loaded = new Map();
  for (const layer of design.layers) {
    if (layer.kind === "image") loaded.set(layer.source, await picture(sourceUrl(id, layer.source)));
    else await document.fonts.load(fontOf(layer), layer.text).catch(() => {});
  }
  const canvas = document.createElement("canvas");
  canvas.width = ${WIDTH}; canvas.height = ${HEIGHT};
  const context = canvas.getContext("2d", { willReadFrequently: true });
  drawThumbnail(context, design, { picture: (source) => loaded.get(source) ?? null, canvas: (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; } }, ${WIDTH}, ${HEIGHT});
  if (grid) {
    context.save();
    context.strokeStyle = "rgba(0,255,255,0.55)"; context.fillStyle = "rgba(0,255,255,0.95)"; context.lineWidth = 1; context.font = "bold 14px Helvetica";
    for (let x = 160; x < ${WIDTH}; x += 160) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, ${HEIGHT}); context.stroke(); context.fillText(String(x), x + 3, 16); }
    for (let y = 120; y < ${HEIGHT}; y += 120) { context.beginPath(); context.moveTo(0, y); context.lineTo(${WIDTH}, y); context.stroke(); context.fillText(String(y), 3, y - 3); }
    context.restore();
  }
  const missing = [...loaded].filter(([, one]) => one === null).map(([source]) => source);
  return { data: canvas.toDataURL(type, 0.9), missing };
};
window.ready = true;
</script></body></html>`;
}

type Browser = { child: ReturnType<typeof Bun.spawn>; socket: WebSocket; profile: string; call: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>; origin: string };

let browser: Promise<Browser> | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function launch(origin: string): Promise<Browser> {
  const binary = seams.broll.chrome();
  if (binary === null) throw new Error("Drawing a thumbnail needs Chrome installed.");
  const profile = fs.mkdtempSync(join(os.tmpdir(), "edit-thumbnail-"));
  const child = Bun.spawn([binary, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio", "--hide-scrollbars", "--window-size=1400,900", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const until = Date.now() + 15_000;
  const portFile = join(profile, "DevToolsActivePort");
  while (!fs.existsSync(portFile) && Date.now() < until) await Bun.sleep(100);
  const port = Number(fs.existsSync(portFile) ? fs.readFileSync(portFile, "utf8").split("\n")[0] : 0);
  if (!Number.isInteger(port) || port <= 0) {
    child.kill();
    throw new Error("Chrome didn't start for the thumbnail.");
  }
  const tabs = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const target = tabs.find((one) => one.type === "page");
  if (target === undefined) throw new Error("Chrome has no page for the thumbnail.");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome's connection timed out")), 5000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Chrome's connection failed"));
    };
  });
  let next = 0;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  socket.onmessage = (event) => {
    let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      message = JSON.parse(String(event.data)) as typeof message;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const own = pending.get(message.id);
    if (own === undefined) return;
    pending.delete(message.id);
    clearTimeout(own.timer);
    if (message.error) own.reject(new Error(message.error.message ?? "Chrome refused"));
    else own.resolve(message.result ?? {});
  };
  socket.onclose = () => {
    for (const one of pending.values()) one.reject(new Error("Chrome closed"));
    pending.clear();
    browser = null;
  };
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Chrome ${method} timed out`));
      }, 60_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await call("Page.enable");
  await call("Page.navigate", { url: `${origin}/api/thumbnails/renderer` });
  const ready = Date.now() + 15_000;
  for (;;) {
    const answer = await call("Runtime.evaluate", { expression: "window.ready === true", returnByValue: true });
    if ((answer.result as { value?: boolean } | undefined)?.value === true) break;
    if (Date.now() > ready) throw new Error("The thumbnail page didn't load in Chrome.");
    await Bun.sleep(100);
  }
  return { child, socket, profile, call, origin };
}

function close(): void {
  const open = browser;
  browser = null;
  void open
    ?.then((one) => {
      one.socket.close();
      one.child.kill();
      fs.rmSync(one.profile, { recursive: true, force: true });
    })
    .catch(() => {});
}

/**
 * The design drawn as a PNG (or JPEG): a grid every 160 px across and 120 down
 * when asked, for placing things by eye. Missing pictures are named.
 */
export function draw(origin: string, id: string, design: Design, options: { grid?: boolean; type?: "image/png" | "image/jpeg" } = {}): Promise<{ bytes: Uint8Array; missing: string[] }> {
  const work = queue.then(async () => {
    if (idle !== null) clearTimeout(idle);
    for (let attempt = 0; ; attempt++) {
      if (browser === null || (await browser.catch(() => null))?.origin !== origin) {
        close();
        browser = launch(origin);
      }
      try {
        const open = await browser;
        const started = Date.now();
        const answer = await open.call("Runtime.evaluate", { expression: `window.render(${JSON.stringify(design)}, ${JSON.stringify(id)}, ${options.grid === true}, ${JSON.stringify(options.type ?? "image/png")})`, awaitPromise: true, returnByValue: true });
        const value = (answer.result as { value?: { data?: string; missing?: string[] } } | undefined)?.value;
        if (typeof value?.data !== "string") throw new Error(String((answer.exceptionDetails as { exception?: { description?: string } } | undefined)?.exception?.description ?? "Chrome drew nothing"));
        diag.record("thumbnails", "draw", Date.now() - started);
        return { bytes: new Uint8Array(Buffer.from(value.data.slice(value.data.indexOf(",") + 1), "base64")), missing: value.missing ?? [] };
      } catch (error) {
        close();
        if (attempt >= 1) throw error;
      }
    }
  });
  queue = work.catch(() => {});
  void work.finally(() => {
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(close, 5 * 60_000);
    idle.unref?.();
  });
  return work;
}
