import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { localPath } from "../src/cloud_media.ts";
import * as localPreviews from "../src/local_previews.ts";
import { scratch } from "./helpers/home.ts";
import { media, project as newProject } from "./helpers/model.ts";

const realFetch = localPreviews.hooks.fetch;
afterEach(() => {
  localPreviews.hooks.fetch = realFetch;
  localPreviews.reset();
});

const KEY = "edit/proxies/youtube/abc/0-1000.mp4";
const stream = (key: string) => `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(key)}`;

function cloudProject() {
  const project = newProject();
  project.media.push(
    media({ id: "m1", name: "a", path: stream(KEY), kind: "video", duration: 60, cloud: { proxy: KEY } } as never),
    media({ id: "m2", name: "b", path: stream("edit/proxies/youtube/def/0-1000.mp4"), kind: "video", duration: 60, cloud: { proxy: "edit/proxies/youtube/def/0-1000.mp4" } } as never),
    media({ id: "m3", name: "here", path: "/footage/here.mp4", kind: "video", duration: 60 }),
  );
  return project;
}

test("a cloud preview whose whole file is here is read from it; the rest stream, and come down behind", async () => {
  const home = scratch("local-previews");
  try {
    const cache = home.dir;
    const fetched: string[] = [];
    localPreviews.hooks.fetch = async (key, local) => {
      fetched.push(key);
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, "mp4");
    };
    const project = cloudProject();
    // Nothing here yet: nothing swapped, both fetched.
    expect(localPreviews.localized(cache, project)).toBeNull();
    await Bun.sleep(10);
    expect(fetched.sort()).toEqual(["edit/proxies/youtube/abc/0-1000.mp4", "edit/proxies/youtube/def/0-1000.mp4"]);
    // Here now: both read from the files; the saved project keeps the cloud's paths.
    const local = localPreviews.localized(cache, project)!;
    expect(local.media.map((one) => one.path)).toEqual([localPath(cache, KEY), localPath(cache, "edit/proxies/youtube/def/0-1000.mp4"), "/footage/here.mp4"]);
    expect(project.media[0]!.path).toBe(stream(KEY));
    expect(localPreviews.pathOf(cache, project.media[0]!)).toBe(localPath(cache, KEY));
    expect(localPreviews.pathOf(cache, project.media[2]!)).toBe("/footage/here.mp4");
  } finally {
    home.cleanup();
  }
});

test("a media streaming something other than its preview is left as it is", () => {
  const home = scratch("local-previews");
  try {
    const project = newProject();
    const original = "https://r2.example/edit/originals/abc.mp4?X-Amz-Signature=1";
    project.media.push(media({ id: "m1", name: "a", path: original, kind: "video", duration: 60, cloud: { proxy: KEY } } as never));
    const local = localPath(home.dir, KEY);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, "mp4");
    expect(localPreviews.localized(home.dir, project)).toBeNull();
    expect(localPreviews.pathOf(home.dir, project.media[0]!)).toBe(original);
  } finally {
    home.cleanup();
  }
});

test("a preview that failed to come isn't asked again on every frame", async () => {
  const home = scratch("local-previews");
  try {
    let asked = 0;
    localPreviews.hooks.fetch = async () => {
      asked += 1;
      throw new Error("offline");
    };
    const project = cloudProject();
    localPreviews.fetchAll(home.dir, project);
    await Bun.sleep(10);
    localPreviews.fetchAll(home.dir, project);
    localPreviews.localized(home.dir, project);
    await Bun.sleep(10);
    expect(asked).toBe(2);
  } finally {
    home.cleanup();
  }
});
