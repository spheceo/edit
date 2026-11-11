// A thumbnail drawn on this Mac for Claude to look at (and for the list), by
// the same drawing the editor runs (`@edit/types/thumbnail_render`), in a
// headless Chrome kept open a few minutes between looks: what Claude sees is
// what the person sees, fonts and all. The page is this server's
// (`/api/thumbnails/renderer`); its pictures and fonts come from here too.

import * as fs from "node:fs";
import * as os from "node:os";

import { HEIGHT, WIDTH, type Design } from "@edit/types/thumbnails";
import { rendererSource } from "./renderer_source.ts" with { type: "macro" };

import * as diag from "../diag.ts";
import { join } from "../paths.ts";
import { devToolsPort } from "../chrome_devtools.ts";
import * as seams from "../seams.ts";

let transpiled: string | null = null;

/** The drawing as plain JavaScript for the page (its imports are types only). */
function rendererScript(): string {
  transpiled ??= new Bun.Transpiler({ loader: "ts" }).transformSync(rendererSource()).replace(/^import .*$/gm, "");
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
  if (!pictures.has(url)) pictures.set(url, new Promise((resolve) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => { pictures.delete(url); resolve(null); }; image.src = url; }));
  return pictures.get(url);
}
const sourceUrl = (id, source) => source.startsWith("asset:") ? "/api/thumbnails/assets/" + encodeURIComponent(source.slice(6)) + "/file" : "/api/thumbnails/" + encodeURIComponent(id) + "/images/" + encodeURIComponent(source);
async function drawDesign(design, id) {
  const loaded = new Map();
  for (const layer of design.layers) {
    if (layer.kind === "image") loaded.set(layer.source, await picture(sourceUrl(id, layer.source)));
    // Every font is the page's own (@font-face above): one that won't load draws in the fallback, which the look shows.
    else await document.fonts.load(fontOf(layer), layer.text).catch(() => {});
  }
  const canvas = document.createElement("canvas");
  canvas.width = ${WIDTH}; canvas.height = ${HEIGHT};
  const context = canvas.getContext("2d", { willReadFrequently: true });
  drawThumbnail(context, design, { picture: (source) => loaded.get(source) ?? null, canvas: (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; } }, ${WIDTH}, ${HEIGHT});
  return { canvas, context, missing: [...loaded].filter(([, one]) => one === null).map(([source]) => source) };
}
// Pictures side by side (two across, four in two rows), the same area of each blown up, each labelled in its corner.
window.compare = async (panels, id, area) => {
  const drawn = [];
  for (const panel of panels) drawn.push({ ...(await drawDesign(panel.design, id)), label: panel.label });
  const across = drawn.length <= 2 ? drawn.length : 2;
  const down = Math.ceil(drawn.length / across);
  const width = drawn.length <= 2 ? 1000 : 820;
  const height = Math.round(Math.min(width * (area.height / area.width), 900));
  const gap = 12;
  const out = document.createElement("canvas");
  out.width = across * width + (across - 1) * gap; out.height = down * height + (down - 1) * gap;
  const context = out.getContext("2d");
  context.fillStyle = "#000"; context.fillRect(0, 0, out.width, out.height);
  drawn.forEach((one, index) => {
    const x = (index % across) * (width + gap);
    const y = Math.floor(index / across) * (height + gap);
    context.imageSmoothingQuality = "high";
    context.drawImage(one.canvas, area.x, area.y, area.width, area.height, x, y, width, height);
    context.font = "bold 20px Helvetica";
    const text = one.label;
    const box = context.measureText(text).width + 20;
    context.fillStyle = "rgba(0,0,0,0.78)"; context.fillRect(x + 10, y + 10, box, 32);
    context.fillStyle = "#fff"; context.textBaseline = "middle"; context.fillText(text, x + 20, y + 27);
  });
  return { data: out.toDataURL("image/png"), missing: drawn.flatMap((one) => one.missing) };
};
window.render = async (design, id, grid, type, marks, area) => {
  const { canvas, context, missing } = await drawDesign(design, id);
  if (grid) {
    context.save();
    context.strokeStyle = "rgba(0,255,255,0.55)"; context.fillStyle = "rgba(0,255,255,0.95)"; context.lineWidth = 1; context.font = "bold 14px Helvetica";
    for (let x = 160; x < ${WIDTH}; x += 160) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, ${HEIGHT}); context.stroke(); context.fillText(String(x), x + 3, 16); }
    for (let y = 120; y < ${HEIGHT}; y += 120) { context.beginPath(); context.moveTo(0, y); context.lineTo(${WIDTH}, y); context.stroke(); context.fillText(String(y), 3, y - 3); }
    context.restore();
  }
  // Comments' pins, numbered, where they were left.
  for (const mark of marks ?? []) {
    context.save();
    context.beginPath(); context.arc(mark.x, mark.y, 17, 0, Math.PI * 2);
    context.fillStyle = "#ffd60a"; context.fill();
    context.lineWidth = 3; context.strokeStyle = "#000"; context.stroke();
    context.fillStyle = "#000"; context.font = "bold 17px Helvetica"; context.textAlign = "center"; context.textBaseline = "middle";
    context.fillText(String(mark.n), mark.x, mark.y + 1);
    context.restore();
  }
  let out = canvas;
  // One area of it, as big as the whole (a comment's surroundings, for a close look).
  if (area) {
    out = document.createElement("canvas");
    out.width = ${WIDTH}; out.height = ${HEIGHT};
    out.getContext("2d").drawImage(canvas, area.x, area.y, area.width, area.height, 0, 0, ${WIDTH}, ${HEIGHT});
  }
  return { data: out.toDataURL(type, 0.9), missing };
};
window.ready = true;
</script></body></html>`;
}

type Browser = { child: ReturnType<typeof Bun.spawn>; socket: WebSocket; profile: string; call: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>; origin: string; closed: boolean };

let browser: Promise<Browser> | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** The profiles' folder name: each Chrome drawing thumbnails runs in one of its own under the temp folder. */
const PROFILE = "edit-thumbnail-";
let swept = false;

/**
 * Chromes an Edit before this one left drawing (a restart that couldn't say
 * goodbye: a crash, `bun --watch`, an update's exec): whatever runs on a
 * thumbnail profile with nobody left to answer to is closed, its profile gone.
 */
function sweepOrphans(): void {
  if (swept) return;
  swept = true;
  try {
    const listed = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="]).stdout.toString();
    for (const line of listed.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match === null || match[2] !== "1" || !match[3]!.includes(`--user-data-dir=${join(os.tmpdir(), PROFILE)}`)) continue;
      process.kill(Number(match[1]));
      const dir = /--user-data-dir=(\S+)/.exec(match[3]!)?.[1];
      if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
      diag.info("thumbnails", `closed a drawing Chrome an earlier Edit left running (pid ${match[1]})`);
    }
  } catch (error) {
    diag.warn("thumbnails", `looking for Chromes left running: ${diag.messageOf(error)}`);
  }
}

/** The Chromes this Edit started and hasn't closed: leaving closes them (an exit handler can't wait on a promise). */
const started = new Set<Browser["child"]>();
process.on("exit", () => {
  for (const child of started) child.kill();
});

async function launch(origin: string): Promise<Browser> {
  const binary = seams.broll.chrome();
  if (binary === null) throw new Error("Drawing a thumbnail needs Chrome installed.");
  sweepOrphans();
  const profile = fs.mkdtempSync(join(os.tmpdir(), PROFILE));
  const child = Bun.spawn([binary, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio", "--hide-scrollbars", "--window-size=1400,900", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  started.add(child);
  void child.exited.then(() => started.delete(child));
  try {
    return await connect(child, profile, origin);
  } catch (error) {
    // A Chrome that never got as far as drawing goes, with its profile: none is left running.
    child.kill();
    fs.rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

async function connect(child: Browser["child"], profile: string, origin: string): Promise<Browser> {
  const port = await devToolsPort(profile);
  if (port === null) throw new Error("Chrome didn't start for the thumbnail.");
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
  // Its own: an older Chrome closing never forgets the one that replaced it.
  const self = { closed: false };
  socket.onclose = () => {
    self.closed = true;
    for (const one of pending.values()) one.reject(new Error("Chrome closed"));
    pending.clear();
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
  return Object.assign(self, { child, socket, profile, call, origin });
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
    // A Chrome that never started: its error went to the drawing that waited on it.
    .catch(() => {});
}

/**
 * The design drawn as a PNG (or JPEG): a grid every 160 px across and 120 down
 * when asked, for placing things by eye; comments' numbered pins when given;
 * one area of it blown up to the whole size when asked. Missing pictures are
 * named.
 */
export function draw(origin: string, id: string, design: Design, options: { grid?: boolean; type?: "image/png" | "image/jpeg"; marks?: { x: number; y: number; n: number }[]; area?: Area } = {}): Promise<{ bytes: Uint8Array; missing: string[] }> {
  return inChrome(origin, `window.render(${JSON.stringify(design)}, ${JSON.stringify(id)}, ${options.grid === true}, ${JSON.stringify(options.type ?? "image/png")}, ${JSON.stringify(options.marks ?? [])}, ${JSON.stringify(options.area ?? null)})`);
}

export type Area = { x: number; y: number; width: number; height: number };

/**
 * Layouts side by side as one PNG, the same area of each (canvas px) blown up
 * and labelled: an edit checked against what it had to keep (Sphe, Nov 4:
 * "let me have these images side by side… compare what went wrong with the
 * eyes").
 */
export function compare(origin: string, id: string, panels: { design: Design; label: string }[], area: Area): Promise<{ bytes: Uint8Array; missing: string[] }> {
  return inChrome(origin, `window.compare(${JSON.stringify(panels)}, ${JSON.stringify(id)}, ${JSON.stringify(area)})`);
}

/** One drawing on the page in the Chrome kept open (started again once if it went away): its PNG and the pictures it lacked. */
function inChrome(origin: string, expression: string): Promise<{ bytes: Uint8Array; missing: string[] }> {
  const work = queue.then(async () => {
    if (idle !== null) clearTimeout(idle);
    for (let attempt = 0; ; attempt++) {
      // One that didn't start is started again here; a second failure is this drawing's error.
      const warm = browser === null ? null : await browser.catch(() => null);
      if (warm === null || warm.closed || warm.origin !== origin) {
        close();
        browser = launch(origin);
      }
      try {
        const open = await browser!;
        const started = Date.now();
        const answer = await open.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
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
  // The line only orders the drawings: each one's error goes to its own caller.
  queue = work.catch(() => {});
  void work.finally(() => {
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(close, 5 * 60_000);
    idle.unref?.();
  });
  return work;
}
