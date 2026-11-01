// R2 and the relay on their bad days: a 503 on an upload asked again, a 403 said at once,
// a 429 on a download waited, a slow R2 abandoned and resumed, and the relay slow, refusing,
// or answering what isn't JSON.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import * as cloud from "../src/cloud.ts";
import { kindOf } from "../src/effect/service.ts";
import * as relay from "../src/relay.ts";
import { scratch } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "relay-token" });
  cloud.timing.sleep = async () => {};
});
afterAll(() => {
  cloud.timing.stallMs = 60_000;
  cloud.timing.connectMs = 30_000;
  restore();
  mock.stop();
});

const bytes = (size: number) => Uint8Array.from({ length: size }, (_, index) => index % 251);
const puts = (key: string) => mock.calls(new RegExp(`^/r2/${key.replace(/[/.]/g, "\\$&")}$`), "PUT").length;
const gets = (key: string) => mock.calls(new RegExp(`^/r2/${key.replace(/[/.]/g, "\\$&")}$`), "GET").length;

test("an upload R2 fails for a moment (500) is asked again; one it refuses (403) is said at once", async () => {
  const { dir, cleanup } = scratch("r2-up");
  try {
    fs.writeFileSync(`${dir}/a.bin`, bytes(5_000));
    mock.cloud.failPuts = 1;
    await cloud.uploadFile(`${dir}/a.bin`, "edit/test/bad/a.bin");
    expect(puts("edit/test/bad/a.bin")).toBe(2);
    expect(mock.cloud.objects.get("edit/test/bad/a.bin")?.length).toBe(5_000);

    mock.on("PUT", /^\/r2\/edit\/test\/bad\/b\.bin$/, () => new Response("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>", { status: 403 }));
    fs.writeFileSync(`${dir}/b.bin`, bytes(5_000));
    const refused = await cloud.uploadFile(`${dir}/b.bin`, "edit/test/bad/b.bin").catch((error: unknown) => error);
    expect((refused as Error).message).toContain("R2 refused the upload (403): AccessDenied: Access Denied");
    expect(kindOf(refused)).toBe("later");
    // Once: the old loop asked four times before saying so.
    expect(puts("edit/test/bad/b.bin")).toBe(1);
  } finally {
    cleanup();
  }
});

test("a download R2 is busy for (429) is asked again; one R2 refuses (403) is said at once", async () => {
  const { dir, cleanup } = scratch("r2-down");
  try {
    mock.cloud.put("edit/test/bad/c.bin", bytes(50_000));
    mock.on("GET", /^\/r2\/edit\/test\/bad\/c\.bin$/, () => new Response("slow down", { status: 429 }), 1);
    await cloud.download("edit/test/bad/c.bin", `${dir}/c.bin`);
    expect(fs.statSync(`${dir}/c.bin`).size).toBe(50_000);
    expect(gets("edit/test/bad/c.bin")).toBe(2);

    mock.cloud.put("edit/test/bad/d.bin", bytes(50_000));
    mock.on("GET", /^\/r2\/edit\/test\/bad\/d\.bin$/, () => new Response("no", { status: 403 }));
    const refused = await cloud.download("edit/test/bad/d.bin", `${dir}/d.bin`).catch((error: unknown) => error);
    expect((refused as Error).message).toContain("(403)");
    expect(gets("edit/test/bad/d.bin")).toBe(1);
  } finally {
    cleanup();
  }
});

test("an R2 too slow to answer is given up on, and the next try gets the file", async () => {
  const { dir, cleanup } = scratch("r2-slow");
  cloud.timing.connectMs = 200;
  let slow = 1;
  mock.cloud.beforeGet = async (key) => {
    if (key === "edit/test/bad/e.bin" && slow-- > 0) await Bun.sleep(1500);
  };
  try {
    mock.cloud.put("edit/test/bad/e.bin", bytes(20_000));
    await cloud.download("edit/test/bad/e.bin", `${dir}/e.bin`);
    expect(fs.statSync(`${dir}/e.bin`).size).toBe(20_000);
    expect(gets("edit/test/bad/e.bin")).toBe(2);
  } finally {
    mock.cloud.beforeGet = null;
    cloud.timing.connectMs = 30_000;
    cleanup();
  }
}, 30_000);

test("the relay slow, refusing, or answering what isn't JSON: each said in its own words, with its kind", async () => {
  mock.on("POST", "/v1/test/slow", async () => (await Bun.sleep(1500), Response.json({})), 1);
  const slow = await relay.json("POST", "/v1/test/slow", {}, "a test", 0.2).catch((error: unknown) => error);
  expect((slow as Error).message).toStartWith(relay.UNREACHABLE);
  expect(kindOf(slow)).toBe("temporary");

  mock.on("POST", "/v1/test/busy", () => Response.json({ error: "Too many at once" }, { status: 429 }), 1);
  const busy = await relay.json("POST", "/v1/test/busy", {}, "a test", 5).catch((error: unknown) => error);
  expect((busy as Error).message).toBe("Too many at once (429)");
  expect(kindOf(busy)).toBe("temporary");

  mock.on("POST", "/v1/test/odd", () => new Response("<html>not json</html>"), 1);
  const odd = await relay.json("POST", "/v1/test/odd", {}, "a test", 5).catch((error: unknown) => error);
  expect((odd as Error).message).toStartWith("the relay's answer:");
  expect(kindOf(odd)).toBe("permanent");

  mock.on("POST", "/v1/test/file", () => Response.json({ error: "That's too long." }, { status: 413 }), 1);
  const { dir, cleanup } = scratch("relay-file");
  try {
    const refused = await relay.call("POST", "/v1/test/file", {}, `${dir}/out.mp3`, "a test").catch((error: unknown) => error);
    expect((refused as Error).message).toBe("That's too long. (413)");
    expect(kindOf(refused)).toBe("permanent");
    expect(fs.existsSync(`${dir}/out.mp3`)).toBe(false);
  } finally {
    cleanup();
  }
}, 30_000);
