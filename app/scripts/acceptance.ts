// Acceptance on a real Mac (Nov 8 audit, item I): what the team does first in
// Edit, done by a script against a fresh server, before anything ships.
//
//   bun scripts/acceptance.ts               the page: Check's Mac leg runs it
//   bun scripts/acceptance.ts --native <edit-window>
//                                           Edit.app's own player (a Mac with a screen)
//
// Both start the server as package-app.sh's smoke start does (`--version`,
// then `serve` until /api/health answers) with a home of its own, signed out
// and pointed at no relay (nothing reaches dev's or prod's cloud), make
// scripts/acceptance/fixture.json's footage with FFmpeg's own test sources,
// import it and lay out its cuts, title and sound through the server's MCP
// tools (as the agent does), then:
//
// - the page: headless Chrome opens the editor (window.__edit.preview, as
//   docs/preview.md measures) and asserts the first frame within 3 s, no
//   decode error, a 3 s play with videoMisses at most 5 and no audio
//   underrun, a scrub of 60 positions showing over half of them, full screen
//   in and out with the picture still drawn after; then scripts/home-audit.ts
//   at two widths against the same server.
// - native: Edit.app's window helper opens the project with
//   EDIT_PREVIEW_CHECK=0 EDIT_PREVIEW_TRACE=1 (crates/edit-window/src/preview.rs
//   seeks, scrubs and plays by itself) and fails on a frame drawn in over
//   100 ms, a refused project or the page drawing instead of the player.
//
// What can't run here (no WebGPU in this Chrome, no sound device) is skipped
// and said in the summary, never failed; on GitHub's hosted Mac a timing past
// its mark is reported, not failed (HOSTED). The summary goes to stdout and to
// GITHUB_STEP_SUMMARY when set. EDIT_BIN runs a built `edit` instead of this
// checkout's server; OUT keeps the logs and screenshots (/tmp/edit-acceptance).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const OUT = process.env.OUT ?? join(tmpdir(), "edit-acceptance");
const PORT = Number(process.env.ACCEPT_PORT ?? 7796);
const API = `http://127.0.0.1:${PORT}`;
const CDP_PORT = 9343;
const args = process.argv.slice(2);
const nativeAt = args.indexOf("--native");
const NATIVE = nativeAt >= 0 ? args[nativeAt + 1] ?? "" : null;
if (NATIVE === "") throw new Error("--native needs the edit-window binary");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(OUT, { recursive: true });

// ---- What happened ----

type Verdict = "pass" | "fail" | "skip" | "warn";
/**
 * GitHub's hosted Mac is a virtual one: no hardware decoding, a shared CPU,
 * so its timings say little about a real Mac's (Nov 8: first frame 10 s, 6
 * of 60 scrubbed positions). There, a timing over its mark is reported, not
 * failed; what's broken (nothing drawn, playback stuck, an error) still
 * fails. A real Mac (the native job, a run by hand) holds every mark.
 */
const HOSTED = process.env.RUNNER_ENVIRONMENT === "github-hosted";
const results: { name: string; verdict: Verdict; detail: string }[] = [];
function record(name: string, verdict: Verdict, detail: string): void {
  results.push({ name, verdict, detail });
  console.log(`${{ pass: "✓", fail: "✗", skip: "–", warn: "!" }[verdict]} ${name}: ${detail}`);
}
/** What a hosted Mac's software decoding can't keep up with: failed on a real Mac, skipped with why on a hosted one. */
const slowHere = (name: string, ok: boolean, detail: string) => record(name, ok ? "pass" : HOSTED ? "skip" : "fail", ok || !HOSTED ? detail : `${detail}; skipped on GitHub's virtual Mac (software decoding falls behind a seek every 33 ms; Nov 8: stuck 91 frames short)`);
/** A timing against its mark: failed on a real Mac, reported on a hosted one. */
const timing = (name: string, ok: boolean, detail: string) => record(name, ok ? "pass" : HOSTED ? "warn" : "fail", ok || !HOSTED ? detail : `${detail}; not enforced on GitHub's virtual Mac`);
const check = (name: string, ok: boolean, detail: string) => record(name, ok ? "pass" : "fail", detail);
let extra: string[] = [];

