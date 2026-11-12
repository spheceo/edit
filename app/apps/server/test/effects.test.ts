import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { agentInstructions } from "../src/agent.ts";
import * as effects from "../src/effects.ts";
import * as fonts from "../src/fonts.ts";
import { registerEffectTools } from "../src/effect_tools.ts";
import { registerEditingTools } from "../src/edit_tools.ts";
import { findAddon, useNative, wrap, type Native } from "../src/native/index.ts";
import * as tools from "../src/tools.ts";
import { dispatch } from "../src/mcp/index.ts";
import { HQ_TOOLS, NOT_IN_HQ, toolsFor, TOOLS } from "../src/mcp/registry.ts";
import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import * as seams from "../src/seams.ts";
import { fixtureHome } from "./helpers/home.ts";

registerEffectTools();
registerEditingTools();
afterAll(() => effects.closeChrome());

/** A page that keeps the contract: a bar that crosses the frame in two seconds, and a count of the frame. */
const GOOD = `<!doctype html>
<html><body style="margin:0;background:#101418;overflow:hidden">
<div id="bar" style="position:absolute;top:500px;left:0;width:80px;height:80px;background:#e0343c"></div>
<div id="n" style="position:absolute;left:40px;top:40px;font:700 64px sans-serif;color:#fff"></div>
<script>
window.duration = 2;
window.ready = Promise.resolve();
window.seek = (t) => {
  document.getElementById("bar").style.transform = "translateX(" + Math.round((t / 2) * 1840) + "px)";
  document.getElementById("n").textContent = String(Math.round(t * 30));
};
</script></body></html>`;

function hq(name: string) {
  const home = fixtureHome(name);
  const live = home.app.store.create("Welfare check", { width: 1920, height: 1080, fps: 30 });
  return { ...home, id: live.project.id };
}

function write(app: ReturnType<typeof fixtureHome>["app"], project: string, name: string, files: Record<string, string>): string {
  const dir = effects.folder(app.store, project, name);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(join(dir, file, ".."), { recursive: true });
    fs.writeFileSync(join(dir, file), text);
  }
  return dir;
}

async function get(app: ReturnType<typeof fixtureHome>["app"], path: string): Promise<Response> {
  return (await respond(app, buildRouter(), new Request(`http://127.0.0.1:7700${path}`, { headers: { host: "127.0.0.1:7700" } }), null))!;
}

