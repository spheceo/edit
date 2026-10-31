// Settings → Beta (beta.ts): off unless switched on, kept for this Mac in
// <home>/beta.json, and only true or false taken.

import { expect, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";

import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import { fixtureHome } from "./helpers/home.ts";

test("the new Home is off until switched on, and stays as switched", async () => {
  const { app } = fixtureHome("beta");
  const router = buildRouter();
  const ask = async (method: string, body?: unknown) => {
    const response = (await respond(app, router, new Request("http://localhost:7700/api/beta", { method, headers: { host: "localhost:7700", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), null))!;
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  expect((await ask("GET")).body).toEqual({ home: false });
  expect(await ask("PUT", { home: true })).toEqual({ status: 200, body: { home: true } });
  expect((await ask("GET")).body).toEqual({ home: true });
  expect(JSON.parse(fs.readFileSync(join(app.store.home, "beta.json"), "utf8"))).toEqual({ home: true });
  expect((await ask("PUT", { home: "yes" })).status).toBe(400);
  expect((await ask("PUT", { home: false })).body).toEqual({ home: false });
  expect((await ask("GET")).body).toEqual({ home: false });
  fs.writeFileSync(join(app.store.home, "beta.json"), "not json");
  expect((await ask("GET")).body).toEqual({ home: false });
});
