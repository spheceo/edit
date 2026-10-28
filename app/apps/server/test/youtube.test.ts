// youtube.ts: links, and downloads through a stand-in yt-dlp (EDIT_YTDLP).

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";

import type { ScriptBlock } from "../src/model.ts";
import { parse, REUSE } from "../src/script.ts";
import { download, downloadRange, fileOf, idOf, startOf, timing, videoId } from "../src/youtube.ts";
import { scratch } from "./helpers/home.ts";

type Footage = Extract<ScriptBlock, { kind: "footage" }>;
type Narration = Extract<ScriptBlock, { kind: "narration" }>;

test("reads_youtube_links_and_times", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=t5ljpPTNvCM&t=86",
    "https://youtube.com/watch?feature=share&v=t5ljpPTNvCM",
    "https://m.youtube.com/watch?v=t5ljpPTNvCM",
    "https://youtu.be/t5ljpPTNvCM?t=1206",
    "https://www.youtube.com/shorts/t5ljpPTNvCM",
    "https://www.youtube.com/live/t5ljpPTNvCM?si=x",
    "https://www.youtube.com/embed/t5ljpPTNvCM",
  ]) {
    expect(videoId(url)).toBe("t5ljpPTNvCM");
  }
  for (const url of [
    "https://drive.google.com/file/d/1abcdefghijkl/view",
    "https://www.youtube.com/watch?v=short",
    "https://evil.example/watch?v=t5ljpPTNvCM",
    "https://youtube.com.evil.example/watch?v=t5ljpPTNvCM",
    "not a url",
  ]) {
    expect(videoId(url)).toBeNull();
  }
  expect(fileOf("https://youtu.be/MeT7tyZqfiw")).toBe("youtube:MeT7tyZqfiw");
  expect(idOf("youtube:MeT7tyZqfiw")).toBe("MeT7tyZqfiw");
  expect(idOf("youtube:../x")).toBeNull();
  expect(idOf("1abcdefghijkl")).toBeNull();
  expect(startOf("86")).toBe(86);
  expect(startOf("86s")).toBe(86);
  expect(startOf("1m26s")).toBe(86);
  expect(startOf("1h2m3s")).toBe(3723);
  expect(startOf("soon")).toBeNull();
});

const yt = (id: string, t: number) => `https://www.google.com/url?q=https://youtu.be/${id}?t%3D${t}&amp;sa=D`;

// The courtroom demo's shape: teasers, a hook paragraph, then one paragraph
// running the setup and every bridge on from the ranges.
const COURT = `<html><head><title>Court</title></head><body>
<p><a href="${yt("MeT7tyZqfiw", 1206)}">(20:07 - 20:15)</a><span> + </span><a href="${yt("MeT7tyZqfiw", 357)}">(5:57 - 6:02)</a></p>
<p><span>An Arizona officer risked everything to fake traffic tickets.</span></p>
<p><span>On September 9, 2024, the trooper was fired. But as the hearing opened, bodycam revealed it. </span><a href="${yt("MeT7tyZqfiw", 42)}">(0:42 - 2:52)</a><span>The investigation proved this was no slip-up. </span><a href="${yt("MeT7tyZqfiw", 173)}">(2:53 - 4:52)</a><span> + </span><a href="${yt("MeT7tyZqfiw", 323)}">(5:23 - </a><a href="${yt("MeT7tyZqfiw", 501)}">8:40)</a><span> In the end, the board reached a unanimous decision.</span></p>
</body></html>`;

test("youtube_ranges_and_narration_written_on_from_them", () => {
  const blocks = parse(COURT).blocks;
  const kinds = blocks.map((block) => (block.kind === "footage" ? `F ${block.start}-${block.end}` : `N ${block.text.slice(0, 12)}`));
  expect(kinds).toEqual([
    "F 1206-1215",
    "F 357-362",
    "N An Arizona o",
    // The setup is its own cut-in, not the hook's second paragraph.
    "N On September",
    "F 42-172",
    "N The investig",
    "F 173-292",
    "F 323-520",
    "N In the end, ",
  ]);
  for (const block of blocks) if (block.kind === "footage") expect((block as Footage).file).toBe("youtube:MeT7tyZqfiw");
  expect((blocks[3] as Narration).text).toBe("On September 9, 2024, the trooper was fired. But as the hearing opened, bodycam revealed it.");
});