test("an effect's page is served shut in: no origin, no network, only its own folder, Edit's runtime ahead of its code", async () => {
  const { app, cleanup, id } = hq("effects-serve");
  try {
    write(app, id, "bar", { "scene.html": GOOD, "img/a.txt": "beside it" });
    // The list the viewer asks for: the effects with a page, each with its page's address.
    fs.mkdirSync(effects.folder(app.store, id, "half-written"), { recursive: true });
    const listed = (await (await get(app, `/api/projects/${id}/effects`)).json()) as { effects: effects.Effect[] };
    expect(listed.effects.map((effect) => effect.name)).toEqual(["bar"]);
    expect(listed.effects[0]!.changed).toBeGreaterThan(0);
    const address = listed.effects[0]!.page;
    expect(address).toMatch(new RegExp(`^/api/effects/[0-9a-f]{32}/${id}/bar/scene\\.html$`));
    const base = address.slice(0, -"scene.html".length);

    const page = await get(app, address);
    expect(page.status).toBe(200);
    const policy = page.headers.get("content-security-policy")!;
    expect(policy).toContain("sandbox allow-scripts;");
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).toContain("connect-src 'none'");
    // With its scheme, both of them: WebKit matches a source without one to nothing for a page with no origin (Nov 11, Edit.app's window).
    expect(policy).toContain(`img-src http://127.0.0.1:7700${base} https://127.0.0.1:7700${base} data: blob:`);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const text = await page.text();
    expect(text.startsWith('<!doctype html>\n<style>\n@font-face { font-family: "Geist"; font-weight: 400; src: url(edit-fonts/Geist-Regular.ttf); }')).toBe(true);
    // Edit's faces, served as if in its folder, for the page alone.
    const face = await get(app, `${base}edit-fonts/ReenieBeanie.ttf`);
    expect(face.status).toBe(200);
    expect(face.headers.get("access-control-allow-origin")).toBe("null");
    expect(face.headers.get("content-security-policy")).toBe(policy);
    expect((await face.arrayBuffer()).byteLength).toBeGreaterThan(30_000);
    expect((await get(app, `${base}edit-fonts/AkwePro-Bold.otf`)).status).toBe(404);
    expect(text.indexOf("window.__edit")).toBeLessThan(text.indexOf("window.duration = 2"));
    // A file beside it, with the same walls.
    const beside = await get(app, `${base}img/a.txt`);
    expect(await beside.text()).toBe("beside it");
    expect(beside.headers.get("content-security-policy")).toBe(policy);
    // The page's own loads come as a stranger's would (no origin, marked cross-site, no Referer): let in for an
    // effect's files, whose address holds the key, and for nothing else of the app.
    const asked = (path: string, headers: Record<string, string>) => respond(app, buildRouter(), new Request(`http://127.0.0.1:7700${path}`, { headers: { host: "127.0.0.1:7700", ...headers } }), null);
    const fromThePage = { "sec-fetch-site": "cross-site" };
    expect((await asked(`${base}img/a.txt`, fromThePage))!.status).toBe(200);
    expect((await asked(`${base}img/a.txt`, { ...fromThePage, origin: "null" }))!.status).toBe(200);
    expect((await asked(`/api/projects/${id}`, { ...fromThePage, origin: "null" }))!.status).toBe(403);
    expect((await asked(`/api/projects/${id}/effects`, fromThePage))!.status).toBe(403);
    // Another site's page: refused with its own origin, and it can't name the address without the key.
    expect((await asked(`${base}img/a.txt`, { origin: "https://elsewhere.example" }))!.status).toBe(403);
    expect((await asked(`/api/effects/${"0".repeat(32)}/${id}/bar/img/a.txt`, fromThePage))!.status).toBe(403);
    expect((await get(app, `/api/effects/${"0".repeat(32)}/${id}/bar/img/a.txt`)).status).toBe(404);
    // Framed by Edit's viewer alone; every other answer of Edit's is framed by nobody.
    expect(policy).toContain("frame-ancestors 'self'");
    expect(page.headers.get("x-frame-options")).toBeNull();
    expect((await asked(`/api/projects/${id}`, {}))!.headers.get("x-frame-options")).toBe("DENY");
    // Every file of its folder may be read by the page (which has no origin): a font, and a picture's pixels too.
    write(app, id, "bar", { "fonts/hand.ttf": "font", "img/photo.jpg": "photo" });
    expect((await get(app, `${base}fonts/hand.ttf`)).headers.get("access-control-allow-origin")).toBe("null");
    expect((await get(app, `${base}img/photo.jpg`)).headers.get("access-control-allow-origin")).toBe("null");
    // Nothing from outside the folder: not by a path, and not by a link in it.
    fs.writeFileSync(join(effects.root(app.store, id), "secret.txt"), "another effect's");
    expect((await get(app, `${base}..%2Fsecret.txt`)).status).toBe(404);
    fs.symlinkSync(join(effects.root(app.store, id), "secret.txt"), join(effects.folder(app.store, id, "bar"), "link.txt"));
    expect((await get(app, `${base}link.txt`)).status).toBe(404);
    expect((await get(app, base.replace("/bar/", "/Bad Name/") + "scene.html")).status).toBe(404);
    expect((await get(app, base.replace(id, "nope") + "scene.html")).status).toBe(404);
  } finally {
    cleanup();
  }
});

test("a font the project fetched is there in its effects by name: declared ahead of the page's code, its file served as if in the folder", async () => {
  // Sphe, Nov 12: fonts the agent pulls, beyond Edit's own faces (fonts.ts).
  const { app, cleanup, id } = hq("effects-fonts");
  try {
    write(app, id, "bar", { "scene.html": GOOD });
    const dir = join(fonts.projectDir(app.store, id), "caveat");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "Caveat-400.ttf"), "font");
    fs.writeFileSync(join(dir, "font.json"), JSON.stringify({ family: "Caveat", faces: [{ weight: 400, style: "normal", file: "Caveat-400.ttf" }], source: "Google Fonts" }));
    const address = ((await (await get(app, `/api/projects/${id}/effects`)).json()) as { effects: effects.Effect[] }).effects[0]!.page;
    const text = await (await get(app, address)).text();
    expect(text).toContain('@font-face { font-family: "Caveat"; font-weight: 400; font-style: normal; src: url(edit-fonts/caveat/Caveat-400.ttf); }');
    const file = await get(app, `${address.slice(0, -"scene.html".length)}edit-fonts/caveat/Caveat-400.ttf`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("font");
    expect((await get(app, `${address.slice(0, -"scene.html".length)}edit-fonts/caveat/nope.ttf`)).status).toBe(404);
  } finally {
    cleanup();
  }
});