function summary(): void {
  const icon = { pass: "✅", fail: "❌", skip: "⏭️", warn: "⚠️" };
  if (HOSTED && results.some((one) => one.verdict === "warn")) extra.push("", "⚠️ Timings over their marks are reported, not failed, on GitHub's virtual Mac (no hardware decoding); a real Mac holds them.");
  const lines = [
    `### Acceptance (${NATIVE === null ? "the page, headless Chrome" : "Edit.app's native player"}) on ${process.platform === "darwin" ? "macOS" : process.platform}`,
    "",
    "| | Check | Result |",
    "|---|---|---|",
    ...results.map((one) => `| ${icon[one.verdict]} | ${one.name} | ${one.detail.replace(/\|/g, "\\|")} |`),
    ...(extra.length > 0 ? ["", ...extra] : []),
    "",
  ];
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, lines.join("\n"));
}

// ---- The server, as package-app.sh's smoke start ----

const home = mkdtempSync(join(tmpdir(), "edit-acceptance-home-"));
const serverCommand = process.env.EDIT_BIN ? [process.env.EDIT_BIN] : ["bun", join(APP, "apps/server/src/main.ts")];
const serverEnv: Record<string, string | undefined> = {
  ...process.env,
  EDIT_KEYCHAIN_FILE: join(home, "keychain.json"),
  EDIT_NO_BROWSER: "1",
  EDIT_CLAUDE_MAINTENANCE: "0",
  // Signed out, so the cloud is off and the footage stays on this machine;
  // the accounts service and the relay nowhere, so nothing reaches dev's or prod's.
  EDIT_ACCOUNTS_URL: "http://127.0.0.1:9",
  EDIT_RELAY_URL: "http://127.0.0.1:9",
};
delete serverEnv.EDIT_RELAY_TOKEN;
/** What this run started, stopped at its end. */
const running: { server?: ReturnType<typeof Bun.spawn>; chrome?: ReturnType<typeof Bun.spawn>; window?: ReturnType<typeof Bun.spawn> } = {};

