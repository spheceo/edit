// Following Repack's reviews from the moment Edit starts, signed in or not yet:
// the sign-in is read from the Keychain after the follower starts (or comes
// later), and a follower that waited for the cloud never ran (Marc's 5 notes
// on Judge EXPLODES v2 went unheard on Oct 23).

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as reviews from "../src/reviews.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  // Nobody signed in yet, and no relay token: the cloud is off.
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "" });
});

afterAll(() => {
  reviews.stop();
  restore();
  mock.stop();
});

const asked = () => mock.calls("/v1/cloud/convex", "POST").filter((call) => call.json<{ path?: string }>().path === "reviews:changes").length;
const until = async (done: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await Bun.sleep(10);
};

test("the reviews are followed once someone signs in, even when Edit started before the sign-in was read", async () => {
  const { app, cleanup } = fixtureHome("reviews-follow");
  try {
    reviews.start(app, 20);
    await Bun.sleep(120);
    expect(asked()).toBe(0);
    // Signed in now (the cloud on): the follower already running asks Repack.
    process.env.EDIT_RELAY_TOKEN = "cloud-token";
    await until(() => asked() > 0, 2_000);
    expect(asked()).toBeGreaterThan(0);
  } finally {
    reviews.stop();
    cleanup();
  }
});