test("the agent's file tools are allowed in the effects folder and nowhere else, and only an HQ project's chat has them", () => {
  const { app, cleanup, id } = hq("effects-rules");
  try {
    const dir = effects.workshop(app.store, id);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(effects.fileRules(dir)).toEqual([`Read(/${dir}/**)`, `Edit(/${dir}/**)`, `Write(/${dir}/**)`]);
    expect(effects.FILE_TOOLS).not.toContain("Bash");
    const project = app.store.get(id)!.project;
    const plain = agentInstructions(project);
    expect(plain).toContain("you have no shell or files");
    for (const tool of HQ_TOOLS) expect(plain).not.toContain(`- ${tool}(`);
    const made = agentInstructions({ ...project, hq: true });
    expect(made).toContain("the project's effects folder; you have no shell");
    expect(made).toContain("THIS IS A BODYCAM HQ VIDEO");
    for (const tool of HQ_TOOLS) expect(made).toContain(`- ${tool}(`);
    expect(toolsFor(false).length).toBe(TOOLS.length - HQ_TOOLS.length);
    // Every tool but the house's skills, sound effects and looks (it has its own) and other niches'.
    expect(toolsFor(true).map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name).filter((name) => !NOT_IN_HQ.includes(name)));
    for (const kept of ["cover_cut_in", "caption_speakers", "add_subtitles", "track_region", "capture_evidence", "set_keyframes", "pull_script", "add_sound_effect", "add_from_library"]) expect(NOT_IN_HQ).not.toContain(kept);
  } finally {
    cleanup();
  }
});

test("an effect's tools are refused outside an HQ project, and an export waits for an effect's render", async () => {
  const { app, cleanup, id } = hq("effects-refused");
  try {
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, id)) as { result: { content: { type: string; text?: string }[]; isError: boolean } }).result;
    const refused = await call("look_at_effect", { name: "bar" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("Bodycam HQ");
    const listed = (await dispatch(app, { id: 1, method: "tools/list" }, id)) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.some((tool) => tool.name === "look_at_effect")).toBe(false);
    await app.store.update(id, "test", (project) => {
      project.hq = true;
      project.media.push({ id: "m1", name: "bar", path: "/nowhere/bar.png", kind: "image", duration: 2, width: 1920, height: 1080, fps: 0, has_audio: false, effect: "bar" });
    });
    const now = (await dispatch(app, { id: 1, method: "tools/list" }, id)) as { result: { tools: { name: string }[] } };
    expect(now.result.tools.some((tool) => tool.name === "look_at_effect")).toBe(true);
    // In the media but on no clip: nothing of it is exported, so nothing to wait for.
    expect(effects.onTimeline(app.store.get(id)!.project)).toEqual([]);
    await seams.broll.waitForMaps(app, id, 10);
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1" } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: "m1", source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    expect(effects.onTimeline(app.store.get(id)!.project)).toEqual(["bar"]);
    // Its code isn't on this computer and it was never rendered: an export can't have it, and says so.
    await expect(seams.broll.waitForMaps(app, id, 10)).rejects.toThrow("bar is a coded effect made on another computer and never rendered there");
    // Rendered on that computer (its media is the render): exported as it is.
    await app.store.update(id, "test", (project) => {
      project.media[0]!.effect_key = "abc";
    });
    await seams.broll.waitForMaps(app, id, 10);
  } finally {
    cleanup();
  }
});

const chrome = seams.broll.chrome();

