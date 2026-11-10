// Settings → Beta (beta.ts): off unless switched on, kept for this computer
// in <home>/beta.json, and only true or false taken.

import { expect, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";

import { read } from "../src/beta.ts";
import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import { fixtureHome } from "./helpers/home.ts";

test("Edit V2 is off until switched on, and stays as switched", async () => {
  const { app, cleanup } = fixtureHome("beta");
  try {
    const router = buildRouter();
    const ask = async (method: string, body?: unknown) => {
      const response = (await respond(app, router, new Request("http://localhost:7700/api/beta", { method, headers: { host: "localhost:7700", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), null))!;
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    expect((await ask("GET")).body).toEqual({ v2: false });
    expect(await ask("PUT", { v2: true })).toEqual({ status: 200, body: { v2: true } });
    expect((await ask("GET")).body).toEqual({ v2: true });
    expect(read(app.store.home)).toEqual({ v2: true });
    expect(JSON.parse(fs.readFileSync(join(app.store.home, "beta.json"), "utf8"))).toEqual({ v2: true });
    expect((await ask("PUT", { v2: "yes" })).status).toBe(400);
    expect((await ask("PUT", { v2: false })).body).toEqual({ v2: false });
    expect((await ask("GET")).body).toEqual({ v2: false });
    // The old Home beta's key is nothing now.
    fs.writeFileSync(join(app.store.home, "beta.json"), JSON.stringify({ home: true }));
    expect((await ask("GET")).body).toEqual({ v2: false });
    fs.writeFileSync(join(app.store.home, "beta.json"), "not json");
    expect((await ask("GET")).body).toEqual({ v2: false });
  } finally {
    cleanup();
  }
});