test("a_reused_video_plays_whole_after_its_narration", () => {
  const doc = `<html><body>
<p><a href="${yt("t5ljpPTNvCM", 86)}">(1:26 - 1:28)</a></p>
<p><span>Up next, another officer.</span><sup><a href="#cmnt1" id="cmnt_ref1">[a]</a></sup></p>
<div><p><a href="#cmnt_ref1" id="cmnt1">[a]</a><span>Reuse: https://www.youtube.com/watch?v=4mqGp1IgqEw</span></p></div>
</body></html>`;
  const blocks = parse(doc).blocks;
  expect(blocks.map((block) => block.kind)).toEqual(["footage", "narration", "footage"]);
  expect(blocks[2]).toMatchObject({ file: "youtube:4mqGp1IgqEw", start: 0, label: REUSE });
});

const restore = process.env.EDIT_YTDLP;
const restoreQjs = process.env.EDIT_QJS;
timing.pause = async () => {};
afterEach(() => {
  if (restore === undefined) delete process.env.EDIT_YTDLP;
  else process.env.EDIT_YTDLP = restore;
  if (restoreQjs === undefined) delete process.env.EDIT_QJS;
  else process.env.EDIT_QJS = restoreQjs;
});

/** A yt-dlp stand-in: refuses `refusals` times (a bot check), then writes the file and says where. */
function fakeYtdlp(dir: string, refusals: number): string {
  const script = `${dir}/yt-dlp`;
  const count = `${dir}/calls`;
  fs.writeFileSync(
    script,
    `#!/bin/sh
n=$(cat "${count}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${count}"
printf '%s\\n' "$@" > "${dir}/args"
for arg in "$@"; do case "$prev" in -P) out="$arg";; --ffmpeg-location) ff="$arg";; esac; prev="$arg"; done
# As yt-dlp: FFmpeg by a bare name isn't found, and the streams stay unmerged.
case "$ff" in /*) ;; *) echo "EDIT-FILE $out/never-merged.mp4"; exit 0;; esac
if [ $n -le ${refusals} ]; then echo "ERROR: [youtube] abc: Sign in to confirm you're not a bot" >&2; exit 1; fi
echo "EDIT 512 1024 NA Some title"
echo "EDIT 1024 1024 NA Some title"
echo "EDIT 100 100 NA Some title"
printf 'video' > "$out/Some title [abcdefghijk].mp4"
echo "EDIT-FILE $out/Some title [abcdefghijk].mp4"
`,
    { mode: 0o755 },
  );
  return count;
}

test("downloads_once_retries_a_refusal_and_reuses_the_file", async () => {
  const { dir, cleanup } = scratch("youtube");
  try {
    const calls = fakeYtdlp(dir, 1);
    process.env.EDIT_YTDLP = `${dir}/yt-dlp`;
    const seen: [number, number | null][] = [];
    const into = `${dir}/out`;
    const got = await download(dir, "abcdefghijk", into, (bytes, total) => seen.push([bytes, total]));
    expect(got.name).toBe("Some title [abcdefghijk].mp4");
    expect(fs.readFileSync(got.path, "utf8")).toBe("video");
    // Refused once, then downloaded; the sound's bytes carry on from the picture's.
    expect(fs.readFileSync(calls, "utf8").trim()).toBe("2");
    expect(seen).toContainEqual([1124, 1124]);
    // Done once: asked again, it's the same file without running yt-dlp.
    const again = await download(dir, "abcdefghijk", into, () => {});
    expect(again.path).toBe(got.path);
    expect(fs.readFileSync(calls, "utf8").trim()).toBe("2");
  } finally {
    cleanup();
  }
});

