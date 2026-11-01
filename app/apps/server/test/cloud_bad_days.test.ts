// Convex through the relay on its bad days: a 503 and a 429 on a query asked again, a mutation never
// asked again blind, a relay that's slow, the database paused for a move, an answer that isn't Convex's,
// and a conflict, each with its kind.

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as cloud from "../src/cloud.ts";
import { kindOf } from "../src/effect/service.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;
const ROUTE = "/v1/cloud/convex";

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "relay-token" });
  cloud.convexRetry.baseMs = 1;
});
afterAll(() => {
  cloud.convexRetry.baseMs = 500;
  restore();
  mock.stop();
});

const ok = (value: unknown) => Response.json({ status: "success", value });
const asked = () => mock.calls(ROUTE, "POST").length;
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as cloud.ConvexFailure);

test("a query the relay fails for a moment (503, then 429) is asked again", async () => {
  const before = asked();
  mock.on("POST", ROUTE, () => ok({ id: "p" }));
  mock.on("POST", ROUTE, () => Response.json({ error: "busy" }, { status: 429, headers: { "retry-after": "0" } }), 1);
  mock.on("POST", ROUTE, () => Response.json({ error: "down" }, { status: 503 }), 1);
  expect(await cloud.convexCall("query", "edit:getProject", { projectId: "p" }, 5)).toEqual({ id: "p" });
  expect(asked() - before).toBe(3);
});

test("a mutation isn't asked again blind: its answer may have been lost after it landed", async () => {
  const before = asked();
  mock.on("POST", ROUTE, () => Response.json({ error: "down" }, { status: 503 }), 1);
  const failed = await failure(cloud.convexCall("mutation", "edit:commitProject", { projectId: "p" }, 5));
  expect(failed?.kind).toBe("relay");
  expect(failed?.status).toBe(503);
  expect(kindOf(failed)).toBe("temporary");
  expect(asked() - before).toBe(1);
});

test("a relay that doesn't answer in time: a query is tried three times, a mutation once, both offline", async () => {
  mock.on("POST", ROUTE, async () => (await Bun.sleep(1500), ok(null)), 4);
  let before = asked();
  const query = await failure(cloud.convexCall("query", "edit:getProject", { projectId: "p" }, 0.2));
  expect(query?.kind).toBe("unreachable");
  expect(query?.message).toStartWith("could not reach Edit's relay");
  expect(asked() - before).toBe(3);
  before = asked();
  const mutation = await failure(cloud.convexCall("mutation", "edit:commitProject", { projectId: "p" }, 0.2));
  expect(mutation?.kind).toBe("unreachable");
  expect(asked() - before).toBe(1);
}, 30_000);

test("the database paused for a move reads as offline, and isn't asked again by the call", async () => {
  const before = asked();
  mock.on("POST", ROUTE, () => Response.json({ error: "the cloud is moving to its new home" }, { status: 503 }), 3);
  const failed = await failure(cloud.convexCall("query", "edit:getProject", { projectId: "p" }, 5));
  expect(failed?.kind).toBe("unreachable");
  expect(kindOf(failed)).toBe("later");
  expect(asked() - before).toBe(1);
});

test("an answer that isn't Convex's is said, and a conflict is the sync's to settle", async () => {
  mock.on("POST", ROUTE, () => Response.json({ rows: [] }), 1);
  const odd = await failure(cloud.convexCall("query", "edit:listProjects", {}, 5));
  expect(odd?.message).toContain("unexpected answer from Convex");
  expect(kindOf(odd)).toBe("permanent");

  mock.on("POST", ROUTE, () => Response.json({ status: "error", errorMessage: "Uncaught ConvexError", errorData: { code: "conflict", message: "saved elsewhere", rev: 9 } }), 1);
  const conflict = await failure(cloud.convexCall("mutation", "edit:commitProject", { projectId: "p" }, 5));
  expect(conflict?.code).toBe("conflict");
  expect(kindOf(conflict)).toBe("later");
});
