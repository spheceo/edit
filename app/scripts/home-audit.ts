// Home's layout audit (the user, Oct 31: "ensure on this new dashboard we have
// zero ui issues like this"): every place in the sidebar, Mine and Everyone,
// at Edit's window widths (960 px at the least) in headless Chrome against
// `just dev`. Per row: as many cells as the table has columns, one line, no
// cell over the next, nothing outside its cell, a name at least 240 px; the
// sidebar's items, the header and the toolbar; a row's menus and Set aside's
// submenu inside the window and beside each other. A few things are set aside
// first (one coming back after 15 s, so a Back mark is measured too) and one
// marked done, all brought back at the end. Screenshots go to OUT.
//
//   bun scripts/home-audit.ts            (HOME_UI=https://localhost:5173 HOME_API=http://localhost:7700 OUT=/tmp/home-audit)
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.HOME_UI ?? "https://localhost:5173";
const API = process.env.HOME_API ?? "http://localhost:7700";
const OUT = process.env.OUT ?? "/tmp/home-audit";
const PROFILE = `${OUT}/profile`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Bun.$`mkdir -p ${OUT}`;
const chrome = Bun.spawn([CHROME, "--headless=new", "--remote-debugging-port=9339", "--ignore-certificate-errors", `--user-data-dir=${PROFILE}`, "--window-size=1600,1000", "about:blank"], { stdout: "ignore", stderr: "ignore" });
await sleep(4000);
const page = ((await (await fetch("http://127.0.0.1:9339/json")).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === "page")!;
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let next = 0;
const pending = new Map<number, (v: any) => void>();
const pageErrors: string[] = [];
ws.onmessage = (event) => {
  const m = JSON.parse(String(event.data));
  if (m.id !== undefined) pending.get(m.id)?.(m);
  if (m.method === "Runtime.exceptionThrown") pageErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
};
const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve) => { const id = ++next; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable"); await send("Runtime.enable");
const js = async (expression: string) => {
  const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (answer.result?.exceptionDetails) throw new Error(`${expression.slice(0, 60)}: ${JSON.stringify(answer.result.exceptionDetails).slice(0, 300)}`);
  return answer.result?.result?.value;
};
const size = async (width: number) => { await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(400); };
const shot = async (name: string) => { await sleep(300); const { result } = await send("Page.captureScreenshot", { format: "png" }); await Bun.write(`${OUT}/${name}.png`, Buffer.from(result.data, "base64")); };
const post = (body: unknown) => fetch(`${API}/api/later`, { method: "POST", headers: { host: "localhost:7700", "content-type": "application/json" }, body: JSON.stringify(body) });

// Something in Later of each kind, and one Back.
const projects = (await (await fetch(`${API}/api/projects`, { headers: { host: "localhost:7700" } })).json()) as { projects: { id: string; name: string; subtitles?: boolean; created_by?: { sub?: string } | null }[] };
const scripts = (await (await fetch(`${API}/api/writer/scripts`, { headers: { host: "localhost:7700" } })).json()) as { id: string; title: string; createdBy?: { sub?: string } | null }[];
const ideas = (await (await fetch(`${API}/api/ideas`, { headers: { host: "localhost:7700" } })).json()) as { ideas: { id: string; summary: { title: string }; createdBy?: { sub?: string } | null }[] };
// Whatever this Mac has (named projects went with the test data, Nov 2), never one already in Later: bringing it back would clear someone's.
const taken = new Set(((await (await fetch(`${API}/api/later`, { headers: { host: "localhost:7700" } })).json()) as { entries: { key: string }[] }).entries.map((e) => e.key));
const inCloud = ((await (await fetch(`${API}/api/cloud/projects`, { headers: { host: "localhost:7700" } })).json()) as { projects?: { id: string; created_by?: { sub?: string } | null }[] }).projects ?? [];
// Only the signed-in person's own: Later is the team's, and a run once set aside a teammate's project (put back after, Nov 2).
const me = ((await (await fetch(`${API}/api/account`, { headers: { host: "localhost:7700" } })).json()) as { person?: { sub?: string } }).person?.sub ?? "";
const mine = (p: { created_by?: { sub?: string } | null }) => me !== "" && p.created_by?.sub === me;
const edits = [...new Set([...projects.projects, ...inCloud].filter(mine).map((p) => `edit:${p.id}`))].filter((key) => !taken.has(key));
const firstFree = (list: string[], what: string) => { const found = list.find((key) => !taken.has(key)); if (found === undefined) throw new Error(`no ${what} to set aside`); return found; };
if (edits.length < 3) throw new Error("the audit needs three edits not in Later");
const ours = <T extends { createdBy?: { sub?: string } | null }>(list: T[]) => list.filter((one) => me !== "" && one.createdBy?.sub === me);
const keys = [edits[0]!, firstFree(ours(scripts).map((one) => `script:${one.id}`), "script"), ...(ours(ideas.ideas).length > 0 ? [firstFree(ours(ideas.ideas).map((one) => `idea:${one.id}`), "idea")] : [])];
const backKey = edits[1]!;
const doneKey = edits[2]!;
for (const key of keys) console.log("aside", key, (await post({ key })).status);
console.log("done", doneKey, (await post({ key: doneKey, done: true })).status);
console.log("back soon", backKey, (await post({ key: backKey, until: Date.now() + 15_000 })).status);
await sleep(16_000);

const AUDIT = `(() => {
  const problems = [];
  const r = (el) => el.getBoundingClientRect();
  const visible = (el) => getComputedStyle(el).display !== "none" && getComputedStyle(el).position !== "absolute";
  const clips = (el, stop) => { for (let at = el.parentElement; at && at !== stop; at = at.parentElement) { const s = getComputedStyle(at); if (s.overflow !== "visible" || s.overflowX !== "visible") return true; } return false; };
  const label = (el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 50);
  const table = document.querySelector('main [role="table"]');
  if (table) {
    const tracks = getComputedStyle(table).gridTemplateColumns.split(" ").length;
    const nameWidth = parseFloat(getComputedStyle(table).gridTemplateColumns.split(" ")[0]);
    if (nameWidth < 240) problems.push("name column squeezed to " + Math.round(nameWidth) + "px");
    const rows = [...table.querySelectorAll('[role="row"]')];
    for (const row of rows) {
      const cells = [...row.children].filter(visible).filter((c) => !c.classList.contains("contents"));
      const name = label(cells[0] ?? row);
      if (cells.length !== tracks) problems.push("cells " + cells.length + "≠" + tracks + ": " + name);
      const rb = r(row);
      if (rb.height > 72) problems.push("tall row " + Math.round(rb.height) + "px: " + name);
      for (let i = 0; i < cells.length; i++) {
        const cb = r(cells[i]);
        if (cb.top < rb.top - 1 || cb.bottom > rb.bottom + 1) problems.push("cell off its row: " + name + " [" + i + "]");
        if (i + 1 < cells.length && cb.right > r(cells[i + 1]).left + 1) problems.push("cell over the next: " + name + " [" + i + "] " + Math.round(cb.right - r(cells[i + 1]).left) + "px");
        for (const inner of cells[i].querySelectorAll("*")) {
          if (!visible(inner) || clips(inner, cells[i])) continue;
          const ib = r(inner);
          if (ib.width === 0) continue;
          if (ib.left < cb.left - 1 || ib.right > cb.right + 1) { problems.push("spills out of its cell: " + name + " [" + i + "] '" + label(inner) + "' by " + Math.round(Math.max(cb.left - ib.left, ib.right - cb.right)) + "px"); break; }
        }
      }
    }
  }
  for (const item of document.querySelectorAll("aside nav button")) {
    const b = r(item);
    for (const inner of item.querySelectorAll("*")) { const ib = r(inner); if (ib.width && (ib.right > b.right + 1 || ib.left < b.left - 1)) problems.push("sidebar item spills: " + label(item)); }
    const text = item.querySelector("span.truncate");
    if (text && text.scrollWidth > text.clientWidth + 1) problems.push("sidebar label cut: " + label(item));
  }
  const h1 = document.querySelector("main header h1"), buttons = document.querySelector("main header h1 + div");
  if (h1 && buttons && r(h1).right > r(buttons).left + 1) problems.push("header title under its buttons");
  const search = document.querySelector('main input[placeholder^="Search"]')?.closest("label");
  const pills = search?.nextElementSibling;
  if (search && pills && r(search).right > r(pills).left + 1) problems.push("search under the pills");
  if (document.documentElement.scrollWidth > innerWidth + 1) problems.push("page scrolls sideways");
  const island = document.querySelector("main > div.overflow-y-auto");
  if (island && island.scrollWidth > island.clientWidth + 1) problems.push("list scrolls sideways by " + (island.scrollWidth - island.clientWidth) + "px");
  return problems;
})()`;
// The sidebar's places (prototype C, Nov 2), and a place's stages as the steps over its list ("Edits/Editing").
const VIEWS = ["Ideas", "Ideas/Drafts", "Ideas/On the board", "Thumbnails", "Scripts", "Scripts/Importing", "Scripts/Ready to script", "Scripts/Scripting", "Scripts/Ready to edit", "Edits", "Edits/Editing", "Edits/In review", "Edits/Subtitled", "Later", "Done"];
// The sidebar's rows, and the foot's Later and Done card (outside its nav since Nov 2).
const navPlace = (text: string) => js(`(() => { const b = [...document.querySelectorAll("aside button")].find((x) => [...x.querySelectorAll("span")].some((one) => one.textContent.trim() === ${JSON.stringify(text)})); b?.click(); return !!b; })()`);
const navStep = (text: string) => js(`(() => { const b = [...document.querySelectorAll("main button")].find((x) => x.firstChild?.textContent?.trim() === ${JSON.stringify(text)} && !x.disabled); b?.click(); return !!b; })()`);
const nav = async (view: string) => {
  const [place, step] = view.split("/") as [string, string | undefined];
  if (!(await navPlace(place))) return false;
  if (step === undefined) return true;
  await sleep(200);
  return navStep(step);
};
const pill = (text: string) => js(`[...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)})?.click()`);
const setSearch = (text: string) => js(`(() => { const el = document.querySelector('main input[placeholder^="Search"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
let total = 0;
const report = (where: string, problems: string[]) => { const unique = [...new Set(problems)]; total += unique.length; if (unique.length) console.log(`✗ ${where}\n   ` + unique.slice(0, 8).join("\n   ") + (unique.length > 8 ? `\n   … ${unique.length - 8} more` : "")); };
try {
  await size(1600);
  await send("Page.navigate", { url: `${BASE}/` });
  await sleep(5000);
  let checked = 0;
  for (const width of [1600, 1440, 1280, 1100, 960]) {
    await size(width);
    for (const mode of ["Mine", "Everyone"]) {
      await pill(mode);
      await sleep(300);
      for (const view of VIEWS) {
        if (!(await nav(view))) continue;
        await sleep(350);
        report(`${width} ${mode} ${view}`, await js(AUDIT));
        checked++;
        if ((width === 1440 || width === 960) && ["Later", "Ideas", "Scripts", "Edits", "Edits/Subtitled", "Thumbnails", "Done"].includes(view)) await shot(`${width}-${mode}-${view.replace(/[ /]/g, "-")}`);
        if ((width === 1440 || width === 960) && view === "Later") {
          const at = await js(`(() => { const row = document.querySelectorAll('main [role="table"] [role="row"]')[1]; if (!row) return null; const b = row.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
          if (at) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at[0], y: at[1] }); await shot(`${width}-${mode}-Later-hover`); await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }); }
        }
      }
      await setSearch("cop"); await sleep(400);
      report(`${width} ${mode} search`, await js(AUDIT)); checked++;
      await setSearch(""); await sleep(200);
    }
  }
  console.log(`checked ${checked} layouts`);
  // Menus: the ⋯ of a row of each kind, then its Set aside submenu, inside the window and beside each other.
  await size(960);
  await pill("Everyone");
  for (const view of ["Edits/Editing", "Scripts/Ready to edit", "Ideas", "Later", "Edits"]) {
    await nav(view); await sleep(400);
    const count = await js(`document.querySelectorAll('main [role="table"] [role="row"]').length - 1`);
    for (const index of [1, count]) {
      if (index < 1 || index > count) continue; // an empty list has no rows
      await js(`(() => { const row = [...document.querySelectorAll('main [role="table"] [role="row"]')][${index}]; row.scrollIntoView({ block: "center" }); return true; })()`);
      await sleep(250);
      await js(`[...[...document.querySelectorAll('main [role="table"] [role="row"]')][${index}].querySelectorAll("button")].find((b) => b.title === "More")?.click()`);
      await sleep(350);
      const sub = await js(`(() => { const b = [...document.querySelectorAll("[data-menu] button")].find((x) => /^Set aside/.test(x.textContent.trim())); if (!b) return null; b.click(); return true; })()`);
      await sleep(350);
      const problems = await js(`(() => {
        const out = []; const panels = [...document.querySelectorAll("[data-menu]")].map((p) => p.getBoundingClientRect());
        if (!panels.length) out.push("no menu");
        for (const p of panels) if (p.left < 0 || p.top < 0 || p.right > innerWidth || p.bottom > innerHeight) out.push("menu off the window");
        if (panels.length === 2 && panels[0].left < panels[1].right - 1 && panels[1].left < panels[0].right - 1) out.push("submenu over its menu");
        return out; })()`);
      report(`menu ${view} row ${index}${sub ? " + Set aside" : ""}`, problems);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27 });
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27 });
      await sleep(250);
    }
  }
  console.log(total === 0 ? "NO PROBLEMS" : `${total} problems`);
  process.exitCode = total === 0 ? 0 : 1;
} catch (error) {
  console.log("FAIL", (error as Error).message);
} finally {
  // Brought back even across a server restart (the dev server restarts on any saved file): tried for a minute each.
  for (const key of [...keys, backKey, doneKey]) {
    for (let tries = 0; tries < 20; tries++) {
      const answer = await post({ key, back: true }).catch(() => null);
      if (answer?.ok) break;
      await sleep(3000);
    }
  }
  const left = await fetch(`${API}/api/later`, { headers: { host: "localhost:7700" } }).then((r) => r.json() as Promise<{ entries: { key: string }[] }>).catch(() => null);
  console.log("left in Later:", left === null ? "(the server didn't answer)" : JSON.stringify(left.entries.map((e) => e.key)));
  if (pageErrors.length) console.log("page errors:\n" + pageErrors.join("\n"));
  chrome.kill();
  process.exit(process.exitCode ?? 0);
}
