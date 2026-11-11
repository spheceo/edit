// The media package's routes: the library, the Drive link and
// the agent panel.

import { afterAll, beforeAll, expect, test } from "bun:test";

import type { App } from "../src/app.ts";
import { baseRouter, respond } from "../src/http/server.ts";
import * as fs from "node:fs";

import { routes } from "../src/media_tools.ts";
import * as modelChoice from "../src/model_choice.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({
    GOOGLE_DRIVE_CLIENT_ID: "id",
    GOOGLE_DRIVE_CLIENT_SECRET: "secret",
    GOOGLE_DOCS_REFRESH_TOKEN: "refresh",
    EDIT_LIBRARY_FOLDER: "root",
  });
});

afterAll(() => {
  restore();
  mock.stop();
});

function asker(app: App) {
  const router = baseRouter();
  routes(router);
  return async (method: string, path: string, body?: unknown) => {
    const headers = new Headers({ host: "localhost:7700" });
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = (await respond(
      app,
      router,
      new Request(`http://localhost:7700${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      null,
    ))!;
    const text = await response.text();
    return { status: response.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
  };
}

test("the library route lists Drive, and says when it can't (503)", async () => {
  const { app, cleanup } = fixtureHome("routes-library");
  try {
    const ask = asker(app);
    const listed = await ask("GET", "/api/library");
    expect(listed.status).toBe(200);
    expect(listed.text).toBe('{"sounds":[],"guide":""}');
    expect((await ask("GET", "/api/library?refresh=maybe")).status).toBe(400);
    mock.on("GET", "/www.googleapis.com/drive/v3/files", () => Response.json({ error: { message: "nope" } }, { status: 403 }), 1);
    const refused = await ask("GET", "/api/library?refresh=true");
    expect(refused.status).toBe(503);
    expect(refused.json()).toEqual({ error: "Google Drive refused the sound library (403): nope" });
    const missing = await ask("POST", "/api/projects/p1/library", { sound: "x" });
    expect(missing.status).toBe(422);
    expect(missing.text).toContain("missing field `origin`");
  } finally {
    cleanup();
  }
});

test("the agent panel's routes", async () => {
  const { app, cleanup } = fixtureHome("routes-agent");
  try {
    const ask = asker(app);
    const project = app.store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    expect((await ask("GET", "/api/projects/nope/agent")).json()).toEqual({ error: "no such project" });
    expect((await ask("GET", `/api/projects/${project}/agent`)).text).toBe('{"auth_retry":null,"effort":null,"entries":[],"model":null,"model_name":"Opus 5.5","queue":[],"revising":false,"running":false}');
    expect((await ask("POST", `/api/projects/${project}/agent/retry-claude`, { user: "not-a-failed-message" })).json()).toEqual({ ok: true, resumed: false });
    const empty = await ask("POST", `/api/projects/${project}/agent`, { text: "  " });
    expect(empty.status).toBe(400);
    expect(empty.json()).toEqual({ error: "say something" });
    expect((await ask("POST", `/api/projects/${project}/agent/reset`)).text).toBe('{"ok":true}');
    expect((await ask("POST", `/api/projects/${project}/agent/stop`)).text).toBe('{"ok":true}');
  } finally {
    cleanup();
  }
});

test("the model menu's pick: Opus at medium until picked, kept in the home, anything unknown taken as the default", async () => {
  const { app, home, cleanup } = fixtureHome("routes-models");
  try {
    const ask = asker(app);
    const hq = { hq_effort: "high", hq_model: "claude-fable-5-2" } as const;
    expect((await ask("GET", "/api/models")).text).toBe('{"effort":"medium","hq_effort":"high","hq_model":"claude-fable-5-2","revision":"claude-opus-5-5"}');
    expect((await ask("PUT", "/api/models", { revision: "claude-sonnet-5-5" })).json()).toEqual({ effort: "medium", revision: "claude-sonnet-5-5", ...hq });
    expect((await ask("PUT", "/api/models", { effort: "max" })).json()).toEqual({ effort: "max", revision: "claude-sonnet-5-5", ...hq });
    expect((await ask("PUT", "/api/models", { effort: "xhigh" })).json()).toEqual({ effort: "xhigh", revision: "claude-sonnet-5-5", ...hq });
    expect(JSON.parse(fs.readFileSync(`${home}/models.json`, "utf8"))).toEqual({ revision: "claude-sonnet-5-5", effort: "xhigh", ...hq });
    // Bodycam HQ's pick (Edit V2): every model, kept apart from the other chats' (neither changes the other).
    expect((await ask("PUT", "/api/models", { hq_model: "claude-opus-5-5", hq_effort: "low" })).json()).toEqual({ effort: "xhigh", revision: "claude-sonnet-5-5", hq_effort: "low", hq_model: "claude-opus-5-5" });
    expect((await ask("PUT", "/api/models", { effort: "medium" })).json()).toEqual({ effort: "medium", revision: "claude-sonnet-5-5", hq_effort: "low", hq_model: "claude-opus-5-5" });
    expect((await ask("PUT", "/api/models", { hq_model: "claude-sonnet-5-5" })).json()).toMatchObject({ hq_model: "claude-sonnet-5-5", revision: "claude-sonnet-5-5", effort: "medium" });
    expect(JSON.parse(fs.readFileSync(`${home}/models.json`, "utf8"))).toEqual({ revision: "claude-sonnet-5-5", effort: "medium", hq_model: "claude-sonnet-5-5", hq_effort: "low" });
    // A saved file from before Bodycam HQ's pick reads it as Fable 5.2 at high.
    fs.writeFileSync(`${home}/models.json`, JSON.stringify({ revision: "claude-sonnet-5-5", effort: "low" }));
    modelChoice.use(`${home}/elsewhere`);
    modelChoice.use(home);
    expect(modelChoice.current()).toEqual({ revision: "claude-sonnet-5-5", effort: "low", ...hq });
    expect((await ask("PUT", "/api/models", { revision: "gpt-6", effort: "ultra", hq_model: "gpt-6", hq_effort: "ultra" })).json()).toEqual({ effort: "medium", revision: "claude-opus-5-5", ...hq });
    expect((await ask("PUT", "/api/models", ["x"])).status).toBe(400);
  } finally {
    modelChoice.save({});
    cleanup();
  }
});

test("the Drive link route checks the project's link (none here)", async () => {
  const { app, cleanup } = fixtureHome("routes-drive");
  try {
    const ask = asker(app);
    const project = app.store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    expect((await ask("GET", `/api/projects/${project}/drive`)).text).toBe('{"drive":null}');
    const gone = await ask("GET", "/api/projects/nope/drive");
    expect(gone.status).toBe(404);
    expect(gone.json()).toEqual({ error: "no such project" });
  } finally {
    cleanup();
  }
});