async function startServer(): Promise<boolean> {
  const version = Bun.spawn([...serverCommand, "--version"], { env: serverEnv, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => version.kill(), 30_000);
  const said = (await new Response(version.stdout).text()).trim();
  clearTimeout(timer);
  if ((await version.exited) !== 0) {
    check("edit --version", false, `didn't answer within 30 s: ${(await new Response(version.stderr).text()).slice(-300)}`);
    return false;
  }
  check("edit --version", true, said);
  const log = Bun.file(join(OUT, "server.log")).writer();
  const server = (running.server = Bun.spawn([...serverCommand, "serve", "--home", home, "--port", String(PORT)], { env: serverEnv, stdout: "pipe", stderr: "pipe" }));
  for (const stream of [server.stdout, server.stderr] as ReadableStream<Uint8Array>[]) {
    void (async () => {
      for await (const chunk of stream) log.write(chunk);
      void log.flush();
    })();
  }
  const started = performance.now();
  while (performance.now() - started < 60_000) {
    const health = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2000) }).then((answer) => answer.text(), () => "");
    if (health.includes('"name":"edit"')) {
      check("edit serve answers /api/health", true, `in ${((performance.now() - started) / 1000).toFixed(1)} s`);
      return true;
    }
    await sleep(500);
  }
  check("edit serve answers /api/health", false, "not within 60 s (server.log)");
  return false;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const answer = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await answer.text();
  if (!answer.ok) throw new Error(`${method} ${path}: ${answer.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

let calls = 0;
async function tool(name: string, args: Record<string, unknown>): Promise<string> {
  const answer = await api<{ result?: { content: { text?: string }[]; isError: boolean }; error?: { message: string } }>("POST", "/mcp", { jsonrpc: "2.0", id: ++calls, method: "tools/call", params: { name, arguments: args } });
  const said = answer.result?.content.map((part) => part.text ?? "").join(" ") ?? answer.error?.message ?? "";
  if (answer.result?.isError !== false) throw new Error(`${name}: ${said}`);
  return said;
}

// ---- The fixture ----

interface Fixture {
  name: string;
  settings: { width: number; height: number; fps: number };
  footage: { file: string; video?: string; audio?: string; seconds: number }[];
  clips: { type: "video" | "audio"; file: string; start: number; duration: number; source_in: number; volume_db?: number }[];
  title: { text: string; start: number; duration: number };
}
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "acceptance/fixture.json"), "utf8")) as Fixture;
const frames = (seconds: number) => Math.round(seconds * fixture.settings.fps);
const lastFrame = Math.max(...fixture.clips.map((clip) => frames(clip.start + clip.duration))) - 1;

async function makeProject(): Promise<string | null> {
  const footage = join(home, "footage");
  mkdirSync(footage, { recursive: true });
  const ffmpeg = process.env.EDIT_FFMPEG ?? "ffmpeg";
  for (const one of fixture.footage) {
    const inputs = [...(one.video ? ["-f", "lavfi", "-i", one.video] : []), ...(one.audio ? ["-f", "lavfi", "-i", one.audio] : [])];
    const codecs = [...(one.video ? ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "15"] : []), ...(one.audio ? ["-c:a", "aac", "-ac", "2"] : [])];
    const made = Bun.spawnSync([ffmpeg, "-v", "error", "-y", ...inputs, "-t", String(one.seconds), ...codecs, join(footage, one.file)]);
    if (made.exitCode !== 0) {
      check("fixture footage", false, `${one.file}: ${made.stderr.toString().slice(-300)}`);
      return null;
    }
  }
  const created = await api<{ project: { id: string } }>("POST", "/api/projects", { name: fixture.name, ...fixture.settings });
  const id = created.project.id;
  await api("POST", `/api/projects/${id}/import`, { paths: fixture.footage.map((one) => join(footage, one.file)) });
  // Ready when every preview is made (a real import's wait).
  const started = performance.now();
  let pending = "";
  while (performance.now() - started < 120_000) {
    const status = await api<{ media: Record<string, { proxy: string; peaks: string; thumbs: string; error?: string }> }>("GET", `/api/projects/${id}/media-status`);
    const all = Object.values(status.media);
    const failed = all.find((one) => one.proxy === "failed");
    if (failed !== undefined) {
      check("import", false, `a preview failed: ${failed.error ?? "no reason given"}`);
      return null;
    }
    pending = all.filter((one) => one.proxy !== "ready" && one.proxy !== "skipped").length.toString();
    if (all.length === fixture.footage.length && pending === "0") break;
    await sleep(500);
  }
  if (pending !== "0") {
    check("import", false, `${pending} previews not made within 120 s`);
    return null;
  }
  check("import", true, `${fixture.footage.length} files, previews made in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  const project = await api<{ project: { media: { id: string; path: string }[] } }>("GET", `/api/projects/${id}`);
  const mediaOf = (file: string) => project.project.media.find((one) => one.path.endsWith(`/${file}`))!.id;
  for (const clip of fixture.clips) {
    const { file, ...rest } = clip;
    await tool("add_clip", { project_id: id, clip: { ...rest, media: mediaOf(file), start: frames(clip.start), duration: frames(clip.duration) } });
  }
  await tool("add_text", { project_id: id, text: fixture.title.text, start: fixture.title.start, duration: fixture.title.duration });
  check("fixture project", true, `${fixture.clips.length} clips (two cuts), a title, ${lastFrame + 1} frames`);
  return id;
}

// ---- Headless Chrome ----

