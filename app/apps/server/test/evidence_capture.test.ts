import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { DRAWN, isPdfLink, pdfScript, pickCapture, UNWALL, waybackOpen } from "../src/evidence_capture.ts";
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

test.skipIf(chrome === null)("a sign-in gate in a shadow root whose host sits in the article, 0 pixels high, is taken off too; a shadow with no gate stays", () => {
  // LAist (Nov 9): allegro-content-gate in a static, 0-pixel host inside the article body, its login form drawn over the words.
  const { dir, cleanup } = scratch("unwall-static");
  try {
    const html = `<html><body><div class="ArticlePage-articleBody" style="position:relative"><p>comments about his wish to be an actor</p><div id="host"></div><div id="player"></div></div>
<script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<div><allegro-content-gate class="overlay-active"><h2>Want to read more?</h2><p>Our stories are always free, just log in to read them.</p><input placeholder="Enter your email"><button>SIGN IN</button><button>Continue with Google</button></allegro-content-gate></div>';
document.getElementById('player').attachShadow({mode:'open'}).innerHTML='<video></video><span>Play</span>';</script></body></html>`;
    const seen = inChrome(dir, html, `{removed: ${UNWALL}, host: !!document.getElementById('host'), player: !!document.getElementById('player')}`) as unknown as { removed: number; host: boolean; player: boolean };
    expect(seen).toEqual({ removed: 1, host: false, player: true });
  } finally {
    cleanup();
  }
});

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

/** A one-page PDF with `lines` of text, double-spaced as court papers are. */
function tinyPdf(lines: string[]): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td 24 TL ${lines.map((line) => `(${line}) Tj T*`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

test("a PDF is known by its link", () => {
  expect(isPdfLink("https://www.courthousenews.com/wp-content/uploads/2020/01/GirlsDoPorn-VERDICT.pdf")).toBe(true);
  expect(isPdfLink("https://laist.com/news/x")).toBe(false);
});

test.skipIf(chrome === null || process.env.EDIT_OFFLINE === "1")("a PDF's phrase is found on its page and cropped to its lines with one whole line either side", () => {
  // The Statement of Decision (Nov 8): headless Chrome shows a PDF to no one, so its phrases were never found.
  const { dir, cleanup } = scratch("pdf");
  try {
    const lines = ["The Court finds Plaintiffs have proven the claims.", "Defendants take considerable, calculated steps", "to falsely assure prospective models.", "Their videos will never be posted online.", "A last line."];
    const b64 = Buffer.from(tinyPdf(lines)).toString("base64");
    // The page answers through a promise: run it and put its answer in the title.
    fs.writeFileSync(`${dir}/check.js`, `(${pdfScript(b64, "considerable, calculated steps", null)}).then(v=>{document.title=JSON.stringify(v)},e=>{document.title=JSON.stringify({error:String(e)})});`);
    fs.writeFileSync(`${dir}/page.html`, `<html><body><script src="check.js"></script></body></html>`);
    const run = Bun.spawnSync([chrome!, "--headless=new", "--no-first-run", `--user-data-dir=${dir}/profile2`, "--virtual-time-budget=15000", "--dump-dom", `file://${dir}/page.html`], { timeout: 60_000 });
    const answer = JSON.parse((/<title>(.*?)<\/title>/s.exec(run.stdout.toString())?.[1] ?? "{}").replaceAll("&quot;", '"')) as { page?: number; width?: number; height?: number; rect?: { y: number; height: number }; error?: string };
    expect(answer.error).toBeUndefined();
    expect(answer.page).toBe(1);
    expect(answer.width).toBe(1600);
    // Three lines (the one above, the phrase's, the one below) at 24 pt spacing, scaled to 1600 px: well under the page.
    const spacing = (24 * 1600) / 612;
    expect(answer.rect!.height).toBeGreaterThan(spacing * 2);
    expect(answer.rect!.height).toBeLessThan(spacing * 3.5);
  } finally {
    cleanup();
  }
}, 90_000);