test("a_video_youtube_keeps_refusing_fails_saying_so", async () => {
  const { dir, cleanup } = scratch("youtube-refused");
  const proxy = process.env.PROXY_URL;
  delete process.env.PROXY_URL;
  try {
    fakeYtdlp(dir, 9);
    process.env.EDIT_YTDLP = `${dir}/yt-dlp`;
    const failed = await download(dir, "abcdefghijk", `${dir}/out`, () => {}).catch((error: Error) => error.message);
    expect(failed).toContain("couldn't be downloaded");
    expect(failed).toContain("not a bot");
  } finally {
    if (proxy !== undefined) process.env.PROXY_URL = proxy;
    cleanup();
  }
});

/**
 * A yt-dlp stand-in that fails call by call: `failures[n]` is the stderr of
 * call n+1 (the last one repeats); a call past them writes the file.
 */
function fakeScripted(dir: string, failures: string[]): string {
  const script = `${dir}/yt-dlp`;
  const count = `${dir}/calls`;
  const arms = failures
    .map((stderr, index) => `  ${index + 1}) printf '%s\\n' '${stderr}' >&2; exit 1;;`)
    .join("\n");
  fs.writeFileSync(
    script,
    `#!/bin/sh
n=$(cat "${count}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${count}"
printf '%s\\n' "$@" > "${dir}/args"
for arg in "$@"; do case "$prev" in -P) out="$arg";; --ffmpeg-location) ff="$arg";; esac; prev="$arg"; done
case "$ff" in /*) ;; *) echo "EDIT-FILE $out/never-merged.mp4"; exit 0;; esac
case $n in
${arms}
esac
if [ $n -le ${failures.length} ]; then printf '%s\\n' '${failures[failures.length - 1] ?? ""}' >&2; exit 1; fi
echo "EDIT 1024 1024 NA Some title"
printf 'video' > "$out/Some title [abcdefghijk].mp4"
echo "EDIT-FILE $out/Some title [abcdefghijk].mp4"
`,
    { mode: 0o755 },
  );
  return count;
}

test("gives yt-dlp the bundled qjs as its javascript runtime, never a storyboard format", async () => {
  const { dir, cleanup } = scratch("youtube-qjs");
  try {
    fakeYtdlp(dir, 0);
    process.env.EDIT_YTDLP = `${dir}/yt-dlp`;
    process.env.EDIT_QJS = `${dir}/qjs-aarch64-apple-darwin`;
    await download(dir, "abcdefghijk", `${dir}/out`, () => {});
    const args = fs.readFileSync(`${dir}/args`, "utf8").split("\n");
    expect(args[args.indexOf("--js-runtimes") + 1]).toBe(`quickjs:${dir}/qjs-aarch64-apple-darwin`);
    const format = args[args.indexOf("-f") + 1]!;
    expect(format.endsWith("/b[vcodec!=none]")).toBe(true);
    expect(format.endsWith("/b")).toBe(false);
  } finally {
    cleanup();
  }
});

