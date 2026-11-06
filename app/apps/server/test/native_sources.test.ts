// What Edit.app's native preview decodes each picture from (routes.ts `nativeSources`).

import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { localPath } from "../src/cloud_media.ts";
import { PLAYBACK_ROUTE } from "../src/cloud_playback.ts";
import * as cloudMedia from "../src/cloud_media.ts";
import { nativeSources } from "../src/native_preview.ts";
import { spyOn } from "bun:test";
import { fixtureHome } from "./helpers/home.ts";
import { media } from "./helpers/model.ts";

test("the native preview reads a media's made preview, else its footage; a cloud one's copy here, else its footage here, else the loopback stream", async () => {
  const { dir, app, store, cleanup } = fixtureHome("native-sources");
  try {
    const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    for (const name of ["made.mp4", "making.mp4", "still.png"]) fs.writeFileSync(`${dir}/${name}`, "x");
    await store.update(id, "test", (p) => {
      p.media.push(media({ id: "made", name: "made.mp4", path: `${dir}/made.mp4`, kind: "video", duration: 1 }));
      p.media.push(media({ id: "making", name: "making.mp4", path: `${dir}/making.mp4`, kind: "video", duration: 1 }));
      p.media.push(media({ id: "still", name: "still.png", path: `${dir}/still.png`, kind: "image", duration: 1 }));
      p.media.push(media({ id: "song", name: "song.mp3", path: `${dir}/song.mp3`, kind: "audio", duration: 1 }));
      p.media.push({ ...media({ id: "here", name: "here.mp4", path: "https://r2.example/a", kind: "video", duration: 1 }), cloud: { proxy: "edit/proxies/aa/here.mp4" } } as never);
      p.media.push({ ...media({ id: "there", name: "there.mp4", path: "https://r2.example/b", kind: "video", duration: 1 }), cloud: { proxy: "edit/proxies/bb/there.mp4" } } as never);
      p.media.push({ ...media({ id: "footage", name: "made.mp4", path: `${dir}/made.mp4`, kind: "video", duration: 1 }), cloud: { proxy: "edit/proxies/cc/footage.mp4" } } as never);
    });
    // One preview made, the other on its way.
    const made = app.media.paths(`${dir}/made.mp4`);
    fs.mkdirSync(made.proxy.slice(0, made.proxy.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(made.proxy, "preview");
    fs.writeFileSync(made.proxyDone, "");
    // One cloud preview whole on this Mac.
    const here = localPath(store.cacheDir(), "edit/proxies/aa/here.mp4");
    fs.mkdirSync(here.slice(0, here.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(here, "copy");
    // A streamed one's whole preview comes down behind it.
    const fetched: string[] = [];
    const fetch = spyOn(cloudMedia, "fetchKey").mockImplementation(async (key) => { fetched.push(key); });
    const answer = (await nativeSources(app, store.get(id)!.project).json()) as { cache: string; sources: Record<string, string> };
    fetch.mockRestore();
    expect(fetched).toEqual(["edit/proxies/bb/there.mp4"]);
    expect(answer.cache).toBe(store.cacheDir());
    expect(answer.sources).toEqual({
      made: made.proxy,
      making: `${dir}/making.mp4`,
      still: `${dir}/still.png`,
      here,
      there: `http://127.0.0.1:${app.port}${PLAYBACK_ROUTE}?key=${encodeURIComponent("edit/proxies/bb/there.mp4")}`,
      footage: `${dir}/made.mp4`,
    });
  } finally {
    cleanup();
  }
});
