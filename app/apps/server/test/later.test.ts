// Home's Later (later.ts): set aside until a time or for good, brought back,
// back by itself on its day (and listed until opened, two weeks at most),
// through the relay's Convex (the cloud mock's editLater).

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as cloud from "../src/cloud.ts";
import { respond } from "../src/http/server.ts";
import * as later from "../src/later.ts";
import { buildRouter } from "../src/routes.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  cloud.timing.sleep = async () => {};
});

afterAll(() => {
  restore();
  mock.stop();
});

test("set aside until a time or for good, brought back, and back by itself on its day until opened", async () => {
  const { app } = fixtureHome("later");
  const router = buildRouter();
  const ask = async (method: string, body?: unknown) => {
    const response = (await respond(app, router, new Request("http://localhost:7700/api/later", { method, headers: { host: "localhost:7700", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), null))!;
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const monday = Date.now() + 2 * 86_400_000;
  expect((await ask("POST", { key: "edit:p1793450000000-abc", until: monday })).status).toBe(200);
  expect((await ask("POST", { key: "idea:i1793450000000-xyz" })).status).toBe(200);
  const { entries } = (await ask("GET")).body as { entries: { key: string; until: number | null }[] };
  expect(entries.map(({ key, until }) => ({ key, until })).sort((a, b) => a.key.localeCompare(b.key))).toEqual([
    { key: "edit:p1793450000000-abc", until: monday },
    { key: "idea:i1793450000000-xyz", until: null },
  ]);
  // Refused: a key that isn't one, a time already gone.
  expect((await ask("POST", { key: "../etc" })).status).toBe(400);
  expect((await ask("POST", { key: "script:s1", until: Date.now() - 1000 })).status).toBe(400);
  // Brought back.
  expect((await ask("POST", { key: "idea:i1793450000000-xyz", back: true })).body).toEqual({ key: "idea:i1793450000000-xyz", back: true });
  expect((await later.list()).map((entry) => entry.key)).toEqual(["edit:p1793450000000-abc"]);
  // Its day come: still listed (the apps show it Back until someone opens it), and gone after two weeks unopened.
  expect((await later.list(monday + 1)).map((entry) => entry.key)).toEqual(["edit:p1793450000000-abc"]);
  expect(await later.list(monday + 15 * 86_400_000)).toEqual([]);
});
