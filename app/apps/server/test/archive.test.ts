// archive.ts / cloud_media.archiveHere: an archived project's big files freed here.

import { expect, test } from "bun:test";

import * as fs from "node:fs";

import { archived, archiveHere } from "../src/archive.ts";
import { noFootage } from "../src/cloud_media.ts";
import { fixtureHome } from "./helpers/home.ts";
import { media } from "./helpers/model.ts";

test("archiving frees a project's exports, footage and previews here, never what another project uses, keeping its analysis", async () => {
  const fixture = fixtureHome("archive");
  try {
    const { app, store, home } = fixture;
    const own = `${home}/media/drive/AAA/own.mp4`;
    const shared = `${home}/media/drive/BBB/shared.mp4`;
    const users = "/tmp/a-users-own-file.mp4";
    for (const path of [own, shared]) {
      fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(path, "x".repeat(1000));
    }
    const make = async (name: string, files: string[]) => {
      const id = store.create(name, { width: 1920, height: 1080, fps: 30 }).project.id;
      await store.update(id, "test", (project) => {
        files.forEach((path, index) => project.media.push(media({ id: `m${index}`, name: `m${index}`, path, kind: "video", duration: 10 })));
      });
      return id;
    };
    const old = await make("old", [own, shared, users]);
    await make("active", [shared]);
    // A preview and a transcript beside the project's own footage.
    const dir = app.media.paths(own).transcript.slice(0, app.media.paths(own).transcript.lastIndexOf("/"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/transcript.json`, "{}");
    fs.writeFileSync(`${dir}/preview.mp4`, "x".repeat(500));
    // An export of it.
    fs.mkdirSync(`${home}/exports`, { recursive: true });
    fs.writeFileSync(`${home}/exports/old v2.mp4`, "x".repeat(2000));
    fs.writeFileSync(`${home}/exports.json`, JSON.stringify({ [old]: [{ path: `${home}/exports/old v2.mp4`, name: "old v2.mp4", finished_ms: 1, seconds: 1, bytes: 2000, frames: 30, whole: true, format: "h264" }] }));
    const freed = archiveHere(app, old);
    expect(fs.existsSync(own)).toBe(false);
    expect(fs.existsSync(shared)).toBe(true);
    expect(fs.existsSync(`${home}/exports/old v2.mp4`)).toBe(false);
    expect([fs.existsSync(`${dir}/transcript.json`), fs.existsSync(`${dir}/preview.mp4`)]).toEqual([true, false]);
    expect(freed).toBe(2000 + 1000 + 500);
    expect(Object.keys(archived(home))).toEqual([old]);
    // Its footage never goes up again while it's archived.
    expect(noFootage(home).has(old)).toBe(true);
  } finally {
    fixture.cleanup();
  }
});
