import { expect, test } from "bun:test";

import * as fs from "node:fs";

import {
  Layout,
  MARKER,
  checkUnder,
  moveCommand,
  prepare,
  save,
  size,
  status,
} from "../src/media_drive/layout.ts";
import { native } from "../src/native/index.ts";
import { Store } from "../src/store.ts";
import { freshNative, scratch } from "./helpers/home.ts";

/** An old modification time, so a copy that loses its date is caught (ms precision: the stub's keys use ms). */
const OLD = new Date(1_700_000_000_123);

function writeOld(path: string, bytes: string): void {
  fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  fs.writeFileSync(path, bytes);
  fs.utimesSync(path, OLD, OLD);
}

/** A copy that keeps the modification time (what `edit media move` makes). */
function copyKept(from: string, to: string): void {
  fs.mkdirSync(to.slice(0, to.lastIndexOf("/")), { recursive: true });
  fs.copyFileSync(from, to);
  const stat = fs.statSync(from);
  fs.utimesSync(to, stat.atime, stat.mtime);
}

async function projectWith(store: Store, paths: string[]): Promise<string> {
  const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
  await store.update(id, "test", (project) => {
    paths.forEach((path, index) => {
      project.media.push({
        id: `m${index}`,
        name: "m",
        path,
        kind: "video",
        duration: 10,
        width: 0,
        height: 0,
        fps: 0,
        has_audio: false,
      });
    });
  });
  return id;
}

function pathsOf(store: Store, id: string): string[] {
  return store.get(id)!.project.media.map((media) => media.path);
}

test("files_are_found_on_either_side_and_keep_their_cache_keys", async () => {
  const { dir, cleanup } = scratch("media-drive-resolve");
  try {
    const home = `${dir}/home`;
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(`${dir}/drive`, { recursive: true });
    freshNative(home);
    const drive = prepare(home, `${dir}/drive`);
    const layout = Layout.fromSettings(home, null);
    expect(layout.media).toBeNull();
    // Off: new media in the data folder, exactly as before.
    expect(layout.mediaRoot()).toBe(layout.home);
    expect(layout.keyPath("/a/b.mp4")).toBe("/a/b.mp4");
    layout.media = drive;
    layout.known = [drive];
    expect(layout.mediaRoot()).toBe(drive);
    expect(layout.exportsDir()).toBe(`${drive}/Exports`);

    const atHome = `${layout.home}/media/drive/abc/clip.mp4`;
    const onDrive = `${drive}/media/drive/abc/clip.mp4`;
    writeOld(atHome, "footage");
    const keyBefore = native().keyOf(layout.keyPath(atHome), atHome);
    // Still at home: nothing to resolve.
    expect(layout.resolve(atHome)).toBeNull();
    copyKept(atHome, onDrive);
    fs.rmSync(atHome);
    // A project naming the old place finds the copy, and its key is the same.
    expect(layout.resolve(atHome)).toBe(onDrive);
    expect(layout.keyPath(onDrive)).toBe(atHome);
    expect(native().keyOf(layout.keyPath(onDrive), onDrive)).toBe(keyBefore);
    // And back: a file named on the drive that's at home again.
    const uploaded = `${drive}/uploads/p1/x.mp4`;
    writeOld(`${layout.home}/uploads/p1/x.mp4`, "x");
    expect(layout.resolve(uploaded)).toBe(`${layout.home}/uploads/p1/x.mp4`);
    // Missing on both sides, or not Edit's media: shown missing as before.
    expect(layout.resolve(`${drive}/media/gone.mp4`)).toBeNull();
    expect(layout.resolve("/Users/someone/Movies/gone.mp4")).toBeNull();

    // The store opens a project that names the old place at the new one.
    save(layout);
    const store = Store.open(home);
    const moved = `${drive}/media/p9/b.mp4`;
    writeOld(moved, "b");
    const id = await projectWith(store, [`${layout.home}/media/p9/b.mp4`]);
    const reopened = Store.open(home);
    expect(pathsOf(reopened, id)).toEqual([moved]);
    expect(reopened.uploadsDir(id)).toBe(`${drive}/media/${id}`);
    // The addon names drive files by their data-folder place once it's told the folders.
    reopened.publishLayout();
    expect(native().mediaKey(onDrive)).toBe(keyBefore);
  } finally {
    cleanup();
  }
});

