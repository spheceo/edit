// Thumbnails' HTTP API, under /api/thumbnails, for the same people as ideas
// (an `ideas.*` capability, or an admin): the list, a thumbnail's page (its
// layers, its images, the chat with Claude), the library of overlays, the
// fonts and the page headless Chrome draws on. Claude's tools are served at
// /mcp/thumbnails/<token> (run.ts), for the turns on this Mac only.

import { assetRef, type Asset, type ThumbImage } from "@edit/types/thumbnails";

import { creator } from "../accounts.ts";
import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { ApiError, bad, empty, json, notFound } from "../http/errors.ts";
import { readBytes, readJson, type RouteContext, type Router } from "../http/router.ts";
import { mayIdeas } from "../ideas/routes.ts";
import * as assets from "./assets.ts";
import * as cloud from "./cloud.ts";
import { designOf, record, step } from "./design.ts";
import * as openart from "./openart.ts";
import * as render from "./render.ts";
import * as run from "./run.ts";
import { canonical } from "./run.ts";
import { sizeOf } from "./size.ts";

type Context = RouteContext<App>;

const NO_THUMBNAILS = "Your account can't make thumbnails yet: an admin can give you ideas at accounts.spheceo.com.";

function guard(): void {
  if (!mayIdeas()) throw new ApiError(403, NO_THUMBNAILS);
}

const by = (): string => creator()?.name || "Edit";
const holderOf = (app: App): string => (process.env.EDIT_CLOUD_HOLDER ?? "").trim() || app.machine;

export const contextOf = (app: App): run.Context => ({ origin: `http://127.0.0.1:${app.port}`, port: app.port, cacheDir: app.store.cacheDir(), holder: holderOf(app), by: by() });

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
      const thumb = run.fresh(newId("t"), who, typeof body.title === "string" ? body.title.trim().slice(0, 120) : "", typeof body.brief === "string" ? body.brief.trim().slice(0, 600) : "");
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
      return picture(new Uint8Array(await Bun.file(file).arrayBuffer()), "font/ttf", "public, max-age=604800");
    })
    .get("/api/thumbnails/openart", async () => {
      guard();
      try {
        const [account, models] = await Promise.all([openart.account(), openart.imageModels()]);
        return json({ ...account, models: models.length });
      } catch (error) {
        throw new ApiError(502, diag.messageOf(error));
      }
    })
    .get("/api/thumbnails/assets", async () => {
      guard();
      try {
        return json({ assets: await assets.all() });
      } catch (error) {
        failed(error);
      }
    })
    .post(
      "/api/thumbnails/assets",
      async (context: Context) => {
        guard();
        const type = (context.request.headers.get("content-type") ?? "").split(";")[0]!.trim();
        const extension = IMAGE_TYPES[type];
        if (extension === undefined) throw bad("Add a PNG (with transparency for an overlay), JPEG or WebP.");
        const bytes = await readBytes(context.request, LIMIT);
        const size = sizeOf(bytes);
        if (size === null) throw bad("That picture can't be read.");
        const who = by();
        const name = cleanName(context.query.get("name") ?? "", "overlay");
        const kind = context.query.get("kind") === "sticker" ? "sticker" : "overlay";
        try {
          const id = newId("a");
          const key = await cloud.put("assets", bytes, type, extension);
          const asset: Asset = { id, name, note: (context.query.get("note") ?? "").trim().slice(0, 400), kind, width: size.width, height: size.height, builtIn: false, key, by: who, at: Date.now() };
          await cloud.putAsset(asset, who);
          assets.forget();
          return json({ asset });
        } catch (error) {
          failed(error);
        }
      },
      { bodyLimit: LIMIT },
    )
    .put("/api/thumbnails/assets/{asset}", async (context: Context) => {
      guard();
      const body = await readJson<{ name?: unknown; note?: unknown; kind?: unknown }>(context);
      const found = (await assets.all(true)).find((one) => one.id === context.params.asset);
      if (found === undefined || found.builtIn) throw notFound("Only the team's own assets can be changed.");
      const next: Asset = { ...found, ...(typeof body.name === "string" ? { name: cleanName(body.name, found.name) } : {}), ...(typeof body.note === "string" ? { note: body.note.trim().slice(0, 400) } : {}), ...(body.kind === "overlay" || body.kind === "sticker" ? { kind: body.kind } : {}) };
      try {
        await cloud.putAsset(next, by());
        assets.forget();
        return json({ asset: next });
      } catch (error) {
        failed(error);
      }
    })
    .delete("/api/thumbnails/assets/{asset}", async ({ params }: Context) => {
      guard();
      if (assets.BUILT_IN.some((one) => one.id === params.asset)) throw bad("Edit's own overlays stay.");
      try {
        await cloud.removeAsset(params.asset!, by());
        assets.forget();
        return empty(204);
      } catch (error) {
        failed(error);
      }
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
    // The person's change: its title, brief or layers (only what's given).
    .put("/api/thumbnails/{id}", async (context: Context) => {
      guard();
      const body = await readJson<{ title?: unknown; brief?: unknown; design?: unknown }>(context);
      try {
        const sources = body.design === undefined ? null : await sourcesFor(context.params.id!);
        const { thumb, rev } = await cloud.change(context.params.id!, by(), (thumb) => {
          if (typeof body.title === "string") thumb.title = body.title.trim().slice(0, 120);
          if (typeof body.brief === "string") thumb.brief = body.brief.trim().slice(0, 600);
          if (body.design !== undefined && sources !== null) record(thumb, designOf(body.design, thumb.design, sources), by());
        });
        return json({ thumb, rev });
      } catch (error) {
        if (error instanceof Error && !(error instanceof cloud.Missing) && !(error instanceof cloud.Conflict) && !(error instanceof ApiError) && body.design !== undefined) throw bad(error.message);
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
    .delete("/api/thumbnails/{id}/images/{image}", async ({ params }: Context) => {
      guard();
      try {
        const { thumb } = await cloud.change(params.id!, by(), (thumb) => {
          if (thumb.design.layers.some((one) => one.kind === "image" && one.source === params.image)) throw bad("That picture is on the thumbnail: take its layer off first.");
          const before = thumb.images.length;
          thumb.images = thumb.images.filter((one) => one.id !== params.image);
          return thumb.images.length !== before;
        });
        return json({ thumb });
      } catch (error) {
        failed(error);
      }
    })
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

async function sourcesFor(id: string): Promise<Set<string>> {
  const found = await cloud.get(id);
  if (found === null) throw new cloud.Missing("This thumbnail was deleted.");
  const library = await assets.all().catch(() => assets.BUILT_IN);
  return new Set([...found.thumb.images.map((one) => one.id), ...library.map((one) => assetRef(one.id))]);
}
