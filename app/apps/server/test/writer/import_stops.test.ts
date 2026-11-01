// A Script import as one Effect: when its words fail, the preview being made beside them is
// stopped with it (its FFmpeg ended, nothing half-made left), and the failure keeps its kind.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import * as tools from "../../src/tools.ts";
import { timing } from "../../src/transcribe.ts";
import * as imports from "../../src/writer/imports.ts";
import * as store from "../../src/writer/store.ts";
import { fixtureHome } from "../helpers/home.ts";
import { MockServer } from "../mocks/server.ts";

const ffmpeg = Bun.which("ffmpeg");
let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "relay-token" });
  timing.instant = true;
  tools.forget();
});
afterAll(() => {
  restore();
  mock.stop();
});

const ffmpegsFor = (path: string) => Bun.spawnSync(["pgrep", "-f", path]).stdout.toString().trim().split("\n").filter(Boolean).length;

test.skipIf(ffmpeg === null)("an import whose words fail stops its preview too, and says the failure with its kind", async () => {
  const { dir, app, cleanup } = fixtureHome("import-stops");
  try {
    // 20 minutes of sound: its preview (sound over black) takes a while to make.
    const source = `${dir}/interview.m4a`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=1200", "-c:a", "aac", "-b:a", "32k", source]).exitCode).toBe(0);
    // The relay refuses at once (a quota): not asked again, so the words fail long before the preview is made.
    mock.on("POST", "/v1/transcribe", () => Response.json({ detail: { message: "quota exceeded" } }, { status: 402 }));
    const data = store.dataDir(app.store.home);
    const failed = await imports.fromFile(app, data, source, null, "Stops", null).catch((error: unknown) => error);
    expect((failed as Error).message).toContain("quota exceeded");
    expect((failed as imports.ImportStopped).kind).toBe("later");
    const [id] = store.ids(data);
    const scriptDir = store.scriptDir(data, id!);
    const script = store.read(scriptDir);
    expect(script.status).toBe("error");
    expect(script.stuckOn).toBeUndefined();
    // The preview's FFmpeg is gone, and no half-made preview is left.
    await Bun.sleep(500);
    expect(ffmpegsFor(scriptDir)).toBe(0);
    expect(fs.existsSync(store.proxyPath(scriptDir))).toBe(false);
  } finally {
    cleanup();
  }
}, 60_000);
