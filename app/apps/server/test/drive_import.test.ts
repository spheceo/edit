import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { folderId, importDrive, importKey, removeStagedCopy, resumeImport } from "../src/drive_import.ts";
import * as jobs from "../src/jobs.ts";
import * as uploads from "../src/uploads.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

test("folderId reads a Drive folder link", () => {
  expect(folderId("https://drive.google.com/drive/folders/1yg-M2MtATPMklbr1buzd0mgR9sNzsgOZ")).toBe("1yg-M2MtATPMklbr1buzd0mgR9sNzsgOZ");
  expect(folderId("https://example.com/folders/1yg-M2MtATPMklbr1buzd0mgR9sNzsgOZ")).toBeNull();
});

test("removeStagedCopy deletes only Edit's staging copies under the uploads root", () => {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/edit-stage-`);
  try {
    const root = `${dir}/media/p1`;
    const staged = `${root}/drive/abc/file.mp4`;
    fs.mkdirSync(`${root}/drive/abc`, { recursive: true });
    fs.writeFileSync(staged, "x");
    const outside = `${dir}/Movies/file.mp4`;
    fs.mkdirSync(`${dir}/Movies`, { recursive: true });
    fs.writeFileSync(outside, "x");
    expect(removeStagedCopy(outside, root)).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    expect(removeStagedCopy(staged, root)).toBe(true);
    expect(fs.existsSync(staged)).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Footage from a Drive link is a job (Sphe, Nov 10: an update goes through at any time, and what it cuts carries
// on): a restart meanwhile carries it on by itself, the footage placed on the timeline once.
const ffmpeg = Bun.which("ffmpeg");

test.skipIf(ffmpeg === null)("a Drive import a restart cut short carries on by itself and places its footage once", async () => {
  const mock = MockServer.start();
  const restore = mock.useEnv();
  const fx = fixtureHome("drive-import-resume");
  try {
    const source = `${fx.dir}/source.mp4`;
    const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x36:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-c:v", "libx264", "-c:a", "aac", source]);
    expect(made.exitCode).toBe(0);
    mock.driveFile("1AbCdEfGhIjKlMnOp", new Uint8Array(fs.readFileSync(source)), "Bodycam 1.mp4");
    const url = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view";
    const id = fx.app.store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
    const home = fx.app.store.home;
    const footage = () => jobs.list(home, "footage");

    const [, added, errors] = await importDrive(fx.app, id, url, true, "");
    expect(errors).toEqual([]);
    expect(added.length).toBe(1);
    const placed = fx.app.store.get(id)!.project.clips.length;
    expect(placed).toBe(2);
    expect(footage()).toEqual([]);
    expect(uploads.list(fx.app.store.uploadsDir(id)).map((one) => one.media)).toEqual(added);

    // Cut after its footage was added, before it was written down: carried on, it isn't placed or noted again.
    jobs.begin(home, "footage", id, { url, place: true, origin: "" }, importKey(id, url).split(":").at(-1)!, "importing");
    resumeImport(fx.app, footage()[0]!);
    for (let i = 0; i < 200 && footage().length > 0; i++) await Bun.sleep(25);
    expect(footage()).toEqual([]);
    expect(fx.app.store.get(id)!.project.clips.length).toBe(placed);
    expect(fx.app.store.get(id)!.project.media.length).toBe(1);
    expect(uploads.list(fx.app.store.uploadsDir(id)).length).toBe(1);

    // Cut before its footage was placed (the person cleared the timeline): placed once, as at first.
    await fx.app.store.update(id, "test", (project) => {
      project.clips = [];
    });
    jobs.begin(home, "footage", id, { url, place: true, origin: "" }, importKey(id, url).split(":").at(-1)!, "downloading");
    resumeImport(fx.app, footage()[0]!);
    for (let i = 0; i < 200 && footage().length > 0; i++) await Bun.sleep(25);
    expect(fx.app.store.get(id)!.project.clips.length).toBe(placed);

    // Cut once it was all done but crossed off: only crossed off.
    jobs.begin(home, "footage", id, { url, place: true, origin: "", media: added, paths: [], whole: false }, importKey(id, url).split(":").at(-1)!, "added");
    resumeImport(fx.app, footage()[0]!);
    expect(footage()).toEqual([]);
    expect(fx.app.store.get(id)!.project.clips.length).toBe(placed);
  } finally {
    fx.cleanup();
    restore();
    mock.stop();
  }
}, 60_000);
