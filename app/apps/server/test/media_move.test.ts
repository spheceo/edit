import { expect, test } from "bun:test";

import * as fs from "node:fs";

import { MARKER } from "../src/media_drive/layout.ts";
import { copyChecked, moveMedia, moveUntil, runCli, takeLock } from "../src/media_drive/move.ts";
import { native } from "../src/native/index.ts";
import { Store } from "../src/store.ts";
import { freshNative, scratch } from "./helpers/home.ts";

/** An old file, so a copy that loses its date is caught (a time with sub-millisecond digits). */
function writeOld(path: string, bytes: string): void {
  fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  fs.writeFileSync(path, bytes);
  const old = 1_700_000_000.123456;
  fs.utimesSync(path, old, old);
}

async function projectWith(store: Store, paths: string[]): Promise<string> {
  const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
  await store.update(id, "test", (project) => {
    paths.forEach((path, index) => {
      project.media.push({ id: `m${index}`, name: "m", path, kind: "video", duration: 10, width: 0, height: 0, fps: 0, has_audio: false });
    });
  });
  return id;
}

function pathsOf(store: Store, id: string): string[] {
  return store.get(id)!.project.media.map((media) => media.path);
}

test("a_move_survives_interruption_and_never_loses_a_file", async () => {
  const { dir, cleanup } = scratch("media-move");
  try {
    const given = `${dir}/home`;
    const target = `${dir}/drive`;
    fs.mkdirSync(given, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    freshNative(given);
    const store = Store.open(given);
    const home = store.layout().home;
    const files = [
      `${home}/media/drive/f1/excerpts/a.mp4`,
      `${home}/media/drive/f1/.done`,
      `${home}/media/p1/upload.mov`,
      `${home}/media/p1/stills/s.png`,
      `${home}/uploads/p1/source-footage/b.mp4`,
      `${home}/uploads/p1/source-footage/c.mp4`,
    ];
    const content = (index: number) => `file ${index}`.repeat(index + 1);
    files.forEach((file, index) => writeOld(file, content(index)));
    const id = await projectWith(store, files);
    const keys = files.map((file) => native().keyOf(file, file));
    const lines: string[] = [];
    const say = (line: string) => lines.push(line);

    // A dry run touches nothing.
    const dry = await moveMedia(store, target, true, say);
    expect(dry.files).toBe(files.length);
    expect(files.every((file) => fs.existsSync(file))).toBe(true);
    expect(store.layout().media).toBeNull();

    // Interrupted after two copies: nothing removed, the project untouched.
    await expect(moveUntil(store, target, false, 2, say)).rejects.toThrow("stopped");
    const drive = store.layout().media!;
    expect(files.every((file) => fs.existsSync(file))).toBe(true);
    expect(pathsOf(store, id)).toEqual(files);
    // ...and one copy cut off mid-way, and one file already on the drive but different.
    const half = `${drive}/media/p1/upload.mov.edit-moving`;
    fs.mkdirSync(`${drive}/media/p1`, { recursive: true });
    fs.writeFileSync(half, "half");
    const clash = `${drive}/uploads/p1/source-footage/c.mp4`;
    fs.mkdirSync(`${drive}/uploads/p1/source-footage`, { recursive: true });
    fs.writeFileSync(clash, "someone else's");

    const report = await moveMedia(store, target, false, say);
    expect(report.already).toBe(2);
    expect(report.copied).toBe(3);
    expect(report.removed).toBe(5);
    expect(report.projects).toBe(1);
    expect(report.problems.length).toBe(1);
    expect(fs.existsSync(half)).toBe(false);
    // The clash: both kept, the project still on the original.
    expect(fs.existsSync(files[5]!)).toBe(true);
    expect(fs.readFileSync(clash, "utf8")).toBe("someone else's");
    const now = pathsOf(store, id);
    files.forEach((file, index) => {
      const moved = `${drive}/${file.slice(home.length + 1)}`;
      if (index === 5) {
        expect(now[index]).toBe(file);
        return;
      }
      expect(fs.existsSync(file)).toBe(false);
      expect(now[index]).toBe(moved);
      expect(fs.readFileSync(moved, "utf8")).toBe(content(index));
      // Same size and time, named by its old place: the same cache key.
      expect(native().keyOf(store.layout().keyPath(moved), moved)).toBe(keys[index]!);
    });
    // Empty folders gone, the ones still holding something kept.
    expect(fs.existsSync(`${home}/media/p1`)).toBe(false);
    expect(fs.statSync(`${home}/uploads/p1/source-footage`).isDirectory()).toBe(true);

    // Once the clash is cleared, running it again finishes the job.
    fs.rmSync(clash);
    const again = await moveMedia(store, target, false, say);
    expect([again.copied, again.removed, again.projects]).toEqual([1, 1, 1]);
    expect(again.problems).toEqual([]);
    expect(fs.existsSync(`${home}/uploads/p1`)).toBe(false);
    const last = await moveMedia(store, target, false, say);
    expect([last.files, last.copied, last.removed]).toEqual([0, 0, 0]);
    // History and deleted projects naming the old places still find their files.
    const reopened = Store.open(given);
    const old = structuredClone(reopened.get(id)!.project);
    old.media[0]!.path = files[0]!;
    reopened.layout().resolveProject(old);
    expect(old.media[0]!.path).toBe(`${drive}/media/drive/f1/excerpts/a.mp4`);
    expect(lines.some((line) => line.startsWith("done: 3 copied"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("a copy keeps its time to the nanosecond, and a different file there is never overwritten", () => {
  const { dir, cleanup } = scratch("media-copy");
  try {
    writeOld(`${dir}/a`, "aaaa");
    expect(copyChecked(`${dir}/a`, `${dir}/x/a`)).toEqual({ made: 4 });
    const ns = (path: string) => fs.statSync(path, { bigint: true }).mtimeNs;
    expect(ns(`${dir}/x/a`)).toBe(ns(`${dir}/a`));
    expect(copyChecked(`${dir}/a`, `${dir}/x/a`)).toBe("already");
    fs.writeFileSync(`${dir}/x/b`, "other");
    writeOld(`${dir}/b`, "bb");
    expect(() => copyChecked(`${dir}/b`, `${dir}/x/b`)).toThrow(
      `${dir}/x/b is on the media drive already and differs from this one (size or date): both kept`,
    );
    expect(() => copyChecked(`${dir}/gone`, `${dir}/x/gone`)).toThrow("No such file or directory (os error 2)");
  } finally {
    cleanup();
  }
});

test("edit media refuses while a server holds the data folder, and use/off set the drive", async () => {
  const { dir, cleanup } = scratch("media-cli");
  const said: string[] = [];
  const log = console.log;
  console.log = (line: string) => said.push(line);
  try {
    const home = `${dir}/home`;
    fs.mkdirSync(`${dir}/drive`, { recursive: true });
    freshNative(home);
    const fail = (message: string): never => {
      throw new Error(`fail: ${message}`);
    };
    // Nothing answers on this port: only the lock decides.
    await runCli(home, 1, ["use", `${dir}/drive`], fail);
    expect(said.pop()).toBe(`New media goes to ${fs.realpathSync(dir)}/drive from now on.`);
    expect(fs.existsSync(`${dir}/drive/${MARKER}`)).toBe(true);
    await runCli(home, 1, ["off"], fail);
    expect(said.pop()).toBe(`New media stays in ${fs.realpathSync(home)} from now on.`);
    await runCli(home, 1, [], fail);
    expect(said.pop()).toBe(`Media stays in ${fs.realpathSync(home)} (no media drive set).`);
    await expect(runCli(home, 1, ["use"], fail)).rejects.toThrow("fail: edit media use DIR");
    await expect(runCli(home, 1, ["nope"], fail)).rejects.toThrow("fail: unknown media command nope");
    // An Edit from before the lock, serving this data folder on the port.
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ home }) });
    try {
      await expect(takeLock(home, server.port!)).rejects.toThrow(
        `Edit is running with ${home} — quit it (or stop \`edit serve\`) first on port ${server.port}`,
      );
    } finally {
      server.stop(true);
    }
  } finally {
    console.log = log;
    cleanup();
  }
});