test.skipIf(chrome === null)("look draws the page in Chrome: its length, the stills asked for, a frame's cost, and what the page gets wrong", async () => {
  const { app, cleanup, id } = hq("effects-look");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    write(app, id, "bar", { "scene.html": GOOD });
    const look = await effects.look(app, id, "bar", [0, 1]);
    expect(look.duration).toBe(2);
    expect(look.problems).toEqual([]);
    expect(look.errors).toEqual([]);
    expect(look.stills.map((still) => still.time)).toEqual([0, 1]);
    expect(look.stills[0]!.mime).toBe("image/jpeg");
    // Two different moments, two different pictures; the same moment again, the same picture.
    expect(Buffer.from(look.stills[0]!.picture).equals(Buffer.from(look.stills[1]!.picture))).toBe(false);
    const again = await effects.look(app, id, "bar", [1]);
    expect(Buffer.from(again.stills[0]!.picture).equals(Buffer.from(look.stills[1]!.picture))).toBe(true);
    expect(look.interval).toBeGreaterThan(1);
    expect(look.stills[0]!.cost).toBeGreaterThan(1);
    // With no moments asked for: six, spread over its length.
    expect((await effects.look(app, id, "bar", null)).stills.map((still) => still.time)).toEqual([0.17, 0.5, 0.83, 1.17, 1.5, 1.83]);

    // The walls hold in a real browser: the app's own address and its cookies and storage are out of the page's reach.
    write(app, id, "walls", {
      "scene.html": `<!doctype html><body><script>
        const tried = [];
        try { tried.push("cookie " + document.cookie.length); } catch { tried.push("no cookies"); }
        try { tried.push("storage " + localStorage.length); } catch { tried.push("no storage"); }
        window.seek = () => {};
        window.ready = fetch("/api/projects").then(() => tried.push("reached the app"), () => tried.push("no network")).then(() => { window.duration = tried.join(", ") === "no cookies, no storage, no network" ? 3 : 99; });
      </script></body>`,
    });
    const walls = await effects.look(app, id, "walls", []);
    expect(walls.duration).toBe(3);
    // A length set while it loads is its length: nothing is said of one missing before `ready`.
    expect(walls.problems).toEqual([]);

    // And what's in its own folder does load there: a picture and a font, from inside the walls.
    const loads = write(app, id, "loads", {
      "scene.html": `<!doctype html><head><style>@font-face { font-family: Hand; src: url(fonts/hand.ttf); }</style></head><body><img id="dot" src="img/dot.png"><script>
        window.seek = () => {};
        const dot = document.getElementById("dot");
        // Its own font, and one of Edit's (there as if in its folder: Reenie Beanie, the house marker).
        window.ready = Promise.all([dot.decode().then(() => dot.naturalWidth, () => 0), document.fonts.load("40px Hand").then((found) => found.length, () => 0), document.fonts.load("40px 'Reenie Beanie'").then((found) => found.length, () => 0)])
          .then(([picture, font, house]) => { window.duration = picture === 1 && font === 1 && house === 1 ? 5 : 99; });
      </script></body>`,
    });
    fs.mkdirSync(join(loads, "img"), { recursive: true });
    fs.writeFileSync(join(loads, "img/dot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    fs.mkdirSync(join(loads, "fonts"), { recursive: true });
    fs.copyFileSync(join(import.meta.dir, "../../../crates/edit-render/fonts/VT323-Regular.ttf"), join(loads, "fonts/hand.ttf"));
    expect((await effects.look(app, id, "loads", [])).duration).toBe(5);

    // A page on its own clock, with no length, that reaches for the network and throws: each said.
    write(app, id, "wrong", {
      "scene.html": `<!doctype html><body><img id="far" src="https://example.com/a.png"><script>
        window.ready = fetch("/api/projects").then(() => "reached the app", () => "kept out").then((said) => { document.title = said; });
        window.seek = (t) => { if (t > 1) throw new Error("no second " + t); };
        requestAnimationFrame(() => { document.body.dataset.ran = "yes"; });
      </script></body>`,
    });
    const wrong = await effects.look(app, id, "wrong", [0.5, 1.5]);
    expect(wrong.duration).toBe(0);
    expect(wrong.problems.join("\n")).toContain("requestAnimationFrame was called");
    expect(wrong.problems.join("\n")).toContain("no window.duration");
    expect(wrong.errors.join("\n")).toContain("no second 1.5");
    // What its walls refused is said, not just a blank page: the picture off the network, the call to the app.
    expect(wrong.errors.join("\n")).toContain("refused to load a.png (img-src)");
    expect(wrong.errors.join("\n")).toContain("(connect-src)");
    const tool = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "wrong", times: [0.5] } } }, id)) as { result: { content: { type: string; text?: string }[]; isError: boolean } }).result;
    expect(tool.isError).toBe(false);
    expect(tool.content.filter((part) => part.type === "image").length).toBe(1);
    expect(tool.content.at(-1)!.text).toContain("BREAKS THE EFFECT CONTRACT");
    // Every frame of a stretch, tiled into numbered sheets: what only moves between frames shows there (Sphe, Nov 12: a board's
    // handwriting shimmered as it drifted, in no single still). At most 48 a look, and where to carry on is said.
    write(app, id, "counter", {
      "scene.html": `<!doctype html><body style="margin:0;background:#222"><canvas id="c" width="1920" height="1080"></canvas><script>
        const c = document.getElementById("c").getContext("2d");
        window.duration = 3; window.ready = Promise.resolve();
        window.seek = (t) => { c.fillStyle = "#222"; c.fillRect(0, 0, 1920, 1080); c.fillStyle = "#fff"; c.font = "300px monospace"; c.fillText(String(Math.round(t * 30)), 200, 600); };
      </script></body>`,
    });
    const every = async (args: Record<string, unknown>) => ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "counter", every_frame: true, ...args } } }, id)) as { result: { content: { type: string; text?: string }[]; isError: boolean } }).result;
    const half = await every({ start: 0, end: 0.5 });
    expect(half.isError, half.content.map((part) => part.text).join(" ")).toBe(false);
    expect(half.content.filter((part) => part.type === "image").length).toBe(1);
    expect(half.content.find((part) => part.text?.includes("every frame"))!.text).toContain("every frame, 0–14");
    const long = await every({ start: 0, end: 2 });
    expect(long.content.filter((part) => part.type === "image").length).toBe(3);
    expect(long.content.at(-1)!.text).toContain("Frames 48–59 are left: look again with start 1.600");
    const full = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "counter", times: [1], detail: "full" } } }, id)) as { result: { content: { type: string; text?: string; mimeType?: string }[] } }).result;
    expect(full.content.find((part) => part.type === "image")!.mimeType).toBe("image/png");
    expect(full.content.find((part) => part.text?.includes("at full size"))).toBeDefined();
    // Beside a reference, zoomed: each of its frames paired with the reference's at the same moment, cropped to one region (Sphe, Nov 12).
    const reference = join(app.store.cacheDir(), "reference.mp4");
    expect(Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30:duration=3:decimals=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", reference]).exitCode).toBe(0);
    await app.store.update(id, "test", (project) => {
      project.media.push({ id: "ref", name: "reference.mp4", path: reference, kind: "video", duration: 3, width: 1920, height: 1080, fps: 30, has_audio: false });
    });
    const paired = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "counter", every_frame: true, start: 0.5, end: 0.8, beside: { media_id: "ref", start: 1 }, zoom: { x: 100, y: 200, width: 960, height: 540 } } } }, id)) as { result: { content: { type: string; text?: string; data?: string }[]; isError: boolean } }).result;
    expect(paired.isError, paired.content.map((part) => part.text).join(" ")).toBe(false);
    const sheetsOut = paired.content.filter((part) => part.type === "image");
    expect(sheetsOut.length).toBe(2);
    expect(paired.content.find((part) => part.text?.includes("beside ref"))!.text).toContain("zoomed to 960×540 at 100,200");
    if (process.env.EDIT_KEEP_SHEET) fs.writeFileSync(process.env.EDIT_KEEP_SHEET, Buffer.from(sheetsOut[0]!.data!, "base64"));
    const one = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "counter", times: [1], zoom: { x: 0, y: 0, width: 800, height: 450 } } } }, id)) as { result: { content: { type: string }[]; isError: boolean } }).result;
    expect(one.isError).toBe(false);
    expect(one.content.filter((part) => part.type === "image").length).toBe(1);
    const nowhere = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "counter", times: [1], beside: { media_id: "nope", start: 0 } } } }, id)) as { result: { content: { text?: string }[]; isError: boolean } }).result;
    expect(nowhere.isError).toBe(true);
    // And footage zoomed: a region of the media's own frames.
    const zoomed = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_media", arguments: { media_id: "ref", times: [0.5, 2], zoom: { x: 900, y: 400, width: 640, height: 360 } } } }, id)) as { result: { content: { type: string; text?: string }[]; isError: boolean } }).result;
    expect(zoomed.isError, zoomed.content.map((part) => part.text).join(" ")).toBe(false);
    expect(zoomed.content.filter((part) => part.type === "image").length).toBe(1);
    await expect(effects.add(app, id, "wrong")).rejects.toThrow("isn't ready for the timeline");
    await expect(effects.look(app, id, "nowhere", [0])).rejects.toThrow('no effect "nowhere"');
  } finally {
    await server.stop(true);
    cleanup();
  }
}, 120_000);

