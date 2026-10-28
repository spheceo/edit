import { expect, test } from "bun:test";

import * as accounts from "../src/accounts.ts";
import type { App } from "../src/app.ts";
import { timings } from "../src/diag.ts";
import { mapAssets, staticAsset, useAssets } from "../src/http/assets.ts";
import { ApiError, bad, json } from "../src/http/errors.ts";
import { checkHost, mapSibling, sameOrigin } from "../src/http/host.ts";
import { badShape, readJson, Router, valueEnd } from "../src/http/router.ts";
import { baseRouter, listen, respond } from "../src/http/server.ts";
import { fixtureHome } from "./helpers/home.ts";

test("origin_must_match_host_and_port", () => {
  expect(sameOrigin("http://localhost:7700", "localhost:7700")).toBe(true);
  expect(sameOrigin("https://kenobi.example", "kenobi.example:443")).toBe(true);
  expect(sameOrigin("http://[::1]:7700", "[::1]:7700")).toBe(true);
  for (const origin of [
    "null",
    "https://evil.example",
    "http://localhost:5173",
    "http://localhost:7700/path",
    "http://localhost:7700?x=1",
  ]) {
    expect(sameOrigin(origin, "localhost:7700")).toBe(false);
  }
});

test("the_map_page_fetches_its_tiles_from_its_localhost_siblings", () => {
  expect(mapSibling("http://127.0.0.1:7700", "t3.localhost:7700")).toBe(true);
  expect(mapSibling("http://127.0.0.1:7700", "t3.localhost:7701")).toBe(false);
  expect(mapSibling("https://evil.example", "t3.localhost:7700")).toBe(false);
  expect(mapSibling("http://evil.localhost.example:7700", "t3.localhost:7700")).toBe(false);
  const tile = (path: string, origin: string, method = "GET") =>
    checkHost(new Request(`http://t3.localhost:7700${path}`, { method, headers: { host: "t3.localhost:7700", origin, "sec-fetch-site": "cross-site" } }), ["localhost", "127.0.0.1"]);
  expect(tile("/v1/3dtiles/datasets/x.glb", "http://127.0.0.1:7700")).toBeNull();
  // Only tiles, only GET, only from Edit's own page.
  expect(tile("/api/projects", "http://127.0.0.1:7700")?.status).toBe(403);
  expect(tile("/v1/3dtiles/datasets/x.glb", "http://127.0.0.1:7700", "POST")?.status).toBe(403);
  expect(tile("/v1/3dtiles/datasets/x.glb", "https://evil.example")?.status).toBe(403);
});

function request(path: string, init: RequestInit & { host?: string } = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", init.host ?? "localhost:7700");
  return new Request(`http://localhost:7700${path}`, { ...init, headers });
}

function router(): Router<App> {
  return baseRouter()
    .get("/api/projects/{id}", ({ params }) => json({ id: params.id }))
    .get("/api/projects/{id}/media/{media}/{kind}", ({ params }) => json({ kind: params.kind }))
    .post("/api/projects/{id}/media/{media}/transcribe", () => json({ transcribing: true }))
    .post("/api/echo", async (context) => json(await readJson(context)))
    .get("/api/refuse", () => {
      throw bad("no paths");
    })
    .get("/api/crash", () => {
      const nothing = undefined as unknown as { field: string };
      return json(nothing.field);
    });
}

test("routes match as axum's: literal segments win, params decode, other methods are 405", async () => {
  const { app, cleanup } = fixtureHome("http-routes");
  try {
    const routes = router();
    const get = async (path: string, init?: RequestInit) => (await respond(app, routes, request(path, init), null))!;
    expect(await (await get("/api/projects/p%201")).json()).toEqual({ id: "p 1" });
    expect(await (await get("/api/projects/p1/media/m1/preview")).json()).toEqual({ kind: "preview" });
    // A literal segment beats a parameter: transcribe is POST only, so GET is refused rather than taken as {kind}.
    expect((await get("/api/projects/p1/media/m1/transcribe")).status).toBe(405);
    const posted = await get("/api/projects/p1/media/m1/transcribe", { method: "POST" });
    expect(await posted.json()).toEqual({ transcribing: true });
    const wrong = await get("/api/projects/p1", { method: "DELETE" });
    expect([wrong.status, wrong.headers.get("allow")]).toEqual([405, "GET"]);
    expect(routes.list()).toContain("POST /mcp");
    // Every request is timed under its route.
    expect(timings().some((timing) => timing.name === "GET /api/projects/{id}")).toBe(true);
  } finally {
    cleanup();
  }
});