function chromePath(): string | null {
  const candidates = [process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((path) => path !== undefined && existsSync(path)) ?? null;
}

interface Page {
  /** When the editor was asked for (performance.now()). */
  navigated: number;
  js: (expression: string, gesture?: boolean) => Promise<any>;
  send: (method: string, params?: Record<string, unknown>) => Promise<any>;
  errors: string[];
}

async function openPage(path: string): Promise<Page> {
  running.chrome = Bun.spawn([chromePath()!, "--headless=new", `--remote-debugging-port=${CDP_PORT}`, "--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required", `--user-data-dir=${OUT}/profile`, "--window-size=1600,1000", "about:blank"], { stdout: "ignore", stderr: "ignore" });
  let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
  for (let tries = 0; tries < 60 && targets.length === 0; tries++) {
    await sleep(500);
    targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((answer) => answer.json() as Promise<typeof targets>, () => []);
  }
  const target = targets.find((one) => one.type === "page");
  if (target === undefined) throw new Error("Chrome didn't open a page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let next = 0;
  const pending = new Map<number, (value: any) => void>();
  const errors: string[] = [];
  let onPaused: ((params: { requestId: string }) => Promise<void>) | null = null;
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) pending.get(message.id)?.(message);
    if (message.method === "Fetch.requestPaused") void onPaused?.(message.params);
    if (message.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text).slice(0, 300));
  };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const js = async (expression: string, gesture = false) => {
    const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: gesture });
    if (answer.result?.exceptionDetails) throw new Error(`${expression.slice(0, 60)}: ${JSON.stringify(answer.result.exceptionDetails).slice(0, 300)}`);
    return answer.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  // The page is told sign-in isn't needed (the server is signed out, so it would ask): only /api/account's answer changes.
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/account", requestStage: "Response" }] });
  const page = { js, send, errors, navigated: 0 };
  onPaused = async (params) => {
    const { body, base64Encoded } = await send("Fetch.getResponseBody", { requestId: params.requestId }).then((answer) => answer.result);
    const account = JSON.parse(base64Encoded ? Buffer.from(body, "base64").toString() : body);
    account.required = false;
    await send("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(account)).toString("base64") });
  };
  page.navigated = performance.now();
  await send("Page.navigate", { url: `${API}${path}` });
  return page;
}

const shot = async (page: Page, name: string) => {
  const { result } = await page.send("Page.captureScreenshot", { format: "png" });
  if (result?.data) writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, "base64"));
};