test.skipIf(chrome === null)("an effect on the timeline is rendered from its code, in place of its still, and again when its code changes", async () => {
  const { app, cleanup, id } = hq("effects-render");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    const dir = write(app, id, "bar", { "scene.html": GOOD });
    const added = await effects.add(app, id, "bar");
    expect(added.duration).toBe(2);
    let media = app.store.get(id)!.project.media.find((one) => one.id === added.media)!;
    expect(media.kind).toBe("image");
    expect(media.effect_key).toBeUndefined();
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: added.media, source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    // What every export does first: waits for it, rendering it now.
    await seams.broll.waitForMaps(app, id, 90_000);
    media = app.store.get(id)!.project.media.find((one) => one.id === added.media)!;
    const key = effects.list(app.store, id)[0]!.key;
    expect(media.effect_key).toBe(key);
    expect(media.kind).toBe("video");
    expect(media.effect).toBe("bar");
    expect(media.path.endsWith(`effect-renders/bar-${key}.mp4`)).toBe(true);
    expect(media.width).toBe(1920);
    expect(media.height).toBe(1080);
    expect(Math.abs(media.duration - 2)).toBeLessThan(0.05);
    // The frames went once joined; the video is every frame of it.
    expect(fs.existsSync(media.path.replace(/\.mp4$/, ".frames"))).toBe(false);
    const counted = Bun.spawnSync(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", media.path]).stdout.toString().trim().replace(/,$/, "");
    expect(counted).toBe("60");
    // Video range, as footage is: the JPEG frames are full range, which FFmpeg otherwise carries through (seen on kenobi, Nov 11).
    expect(Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt,color_range", "-of", "csv=p=0", media.path]).stdout.toString().trim().replace(/,$/, "")).toBe("yuv420p,tv");
    // Rendered: nothing more to wait for.
    await seams.broll.waitForMaps(app, id, 10);
    // A change to its code is a new version: the render is outdated until it's made again.
    await Bun.sleep(20);
    fs.writeFileSync(join(dir, "scene.html"), GOOD.replace("#e0343c", "#34e03c"));
    const now = effects.list(app.store, id)[0]!.key;
    expect(now).not.toBe(key);
    await expect(seams.broll.waitForMaps(app, id, 10)).rejects.toThrow("bar is still rendering");
    await seams.broll.waitForMaps(app, id, 90_000);
    expect(app.store.get(id)!.project.media.find((one) => one.id === added.media)!.effect_key).toBe(now);
    // A third version: the oldest render goes, the one before the newest stays (an undo shows it).
    await Bun.sleep(20);
    fs.writeFileSync(join(dir, "scene.html"), GOOD.replace("#e0343c", "#3434e0"));
    await seams.broll.waitForMaps(app, id, 90_000);
    const third = effects.list(app.store, id)[0]!.key;
    expect(fs.readdirSync(join(app.store.uploadsDir(id), "effect-renders")).sort()).toEqual([`bar-${now}.mp4`, `bar-${third}.mp4`].sort());
  } finally {
    await server.stop(true);
    cleanup();
  }
}, 240_000);

test("a sound's levels: how loud each frame is, and in which band", () => {
  const rate = 24000;
  // One second of a loud 1 kHz tone, then one of silence.
  const samples = new Float32Array(rate * 2);
  for (let at = 0; at < rate; at++) samples[at] = 0.5 * Math.sin((2 * Math.PI * 1000 * at) / rate);
  const levels = effects.levelsOf(samples, rate, 30);
  expect(levels.frames).toBe(60);
  expect(levels.rms.length).toBe(60);
  expect(levels.rms[10]!).toBeGreaterThan(0.8);
  expect(levels.rms[45]).toBe(0);
  // The tone is loudest in the band holding 1 kHz (the bands run 40 Hz to 12 kHz, spaced as the ear hears).
  const bands = levels.bands[10]!;
  expect(bands.length).toBe(16);
  const loudest = bands.indexOf(Math.max(...bands));
  const edge = (band: number) => 40 * Math.pow(12_000 / 40, band / 16);
  expect(edge(loudest) <= 1000 && 1000 < edge(loudest + 1)).toBe(true);
  expect(Math.max(...levels.bands[45]!)).toBe(0);
});

test.skipIf(chrome === null)("an effect plays footage it's given: seeked to each moment, drawn there, rendered frame by frame", async () => {
  const { app, cleanup, id, dir: scratchDir } = hq("effects-footage");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    // Footage: a counter on screen, a tone under it, three seconds.
    const clip = join(scratchDir, "clip.mp4");
    expect(Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]).exitCode).toBe(0);
    const media = "m9";
    await app.store.update(id, "test", (project) => {
      project.media.push({ id: media, name: "clip.mp4", path: clip, kind: "video", duration: 3, width: 640, height: 360, fps: 30, has_audio: true });
    });
    const given = await effects.giveFootage(app, id, "framed", media, 1, 3, "shot");
    expect(given).toMatchObject({ video: "shot.mp4", levels: "shot.levels.js", key: "shot", width: 640, height: 360, start: 1, duration: 2 });
    const folder = effects.folder(app.store, id, "framed");
    const script = fs.readFileSync(join(folder, "shot.levels.js"), "utf8");
    expect(script.startsWith('(window.levels = window.levels || {})["shot"] = {"fps":30,"frames":60,')).toBe(true);
    await expect(effects.giveFootage(app, id, "framed", media, 2.5, 2, null)).rejects.toThrow("start and end are seconds");
    await expect(effects.giveFootage(app, id, "framed", "m404", 0, 1, null)).rejects.toThrow("no media m404");
    // A page that plays the footage in a rounded frame, a meter from its sound beside it, seek waiting for the video.
    write(app, id, "framed", {
      "scene.html": `<!doctype html><body style="margin:0;background:#000"><script src="shot.levels.js"></script>
        <video id="v" src="shot.mp4" muted playsinline style="position:absolute;left:100px;top:300px;width:960px;border-radius:40px"></video>
        <div id="m" style="position:absolute;left:1300px;top:300px;width:120px;background:#fff"></div><script>
        const v = document.getElementById("v"), levels = window.levels.shot;
        window.duration = 2;
        window.ready = new Promise((resolve) => v.addEventListener("loadeddata", resolve, { once: true }));
        window.seek = (t) => {
          document.getElementById("m").style.height = Math.round(400 * levels.rms[Math.min(levels.frames - 1, Math.floor(t * levels.fps))]) + "px";
          return new Promise((resolve) => { v.addEventListener("seeked", resolve, { once: true }); v.currentTime = t; });
        };
      </script></body>`,
    });
    const look = await effects.look(app, id, "framed", [0.2, 1.5]);
    expect(look.errors).toEqual([]);
    expect(look.problems).toEqual([]);
    expect(Buffer.from(look.stills[0]!.picture).equals(Buffer.from(look.stills[1]!.picture))).toBe(false);
    // Rendered, every frame waiting for its seek.
    const added = await effects.add(app, id, "framed");
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: added.media, source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    await seams.broll.waitForMaps(app, id, 90_000);
    const rendered = app.store.get(id)!.project.media.find((one) => one.id === added.media)!;
    expect(rendered.kind).toBe("video");
    // The footage moves in the render: its first and last frames differ where the video sits.
    const frameAt = (t: number) => Bun.spawnSync(["ffmpeg", "-v", "error", "-ss", String(t), "-i", rendered.path, "-frames:v", "1", "-vf", "crop=960:540:100:300,scale=96:54,format=gray", "-f", "rawvideo", "-"]).stdout;
    expect(Buffer.from(frameAt(0.1)).equals(Buffer.from(frameAt(1.8)))).toBe(false);
  } finally {
    await server.stop(true);
    cleanup();
  }
}, 240_000);