test("failures answer with JSON and a crash doesn't take the server down", async () => {
  const { app, cleanup } = fixtureHome("http-errors");
  try {
    const routes = router();
    const refused = (await respond(app, routes, request("/api/refuse"), null))!;
    expect([refused.status, await refused.json()]).toEqual([400, { error: "no paths" }]);
    expect(refused.headers.get("x-content-type-options")).toBe("nosniff");
    const crashed = (await respond(app, routes, request("/api/crash"), null))!;
    expect(crashed.status).toBe(500);
    expect(((await crashed.json()) as { error: string }).error).toMatch(/^this request crashed \(.*\); this is a bug in Edit$/);
    const failed = timings().find((timing) => timing.name === "GET /api/crash")!;
    expect(failed.failed).toBe(1);
    // Bodies are refused as axum's Json extractor refuses them.
    const noType = (await respond(app, routes, request("/api/echo", { method: "POST", body: "{}" }), null))!;
    expect([noType.status, await noType.text()]).toEqual([415, "Expected request with `Content-Type: application/json`"]);
    const broken = (await respond(
      app,
      routes,
      request("/api/echo", { method: "POST", body: "{", headers: { "content-type": "application/json" } }),
      null,
    ))!;
    expect(broken.status).toBe(400);
    expect(await broken.text()).toStartWith("Failed to parse the request body as JSON: ");
    const big = (await respond(
      app,
      routes,
      request("/api/echo", { method: "POST", body: JSON.stringify("x".repeat(3 << 20)), headers: { "content-type": "application/json" } }),
      null,
    ))!;
    expect([big.status, await big.text()]).toEqual([413, "Failed to buffer the request body: length limit exceeded"]);
    expect(new ApiError(423, "held", false).response().status).toBe(423);
  } finally {
    cleanup();
  }
});

test("a body of the wrong shape says where, as serde does (line and column just past the value)", async () => {
  const { app, cleanup } = fixtureHome("http-shape");
  try {
    const routes = baseRouter().post("/api/shape", async (context) => {
      const given = (await readJson(context)) as Record<string, unknown>;
      if (given.name === undefined) throw badShape("missing field `name`");
      if (typeof given.name !== "string") throw badShape("name: invalid type: integer `3`, expected a string");
      throw badShape("project.clips[0]: missing field `start`");
    });
    const ask = async (body: string) => {
      const init = { method: "POST", body, headers: { "content-type": "application/json" } };
      const response = (await respond(app, routes, request("/api/shape", init), null))!;
      return [response.status, await response.text()];
    };
    const prefix = "Failed to deserialize the JSON body into the target type: ";
    // As serde_path_to_error words them.
    expect(await ask('{"width":3}')).toEqual([422, `${prefix}missing field \`name\` at line 1 column 11`]);
    expect(await ask('{ "name": 3 }')).toEqual([422, `${prefix}name: invalid type: integer \`3\`, expected a string at line 1 column 11`]);
    expect(await ask('{"name":"x",\n "project":{"clips":[{"id":"x","track":"nope"}]}}')).toEqual([
      422,
      `${prefix}project.clips[0]: missing field \`start\` at line 2 column 46`,
    ]);
    expect(valueEnd('{"a":[1,{"b":"}"}]}', ["a", 1])).toBe(17);
  } finally {
    cleanup();
  }
});

test("the host check turns away rebinding and cross-site requests", async () => {
  const { app, cleanup } = fixtureHome("http-hosts");
  try {
    const routes = router();
    const asked = async (init: RequestInit & { host?: string }) => (await respond(app, routes, request("/api/projects/p1", init), null))!;
    const evil = await asked({ host: "evil.example:7700" });
    expect([evil.status, await evil.text()]).toEqual([403, "host evil.example is not allowed; set EDIT_HOSTS"]);
    expect((await asked({ host: "edit.localhost:7700" })).status).toBe(200);
    expect((await asked({ host: "[::1]:7700" })).status).toBe(200);
    expect((await asked({ host: "" })).status).toBe(403);
    const crossOrigin = await asked({ headers: { origin: "http://localhost:5173" } });
    expect([crossOrigin.status, await crossOrigin.text()]).toEqual([403, "cross-origin requests are not allowed"]);
    const crossSite = await asked({ headers: { "sec-fetch-site": "cross-site" } });
    expect([crossSite.status, await crossSite.text()]).toEqual([403, "cross-site requests are not allowed"]);
    const ok = await asked({ headers: { origin: "http://localhost:7700" } });
    expect([ok.status, ok.headers.get("x-frame-options")]).toEqual([200, "DENY"]);
  } finally {
    cleanup();
  }
});

