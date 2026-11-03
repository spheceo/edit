// Smooth playback in a real page (headless Chrome over its debugging
// protocol, `window.__edit`): how soon the render shows at a position, and
// how it plays. `bun scripts/preview-check.ts <project id> [frame ...]`; the
// dev UI at PREVIEW_UI (https://localhost:5173), its server at PREVIEW_API.
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.PREVIEW_UI ?? "https://localhost:5173";
const API = process.env.PREVIEW_API ?? "http://localhost:7700";
const OUT = process.env.OUT ?? "/tmp/preview-check";
const PORT = 9341;
const [id, ...asked] = process.argv.slice(2);
if (id === undefined) throw new Error("bun scripts/preview-check.ts <project id> [frame ...]");
const frames = asked.length > 0 ? asked.map(Number) : [0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Bun.$`mkdir -p ${OUT}`;
const chrome = Bun.spawn([CHROME, "--headless=new", `--remote-debugging-port=${PORT}`, "--ignore-certificate-errors", "--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required", `--user-data-dir=${OUT}/profile`, "--window-size=1600,1000", "about:blank"], { stdout: "ignore", stderr: "ignore" });
try {
  let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
  for (let tries = 0; tries < 60 && targets.length === 0; tries++) {
    await sleep(500);
    targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((answer) => answer.json() as Promise<typeof targets>, () => []);
  }
  const page = targets.find((t) => t.type === "page")!;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let next = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id !== undefined) pending.get(m.id)?.(m);
  };
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve) => { const n = ++next; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  const js = async (expression: string) => {
    const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (answer.result?.exceptionDetails) throw new Error(`${expression.slice(0, 60)}: ${JSON.stringify(answer.result.exceptionDetails).slice(0, 300)}`);
    return answer.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  const status = async () => (await (await fetch(`${API}/api/projects/${id}/playback`, { headers: { host: "localhost:7700" } })).json()) as { state: string; rev: number | null; progress: number; stream?: boolean };
  const opened = performance.now();
  await send("Page.navigate", { url: `${BASE}/p/${id}` });
  for (let tries = 0; tries < 120 && !(await js("Boolean(window.__edit?.preview)")); tries++) await sleep(500);
  const state = () => js(`(() => { const v = document.querySelector("video"); const b = v?.buffered; const ranges = []; for (let i = 0; b && i < b.length; i++) ranges.push([+b.start(i).toFixed(1), +b.end(i).toFixed(1)]); return { shown: window.__edit.preview.smoothShown, frame: Math.round(window.__edit.playhead.frame), src: (v?.getAttribute("src") ?? "").slice(0, 20), buffered: ranges, paused: v?.paused ?? null }; })()`);
  for (const frame of frames) {
    await js(`window.__edit.preview.seek(${frame})`);
    const asked = performance.now();
    let shownAfter: number | null = null;
    for (let tries = 0; tries < 600; tries++) {
      const now = await state();
      if (now.shown) { shownAfter = performance.now() - asked; break; }
      await sleep(250);
    }
    const before = await state();
    await js("window.__edit.preview.play()");
    await sleep(5000);
    const after = await state();
    await js("window.__edit.preview.pause()");
    console.log(JSON.stringify({ frame, render: await status(), sinceOpen_s: +((asked - opened) / 1000).toFixed(1), shownAfter_s: shownAfter === null ? null : +(shownAfter / 1000).toFixed(2), playedFrames5s: after.frame - before.frame, smoothWhilePlaying: after.shown, buffered: after.buffered, src: after.src }));
  }
  const { result } = await send("Page.captureScreenshot", { format: "png" });
  await Bun.write(`${OUT}/last.png`, Buffer.from(result.data, "base64"));
} finally {
  chrome.kill();
}