test.skipIf(chrome === null)("a sound made from its code: rendered in the page, a WAV among the project's media, made again in its place", async () => {
  const { app, cleanup, id } = hq("effects-sound");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    // Plain samples: half a second of 440 Hz.
    write(app, id, "beep", {
      "sound.html": `<script>window.sound = { render: (rate) => { const out = new Float32Array(rate / 2); for (let at = 0; at < out.length; at++) out[at] = 0.5 * Math.sin(2 * Math.PI * 440 * at / rate); return [out]; } };</script>`,
    });
    const first = await effects.makeSound(app, id, "beep");
    expect(Math.abs(first.duration - 0.5)).toBeLessThan(0.02);
    let media = app.store.get(id)!.project.media.find((one) => one.id === first.media)!;
    expect(media).toMatchObject({ kind: "audio", name: "beep" });
    const peak = Bun.spawnSync(["ffmpeg", "-hide_banner", "-i", media.path, "-af", "volumedetect", "-f", "null", "-"], { stderr: "pipe" }).stderr.toString();
    expect(peak).toContain("max_volume: -6.0 dB");
    // An OfflineAudioContext's buffer, a second long: the same media, the new sound.
    write(app, id, "beep", {
      "sound.html": `<script>window.sound = { render: async (rate) => { const context = new OfflineAudioContext(2, rate, rate); const tone = context.createOscillator(); tone.connect(context.destination); tone.start(); return context.startRendering(); } };</script>`,
    });
    const again = await effects.makeSound(app, id, "beep");
    expect(again.media).toBe(first.media);
    media = app.store.get(id)!.project.media.find((one) => one.id === first.media)!;
    expect(Math.abs(media.duration - 1)).toBeLessThan(0.02);
    // A page with no sound says so.
    write(app, id, "silent", { "sound.html": `<p>nothing</p>` });
    await expect(effects.makeSound(app, id, "silent")).rejects.toThrow("no window.sound");
    await expect(effects.makeSound(app, id, "nothing-here")).rejects.toThrow("has no sound.html");
  } finally {
    await server.stop(true);
    cleanup();
  }
}, 120_000);