async function pageChecks(id: string): Promise<void> {
  if (chromePath() === null) {
    record("the page's player", "skip", "no Chrome on this machine");
    return;
  }
  const page = await openPage(`/p/${id}`);
  const opened = page.navigated;
  for (let tries = 0; tries < 120 && !(await page.js("Boolean(window.__edit?.preview)")); tries++) await sleep(100);
  const gpu = await page.js("navigator.gpu ? navigator.gpu.requestAdapter().then((a) => a !== null, () => false) : false");
  const P = "window.__edit.preview";
  // First frame: from opening the editor to the viewer's first drawn picture.
  let first: number | null = null;
  for (let tries = 0; tries < 600; tries++) {
    const state = await page.js(`({ frame: ${P}.diagnostics.renderedFrame, error: ${P}.error })`);
    if (state.error) break;
    if (state.frame !== null && state.frame !== undefined) {
      first = performance.now() - opened;
      break;
    }
    await sleep(50);
  }
  // Every error the viewer shows on the way, not only the last (a new source clears it).
  const seen: string[] = [];
  const noteError = async () => {
    const now = await page.js(`${P}.error`);
    if (now && !seen.includes(now)) seen.push(now);
  };
  await page.js(`(() => { const p = ${P}; window.__acceptanceErrors = []; setInterval(() => { if (p.error && !window.__acceptanceErrors.includes(p.error)) window.__acceptanceErrors.push(p.error); }, 50); })()`);
  await noteError();
  const error = await page.js(`${P}.error`);
  if (first === null && !gpu) {
    record("the page's player", "skip", `no WebGPU adapter in this headless Chrome, so the viewer can't draw${error ? ` (${error})` : ""}`);
    await shot(page, "no-gpu");
    return;
  }
  if (first === null) check("first frame", false, `none in 30 s${error ? `: ${error}` : ""}`);
  else timing("first frame", first < 3000, `${(first / 1000).toFixed(2)} s after opening (under 3 s)`);
  // Play 3 s from the start, across the first cut.
  await page.js(`${P}.seek(0)`);
  await sleep(800);
  const before = await page.js(`(() => ({ ...${P}.diagnostics, at: window.__edit.playhead.frame }))()`);
  await page.js(`${P}.play()`, true);
  await sleep(3000);
  const after = await page.js(`(() => ({ ...${P}.diagnostics, at: window.__edit.playhead.frame }))()`);
  await page.js(`${P}.pause()`);
  const misses = after.videoMisses - before.videoMisses;
  const underruns = after.audioUnderruns - before.audioUnderruns;
  const played = Math.round(after.at - before.at);
  if (played <= 0) check("play 3 s", false, "the playhead didn't move");
  else timing("play 3 s", played >= frames(2.5), `${played} frames advanced (${frames(3)} asked)`);
  timing("video misses while playing", misses <= 5, `${misses} (at most 5)`);
  if (after.audioOutput?.state !== "running") record("audio underruns", "skip", `the page's sound never started here (AudioContext ${after.audioOutput?.state ?? "missing"}): no sound device`);
  else check("audio underruns", underruns === 0, `${underruns}`);
  // Scrub: 60 positions across the edit, one every 33 ms, as a drag; which were drawn.
  const scrub = await page.js(
    `new Promise((done) => { const p = ${P}; const wanted = Array.from({ length: 60 }, (_, i) => Math.round(i * ${lastFrame} / 59)); const seen = new Set(); let i = 0; let live = true;
      const watch = () => { seen.add(p.diagnostics.renderedFrame); if (live) requestAnimationFrame(watch); }; requestAnimationFrame(watch);
      const end = Date.now() + 10000; const settle = () => { if (p.diagnostics.renderedFrame === wanted.at(-1) || Date.now() > end) { live = false; done({ shown: wanted.filter((f) => seen.has(f)).length, last: p.diagnostics.renderedFrame, wanted: wanted.at(-1) }); } else setTimeout(settle, 50); };
      const step = () => { if (i < wanted.length) { p.seek(wanted[i++]); setTimeout(step, 33); } else settle(); };
      step(); })`,
  );
  slowHere("scrub settles where it stopped", scrub.last === scrub.wanted, `frame ${scrub.last} drawn (${scrub.wanted} asked, within 10 s)`);
  timing("scrub coverage", scrub.shown > 30, `${scrub.shown} of 60 positions drawn (over 30)`);
  // Full screen (F) and back; the picture is still drawn after.
  const key = async () => {
    for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "f", code: "KeyF", text: type === "keyDown" ? "f" : undefined, windowsVirtualKeyCode: 70 });
    await sleep(600);
  };
  await page.js("document.activeElement?.blur?.(), true");
  await key();
  const full = await page.js("document.fullscreenElement !== null");
  await shot(page, "full-screen");
  await key();
  const back = await page.js("document.fullscreenElement === null");
  await page.js(`${P}.seek(${frames(4)})`);
  let drawn = null;
  for (let tries = 0; tries < 200 && drawn !== frames(4); tries++) {
    await sleep(50);
    drawn = await page.js(`${P}.diagnostics.renderedFrame`);
  }
  if (!full) record("full screen", drawn === frames(4) || HOSTED ? "skip" : "fail", `F didn't enter full screen in headless Chrome; the picture ${drawn === frames(4) ? "still draws" : `stopped drawing (${drawn})`}`);
  else if (!back) check("full screen", false, "it didn't come out of full screen");
  else slowHere("full screen", drawn === frames(4), `in and out, frame ${drawn} drawn after (${frames(4)} asked, within 10 s)`);
  await noteError();
  for (const one of (await page.js("window.__acceptanceErrors")) as string[]) if (!seen.includes(one)) seen.push(one);
  const said = [...seen, ...page.errors];
  check("no decode error", said.length === 0, said.length === 0 ? "none" : said.slice(0, 3).join("; "));
  extra.push("<details><summary>The preview's diagnostics after the run</summary>", "", "```json", JSON.stringify(await page.js(`${P}.diagnostics`), null, 2), "```", "</details>");
  await shot(page, "editor");
}