test("an installed runtime serves when there is no bundled qjs", async () => {
  const { dir, cleanup } = scratch("youtube-installed");
  try {
    fakeYtdlp(dir, 0);
    process.env.EDIT_YTDLP = `${dir}/yt-dlp`;
    delete process.env.EDIT_QJS;
    await download(dir, "abcdefghijk", `${dir}/out`, () => {});
    const args = fs.readFileSync(`${dir}/args`, "utf8").split("\n");
    // Whichever of deno/node/bun/quickjs this Mac has, named with its path
    // (a bare name would leave a Dock-launched Edit with nothing to run).
    expect(args[args.indexOf("--js-runtimes") + 1]).toMatch(/^(deno|node|bun|quickjs):\//);
  } finally {
    cleanup();
  }
});

test("a route withholding formats or giving only images falls through to the next", async () => {
  for (const [name, stderr] of [
    ["format", "ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats"],
    ["images", "ERROR: Only images are available for download. use --list-formats to see them"],
    ["runtime", "WARNING: [youtube] No supported JavaScript runtime could be found. Only deno is enabled by default\nERROR: [youtube] abc: Requested format is not available"],
  ] as const) {
    const { dir, cleanup } = scratch(`youtube-${name}`);
    try {
      const calls = fakeScripted(dir, [stderr]);
      process.env.EDIT_YTDLP = `${dir}/yt-dlp`;
      const got = await download(dir, "abcdefghijk", `${dir}/out`, () => {});
      expect(fs.readFileSync(got.path, "utf8")).toBe("video");
      expect(fs.readFileSync(calls, "utf8").trim()).toBe("2");
    } finally {
      cleanup();
    }
  }
});

test("a final failure quotes the ERROR line, not a WARNING before it", async () => {
  const { dir, cleanup } = scratch("youtube-final");
  const proxy = process.env.PROXY_URL;
  delete process.env.PROXY_URL;
  try {
    fakeScripted(dir, [
      "WARNING: [youtube] No supported JavaScript runtime could be found. Only deno is enabled by default\nERROR: [youtube] abc: Private video",
    ]);
    process.env.EDIT_YTDLP = `${dir}/yt-dlp`;
    const failed = await download(dir, "abcdefghijk", `${dir}/out`, () => {}).catch((error: Error) => error.message);
    expect(failed).toContain("Private video");
    expect(failed).not.toContain("No supported JavaScript runtime");
  } finally {
    if (proxy !== undefined) process.env.PROXY_URL = proxy;
    cleanup();
  }
});

test("a visual excerpt requests an exact bounded section and rejects an entire-stream range", async () => {
  const { dir, cleanup } = scratch("youtube-range");
  try {
    fakeYtdlp(dir, 0); process.env.EDIT_YTDLP = `${dir}/yt-dlp`;
    const got = await downloadRange(dir, "abcdefghijk", [6250.5, 6267], `${dir}/out`);
    expect(fs.readFileSync(got.path, "utf8")).toBe("video");
    const args = fs.readFileSync(`${dir}/args`, "utf8").split("\n");
    expect(args[args.indexOf("--download-sections") + 1]).toBe("*6250.5-6267");
    expect(args).toContain("--force-keyframes-at-cuts");
    await expect(downloadRange(dir, "abcdefghijk", [0, 3600], `${dir}/long`)).rejects.toThrow("at most 10 minutes");
  } finally { cleanup(); }
});

test("a yt-dlp that says nothing for too long is stopped and tried again, never left frozen", async () => {
  const { dir, cleanup } = scratch("youtube-quiet");
  const quiet = timing.quiet;
  timing.quiet = 2000;
  try {
    const script = `${dir}/yt-dlp`;
    const count = `${dir}/calls`;
    fs.writeFileSync(
      script,
      `#!/bin/sh
n=$(cat "${count}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${count}"
for arg in "$@"; do case "$prev" in -P) out="$arg";; esac; prev="$arg"; done
# The first run: some progress, then a dead connection (nothing more, ever).
if [ $n -eq 1 ]; then echo "EDIT 100 1024 NA Some title"; exec sleep 30; fi
echo "EDIT 1024 1024 NA Some title"
printf 'video' > "$out/Some title [abcdefghijk].mp4"
echo "EDIT-FILE $out/Some title [abcdefghijk].mp4"
`,
      { mode: 0o755 },
    );
    process.env.EDIT_YTDLP = script;
    const got = await download(dir, "abcdefghijk", `${dir}/out`, () => {});
    expect(fs.readFileSync(got.path, "utf8")).toBe("video");
    expect(fs.readFileSync(count, "utf8").trim()).toBe("2");
  } finally {
    timing.quiet = quiet;
    cleanup();
  }
});
