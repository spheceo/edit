// links.ts: a link pasted in a chat, read, downloaded whole through a stand-in
// yt-dlp (EDIT_YTDLP), brought into the project and heard whole by Scribe.

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";

import { bringIn, bytesSaid, linkOf } from "../src/links.ts";
import * as progress from "../src/progress.ts";
import { videoLinks } from "../src/writer/links.ts";
import { fixtureHome } from "./helpers/home.ts";

const ffmpeg = Bun.which("ffmpeg");
const restore = process.env.EDIT_YTDLP;
afterEach(() => {
  if (restore === undefined) delete process.env.EDIT_YTDLP;
  else process.env.EDIT_YTDLP = restore;
  progress.reset();
});

test("a pasted link is read for what it is", () => {
  expect(linkOf("https://youtu.be/4mqGp1IgqEw?t=86.")).toMatchObject({ kind: "youtube", id: "4mqGp1IgqEw", url: "https://www.youtube.com/watch?v=4mqGp1IgqEw" });
  expect(linkOf("https://drive.google.com/file/d/1HUs7y0LLbdzroW2Xu73MGBcMJZw6ztnt/view?usp=sharing")).toMatchObject({ kind: "drive", id: "1HUs7y0LLbdzroW2Xu73MGBcMJZw6ztnt" });
  expect(linkOf("https://www.instagram.com/reel/DU6q9WeEjRX/")).toMatchObject({ kind: "page" });
  expect(linkOf("https://cdn.example.com/footage/bodycam.mp4")).toMatchObject({ kind: "page", url: "https://cdn.example.com/footage/bodycam.mp4" });
  expect(() => linkOf("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp")).toThrow("Drive folder");
  expect(() => linkOf("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit")).toThrow("Google Doc");
  expect(() => linkOf("ftp://example.com/a.mp4")).toThrow("http");
});

test("a revision's message names its video links, not its Docs or Edit's own", () => {
  const message = "Put this after the intro https://youtu.be/4mqGp1IgqEw and this clip (https://x.com/someone/status/123), see https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit and https://youtu.be/4mqGp1IgqEw again";
  expect(videoLinks(message)).toEqual(["https://www.youtube.com/watch?v=4mqGp1IgqEw", "https://x.com/someone/status/123"]);
  expect(videoLinks("Make the opening tighter")).toEqual([]);
});

test("its progress reads as a person would say it", () => {
  expect(bytesSaid(1_200_000_000, 3_400_000_000)).toBe("1.2 GB of 3.4 GB, 35%");
  expect(bytesSaid(52_000_000, null)).toBe("52 MB");
  progress.begin("link", "p1", "a");
  progress.stage("link", "p1", "a", "download", `downloading “Bodycam 4”: ${bytesSaid(400e6, 800e6)}`, 400e6, 800e6);
  expect(progress.summary("p1", ["link"])).toStartWith("a link downloading “Bodycam 4”: 400 MB of 800 MB, 50%: done in");
  progress.stage("link", "p1", "a", "words", "being transcribed (“Bodycam 4”)");
  expect(progress.summary("p1")).toStartWith("a link being transcribed (“Bodycam 4”): done in");
});

/** A yt-dlp stand-in that "downloads" `video` into the folder it's given, saying its progress as yt-dlp does. */
function fakeYtdlp(dir: string, video: string): void {
  const size = fs.statSync(video).size;
  fs.writeFileSync(
    `${dir}/yt-dlp`,
    `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/args"
for arg in "$@"; do case "$prev" in -P) out="$arg";; esac; prev="$arg"; done
echo "EDIT ${Math.floor(size / 2)} ${size} NA NA Raid footage"
cp "${video}" "$out/Raid footage [clip1].mp4"
echo "EDIT ${size} ${size} NA NA Raid footage"
echo "EDIT-FILE $out/Raid footage [clip1].mp4"
`,
    { mode: 0o755 },
  );
}

test.skipIf(ffmpeg === null)("a link from any page comes in whole and is heard whole by Scribe", async () => {
  const fx = fixtureHome("links");
  try {
    const video = `${fx.dir}/source.mp4`;
    const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
    expect(made.exitCode).toBe(0);
    fakeYtdlp(fx.dir, video);
    process.env.EDIT_YTDLP = `${fx.dir}/yt-dlp`;
    // Scribe stands in: what it was asked is what matters (whole, with no free first hearing).
    const asked: unknown[][] = [];
    const media = fx.app.media as unknown as { transcribe: (...args: unknown[]) => unknown; status: (source: string) => unknown };
    media.transcribe = (...args: unknown[]) => {
      asked.push(args);
      return { transcript: "ready" };
    };
    const id = fx.app.store.createAs("Bodycam", "bodycam", { width: 1920, height: 1080, fps: 30 }).project.id;
    const got = await bringIn(fx.app, id, "https://news.example.com/video/raid-footage", "link:test");
    expect(got).toMatchObject({ name: "Raid footage [clip1].mp4", kind: "video", words: "ready", url: "https://news.example.com/video/raid-footage" });
    // Asked of yt-dlp straight, whole: no proxy, no range, no size cap.
    const args = fs.readFileSync(`${fx.dir}/args`, "utf8").split("\n");
    expect(args).toContain("https://news.example.com/video/raid-footage");
    expect(args).not.toContain("--proxy");
    expect(args).not.toContain("--download-sections");
    expect(args.join(" ")).not.toContain("max-filesize");
    // In the project's media, listed with what was uploaded, not placed.
    const project = fx.app.store.get(id)!.project;
    expect(project.media.map((m) => m.id)).toEqual([got.media as string]);
    expect(project.clips).toHaveLength(0);
    // Heard whole: Scribe (not the free first hearing), with the case's names.
    expect(asked).toHaveLength(1);
    expect(asked[0]![1]).toBe(true);
    expect(asked[0]![5]).toBe(true);
    expect(progress.pending(id)).toHaveLength(0);
  } finally {
    fx.cleanup();
  }
});