async function homeAudit(): Promise<void> {
  if (chromePath() === null) {
    record("Home's layout", "skip", "no Chrome on this machine");
    return;
  }
  const audit = Bun.spawn(["bun", join(APP, "scripts/home-audit.ts")], {
    env: { ...process.env, HOME_UI: API, HOME_API: API, HOME_WIDTHS: "1440,960", HOME_SIGN_IN: "skip", CHROME: chromePath()!, OUT: join(OUT, "home") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => audit.kill(), 180_000);
  const said = await new Response(audit.stdout).text();
  clearTimeout(timer);
  const code = await audit.exited;
  writeFileSync(join(OUT, "home-audit.log"), said + (await new Response(audit.stderr).text()));
  const problems = said.split("\n").filter((line) => line.startsWith("✗") || line.startsWith("FAIL"));
  check("Home's layout at 1440 and 960 px", code === 0, code === 0 ? (said.match(/checked \d+ layouts/)?.[0] ?? "no problems") : problems.slice(0, 4).join("; ") || `exit ${code}`);
}

// ---- Edit.app's own player ----

async function nativeChecks(id: string, helper: string): Promise<void> {
  if (process.platform !== "darwin") {
    record("native player", "skip", "Edit.app's player is the Mac's");
    return;
  }
  const trace = join(OUT, "window.log");
  const window = (running.window = Bun.spawn([helper, "--url", `${API}/p/${id}`], {
    env: { ...process.env, EDIT_PREVIEW_CHECK: "0", EDIT_PREVIEW_TRACE: "1", EDIT_PREVIEW_SHOT: join(OUT, "native.png") },
    stdin: "pipe",
    stdout: "ignore",
    stderr: Bun.file(trace),
  }));
  // The check waits 20 s for the page, seeks, scrubs, plays 10 s: about 50 s.
  const started = performance.now();
  while (performance.now() - started < 120_000 && !(existsSync(trace) && readFileSync(trace, "utf8").includes("check: done"))) await sleep(1000);
  const said = existsSync(trace) ? readFileSync(trace, "utf8") : "";
  void window.stdin.end();
  if (!said.includes("check: done")) {
    check("native check ran", false, "the window's check didn't finish in 120 s (window.log)");
    return;
  }
  const draws = [...said.matchAll(/frame (-?\d+) in ([\d.]+) ms: (.*)/g)].map((m) => ({ frame: Number(m[1]), ms: Number(m[2]), ok: m[3]!.startsWith("Ok") }));
  const times = draws.map((one) => one.ms).sort((a, b) => a - b);
  const at = (q: number) => (times.length === 0 ? 0 : times[Math.min(times.length - 1, Math.floor(q * times.length))]!);
  const slow = draws.filter((one) => one.ms > 100);
  check("native frames drawn", draws.length > 0 && draws.every((one) => one.ok), `${draws.length} draws, ${draws.filter((one) => !one.ok).length} failed`);
  check("no native frame over 100 ms", slow.length === 0, `p50 ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms, worst ${(times.at(-1) ?? 0).toFixed(1)} ms${slow.length ? `; over 100 ms: ${slow.slice(0, 5).map((one) => `frame ${one.frame} ${one.ms} ms`).join(", ")}` : ""}`);
  const log = readFileSync(join(OUT, "server.log"), "utf8");
  const native = /preview check: native=(\w+)/.exec(log)?.[1] ?? "unknown";
  const refused = said.includes("the native preview refused") || said.includes("couldn't open");
  check("no fallback to the page", native === "true" && !refused, `native=${native}${refused ? ", the player refused the project or couldn't open" : ""}`);
  const buckets = [5, 10, 16, 33, 50, 100, Infinity].map((top, i, all) => ({ label: top === Infinity ? `> ${all[i - 1]} ms` : `≤ ${top} ms`, n: times.filter((ms) => ms <= top && (i === 0 || ms > all[i - 1]!)).length }));
  extra.push("Native frame timings:", "", "| Draw time | Frames |", "|---|---|", ...buckets.map((one) => `| ${one.label} | ${one.n} |`));
}

// ---- The run ----

try {
  if (await startServer()) {
    const id = await makeProject().catch((error: unknown) => {
      check("fixture project", false, String(error));
      return null;
    });
    if (id !== null) {
      if (NATIVE !== null) await nativeChecks(id, NATIVE);
      else {
        await pageChecks(id).catch((error: unknown) => check("the page's player", false, String(error)));
        running.chrome?.kill();
        await homeAudit();
      }
    }
  }
} finally {
  running.window?.kill();
  running.chrome?.kill();
  running.server?.kill();
  summary();
}
const failed = results.filter((one) => one.verdict === "fail");
console.log(failed.length === 0 ? `acceptance: passed (${results.filter((one) => one.verdict === "skip").length} skipped)` : `acceptance: ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
