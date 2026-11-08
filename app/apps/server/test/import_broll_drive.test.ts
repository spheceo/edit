import { afterAll, beforeAll, expect, test } from "bun:test";

import "../src/commentary_sources.ts";
import { handlerFor } from "../src/mcp/registry.ts";
import { MockServer } from "./mocks/server.ts";
import { fixtureHome } from "./helpers/home.ts";

let mock: MockServer;
let restoreEnv: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restoreEnv = mock.useEnv();
});

afterAll(() => {
  restoreEnv();
  mock.stop();
});

const ffmpeg = Bun.which("ffmpeg");

test.skipIf(ffmpeg === null)("a Drive screenshot a script's comment links imports as a picture", async () => {
  // The horror Doc of Nov 8 attached 26 Drive files in its comments (a channel's screenshot, a blog post in
  // English, archived thumbnails); import_broll took any non-YouTube link for a post and asked yt-dlp for its video.
  const fx = fixtureHome("broll-drive");
  try {
    const png = `${fx.dir}/channel.png`;
    const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "color=c=white:s=1200x800", "-frames:v", "1", png]);
    expect(made.exitCode).toBe(0);
    const bytes = new Uint8Array(await Bun.file(png).arrayBuffer());
    mock.on("GET", "/drive.usercontent.google.com/download", (request) => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
      const headers = { "content-type": "image/png", "content-disposition": 'attachment; filename="Ryu channel.png"' };
      if (range === null) return new Response(bytes, { headers });
      const start = Number(range[1]);
      const end = range[2] === "" ? bytes.length - 1 : Number(range[2]);
      return new Response(bytes.slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${bytes.length}` } });
    });
    const id = fx.app.store.createAs("Horror", "horror", { width: 1920, height: 1080, fps: 30 }).project.id;
    const answer = await handlerFor("import_broll")!.handler({
      app: fx.app,
      projectId: id,
      args: { ranges: [{ url: "https://drive.google.com/file/d/1HUs7y0LLbdzroW2Xu73MGBcMJZw6ztnt/view?usp=sharing", purpose: "his channel, zoom on the top left" }] },
    } as never);
    const said = JSON.parse((answer[0] as { text: string }).text) as { results: { media?: string; kind?: string; width?: number; error?: string }[] };
    expect(said.results[0]?.error).toBeUndefined();
    expect(said.results[0]).toMatchObject({ kind: "image", width: 1200, height: 800 });
    const media = fx.app.store.get(id)!.project.media.find((m) => m.id === said.results[0]!.media);
    expect(media?.kind).toBe("image");
  } finally {
    fx.cleanup();
  }
});
