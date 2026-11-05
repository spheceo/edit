// The window's playback timings reach the server's (and so a Mac's report): every wait, not only the stalls.

import { expect, test } from "bun:test";

import * as diag from "../src/diag.ts";
import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import { fixtureHome } from "./helpers/home.ts";

test("playback's timings from the window are kept as the server's, and nothing else is", async () => {
  const { app, cleanup } = fixtureHome("client-timings");
  try {
    const router = buildRouter();
    const post = async (value: unknown) =>
      (await respond(app, router, new Request("http://localhost:7700/api/diagnostics/timings", { method: "POST", headers: { host: "localhost:7700", "content-type": "application/json" }, body: JSON.stringify(value) }), null))!;
    const answer = await post({
      timings: [
        { name: "preview: waiting for a frame (live, playing)", ms: [120, 340, 4100] },
        { name: "script preview: stalled while playing", ms: [900] },
        // Not playback's, and not a number: left out.
        { name: "GET /api/projects", ms: [5] },
        { name: "preview: play (smooth)", ms: ["x", -1, 0] },
      ],
    });
    expect(answer.status).toBe(200);
    const kept = new Map(diag.timings().map((timing) => [timing.name, timing]));
    expect(kept.get("ui: preview: waiting for a frame (live, playing)")).toMatchObject({ count: 3, max_ms: 4100, median_ms: 340 });
    expect(kept.get("ui: script preview: stalled while playing")).toMatchObject({ count: 1 });
    expect(kept.get("ui: preview: play (smooth)")).toMatchObject({ count: 1 });
    expect(kept.has("ui: GET /api/projects")).toBe(false);
  } finally {
    cleanup();
  }
});
