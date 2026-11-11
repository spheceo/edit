import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";

import { agentInstructions } from "../src/agent.ts";
import * as effects from "../src/effects.ts";
import { registerEffectTools } from "../src/effect_tools.ts";
import { dispatch } from "../src/mcp/index.ts";
import { HQ_TOOLS, toolsFor, TOOLS } from "../src/mcp/registry.ts";
import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import * as seams from "../src/seams.ts";
import { fixtureHome } from "./helpers/home.ts";

registerEffectTools();
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
    expect(policy).toContain(`img-src 127.0.0.1:7700${base} data: blob:`);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const text = await page.text();
    expect(text.startsWith("<!doctype html>\n<script>")).toBe(true);
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
    // A font may be read by the page (which has no origin); a picture is only ever shown.
    write(app, id, "bar", { "fonts/hand.ttf": "font", "img/photo.jpg": "photo" });
    expect((await get(app, `${base}fonts/hand.ttf`)).headers.get("access-control-allow-origin")).toBe("null");
    expect((await get(app, `${base}img/photo.jpg`)).headers.get("access-control-allow-origin")).toBeNull();
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
    expect(toolsFor(true)).toEqual(TOOLS);
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
        window.ready = Promise.all([dot.decode().then(() => dot.naturalWidth, () => 0), document.fonts.load("40px Hand").then((found) => found.length, () => 0)])
          .then(([picture, font]) => { window.duration = picture === 1 && font === 1 ? 5 : 99; });
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
    const tool = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name: "wrong", times: [0.5] } } }, id)) as { result: { content: { type: string; text?: string }[]; isError: boolean } }).result;
    expect(tool.isError).toBe(false);
    expect(tool.content.filter((part) => part.type === "image").length).toBe(1);
    expect(tool.content.at(-1)!.text).toContain("BREAKS THE EFFECT CONTRACT");
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
  } finally {
    await server.stop(true);
    cleanup();
  }
}, 240_000);
