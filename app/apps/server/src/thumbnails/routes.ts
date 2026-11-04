// Thumbnails' HTTP API, under /api/thumbnails, for the same people as ideas
// (an `ideas.*` capability, or an admin): the list, a thumbnail's page (its
// layers, its images, the chat with Claude), the library of overlays, the
// fonts and the page headless Chrome draws on. Claude's tools are served at
// /mcp/thumbnails/<token> (run.ts), for the turns on this Mac only.

import type { OpenArtAccount, OpenArtState, ThumbImage } from "@edit/types/thumbnails";

import { creator } from "../accounts.ts";
import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { ApiError, bad, empty, json, notFound } from "../http/errors.ts";
import { readBytes, readJson, type RouteContext, type Router } from "../http/router.ts";
import { mayIdeas } from "../ideas/routes.ts";
import * as assets from "./assets.ts";
import * as cloud from "./cloud.ts";
import { canonical, step, switchVersion, takeFinal } from "./design.ts";
import * as openart from "./openart.ts";
import * as render from "./render.ts";
import * as run from "./run.ts";
import { sizeOf } from "./size.ts";

type Context = RouteContext<App>;

const NO_THUMBNAILS = "Your account can't make thumbnails yet: an admin can give you ideas at accounts.spheceo.com.";

function guard(): void {
  if (!mayIdeas()) throw new ApiError(403, NO_THUMBNAILS);
}

const by = (): string => creator()?.name || "Edit";
const holderOf = (app: App): string => (process.env.EDIT_CLOUD_HOLDER ?? "").trim() || app.machine;

export const contextOf = (app: App): run.Context => ({ origin: `http://127.0.0.1:${app.port}`, port: app.port, cacheDir: app.store.cacheDir(), holder: holderOf(app), by: by() });

async function openartState(): Promise<Response> {
  const accounts = await Promise.all(
    openart.ACCOUNTS.map(async (one): Promise<OpenArtAccount> => {
      const answer = await openart.account(undefined, one).catch((error: unknown) => {
        diag.warn("thumbnails", `OpenArt ${one.id}: ${diag.messageOf(error)}`);
        return { plan: null, credits: null };
      });
      return { id: one.id, name: one.name, ...answer };
    }),
  );
  if (accounts.every((one) => one.credits === null && one.plan === null)) throw new ApiError(502, "OpenArt didn't answer.");
  const list = await openart.imageModels().catch(() => []);
  const model = list.find((one) => one.id === run.pickModel(list, false));
  const state: OpenArtState = { accounts, current: openart.current().id, picture: model !== undefined && model.credits !== null ? { model: model.name, credits: model.credits } : null };
  return json(state);
}

function failed(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof cloud.Missing) throw notFound(error.message);
  if (error instanceof cloud.Conflict) throw new ApiError(409, "Someone else changed this thumbnail at the same moment: try again.");
  throw new ApiError(502, diag.messageOf(error));
}

const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const LIMIT = 20 * 1024 * 1024;
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const shortId = () => Math.random().toString(36).slice(2, 10);
const cleanName = (name: string, fallback: string) => name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[^\p{L}\p{N} _-]+/gu, " ").trim().slice(0, 80) || fallback;

function picture(bytes: Uint8Array, type: string, cache = "private, max-age=86400"): Response {
  return new Response(bytes, { headers: { "content-type": type, "cache-control": cache } });
}