test("the sign-in's redirect back from accounts.spheceo.com gets through the cross-site guard, and nothing else does", async () => {
  const { app, cleanup } = fixtureHome("http-callback");
  try {
    const routes = router();
    accounts.routes(routes);
    // What Chrome sends on the top-level redirect from the accounts site.
    const chrome = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "sec-fetch-user": "?1",
      referer: "https://accounts.spheceo.com/",
    };
    const back = (await respond(app, routes, request("/callback?code=c1&state=s1", { headers: chrome, host: "127.0.0.1:7700" }), null))!;
    // Through the guard to the sign-in, which turns away a state it didn't start.
    expect(back.status).toBe(400);
    expect(await back.text()).toContain("isn't the one Edit started");
    const nullOrigin = (await respond(app, routes, request("/callback?code=c1&state=s1", { headers: { ...chrome, origin: "null" }, host: "127.0.0.1:7700" }), null))!;
    expect(nullOrigin.status).toBe(400);
    // The same headers anywhere else, or a POST to /callback, still refused.
    const other = (await respond(app, routes, request("/api/projects/p1", { headers: chrome }), null))!;
    expect([other.status, await other.text()]).toEqual([403, "cross-site requests are not allowed"]);
    const posted = (await respond(app, routes, request("/callback", { method: "POST", headers: chrome }), null))!;
    expect(posted.status).toBe(403);
    // A host this server doesn't answer to is refused even there.
    const rebound = (await respond(app, routes, request("/callback?code=c1&state=s1", { headers: chrome, host: "evil.example:7700" }), null))!;
    expect(rebound.status).toBe(403);
  } finally {
    cleanup();
  }
});

test("the UI's files, its shell for SPA routes, and fonts", async () => {
  const { app, cleanup } = fixtureHome("http-static");
  try {
    useAssets(
      mapAssets(
        new Map<string, Uint8Array>([
          ["index.html", new TextEncoder().encode("<html>shell</html>")],
          ["assets/app-1.js", new TextEncoder().encode("console.log(1)")],
        ]),
      ),
    );
    const routes = router();
    const shell = (await respond(app, routes, request("/projects/p1"), null))!;
    expect([shell.status, await shell.text(), shell.headers.get("cache-control")]).toEqual([
      200,
      "<html>shell</html>",
      "no-cache",
    ]);
    expect(shell.headers.get("content-type")).toBe("text/html");
    const script = (await respond(app, routes, request("/assets/app-1.js"), null))!;
    expect([script.headers.get("content-type"), script.headers.get("cache-control")]).toEqual([
      "text/javascript",
      "public, max-age=31536000, immutable",
    ]);
    const missing = staticAsset("/x", mapAssets(new Map()));
    expect(missing.status).toBe(503);
    const font = (await respond(app, routes, request("/fonts/Nope.ttf"), null))!;
    expect([font.status, await font.json()]).toEqual([404, { error: "no such font" }]);
    expect((await respond(app, routes, request("/mcp"), null))!.status).toBe(405);
  } finally {
    cleanup();
  }
});

test("/api/ws streams the store's events", async () => {
  const { app, store, cleanup } = fixtureHome("http-ws");
  const server = listen(app, router(), "127.0.0.1", 0);
  try {
    const open = async (path: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, { headers: { host: "localhost" } } as unknown as string[]);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("websocket failed"));
      });
      return socket;
    };
    const socket = await open("/api/ws");
    const patched = await open("/api/ws?patches=1");
    const received: unknown[] = [];
    const got = new Promise<void>((resolve) => {
      socket.onmessage = (message) => {
        received.push(JSON.parse(String(message.data)));
        resolve();
      };
    });
    const asPatch: unknown[] = [];
    const gotPatch = new Promise<void>((resolve) => {
      patched.onmessage = (message) => {
        asPatch.push(JSON.parse(String(message.data)));
        resolve();
      };
    });
    const live = store.create("ws", { width: 1920, height: 1080, fps: 30 });
    await store.update(live.project.id, "ui", (project) => {
      project.name = "heard";
    });
    await got;
    expect(received[0]).toMatchObject({ type: "project", id: live.project.id, rev: 2, origin: "ui" });
    socket.close();
    // Asked for patches: only what changed, against the revision before.
    await gotPatch;
    expect(asPatch[0]).toEqual({
      type: "project",
      id: live.project.id,
      rev: 2,
      base_rev: 1,
      origin: "ui",
      patch: { set: { name: "heard" }, unset: [], lists: {} },
    });
    patched.close();
    // Through the real server too: a JSON-RPC ping.
    const ping = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]),
    });
    expect(await ping.json()).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    const note = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(note.status).toBe(202);
  } finally {
    void server.stop(true);
    cleanup();
  }
});
