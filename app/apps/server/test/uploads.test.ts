// Any file dropped into a project (Oct 31): media as it is, other pictures,
// video and sound converted, anything else kept as a file; the agent told.
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { dispatch } from "../src/mcp/index.ts";
import * as uploads from "../src/uploads.ts";
import { fixtureHome } from "./helpers/home.ts";

const ffmpeg = Bun.which("ffmpeg");
const mac = process.platform === "darwin";

test.skipIf(ffmpeg === null || !mac)("pictures, video and sound Edit doesn't read are converted; documents are kept as files", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "uploads-"));
  try {
    const png = join(dir, "still.png");
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "testsrc=s=64x48:d=1", "-frames:v", "1", png]).exitCode).toBe(0);
    expect(await uploads.plan(png, join(dir, "converted"))).toEqual({ media: png });
    const heic = join(dir, "phone photo.heic");
    expect(Bun.spawnSync(["/usr/bin/sips", "-s", "format", "heic", png, "--out", heic], { stdout: "ignore" }).exitCode).toBe(0);
    const fromHeic = await uploads.plan(heic, join(dir, "converted"));
    expect(fromHeic).toEqual({ media: join(dir, "converted", "phone photo.png"), from: "heic" });
    const wmv = join(dir, "dashcam.wmv");
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "testsrc=s=64x48:d=1", "-f", "lavfi", "-i", "sine=d=1", "-c:v", "wmv2", "-c:a", "wmav2", wmv]).exitCode).toBe(0);
    expect(await uploads.plan(wmv, join(dir, "converted"))).toEqual({ media: join(dir, "converted", "dashcam.mp4"), from: "wmv" });
    const wma = join(dir, "call.wma");
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=d=1", "-c:a", "wmav2", wma]).exitCode).toBe(0);
    expect(await uploads.plan(wma, join(dir, "converted"))).toEqual({ media: join(dir, "converted", "call.m4a"), from: "wma" });
    const gif = join(dir, "moving.gif");
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "testsrc=s=64x48:d=1:r=10", gif]).exitCode).toBe(0);
    expect(await uploads.plan(gif, join(dir, "converted"))).toEqual({ media: join(dir, "converted", "moving.mp4"), from: "gif" });
    for (const name of ["report.pdf", "notes.txt", "case.docx", "archive.zip"]) {
      fs.writeFileSync(join(dir, name), "not media");
      expect(await uploads.plan(join(dir, name), join(dir, "converted"))).toEqual({ file: true });
    }
    expect(await uploads.words(join(dir, "notes.txt"))).toBe("not media");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(ffmpeg === null || mac)("off a Mac, FFmpeg makes other pictures PNGs, and a document's words come from the XML or markup inside it", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "uploads-"));
  try {
    const avif = join(dir, "phone photo.avif");
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "testsrc=s=64x48", "-frames:v", "1", "-c:v", "libaom-av1", "-still-picture", "1", avif]).exitCode).toBe(0);
    expect(await uploads.plan(avif, join(dir, "converted"))).toEqual({ media: join(dir, "converted", "phone photo.png"), from: "avif" });
    fs.writeFileSync(join(dir, "raw.cr2"), "not a picture");
    expect(await uploads.plan(join(dir, "raw.cr2"), join(dir, "converted"))).toEqual({ file: true });
    expect(fs.existsSync(join(dir, "converted", "raw.png"))).toBe(false);
    fs.writeFileSync(join(dir, "page.html"), "<html><style>p{}</style><body><h1>Case 12</h1><p>Officer &amp; driver</p><p>Line&nbsp;two&#33;</p></body></html>");
    expect(await uploads.words(join(dir, "page.html"))).toBe("Case 12\nOfficer & driver\nLine two!");
    fs.writeFileSync(join(dir, "note.rtf"), "{\\rtf1\\ansi{\\fonttbl\\f0 Helvetica;}\\f0 First line\\par Caf\\'e9}");
    expect(await uploads.words(join(dir, "note.rtf"))).toBe("First line\nCafé");
    if (Bun.which("zip") !== null) {
      fs.mkdirSync(join(dir, "doc", "word"), { recursive: true });
      fs.writeFileSync(join(dir, "doc", "word", "document.xml"), '<w:document><w:body><w:p><w:r><w:t>Suspect fled</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">at 9 &lt;pm&gt;</w:t></w:r></w:p></w:body></w:document>');
      expect(Bun.spawnSync(["zip", "-q", "-r", join(dir, "case.docx"), "word"], { cwd: join(dir, "doc") }).exitCode).toBe(0);
      expect(await uploads.words(join(dir, "case.docx"))).toBe("Suspect fled\nat 9 <pm>");
    }
    await expect(uploads.words(join(dir, "raw.cr2"))).rejects.toThrow("its words can't be read");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the agent's context lists what the user uploaded, newest first, and whether it's placed; read_upload reads a file", async () => {
  const { app, store, cleanup } = fixtureHome("uploads-context");
  try {
    const id = store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    const dir = store.uploadsDir(id);
    fs.mkdirSync(join(dir, "files"), { recursive: true });
    fs.writeFileSync(join(dir, "files", "brief.txt"), "Use the mugshot at the end.");
    const now = 1_000_000_000;
    uploads.remember(dir, { at: now - 3 * 60_000, name: "mugshot.jpg", media: "m1", file: null });
    uploads.remember(dir, { at: now - 60_000, name: "scene.heic", media: "m2", file: null, from: "heic" });
    uploads.remember(dir, { at: now - 30_000, name: "brief.txt", media: null, file: join(dir, "files", "brief.txt") });
    const project = { id, media: [{ id: "m1", name: "mugshot.jpg", kind: "image" }, { id: "m2", name: "scene.png", kind: "image" }], clips: [{ media: "m1" }] };
    expect(uploads.forContext(app, project, now)).toEqual([
      'file "brief.txt" (read_upload name "brief.txt"), just now',
      'm2 image "scene.heic" (made png from heic) NOT ON THE TIMELINE YET, 1 min ago',
      'm1 image "mugshot.jpg" on the timeline, 3 min ago',
    ]);
    const reply = (await dispatch(app, { id: 1, method: "tools/call", params: { name: "read_upload", arguments: { name: "brief", project_id: id } } }, null)) as { result: { content: { text?: string }[] } };
    expect(reply.result.content[0]!.text).toBe("Use the mugshot at the end.");
  } finally {
    cleanup();
  }
});