export function routes(router: Router<App>): void {
  router
    .get("/api/thumbnails", async () => {
      guard();
      try {
        return json({ thumbnails: await cloud.list() });
      } catch (error) {
        failed(error);
      }
    })
    .post("/api/thumbnails", async (context: Context) => {
      guard();
      const body = await readJson<{ title?: unknown; brief?: unknown }>(context).catch(() => ({}) as Record<string, unknown>);
      const who = by();
      // A new one starts under a placeholder title ("Thumbnail 1", the next free number) until the person names it.
      let title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
      if (title === "") {
        const taken = new Set((await cloud.list().catch(() => [])).map((row) => row.summary.title));
        let next = 1;
        while (taken.has(`Thumbnail ${next}`)) next++;
        title = `Thumbnail ${next}`;
      }
      const thumb = run.fresh(newId("t"), who, title, typeof body.brief === "string" ? body.brief.trim().slice(0, 600) : "");
      try {
        await cloud.commit(thumb, 0, who);
        return json({ id: thumb.id });
      } catch (error) {
        failed(error);
      }
    })
    // The page headless Chrome draws on (render.ts), and what it loads.
    .get("/api/thumbnails/renderer", () => new Response(render.page(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }))
    .get("/api/thumbnails/fonts/{name}", async ({ params }: Context) => {
      const file = assets.FONT_FILES[params.name ?? ""];
      if (file === undefined) throw notFound("No such font.");
      const type = (params.name ?? "").endsWith(".otf") ? "font/otf" : "font/ttf";
      return picture(new Uint8Array(await Bun.file(file).arrayBuffer()), type, "public, max-age=604800");
    })
    // The team's OpenArt accounts with their credits, the one in use on this Mac, and what a picture costs on it.
    .get("/api/thumbnails/openart", () => {
      guard();
      return openartState();
    })
    .put("/api/thumbnails/openart", async (context: Context) => {
      guard();
      const body = await readJson<{ account?: unknown }>(context);
      if (typeof body.account !== "string") throw bad("account is one of the team's OpenArt accounts.");
      try {
        openart.choose(body.account);
      } catch (error) {
        throw bad(diag.messageOf(error));
      }
      return openartState();
    })
    .get("/api/thumbnails/assets/{asset}/file", async ({ params, app }: Context) => {
      try {
        const { bytes, type } = await assets.bytesOf(app.store.cacheDir(), params.asset!);
        return picture(bytes, type);
      } catch (error) {
        failed(error);
      }
    })
    .get("/api/thumbnails/{id}", async ({ params }: Context) => {
      guard();
      try {
        const found = await cloud.get(params.id!);
        if (found === null) throw notFound("This thumbnail was deleted.");
        const live = run.liveOf(found.thumb.id);
        const thumb = live !== null && found.thumb.run !== null ? { ...found.thumb, run: { ...found.thumb.run, ...live } } : found.thumb;
        return json({ thumb, rev: found.rev });
      } catch (error) {
        failed(error);
      }
    })
    // The person's change: its title or brief (only what's given). The layout is Claude's.
    .put("/api/thumbnails/{id}", async (context: Context) => {
      guard();
      const body = await readJson<{ title?: unknown; brief?: unknown }>(context);
      try {
        const { thumb, rev } = await cloud.change(context.params.id!, by(), (thumb) => {
          if (typeof body.title === "string") thumb.title = body.title.trim().slice(0, 120);
          if (typeof body.brief === "string") thumb.brief = body.brief.trim().slice(0, 600);
        });
        return json({ thumb, rev });
      } catch (error) {
        failed(error);
      }
    })
    .delete("/api/thumbnails/{id}", async ({ params }: Context) => {
      guard();
      run.stop(params.id!);
      try {
        await cloud.remove(params.id!, by());
        return empty(204);
      } catch (error) {
        failed(error);
      }
    })
    .post("/api/thumbnails/{id}/chat", async (context: Context) => {
      guard();
      const body = await readJson<{ text?: unknown; images?: unknown }>(context);
      const images = Array.isArray(body.images) ? body.images.filter((one): one is string => typeof one === "string").slice(0, 8) : [];
      try {
        await run.chat(contextOf(context.app), context.params.id!, typeof body.text === "string" ? body.text : "", images);
        return json({ ok: true });
      } catch (error) {
        if (error instanceof Error && /^(Write what|Keep the message|Claude is)/.test(error.message)) throw bad(error.message);
        failed(error);
      }
    })
    // The version that ships, and showing another.
    .post("/api/thumbnails/{id}/versions/final", async (context: Context) => {
      guard();
      const body = await readJson<{ version?: unknown }>(context);
      try {
        const { thumb, rev } = await cloud.change(context.params.id!, by(), (thumb) => {
          if (typeof body.version !== "string" || takeFinal(thumb, body.version) === null) throw bad(`No version ${String(body.version)} to take as final.`);
        });
        return json({ thumb, rev });
      } catch (error) {
        failed(error);
      }
    })
    .post("/api/thumbnails/{id}/versions/switch", async (context: Context) => {
      guard();
      const body = await readJson<{ version?: unknown }>(context);
      try {
        const { thumb, rev } = await cloud.change(context.params.id!, by(), (thumb) => {
          if (typeof body.version !== "string" || switchVersion(thumb, body.version) === null) throw bad(`No version ${String(body.version)} to show.`);
        });
        return json({ thumb, rev });
      } catch (error) {
        failed(error);
      }
    })
    // One step back or forward on the layout's timeline (the person's changes and Claude's alike).
    .post("/api/thumbnails/{id}/undo", ({ params }: Context) => stepped(params.id!, true))
    .post("/api/thumbnails/{id}/redo", ({ params }: Context) => stepped(params.id!, false))
    .post("/api/thumbnails/{id}/stop", ({ params }: Context) => {
      guard();
      return json({ stopped: run.stop(params.id!) });
    })
    .post(
      "/api/thumbnails/{id}/images",
      async (context: Context) => {
        guard();
        const type = (context.request.headers.get("content-type") ?? "").split(";")[0]!.trim();
        const extension = IMAGE_TYPES[type];
        if (extension === undefined) throw bad("Add a JPEG, PNG or WebP picture.");
        const bytes = await readBytes(context.request, LIMIT);
        const size = sizeOf(bytes);
        if (size === null) throw bad("That picture can't be read.");
        const who = by();
        try {
          const key = await cloud.put(context.params.id!, bytes, type, extension);
          const image: ThumbImage = { id: shortId(), name: cleanName(context.query.get("name") ?? "", "picture"), key, from: "upload", width: size.width, height: size.height, at: Date.now(), by: who };
          const { thumb } = await cloud.change(context.params.id!, who, (thumb) => {
            thumb.images = [...thumb.images, image].slice(-60);
          });
          return json({ image, thumb });
        } catch (error) {
          failed(error);
        }
      },
      { bodyLimit: LIMIT },
    )
    .get("/api/thumbnails/{id}/images/{image}", async ({ params, app }: Context) => {
      try {
        const found = await cloud.get(params.id!);
        const image = found?.thumb.images.find((one) => one.id === params.image);
        if (image === undefined) throw notFound("That picture isn't with this thumbnail.");
        return picture(await assets.cached(app.store.cacheDir(), image.key), assets.typeOf(image.key));
      } catch (error) {
        failed(error);
      }
    })
    // The browser's own drawing of the layers it just saved (the same drawing Claude's looks use): the list's picture.
    .put(
      "/api/thumbnails/{id}/render",
      async (context: Context) => {
        guard();
        const bytes = await readBytes(context.request, LIMIT);
        if (sizeOf(bytes) === null) throw bad("Send the drawing as a PNG or JPEG.");
        const type = bytes[0] === 0x89 ? "image/png" : "image/jpeg";
        try {
          const key = await cloud.put(context.params.id!, bytes, type, type === "image/png" ? "png" : "jpg");
          await cloud.change(context.params.id!, by(), (thumb) => {
            thumb.render = { key, at: Date.now() };
          });
          return json({ key });
        } catch (error) {
          failed(error);
        }
      },
      { bodyLimit: LIMIT },
    )
    .get("/api/thumbnails/{id}/render", async ({ params, app }: Context) => {
      guard();
      try {
        const found = await cloud.get(params.id!);
        if (found === null) throw notFound("This thumbnail was deleted.");
        const { thumb } = found;
        if (thumb.render !== null) return picture(await assets.cached(app.store.cacheDir(), thumb.render.key), assets.typeOf(thumb.render.key));
        // Changed with nobody's page open to draw it (Claude's undo, another Mac): drawn here, the canvas as it is, and kept.
        if (thumb.design.layers.length === 0) throw notFound("Nothing on it yet.");
        const { bytes } = await render.draw(contextOf(app).origin, thumb.id, thumb.design);
        const key = await cloud.put(thumb.id, bytes, "image/png", "png");
        await cloud.change(thumb.id, by(), (fresh) => {
          if (fresh.render !== null || canonical(fresh.design) !== canonical(thumb.design)) return false;
          fresh.render = { key, at: Date.now() };
        });
        return picture(bytes, "image/png", "private, no-cache");
      } catch (error) {
        failed(error);
      }
    })
    .post("/mcp/thumbnails/{token}", async (context: Context) => {
      const body = await readJson<unknown>(context);
      const answers = (await Promise.all((Array.isArray(body) ? body : [body]).map((message) => run.answerTo(context.params.token ?? "", message)))).filter((one) => one !== null);
      if (answers.length === 0) return empty(202);
      return json(Array.isArray(body) ? answers : answers[0]);
    });
}

async function stepped(id: string, back: boolean): Promise<Response> {
  guard();
  try {
    let taken: string | null = null;
    const { thumb, rev } = await cloud.change(id, by(), (thumb) => {
      const one = step(thumb, back);
      taken = one === null ? null : one.label;
      return one !== null;
    });
    return json({ thumb, rev, step: taken });
  } catch (error) {
    failed(error);
  }
}