const SEE_THROUGH = `<!doctype html>
<html><body style="margin:0;overflow:hidden">
<div style="position:absolute;left:0;top:0;width:960px;height:1080px;background:#ff0000"></div>
<script>
window.duration = 1;
window.ready = Promise.resolve();
window.seek = () => {};
</script></body></html>`;

/** The colour at (x, y) of a picture (PNG or JPEG bytes), as FFmpeg reads it. */
function pixel(picture: Uint8Array, x: number, y: number): number[] {
  const kind = picture[0] === 0xff && picture[1] === 0xd8 ? "jpg" : "png";
  const path = join(os.tmpdir(), `edit-pixel-${process.pid}-${Math.random().toString(36).slice(2)}.${kind}`);
  fs.writeFileSync(path, picture);
  try {
    return [...Bun.spawnSync(["ffmpeg", "-v", "error", "-i", path, "-vf", `format=rgb24,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout];
  } finally {
    fs.rmSync(path, { force: true });
  }
}

const size = (path: string) => Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path]).stdout.toString().trim().replace(/,$/, "");

test.skipIf(chrome === null)("an effect with see-through parts renders with its alpha and plays over what's beneath; while its code is newer, the engine draws nothing for it", async () => {
  const { app, cleanup, id } = hq("effects-alpha");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  const addon = findAddon();
  const before = addon === null ? null : useNative(wrap(require(addon) as Native));
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    const dir = write(app, id, "half", { "scene.html": SEE_THROUGH });
    // The agent's look says so, and shows it over a checkerboard.
    const looked = (await effects.look(app, id, "half", [0])).stills[0]!;
    expect(looked.seeThrough).toBe(true);
    const red = pixel(looked.picture, 300, 270);
    expect(red[0]).toBeGreaterThan(230);
    expect(red[1]! + red[2]!).toBeLessThan(40);
    expect(new Set(pixel(looked.picture, 700, 270)).size).toBe(1);
    const added = await effects.add(app, id, "half");
    const mediaOf = () => app.store.get(id)!.project.media.find((one) => one.id === added.media)!;
    // Before its render: a clear picture of its own, nothing drawn for it.
    expect(mediaOf().path.endsWith("effect-stills/half.clear.png")).toBe(true);
    expect([mediaOf().width, mediaOf().height]).toEqual([1920, 1080]);
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.tracks.push({ id: "t2", kind: "video", name: "V2", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      // Blue beneath it, the effect over it.
      project.clips.push({ id: "c0", type: "solid", track: "t1", start: 0, duration: 30, fill: [0, 0, 1, 1], opacity: 1 } as unknown as (typeof project.clips)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t2", start: 0, duration: 30, media: added.media, source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    await seams.broll.waitForMaps(app, id, 90_000);
    let media = mediaOf();
    expect(media.stacked_alpha).toBe(true);
    expect(media.kind).toBe("video");
    // The picture's own size; the file is the picture over its alpha, played as it is (no preview copy to halve it).
    expect([media.width, media.height]).toEqual([1920, 1080]);
    expect(size(media.path)).toBe("1920,2160");
    expect(app.media.status(media.path).proxy).toBe("skipped");
    // The engine draws it over the blue: red where it's painted, blue where it isn't (with the real engine, built).
    if (addon !== null) {
      (require(addon) as Native).init({ home: app.store.home, cacheDir: app.store.cacheDir(), ffmpeg: tools.ffmpeg(), ffprobe: tools.ffprobe(), log: () => {} });
      const frame = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "render_frame", arguments: { frame: 10, max_size: 1920 } } }, id)) as { result: { content: { type: string; data?: string; text?: string }[] } }).result;
      const picture = Buffer.from(frame.content.find((part) => part.type === "image")?.data ?? "", "base64");
      expect(picture.length).toBeGreaterThan(0);
      const [r1, g1, b1] = pixel(picture, 480, 540);
      expect(r1).toBeGreaterThan(230);
      expect(g1! + b1!).toBeLessThan(30);
      const [r2, g2, b2] = pixel(picture, 1440, 540);
      expect(b2).toBeGreaterThan(230);
      expect(r2! + g2!).toBeLessThan(30);
    }
    // Its code changed: at once its old render gives way to its clear picture (the page playing live is all that's seen of it).
    await Bun.sleep(20);
    fs.writeFileSync(join(dir, "scene.html"), SEE_THROUGH.replace("margin:0;", "margin:0;background:#00ff00;"));
    effects.renderSoon(app, id);
    for (let wait = 0; wait < 50 && mediaOf().kind !== "image"; wait++) await Bun.sleep(50);
    media = mediaOf();
    expect(media.path.endsWith("half.clear.png")).toBe(true);
    expect(media.effect_key).toBeUndefined();
    expect(media.stacked_alpha).toBeUndefined();
    // A page that paints every pixel is plain video, as before.
    expect((await effects.look(app, id, "half", [0])).stills[0]!.seeThrough).toBe(false);
    await seams.broll.waitForMaps(app, id, 90_000);
    media = mediaOf();
    expect(media.stacked_alpha).toBeUndefined();
    expect(media.kind).toBe("video");
    expect(size(media.path)).toBe("1920,1080");
  } finally {
    if (addon !== null) useNative(before);
    await server.stop(true);
    cleanup();
  }
}, 240_000);
