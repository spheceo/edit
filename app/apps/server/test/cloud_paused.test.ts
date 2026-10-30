import { afterAll, beforeAll, expect, test } from "bun:test";

import { ConvexFailure, convexCall } from "../src/cloud.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "person-token" });
});

afterAll(() => {
  restore();
  mock.stop();
});

test("the relay pausing the database while it moves reads as offline: the work waits here", async () => {
  mock.on("POST", "/v1/cloud/convex", () => Response.json({ error: "Edit's cloud is moving to its new home: a few minutes. Your work is kept on this Mac and saved when it's back." }, { status: 503 }));
  const failed = await convexCall("mutation", "edit:commitProject", { projectId: "p1" }, 10).catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(ConvexFailure);
  expect((failed as ConvexFailure).kind).toBe("unreachable");
});
