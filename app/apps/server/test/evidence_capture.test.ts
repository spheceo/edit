import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { DRAWN, pickCapture, UNWALL, waybackOpen } from "../src/evidence_capture.ts";
import { scratch } from "./helpers/home.ts";

test("a Wayback link that leaves the date open stands for a real capture of the page, never a parked one", () => {
  expect(waybackOpen("https://web.archive.org/web/*/youtube.com/@Ryu-Kuriyama")).toBe("youtube.com/@Ryu-Kuriyama");
  expect(waybackOpen("https://web.archive.org/web/2015*/beginmodeling.com")).toBe("beginmodeling.com");
  expect(waybackOpen("https://web.archive.org/web/20150704004423/http://sandiego.craigslist.org/")).toBeNull();
  expect(waybackOpen("https://laist.com/news/x")).toBeNull();
  // beginmodeling.com: the site in 2015, a parked domain since.
  const rows = [
    ["timestamp", "original", "length"],
    ["20150301000000", "http://beginmodeling.com/", "7400"],
    ["20160301000000", "http://beginmodeling.com/", "7100"],
    ["20250804091911", "http://beginmodeling.com/", "541"],
  ];
  expect(pickCapture(rows)).toBe("https://web.archive.org/web/20160301000000/http://beginmodeling.com/");
  expect(pickCapture([["timestamp", "original", "length"]])).toBeNull();
});

const chrome = Bun.which("google-chrome") ?? Bun.which("chromium");

test.skipIf(chrome === null)("a sign-in gate drawn in a shadow root is taken off, and the blur it leaves on the article", async () => {
  // LAist (Nov 8): "Want to read more? … just log in" in an open shadow root over the article body, the article blurred.
  const { dir, cleanup } = scratch("unwall");
  try {
    const page = `${dir}/page.html`;
    fs.writeFileSync(page, `<html><body><div id="body" style="position:relative;filter:blur(6px)"><p id="p">threats he made at industry gatherings</p>
<div id="gate" style="position:absolute;top:0;left:0;width:600px;height:300px;z-index:10"></div></div>
<script>const root=document.getElementById('gate').attachShadow({mode:'open'});root.innerHTML='<style>'+'.x{color:red}'.repeat(400)+'</style><h2>Want to read more?</h2><p>Our stories are always free, just log in to read them.</p><button>Continue with Google</button>';</script></body></html>`);
    const check = `${dir}/check.js`;
    fs.writeFileSync(check, `setTimeout(()=>{const removed=${UNWALL};document.title=JSON.stringify({removed,gate:!!document.getElementById('gate'),filter:getComputedStyle(document.getElementById('body')).filter});},200);`);
    fs.appendFileSync(page, `<script src="check.js"></script>`);
    const run = Bun.spawnSync([chrome!, "--headless=new", "--no-first-run", `--user-data-dir=${dir}/profile`, "--virtual-time-budget=3000", "--dump-dom", `file://${page}`]);
    const title = /<title>(.*?)<\/title>/s.exec(run.stdout.toString())?.[1] ?? "";
    const seen = JSON.parse(title.replaceAll("&quot;", '"')) as { removed: number; gate: boolean; filter: string };
    expect(seen.gate).toBe(false);
    expect(seen.removed).toBeGreaterThan(0);
    expect(seen.filter).toBe("none");
  } finally {
    cleanup();
  }
}, 30_000);

/** Runs `expression` in headless Chrome over `html` and gives back what it returns (as the page title). */
function inChrome(dir: string, html: string, expression: string): string {
  fs.writeFileSync(`${dir}/check.js`, `setTimeout(()=>{document.title=JSON.stringify(${expression});},200);`);
  fs.writeFileSync(`${dir}/page.html`, `${html}<script src="check.js"></script>`);
  const run = Bun.spawnSync([chrome!, "--headless=new", "--no-first-run", `--user-data-dir=${dir}/profile`, "--virtual-time-budget=3000", "--dump-dom", `file://${dir}/page.html`]);
  return JSON.parse((/<title>(.*?)<\/title>/s.exec(run.stdout.toString())?.[1] ?? '""').replaceAll("&quot;", '"')) as string;
}

test.skipIf(chrome === null)("a page that draws nothing is told from one that draws words", () => {
  // An archived YouTube channel (Nov 8): the archive's bar, a hidden shell with text, its scripts, nothing on screen.
  const { dir, cleanup } = scratch("drawn");
  try {
    const blank = `<html><body><div id="wm-ipp-base">Wayback Machine 5 captures 06 Jan 2026 - 02 May 2026</div><div id="content" style="display:none">Before you continue to YouTube we use cookies and data</div><script>var x = "lots of script text";</script></body></html>`;
    expect(inChrome(dir, blank, DRAWN)).toBe("");
    const words = `<html><body><p>In porn industry parlance, he was a mope, a low-ranking male performer.</p></body></html>`;
    expect(inChrome(dir, words, DRAWN).length).toBeGreaterThanOrEqual(20);
  } finally {
    cleanup();
  }
}, 30_000);
