import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import * as relay from "../src/relay.ts";
import { scratch } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "test-token" });
});

afterAll(() => {
  restore();
  mock.stop();
});

test("private_relay_token_is_escaped_and_cannot_add_headers", () => {
  expect(relay.authConfig(null)).toBe("");
  expect(relay.authConfig("test-token")).toBe('header = "Authorization: Bearer test-token"\n');
  expect(relay.authConfig('a"b\\c')).toBe('header = "Authorization: Bearer a\\"b\\\\c"\n');
  expect(() => relay.authConfig("token\nheader = evil")).toThrow("EDIT_RELAY_TOKEN contains a control character");
  expect(() => relay.authHeaders("token\r\nx-evil: 1")).toThrow("EDIT_RELAY_TOKEN contains a control character");
});

test("failures_say_what_the_relay_said", () => {
  expect(relay.failure("404", '{"error":"not found"}', "cloud storage")).toBe(
    "Edit's relay doesn't do cloud storage yet (it needs deploying).",
  );
  expect(relay.failure("401", '{"error":"This relay needs Edit\'s cloud token."}', "x")).toBe(
    "This relay needs Edit's cloud token. (401)",
  );
  expect(relay.failure("502", "Bad gateway", "x")).toBe("Bad gateway (502)");
});

test("the env token wins over the saved one, and an empty one is none", () => {
  relay.setSavedToken("saved");
  expect(relay.token()).toBe("test-token");
  const before = process.env.EDIT_RELAY_TOKEN;
  process.env.EDIT_RELAY_TOKEN = "";
  try {
    expect(relay.envToken()).toBeNull();
    expect(relay.token()).toBe("saved");
    relay.setSavedToken("");
    expect(relay.token()).toBeNull();
    expect(relay.cloudEnabled()).toBe(false);
  } finally {
    process.env.EDIT_RELAY_TOKEN = before;
    relay.setSavedToken(null);
  }
});

test("json and call carry the bearer and report the relay's reason", async () => {
  mock.on("POST", "/v1/echo", (request) =>
    Response.json({ auth: request.headers.get("authorization"), body: request.json() }),
  );
  const answer = await relay.json<{ auth: string; body: unknown }>("POST", "/v1/echo", { a: 1 }, "echo", 10);
  expect(answer).toEqual({ auth: "Bearer test-token", body: { a: 1 } });
  await expect(relay.json("GET", "/v1/missing", null, "missing things", 10)).rejects.toThrow(
    "Edit's relay doesn't do missing things yet (it needs deploying).",
  );

  const { dir, cleanup } = scratch("relay");
  try {
    mock.on("POST", "/v1/file", () => new Response("bytes", { headers: { "x-request-id": "req-7" } }));
    expect(await relay.call("POST", "/v1/file", { x: 1 }, `${dir}/out`, "files")).toBe("req-7");
    expect(fs.readFileSync(`${dir}/out`, "utf8")).toBe("bytes");
    mock.on("POST", "/v1/refuse", () => Response.json({ error: "over the daily limit" }, { status: 429 }));
    await expect(relay.call("POST", "/v1/refuse", null, `${dir}/refused`, "files")).rejects.toThrow(
      "over the daily limit (429)",
    );
    expect(fs.existsSync(`${dir}/refused`)).toBe(false);
  } finally {
    cleanup();
  }
});

test("an unreachable relay says so", async () => {
  const before = process.env.EDIT_RELAY_URL;
  process.env.EDIT_RELAY_URL = "http://127.0.0.1:9";
  try {
    await expect(relay.json("GET", "/v1/x", null, "x", 5)).rejects.toThrow(/^could not reach Edit's relay: /);
  } finally {
    process.env.EDIT_RELAY_URL = before;
  }
});
