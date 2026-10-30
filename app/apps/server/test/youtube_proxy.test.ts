import { afterAll, beforeAll, expect, test } from "bun:test";

import { proxyUrl } from "../src/youtube.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "person-token", PROXY_URL: undefined });
});

afterAll(() => {
  restore();
  mock.stop();
});

test("an Edit without its own proxy asks the relay for it (signed in), once in a while", async () => {
  let asked = 0;
  mock.on("GET", "/v1/proxy", (request) => {
    asked++;
    expect(request.headers.get("authorization")).toBe("Bearer person-token");
    return Response.json({ proxyUrl: "http://login:secret@gateway.test:823" });
  });
  expect(await proxyUrl()).toBe("http://login:secret@gateway.test:823");
  expect(await proxyUrl()).toBe("http://login:secret@gateway.test:823");
  expect(asked).toBe(1);
});