test("an_unplugged_drive_is_never_written_to", () => {
  const { dir, cleanup } = scratch("media-drive-unplugged");
  try {
    const home = `${dir}/home`;
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(`${dir}/drive`, { recursive: true });
    freshNative(home);
    const store = Store.open(home);
    const drive = store.setMediaDir(`${dir}/drive`).media!;
    expect(store.driveDir().startsWith(drive)).toBe(true);

    // Unplugged: the folder is gone (or its marker isn't there).
    fs.rmSync(`${drive}/${MARKER}`);
    expect(() => store.uploadsDir("p1")).toThrow("isn't connected");
    expect(() => store.driveDir()).toThrow();
    expect(() => store.layout().writable(`${drive}/Exports/a.mp4`)).toThrow();
    expect(() => store.layout().writable("/elsewhere/a.mp4")).not.toThrow();
    expect(fs.existsSync(`${store.layout().home}/media`)).toBe(false);
    // The setting survives a restart, still refusing.
    const reopened = Store.open(home);
    expect(reopened.layout().media).toBe(drive);
    expect(() => reopened.uploadsDir("p1")).toThrow();
    expect(status(reopened.layout()).state).toBe("offline");

    // A /Volumes/<drive> folder left on the internal disk isn't the drive,
    // even with Edit's folder and marker in it.
    const volumes = `${dir}/Volumes`;
    const stub = `${volumes}/External/Edit`;
    fs.mkdirSync(stub, { recursive: true });
    fs.writeFileSync(`${stub}/${MARKER}`, "{}");
    expect(() => checkUnder(stub, volumes)).toThrow("isn't mounted");
    // Plugged in again (here: a folder that's no mount point needs only its marker).
    fs.writeFileSync(`${drive}/${MARKER}`, "{}");
    expect(reopened.uploadsDir("p1")).toBe(`${drive}/media/p1`);
    // Turned off: the data folder again.
    reopened.setMediaDir(null);
    expect(reopened.uploadsDir("p1")).toBe(`${reopened.layout().home}/media/p1`);
    expect(() => prepare(home, "relative/dir")).toThrow("Give the media folder's full path, not relative/dir.");
    expect(() => prepare(home, `${home}/media`)).toThrow("must be outside Edit's data folder");
    expect(() => prepare(home, `${dir}/no/such/parent`)).toThrow("doesn't exist (is the drive connected?)");
  } finally {
    cleanup();
  }
});

test("the env's media folder can't be changed from the UI", () => {
  const { dir, cleanup } = scratch("media-drive-env");
  const before = process.env.EDIT_MEDIA_DIR;
  try {
    fs.mkdirSync(`${dir}/home`, { recursive: true });
    freshNative(`${dir}/home`);
    process.env.EDIT_MEDIA_DIR = `${dir}/drive`;
    const store = Store.open(`${dir}/home`);
    // Set on purpose: made usable at startup.
    expect(fs.existsSync(`${dir}/drive/${MARKER}`)).toBe(true);
    expect(() => store.setMediaDir(null)).toThrow(
      "EDIT_MEDIA_DIR is set, and it decides the media drive: change or unset it instead.",
    );
  } finally {
    if (before === undefined) delete process.env.EDIT_MEDIA_DIR;
    else process.env.EDIT_MEDIA_DIR = before;
    cleanup();
  }
});

test("settings keep what else is in them, and the move command quotes what it must", () => {
  const { dir, cleanup } = scratch("media-drive-settings");
  try {
    const home = `${dir}/home`;
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(`${home}/settings.json`, JSON.stringify({ theme: "dark" }));
    const layout = Layout.fromSettings(home, null);
    layout.media = "/Volumes/External/Edit";
    layout.known = ["/Volumes/External/Edit"];
    save(layout);
    expect(JSON.parse(fs.readFileSync(`${home}/settings.json`, "utf8"))).toEqual({
      media_dir: "/Volumes/External/Edit",
      media_dirs_known: ["/Volumes/External/Edit"],
      theme: "dark",
    });
    expect(moveCommand(layout.home, "/Volumes/My Drive/Edit")).toBe(
      `edit media move --to '/Volumes/My Drive/Edit' --home ${layout.home}`,
    );
    expect(size(0)).toBe("0 KB");
    expect(size(512)).toBe("1 KB");
    expect(size(340e6)).toBe("340 MB");
    expect(size(1.26e9)).toBe("1.3 GB");
  } finally {
    cleanup();
  }
});
